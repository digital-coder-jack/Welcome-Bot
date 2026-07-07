"""
Activity Unlock cog — first-message reward system.

Watches #chill-zone for each member's FIRST valid message, then awards the
🔥 Forge Member role exactly once (DB-level atomic claim + in-memory
per-user locks make double-award impossible), reacts to the message,
sends a congratulation DM and notifies the owner on Telegram.
"""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import discord
from discord.ext import commands

from bot.core.logging import get_logger
from bot.utils.embeds import build_forge_dm_embed
from bot.utils.formatting import utcnow

if TYPE_CHECKING:
    from bot.core.bot import ForgeBot

log = get_logger("cogs.activity")


class ActivityUnlock(commands.Cog):
    """First valid message in the configured chill-zone → 🔥 Forge Member."""

    def __init__(self, bot: "ForgeBot") -> None:
        self.bot = bot
        # per (guild, user) locks to serialise concurrent message bursts
        self._locks: dict[tuple[int, int], asyncio.Lock] = {}

    def _lock_for(self, guild_id: int, user_id: int) -> asyncio.Lock:
        key = (guild_id, user_id)
        lock = self._locks.get(key)
        if lock is None:
            lock = self._locks[key] = asyncio.Lock()
        return lock

    # ─────────────────────────────────────────────────────────

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        # Fast, allocation-free rejections first (large-server friendly)
        if message.author.bot:                       # ignore bots
            return
        if message.guild is None:                    # ignore DMs
            return
        if not message.content or not message.content.strip():
            return                                   # empty / whitespace-only

        guild = message.guild
        member = message.author
        if not isinstance(member, discord.Member):
            return

        try:
            settings = await self.bot.db.get_guild_settings(guild.id)
        except Exception:  # noqa: BLE001
            log.exception("Settings load failed in on_message")
            return

        if not settings.get("enable_activity_unlock", 1):
            return
        chill_id = settings.get("chill_zone_channel_id")
        if not chill_id or message.channel.id != int(chill_id):
            return

        lock = self._lock_for(guild.id, member.id)
        if lock.locked():
            return  # duplicate burst — already processing this user
        async with lock:
            await self._try_award(message, member, settings)

    # NOTE: edited messages never re-trigger — we only listen to on_message,
    # and the DB claim below is insert-once, so edits/deletes cannot re-award.

    async def _try_award(
        self,
        message: discord.Message,
        member: discord.Member,
        settings: dict,
    ) -> None:
        guild = member.guild

        # Atomic first-message claim — returns False if any message was
        # already claimed for this member (exactly-once guarantee).
        claimed = await self.bot.db.try_claim_first_message(
            guild_id=guild.id,
            user_id=member.id,
            message_id=message.id,
            channel_id=message.channel.id,
            content=message.content,
            timestamp=(message.created_at or utcnow()).isoformat(),
        )
        if not claimed:
            return
        # Belt & braces: reward table has its own unique constraint too.
        if await self.bot.db.has_role_reward(guild.id, member.id, "forge_member"):
            return

        role_name = await self._assign_forge_role(member, settings)
        await self._maybe_remove_new_member_role(member, settings)
        await self._react(message, settings)
        await self._update_member_record(member, message)
        dm_ok = await self._send_forge_dm(member, settings)
        if settings.get("enable_telegram", 1):
            await self._notify_telegram(member, message, role_name, dm_ok)

        log.info("🔥 Forge Member awarded to %s in guild %s", member.id, guild.id)

    # ── steps ────────────────────────────────────────────────

    async def _assign_forge_role(self, member: discord.Member, settings: dict) -> str:
        role_id = settings.get("forge_member_role_id")
        if not role_id:
            log.warning("Forge Member role not configured in guild %s", member.guild.id)
            return "🔥 Forge Member (not configured)"
        role = member.guild.get_role(int(role_id))
        if role is None:
            log.warning("Forge Member role %s missing in guild %s",
                        role_id, member.guild.id)
            return "🔥 Forge Member (missing)"
        try:
            await member.add_roles(role, reason="Developer Forge: first message unlock")
            await self.bot.db.record_role_reward(
                member.guild.id, member.id, role.id, "forge_member"
            )
            await self.bot.db.set_member_flag(
                member.guild.id, member.id, "forge_member_awarded", 1
            )
            return role.name
        except discord.Forbidden:
            log.warning("No permission to grant Forge role in guild %s", member.guild.id)
            return f"{role.name} (permission error)"
        except discord.HTTPException:
            log.exception("Forge role grant failed for %s", member.id)
            return f"{role.name} (error)"

    async def _maybe_remove_new_member_role(
        self, member: discord.Member, settings: dict
    ) -> None:
        if not settings.get("remove_new_member_role", 1):
            return
        role_id = settings.get("new_member_role_id")
        if not role_id:
            return
        role = member.guild.get_role(int(role_id))
        if role and role in member.roles:
            try:
                await member.remove_roles(
                    role, reason="Developer Forge: upgraded to Forge Member"
                )
            except (discord.Forbidden, discord.HTTPException):
                log.warning("Could not remove New Member role from %s", member.id)

    async def _react(self, message: discord.Message, settings: dict) -> None:
        emoji = (settings.get("unlock_reaction")
                 or self.bot.config.defaults.unlock_reaction)
        try:
            await message.add_reaction(emoji)
        except (discord.Forbidden, discord.HTTPException, discord.NotFound):
            # message deleted or missing permission — non-critical
            log.debug("Could not react to first message %s", message.id)

    async def _update_member_record(
        self, member: discord.Member, message: discord.Message
    ) -> None:
        try:
            await self.bot.db.set_member_flag(
                member.guild.id, member.id, "first_message_time",
                (message.created_at or utcnow()).isoformat(),
            )
            await self.bot.db.set_member_flag(
                member.guild.id, member.id, "first_message_channel",
                message.channel.id,
            )
        except Exception:  # noqa: BLE001
            log.exception("Failed to update first-message record")

    async def _send_forge_dm(self, member: discord.Member, settings: dict) -> bool:
        try:
            embed = build_forge_dm_embed(
                member, settings, self.bot.config.defaults.footer
            )
            await member.send(embed=embed)
            await self.bot.db.log_dm(member.guild.id, member.id, "forge_member", True)
            return True
        except discord.Forbidden:
            await self.bot.db.log_dm(
                member.guild.id, member.id, "forge_member", False, "DMs disabled"
            )
            log.info("Forge DM blocked for %s (DMs disabled)", member.id)
        except discord.HTTPException as exc:
            await self.bot.db.log_dm(
                member.guild.id, member.id, "forge_member", False, str(exc)[:200]
            )
            log.warning("Forge DM failed for %s: %s", member.id, exc)
        except Exception:  # noqa: BLE001
            log.exception("Unexpected Forge DM error for %s", member.id)
        return False

    async def _notify_telegram(
        self,
        member: discord.Member,
        message: discord.Message,
        role_name: str,
        dm_ok: bool,
    ) -> None:
        channel_name = getattr(message.channel, "name", str(message.channel.id))
        text = self.bot.telegram.build_forge_unlocked({
            "username": str(member),
            "user_id": member.id,
            "first_message": message.content[:300],
            "channel_name": channel_name,
            "time": (message.created_at or utcnow()).strftime("%Y-%m-%d %H:%M:%S UTC"),
            "new_role": f"{role_name} · DM {'✅' if dm_ok else '❌'}",
        })
        await self.bot.telegram.send(
            text, event_type="forge_unlocked",
            guild_id=member.guild.id, user_id=member.id,
        )


async def setup(bot: "ForgeBot") -> None:
    await bot.add_cog(ActivityUnlock(bot))
