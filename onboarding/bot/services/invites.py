"""
Invite tracking service.

Keeps an in-memory snapshot of every guild's invite uses and diffs it on
member join to attribute which invite (and inviter) was used. Handles
races and missing-permission cases gracefully.
"""
from __future__ import annotations

from dataclasses import dataclass

import discord

from bot.core.logging import get_logger

log = get_logger("invites")


@dataclass(frozen=True)
class InviteHit:
    code: str
    inviter_id: int | None
    inviter_name: str | None
    uses: int | None


class InviteTracker:
    """Per-guild invite-use cache with join attribution."""

    def __init__(self) -> None:
        # {guild_id: {invite_code: uses}}
        self._cache: dict[int, dict[str, int]] = {}
        # {guild_id: {invite_code: (inviter_id, inviter_name)}}
        self._inviters: dict[int, dict[str, tuple[int | None, str | None]]] = {}

    async def cache_guild(self, guild: discord.Guild) -> None:
        """Snapshot all invites for a guild (call on ready / invite events)."""
        try:
            invites = await guild.invites()
        except discord.Forbidden:
            log.warning("Missing 'Manage Server' permission to read invites in %s", guild.name)
            return
        except discord.HTTPException as exc:
            log.warning("Failed to fetch invites for %s: %s", guild.name, exc)
            return

        self._cache[guild.id] = {inv.code: inv.uses or 0 for inv in invites}
        self._inviters[guild.id] = {
            inv.code: (inv.inviter.id if inv.inviter else None,
                       str(inv.inviter) if inv.inviter else None)
            for inv in invites
        }
        log.debug("Cached %d invites for guild %s", len(invites), guild.id)

    def add_invite(self, invite: discord.Invite) -> None:
        if invite.guild is None:
            return
        gid = invite.guild.id
        self._cache.setdefault(gid, {})[invite.code] = invite.uses or 0
        self._inviters.setdefault(gid, {})[invite.code] = (
            invite.inviter.id if invite.inviter else None,
            str(invite.inviter) if invite.inviter else None,
        )

    def remove_invite(self, invite: discord.Invite) -> None:
        if invite.guild is None:
            return
        self._cache.get(invite.guild.id, {}).pop(invite.code, None)
        self._inviters.get(invite.guild.id, {}).pop(invite.code, None)

    async def resolve_join(self, guild: discord.Guild) -> InviteHit | None:
        """
        Diff current invite uses against the snapshot to find which invite
        was consumed. Returns None if it cannot be determined.
        """
        old = self._cache.get(guild.id, {})
        try:
            invites = await guild.invites()
        except (discord.Forbidden, discord.HTTPException):
            return None

        hit: InviteHit | None = None
        for inv in invites:
            previous = old.get(inv.code, 0)
            if (inv.uses or 0) > previous:
                hit = InviteHit(
                    code=inv.code,
                    inviter_id=inv.inviter.id if inv.inviter else None,
                    inviter_name=str(inv.inviter) if inv.inviter else None,
                    uses=inv.uses,
                )
                break

        # A vanity URL or expired one-use invite may leave no diff; also check
        # for invites that disappeared (max-uses reached).
        if hit is None:
            current_codes = {inv.code for inv in invites}
            for code in old:
                if code not in current_codes:
                    inviter_id, inviter_name = self._inviters.get(guild.id, {}).get(
                        code, (None, None)
                    )
                    hit = InviteHit(code=code, inviter_id=inviter_id,
                                    inviter_name=inviter_name, uses=None)
                    break

        # Refresh snapshot for the next join
        self._cache[guild.id] = {inv.code: inv.uses or 0 for inv in invites}
        self._inviters[guild.id] = {
            inv.code: (inv.inviter.id if inv.inviter else None,
                       str(inv.inviter) if inv.inviter else None)
            for inv in invites
        }
        return hit
