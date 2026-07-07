"""
Welcome cog — the full member-join onboarding pipeline.

Join → auto-role → welcome embed + premium image + buttons → welcome DM →
database records → private Telegram notification to the server owner.

Public Discord messages stay clean & friendly; all sensitive member
details go exclusively to Telegram.
"""
from __future__ import annotations

import io
from typing import TYPE_CHECKING

import discord
from discord.ext import commands

from bot.core.logging import get_logger
from bot.services.invites import InviteHit
from bot.utils.embeds import build_welcome_dm_embed, build_welcome_embed
from bot.utils.premium_dm import build_premium_dm_embeds, build_premium_dm_view
from bot.utils.formatting import human_age, utcnow
from bot.utils.views import build_welcome_view

if TYPE_CHECKING:
    from bot.core.bot import ForgeBot

log = get_logger("cogs.welcome")


class Welcome(commands.Cog):
    """Handles the complete new-member onboarding flow."""

    def __init__(self, bot: "ForgeBot") -> None:
        self.bot = bot

    # ─────────────────────────────────────────────────────────
    # Member join pipeline
    # ─────────────────────────────────────────────────────────

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member) -> None:
        guild = member.guild
        try:
            settings = await self.bot.db.get_guild_settings(guild.id)
        except Exception:  # noqa: BLE001
            log.exception("Could not load settings for guild %s", guild.id)
            return

        member_number = guild.member_count or 0
        joined_at = (member.joined_at or utcnow()).isoformat()

        # 1) invite attribution
        invite: InviteHit | None = None
        if settings.get("enable_invite_tracking", 1):
            invite = await self._track_invite(member)

        # 2) persist master record + join history
        await self._record_join(member, member_number, joined_at, invite)

        # 3) auto role
        assigned_role = await self._assign_new_member_role(member, settings)

        # 4) public welcome (embed + image + buttons)
        if settings.get("enable_welcome", 1):
            await self._send_welcome_message(member, member_number, invite, settings)

        # 5) welcome DM (graceful failure)
        dm_ok = False
        if settings.get("enable_welcome_dm", 1) and not member.bot:
            dm_ok = await self._send_welcome_dm(member, settings)

        # 6) private owner notification via Telegram
        if settings.get("enable_telegram", 1):
            await self._notify_telegram_join(
                member, member_number, invite, assigned_role, dm_ok
            )

    # ── step helpers ─────────────────────────────────────────

    async def _track_invite(self, member: discord.Member) -> InviteHit | None:
        try:
            hit = await self.bot.invite_tracker.resolve_join(member.guild)
        except Exception:  # noqa: BLE001
            log.exception("Invite resolution failed for %s", member.id)
            return None
        if hit:
            try:
                await self.bot.db.add_invite_history(
                    guild_id=member.guild.id,
                    invite_code=hit.code,
                    inviter_id=hit.inviter_id,
                    inviter_name=hit.inviter_name,
                    used_by=member.id,
                    uses=hit.uses,
                )
            except Exception:  # noqa: BLE001
                log.exception("Failed to store invite history")
        return hit

    async def _record_join(
        self,
        member: discord.Member,
        member_number: int,
        joined_at: str,
        invite: InviteHit | None,
    ) -> None:
        try:
            await self.bot.db.upsert_member_join(
                guild_id=member.guild.id,
                user_id=member.id,
                username=str(member),
                display_name=member.display_name,
                is_bot=member.bot,
                member_number=member_number,
                joined_at=joined_at,
                account_created_at=member.created_at.isoformat(),
                invite_code=invite.code if invite else None,
                inviter_id=invite.inviter_id if invite else None,
                inviter_name=invite.inviter_name if invite else None,
            )
            await self.bot.db.add_join_history(
                guild_id=member.guild.id,
                user_id=member.id,
                joined_at=joined_at,
                joined_channel=None,
                member_number=member_number,
                invite_code=invite.code if invite else None,
                inviter_id=invite.inviter_id if invite else None,
            )
        except Exception:  # noqa: BLE001
            log.exception("Failed to persist join for %s", member.id)

    async def _assign_new_member_role(
        self, member: discord.Member, settings: dict
    ) -> str:
        if not settings.get("enable_auto_role", 1):
            return "—"
        role_id = settings.get("new_member_role_id")
        if not role_id:
            return "— (role not configured)"
        role = member.guild.get_role(int(role_id))
        if role is None:
            log.warning("New Member role %s not found in guild %s",
                        role_id, member.guild.id)
            return "— (role missing)"
        try:
            await member.add_roles(role, reason="Developer Forge onboarding: New Member")
            await self.bot.db.record_role_reward(
                member.guild.id, member.id, role.id, "new_member"
            )
            return role.name
        except discord.Forbidden:
            log.warning("Missing permission to assign role in guild %s", member.guild.id)
            return "— (missing permission)"
        except discord.HTTPException:
            log.exception("Role assignment failed for %s", member.id)
            return "— (error)"

    async def _send_welcome_message(
        self,
        member: discord.Member,
        member_number: int,
        invite: InviteHit | None,
        settings: dict,
    ) -> None:
        channel_id = settings.get("welcome_channel_id")
        if not channel_id:
            log.debug("Welcome channel not configured for guild %s", member.guild.id)
            return
        channel = member.guild.get_channel(int(channel_id))
        if not isinstance(channel, discord.TextChannel):
            log.warning("Welcome channel %s invalid in guild %s",
                        channel_id, member.guild.id)
            return

        embed = build_welcome_embed(
            member,
            member_number=member_number,
            inviter_name=invite.inviter_name if invite else None,
            invite_code=invite.code if invite else None,
            settings=settings,
            default_footer=self.bot.config.defaults.footer,
        )
        view = build_welcome_view(member.guild.id, settings)

        file: discord.File | None = None
        if settings.get("enable_welcome_image", 1):
            png = await self.bot.image_generator.generate(
                avatar_url=member.display_avatar.replace(size=512, format="png").url,
                username=member.display_name,
                server_name=member.guild.name,
                member_number=member_number,
                branding=settings.get("branding")
                or self.bot.config.defaults.branding,
                logo_url=settings.get("server_logo_url")
                or (member.guild.icon.url if member.guild.icon else None),
            )
            if png:
                file = discord.File(io.BytesIO(png), filename="welcome.png")
                embed.set_image(url="attachment://welcome.png")

        try:
            kwargs: dict = {"embed": embed}
            if view:
                kwargs["view"] = view
            if file:
                kwargs["file"] = file
            await channel.send(**kwargs)
            await self.bot.db.set_member_flag(
                member.guild.id, member.id, "welcome_sent", 1
            )
        except discord.Forbidden:
            log.warning("Cannot send in welcome channel of guild %s", member.guild.id)
        except discord.HTTPException:
            log.exception("Welcome message failed for %s", member.id)

    async def _send_welcome_dm(self, member: discord.Member, settings: dict) -> bool:
        """v2.0 premium multi-embed DM with graceful fallback to the classic
        single-embed DM if the premium payload is rejected for any reason."""
        try:
            welcome_settings = await self.bot.db.get_welcome_settings(member.guild.id)
            try:
                embeds = build_premium_dm_embeds(
                    member, settings, welcome_settings,
                    self.bot.config.defaults.footer,
                )
                view = build_premium_dm_view(member, settings)
                kwargs: dict = {"embeds": embeds}
                if view:
                    kwargs["view"] = view
                await member.send(**kwargs)
            except discord.HTTPException:
                # fallback: classic single-embed welcome DM (v1 behaviour)
                embed = build_welcome_dm_embed(
                    member, settings, welcome_settings,
                    self.bot.config.defaults.footer,
                )
                await member.send(embed=embed)
            await self.bot.db.log_dm(member.guild.id, member.id, "welcome", True)
            await self.bot.db.set_member_flag(member.guild.id, member.id, "dm_sent", 1)
            return True
        except discord.Forbidden:
            # DMs disabled — record silently, never surface publicly
            await self.bot.db.log_dm(
                member.guild.id, member.id, "welcome", False, "DMs disabled"
            )
            log.info("Welcome DM blocked for %s (DMs disabled)", member.id)
        except discord.HTTPException as exc:
            await self.bot.db.log_dm(
                member.guild.id, member.id, "welcome", False, str(exc)[:200]
            )
            log.warning("Welcome DM failed for %s: %s", member.id, exc)
        except Exception:  # noqa: BLE001
            log.exception("Unexpected DM error for %s", member.id)
        return False

    async def _notify_telegram_join(
        self,
        member: discord.Member,
        member_number: int,
        invite: InviteHit | None,
        assigned_role: str,
        dm_ok: bool,
    ) -> None:
        joined = member.joined_at or utcnow()
        text = self.bot.telegram.build_member_joined({
            "username": str(member),
            "display_name": member.display_name,
            "user_id": member.id,
            "server_name": member.guild.name,
            "join_time": joined.strftime("%Y-%m-%d %H:%M:%S UTC"),
            "account_created": member.created_at.strftime("%Y-%m-%d %H:%M:%S UTC"),
            "account_age": human_age(member.created_at),
            "member_number": f"#{member_number}",
            "inviter": invite.inviter_name if invite and invite.inviter_name else "Unknown",
            "invite_code": invite.code if invite else "Unknown",
            "bot_or_human": "🤖 Bot" if member.bot else "👤 Human",
            "avatar_url": member.display_avatar.url,
            "dm_status": "✅ Delivered" if dm_ok else "❌ Failed / Disabled",
            "assigned_role": assigned_role,
        })
        ok = await self.bot.telegram.send(
            text, event_type="member_joined",
            guild_id=member.guild.id, user_id=member.id,
        )
        try:
            await self.bot.db.set_member_flag(
                member.guild.id, member.id, "telegram_sent", int(ok)
            )
            await self.bot.db.set_member_flag(
                member.guild.id, member.id, "telegram_status",
                "delivered" if ok else "failed",
            )
        except Exception:  # noqa: BLE001
            log.exception("Failed to update telegram status flags")


async def setup(bot: "ForgeBot") -> None:
    await bot.add_cog(Welcome(bot))
