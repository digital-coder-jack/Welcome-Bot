"""
ProfileCollector — extracts every piece of member data the OFFICIAL
Discord Bot API exposes, and nothing more.

⚠ Discord API limitations (documented honestly, per project requirements):
  • Connected accounts (GitHub/Spotify/Steam/Twitch/...)  → NOT exposed to
    bots. Only OAuth2 user-authorised flows can read them. We never scrape.
  • About Me / bio, pronouns                              → NOT exposed to bots.
  • Mutual server count                                   → NOT exposed
    (a bot only sees guilds it is itself a member of).
  • Join source ("how did they find the server")          → NOT exposed;
    invite attribution via invite-usage diffing is the closest supported
    alternative (implemented in services/invites.py).
  • Presence/status/activities                            → requires the
    privileged PRESENCES intent; collected only when available, stored as
    "unknown" otherwise.
  • Banner / accent colour                                → only present on a
    full `fetch_user()` — fetched lazily for single joins, never in bulk.
"""
from __future__ import annotations

import json
from typing import Any

import discord

from bot.core.logging import get_logger

log = get_logger("intel.collector")

#: moderation-relevant permission names we snapshot
_KEY_PERMS = (
    "administrator", "manage_guild", "manage_roles", "manage_channels",
    "kick_members", "ban_members", "moderate_members", "manage_messages",
    "mention_everyone", "manage_webhooks", "view_audit_log",
)


def _badges(user: discord.User | discord.Member) -> list[str]:
    """Public badge names from the user's public flags."""
    try:
        return [name for name, value in user.public_flags if value]
    except Exception:  # noqa: BLE001
        return []


def _activities(member: discord.Member) -> tuple[list[str], str | None]:
    """Activity summaries + custom status text (presence intent required)."""
    acts: list[str] = []
    custom: str | None = None
    try:
        for a in member.activities or ():
            if isinstance(a, discord.CustomActivity):
                custom = str(a.name or "") or None
                acts.append(f"custom: {custom or '—'}")
            elif isinstance(a, discord.Spotify):
                acts.append(f"spotify: {a.title} — {a.artist}")
            else:
                kind = getattr(getattr(a, "type", None), "name", "activity")
                acts.append(f"{kind}: {getattr(a, 'name', '?')}")
    except Exception:  # noqa: BLE001
        pass
    return acts, custom


class ProfileCollector:
    """Builds user_profiles rows from live Discord objects."""

    def __init__(self, bot: discord.Client) -> None:
        self._bot = bot
        # user_id → (banner_url, accent_color) — avoids re-fetching users
        self._banner_cache: dict[int, tuple[str | None, int | None]] = {}

    # ─────────────────────────────────────────────────────────

    def snapshot(self, member: discord.Member) -> dict[str, Any]:
        """
        Fast, cache-only snapshot (no HTTP calls). Safe for bulk scanning
        thousands of members without touching rate limits.
        """
        roles = [
            {"id": r.id, "name": r.name}
            for r in member.roles if r.name != "@everyone"
        ]
        perms = member.guild_permissions
        key_perms = [p for p in _KEY_PERMS if getattr(perms, p, False)]
        acts, custom = _activities(member)

        status = "unknown"
        try:  # presence intent may be disabled — never assume
            raw = getattr(member, "raw_status", None)
            if raw:
                status = str(member.status)
        except Exception:  # noqa: BLE001
            pass

        data: dict[str, Any] = {
            "username": member.name,
            "display_name": member.display_name,
            "global_name": member.global_name,
            "nickname": member.nick,
            "is_bot": int(member.bot),
            "account_created_at": member.created_at.isoformat(),
            "joined_at": member.joined_at.isoformat() if member.joined_at else None,
            "roles_json": json.dumps(roles),
            "highest_role": member.top_role.name if member.top_role else None,
            "permissions_json": json.dumps(key_perms),
            "is_admin": int(perms.administrator),
            "avatar_url": member.display_avatar.url,
            "guild_avatar_url": member.guild_avatar.url if member.guild_avatar else None,
            "status": status,
            "activities_json": json.dumps(acts) if acts else None,
            "custom_status": custom,
            "public_flags_json": json.dumps(_badges(member)),
            "premium_since": member.premium_since.isoformat()
                             if member.premium_since else None,
            "is_booster": int(member.premium_since is not None),
            "timed_out_until": member.timed_out_until.isoformat()
                               if member.timed_out_until else None,
            "is_pending": int(getattr(member, "pending", False)),
        }
        cached = self._banner_cache.get(member.id)
        if cached:
            data["banner_url"], data["accent_color"] = cached
        return data

    async def snapshot_full(self, member: discord.Member) -> dict[str, Any]:
        """
        snapshot() + ONE `fetch_user()` HTTP call for banner / accent colour
        (the only public profile data that requires a full user fetch).
        Used for single joins — never for bulk scans.
        """
        data = self.snapshot(member)
        try:
            fetched = await self._bot.fetch_user(member.id)
            banner = fetched.banner.url if fetched.banner else None
            accent = fetched.accent_color.value if fetched.accent_color else None
            data["banner_url"] = banner
            data["accent_color"] = accent
            self._banner_cache[member.id] = (banner, accent)
        except (discord.HTTPException, discord.NotFound):
            log.debug("Could not fetch full user %s (banner skipped)", member.id)
        except Exception:  # noqa: BLE001
            log.exception("Unexpected error fetching user %s", member.id)
        return data

    def snapshot_user(self, user: discord.User) -> dict[str, Any]:
        """Minimal snapshot from a bare User (e.g. on_member_remove payloads)."""
        return {
            "username": user.name,
            "display_name": user.display_name,
            "global_name": user.global_name,
            "is_bot": int(user.bot),
            "account_created_at": user.created_at.isoformat(),
            "avatar_url": user.display_avatar.url,
            "public_flags_json": json.dumps(_badges(user)),
        }
