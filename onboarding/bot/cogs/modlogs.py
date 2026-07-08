"""
Moderation Logs cog — posts a premium, translated embed to the configured
#mod-logs channel (and records to modlog_entries) for every important event:

  member join · member leave · kick · ban · unban · timeout applied/removed
  message deleted · role added/removed

Kick vs. voluntary leave is disambiguated via the audit log; moderator and
reason are pulled from audit-log entries whenever available.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

import discord
from discord.ext import commands

from bot.core.logging import get_logger
from bot.utils.formatting import utcnow

if TYPE_CHECKING:
    from bot.core.bot import ForgeBot

log = get_logger("cogs.modlogs")

COLORS = {
    "log.member_join": discord.Color.green(),
    "log.member_leave": discord.Color.light_grey(),
    "log.kick": discord.Color.orange(),
    "log.ban": discord.Color.red(),
    "log.unban": discord.Color.teal(),
    "log.timeout": discord.Color.dark_orange(),
    "log.timeout_removed": discord.Color.blurple(),
    "log.message_delete": discord.Color.dark_grey(),
    "log.role_add": discord.Color.blue(),
    "log.role_remove": discord.Color.dark_blue(),
}


class ModLogs(commands.Cog):
    """Central moderation-log pipeline with audit-log enrichment."""

    def __init__(self, bot: "ForgeBot") -> None:
        self.bot = bot
        # (guild_id, user_id) recently kicked/banned → suppress 'leave' log
        self._removal_cache: dict[tuple[int, int], str] = {}

    # ═════════════════════════════════════════════════════════
    # helpers
    # ═════════════════════════════════════════════════════════

    async def _channel(self, guild: discord.Guild) -> discord.TextChannel | None:
        gs = await self.bot.guardian_store.get_settings(guild.id)
        if not gs.get("enable_modlog", 1):
            return None
        cid = gs.get("modlog_channel_id")
        channel = guild.get_channel(int(cid)) if cid else None
        if channel is None:
            channel = discord.utils.get(guild.text_channels, name="mod-logs")
        if channel is None:
            return None
        me = guild.me
        if me and not channel.permissions_for(me).send_messages:
            return None
        return channel  # type: ignore[return-value]

    async def _post(
        self, guild: discord.Guild, title_key: str, *,
        user: discord.abc.User | None = None,
        user_id: int | None = None, username: str | None = None,
        moderator: str | None = None, reason: str | None = None,
        channel_name: str | None = None, evidence: str | None = None,
        extra_fields: list[tuple[str, str]] | None = None,
        action: str | None = None,
    ) -> None:
        """Build + send the log embed and persist a modlog_entries row."""
        try:
            lang = await self.bot.guardian_store.language(guild.id)
            t = self.bot.i18n.t
            uid = user.id if user else user_id
            uname = str(user) if user else username

            await self.bot.guardian_store.add_modlog(
                guild_id=guild.id,
                action=action or title_key.removeprefix("log."),
                user_id=uid, username=uname,
                moderator_id=None, reason=reason, evidence=evidence)

            channel = await self._channel(guild)
            if channel is None:
                return
            embed = discord.Embed(
                title=t(lang, title_key),
                color=COLORS.get(title_key, discord.Color.dark_grey()),
                timestamp=utcnow())
            embed.add_field(name=t(lang, "log.field.user"),
                            value=f"{uname or '—'} (`{uid or '—'}`)", inline=True)
            embed.add_field(name=t(lang, "log.field.moderator"),
                            value=moderator or "—", inline=True)
            if channel_name:
                embed.add_field(name=t(lang, "log.field.channel"),
                                value=f"#{channel_name}", inline=True)
            if reason:
                embed.add_field(name=t(lang, "log.field.reason"),
                                value=reason[:1024], inline=False)
            if evidence:
                embed.add_field(name=t(lang, "log.field.evidence"),
                                value=evidence[:1024], inline=False)
            for name, value in (extra_fields or []):
                embed.add_field(name=name, value=value[:1024], inline=True)
            if user and getattr(user, "display_avatar", None):
                embed.set_thumbnail(url=user.display_avatar.url)
            embed.set_footer(text="Forge Guardian • Moderation Log")
            await channel.send(embed=embed)
        except Exception:  # noqa: BLE001 — logging must never break the bot
            log.exception("Failed to post mod log (%s)", title_key)

    async def _audit_entry(
        self, guild: discord.Guild, action: discord.AuditLogAction,
        target_id: int, *, window: float = 15.0,
    ) -> discord.AuditLogEntry | None:
        """Find the freshest audit entry matching target within `window`s."""
        me = guild.me
        if me is None or not me.guild_permissions.view_audit_log:
            return None
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=window)
        try:
            async for entry in guild.audit_logs(limit=8, action=action):
                if entry.created_at < cutoff:
                    break
                if entry.target and entry.target.id == target_id:
                    return entry
        except (discord.Forbidden, discord.HTTPException):
            pass
        return None

    # ═════════════════════════════════════════════════════════
    # join / leave / kick disambiguation
    # ═════════════════════════════════════════════════════════

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member) -> None:
        await self._post(
            member.guild, "log.member_join", user=member, action="join",
            extra_fields=[
                ("📅", f"<t:{int(member.created_at.timestamp())}:R> account"),
                ("👥", f"member #{member.guild.member_count}"),
            ])

    @commands.Cog.listener()
    async def on_raw_member_remove(self, payload: discord.RawMemberRemoveEvent) -> None:
        guild = self.bot.get_guild(payload.guild_id)
        if guild is None:
            return
        user = payload.user
        # ban events fire on_member_ban too — skip double logging here
        if self._removal_cache.pop((guild.id, user.id), None) == "ban":
            return
        await asyncio.sleep(1.5)  # let the audit log catch up
        entry = await self._audit_entry(
            guild, discord.AuditLogAction.kick, user.id)
        if entry is not None:
            await self._post(
                guild, "log.kick", user=user, action="kick",
                moderator=str(entry.user) if entry.user else "—",
                reason=entry.reason or "—")
        else:
            await self._post(guild, "log.member_leave", user=user, action="leave")

    @commands.Cog.listener()
    async def on_member_ban(self, guild: discord.Guild, user: discord.User) -> None:
        self._removal_cache[(guild.id, user.id)] = "ban"
        await asyncio.sleep(1.5)
        entry = await self._audit_entry(guild, discord.AuditLogAction.ban, user.id)
        await self._post(
            guild, "log.ban", user=user, action="ban",
            moderator=str(entry.user) if entry and entry.user else "—",
            reason=(entry.reason if entry else None) or "—")

    @commands.Cog.listener()
    async def on_member_unban(self, guild: discord.Guild, user: discord.User) -> None:
        await asyncio.sleep(1.5)
        entry = await self._audit_entry(guild, discord.AuditLogAction.unban, user.id)
        await self._post(
            guild, "log.unban", user=user, action="unban",
            moderator=str(entry.user) if entry and entry.user else "—",
            reason=(entry.reason if entry else None) or "—")

    # ═════════════════════════════════════════════════════════
    # timeout + role changes
    # ═════════════════════════════════════════════════════════

    @commands.Cog.listener()
    async def on_member_update(self, before: discord.Member,
                               after: discord.Member) -> None:
        guild = after.guild
        # ── timeout applied / removed ────────────────────────
        b_to = before.timed_out_until
        a_to = after.timed_out_until
        now = datetime.now(timezone.utc)
        b_active = b_to is not None and b_to > now
        a_active = a_to is not None and a_to > now
        if not b_active and a_active:
            entry = await self._audit_entry(
                guild, discord.AuditLogAction.member_update, after.id)
            await self._post(
                guild, "log.timeout", user=after, action="timeout",
                moderator=str(entry.user) if entry and entry.user else "—",
                reason=(entry.reason if entry else None) or "—",
                extra_fields=[("⏱ Until", f"<t:{int(a_to.timestamp())}:f>")])
        elif b_active and not a_active:
            await self._post(guild, "log.timeout_removed", user=after,
                             action="timeout_removed")

        # ── role add / remove ────────────────────────────────
        b_roles = set(before.roles)
        a_roles = set(after.roles)
        added = a_roles - b_roles
        removed = b_roles - a_roles
        for role in added:
            await self._post(
                guild, "log.role_add", user=after, action="role_add",
                reason=f"Role: **{role.name}**")
        for role in removed:
            await self._post(
                guild, "log.role_remove", user=after, action="role_remove",
                reason=f"Role: **{role.name}**")

    # ═════════════════════════════════════════════════════════
    # message deletes
    # ═════════════════════════════════════════════════════════

    @commands.Cog.listener()
    async def on_message_delete(self, message: discord.Message) -> None:
        if message.guild is None or message.author.bot:
            return
        content = (message.content or "(no text / media)")[:400]
        await self._post(
            message.guild, "log.message_delete", user=message.author,
            action="message_delete",
            channel_name=getattr(message.channel, "name", "?"),
            evidence=f"```{content.replace('`', 'ˋ')}```")


async def setup(bot: "ForgeBot") -> None:
    await bot.add_cog(ModLogs(bot))
