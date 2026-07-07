"""
Action Executor — applies configured punishments safely.

Centralizes every moderation action (delete / warn / timeout / kick / ban /
channel lockdown) with permission checks, hierarchy checks, structured
logging and full DB audit. Never raises into the event pipeline.
"""
from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING

import discord

from bot.core.logging import get_logger

if TYPE_CHECKING:
    from bot.database.security_store import SecurityStore

log = get_logger("security.actions")

VALID_PUNISHMENTS = ("none", "warn", "delete", "timeout", "kick", "ban")


class ActionExecutor:
    """Executes punishments and records them; every method is exception-safe."""

    def __init__(self, store: "SecurityStore") -> None:
        self._store = store

    # ── message level ────────────────────────────────────────

    async def delete_message(self, message: discord.Message) -> bool:
        try:
            await message.delete()
            return True
        except discord.NotFound:
            return True  # already gone
        except discord.Forbidden:
            log.warning("Missing permission to delete message in #%s", message.channel)
        except discord.HTTPException as exc:
            log.warning("Delete failed: %s", exc)
        return False

    # ── member level ─────────────────────────────────────────

    async def warn(
        self, member: discord.Member, *, reason: str, event_type: str,
        moderator_id: int | None = None, notify: bool = True,
    ) -> int:
        count = await self._store.add_warning(
            guild_id=member.guild.id, user_id=member.id, username=str(member),
            reason=reason, event_type=event_type, moderator_id=moderator_id,
        )
        if notify:
            try:
                await member.send(
                    f"⚠️ **Warning from {member.guild.name}**\n"
                    f"Reason: {reason}\n"
                    f"Total warnings: **{count}** — repeated violations lead to "
                    f"timeouts or removal."
                )
            except (discord.Forbidden, discord.HTTPException):
                pass  # DMs closed — warning still recorded
        return count

    async def timeout(
        self, member: discord.Member, *, minutes: int, reason: str,
        event_type: str, moderator_id: int | None = None,
    ) -> bool:
        ok, err = True, None
        try:
            await member.timeout(
                timedelta(minutes=max(1, min(minutes, 40320))),  # ≤ 28 days
                reason=f"[Forge Security] {reason}"[:512],
            )
        except (discord.Forbidden, discord.HTTPException) as exc:
            ok, err = False, str(exc)
            log.warning("Timeout failed for %s: %s", member, exc)
        await self._store.add_punishment(
            guild_id=member.guild.id, user_id=member.id, username=str(member),
            punishment="timeout", reason=reason, duration_secs=minutes * 60,
            event_type=event_type, moderator_id=moderator_id,
            success=ok, error=err,
        )
        return ok

    async def kick(
        self, member: discord.Member, *, reason: str, event_type: str,
        moderator_id: int | None = None,
    ) -> bool:
        ok, err = True, None
        try:
            await member.kick(reason=f"[Forge Security] {reason}"[:512])
        except (discord.Forbidden, discord.HTTPException) as exc:
            ok, err = False, str(exc)
            log.warning("Kick failed for %s: %s", member, exc)
        await self._store.add_punishment(
            guild_id=member.guild.id, user_id=member.id, username=str(member),
            punishment="kick", reason=reason, event_type=event_type,
            moderator_id=moderator_id, success=ok, error=err,
        )
        return ok

    async def ban(
        self, member: discord.Member, *, reason: str, event_type: str,
        moderator_id: int | None = None,
    ) -> bool:
        ok, err = True, None
        try:
            await member.ban(
                reason=f"[Forge Security] {reason}"[:512],
                delete_message_seconds=3600,
            )
        except (discord.Forbidden, discord.HTTPException) as exc:
            ok, err = False, str(exc)
            log.warning("Ban failed for %s: %s", member, exc)
        await self._store.add_punishment(
            guild_id=member.guild.id, user_id=member.id, username=str(member),
            punishment="ban", reason=reason, event_type=event_type,
            moderator_id=moderator_id, success=ok, error=err,
        )
        return ok

    # ── configured punishment dispatch ───────────────────────

    async def apply(
        self,
        member: discord.Member,
        punishment: str,
        *,
        message: discord.Message | None,
        reason: str,
        event_type: str,
        timeout_minutes: int,
    ) -> str:
        """
        Apply the configured punishment; message deletion is implied for
        every level ≥ delete. Returns a human label of what was done.
        """
        performed: list[str] = []
        if punishment not in VALID_PUNISHMENTS:
            punishment = "warn"

        if message is not None and punishment in ("delete", "timeout", "kick", "ban"):
            if await self.delete_message(message):
                performed.append("deleted message")

        if punishment == "warn":
            count = await self.warn(member, reason=reason, event_type=event_type)
            performed.append(f"warned (#{count})")
        elif punishment == "timeout":
            if await self.timeout(member, minutes=timeout_minutes,
                                  reason=reason, event_type=event_type):
                performed.append(f"timeout {timeout_minutes}m")
        elif punishment == "kick":
            if await self.kick(member, reason=reason, event_type=event_type):
                performed.append("kicked")
        elif punishment == "ban":
            if await self.ban(member, reason=reason, event_type=event_type):
                performed.append("banned")

        return ", ".join(performed) or "logged only"

    # ── raid lockdown ────────────────────────────────────────

    async def lockdown_guild(self, guild: discord.Guild, *, lock: bool) -> list[str]:
        """Toggle send_messages for @everyone in public text channels."""
        changed: list[str] = []
        for channel in guild.text_channels:
            try:
                overwrite = channel.overwrites_for(guild.default_role)
                if overwrite.send_messages is (False if lock else None):
                    continue
                overwrite.send_messages = False if lock else None
                await channel.set_permissions(
                    guild.default_role, overwrite=overwrite,
                    reason="[Forge Security] raid lockdown" if lock
                           else "[Forge Security] lockdown lifted",
                )
                changed.append(channel.name)
            except (discord.Forbidden, discord.HTTPException):
                continue
        return changed
