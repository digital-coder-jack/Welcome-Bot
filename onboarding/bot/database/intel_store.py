"""
IntelStore — data access layer for the v2.0 Member Intelligence module.

Owns user_profiles, profile_history, member_events, connected_accounts,
intel_scan_state, warning_settings and mod_actions. Cogs and services never
touch SQL directly. Batch helpers keep the first-run member scan fast even
on servers with thousands of members.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from bot.core.logging import get_logger

if TYPE_CHECKING:
    from bot.database.db import Database

log = get_logger("intel.store")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


#: fields tracked in profile_history when they change
TRACKED_FIELDS = (
    "username", "global_name", "nickname", "avatar_url", "banner_url",
    "roles_json", "highest_role", "status", "is_booster", "timed_out_until",
)

_PROFILE_COLUMNS = (
    "username", "display_name", "global_name", "nickname", "is_bot",
    "account_created_at", "joined_at", "roles_json", "highest_role",
    "permissions_json", "is_admin", "avatar_url", "guild_avatar_url",
    "banner_url", "accent_color", "status", "activities_json",
    "custom_status", "public_flags_json", "premium_since", "is_booster",
    "timed_out_until", "is_pending", "invite_code", "inviter_id",
)


class IntelStore:
    """All persistence for member intelligence and the 3-level warn system."""

    def __init__(self, db: "Database") -> None:
        self._db = db
        self._warn_settings_cache: dict[int, dict[str, Any]] = {}

    # ═════════════════════════════════════════════════════════
    # user profiles
    # ═════════════════════════════════════════════════════════

    async def get_profile(self, guild_id: int, user_id: int) -> dict[str, Any] | None:
        row = await self._db.fetchone(
            "SELECT * FROM user_profiles WHERE guild_id = ? AND user_id = ?",
            (guild_id, user_id),
        )
        return dict(row) if row else None

    async def upsert_profile(
        self,
        guild_id: int,
        user_id: int,
        data: dict[str, Any],
        *,
        track_changes: bool = True,
    ) -> list[dict[str, str]]:
        """
        Insert or update a profile snapshot.

        Returns the list of detected changes ({field, old, new}) so callers
        can build change reports (Telegram / audit). Change tracking is
        skipped for brand-new rows and when track_changes=False (bulk scan).
        """
        existing = await self.get_profile(guild_id, user_id)
        now = _now()
        changes: list[dict[str, str]] = []

        if existing and track_changes:
            for field in TRACKED_FIELDS:
                if field not in data:
                    continue
                old, new = existing.get(field), data.get(field)
                if old != new and not (old is None and new is None):
                    changes.append({
                        "field": field,
                        "old": str(old) if old is not None else "—",
                        "new": str(new) if new is not None else "—",
                    })

        cols = [c for c in _PROFILE_COLUMNS if c in data]
        if existing is None:
            all_cols = ["guild_id", "user_id", *cols,
                        "collected_at", "updated_at", "last_seen"]
            placeholders = ", ".join("?" for _ in all_cols)
            values = [guild_id, user_id, *(data[c] for c in cols), now, now, now]
            await self._db.execute(
                f"INSERT INTO user_profiles ({', '.join(all_cols)}) "
                f"VALUES ({placeholders})",
                tuple(values),
            )
        else:
            sets = ", ".join(f"{c} = ?" for c in cols)
            await self._db.execute(
                f"UPDATE user_profiles SET {sets}, updated_at = ?, last_seen = ? "
                f"WHERE guild_id = ? AND user_id = ?",
                (*(data[c] for c in cols), now, now, guild_id, user_id),
            )

        if changes:
            for ch in changes:
                await self.add_history(
                    guild_id, user_id, ch["field"], ch["old"], ch["new"])
        return changes

    async def set_profile_fields(
        self, guild_id: int, user_id: int, **fields: Any
    ) -> None:
        """Update arbitrary bookkeeping columns (counters, flags, notes)."""
        allowed = {
            "join_count", "leave_count", "rejoin_count", "imported",
            "welcome_sent", "in_guild", "security_notes", "telegram_log_id",
            "last_seen", "invite_code", "inviter_id",
        }
        cols = [k for k in fields if k in allowed]
        if not cols:
            return
        sets = ", ".join(f"{c} = ?" for c in cols)
        await self._db.execute(
            f"UPDATE user_profiles SET {sets}, updated_at = ? "
            f"WHERE guild_id = ? AND user_id = ?",
            (*(fields[c] for c in cols), _now(), guild_id, user_id),
        )

    async def bump_counter(
        self, guild_id: int, user_id: int, counter: str, by: int = 1
    ) -> None:
        if counter not in ("join_count", "leave_count", "rejoin_count"):
            raise ValueError(f"Unknown counter: {counter}")
        await self._db.execute(
            f"UPDATE user_profiles SET {counter} = {counter} + ?, "
            f"updated_at = ?, last_seen = ? WHERE guild_id = ? AND user_id = ?",
            (by, _now(), _now(), guild_id, user_id),
        )

    async def touch_last_seen(self, guild_id: int, user_id: int) -> None:
        await self._db.execute(
            "UPDATE user_profiles SET last_seen = ? "
            "WHERE guild_id = ? AND user_id = ?",
            (_now(), guild_id, user_id),
        )

    async def profile_count(self, guild_id: int) -> int:
        row = await self._db.fetchone(
            "SELECT COUNT(*) AS n FROM user_profiles WHERE guild_id = ?",
            (guild_id,),
        )
        return int(row["n"]) if row else 0

    # ── batch upsert used by the first-run scan ──────────────

    async def bulk_import_profiles(
        self, guild_id: int, profiles: list[tuple[int, dict[str, Any]]]
    ) -> int:
        """
        Insert-or-replace a batch of (user_id, data) rows in ONE transaction.
        Existing rows keep their counters / notes / import flags. Designed for
        the existing-members scan: fast, no per-row history writes.
        """
        if not profiles:
            return 0
        now = _now()
        conn = self._db.conn
        imported = 0
        for user_id, data in profiles:
            cols = [c for c in _PROFILE_COLUMNS if c in data]
            col_sql = ", ".join(cols)
            placeholders = ", ".join("?" for _ in cols)
            update_sql = ", ".join(f"{c} = excluded.{c}" for c in cols)
            await conn.execute(
                f"""
                INSERT INTO user_profiles
                    (guild_id, user_id, {col_sql}, imported, welcome_sent,
                     in_guild, collected_at, updated_at, last_seen)
                VALUES (?, ?, {placeholders}, 1, 0, 1, ?, ?, ?)
                ON CONFLICT (guild_id, user_id) DO UPDATE SET
                    {update_sql}, in_guild = 1, updated_at = excluded.updated_at,
                    last_seen = excluded.last_seen
                """,
                (guild_id, user_id, *(data[c] for c in cols), now, now, now),
            )
            imported += 1
        await conn.commit()
        return imported

    # ═════════════════════════════════════════════════════════
    # history & lifecycle events
    # ═════════════════════════════════════════════════════════

    async def add_history(
        self, guild_id: int, user_id: int,
        field: str, old_value: str | None, new_value: str | None,
    ) -> None:
        await self._db.execute(
            """
            INSERT INTO profile_history
                (guild_id, user_id, field, old_value, new_value, changed_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (guild_id, user_id, field,
             (old_value or "")[:1000] or None,
             (new_value or "")[:1000] or None, _now()),
        )

    async def get_history(
        self, guild_id: int, user_id: int,
        *, field: str | None = None, limit: int = 25,
    ) -> list[dict[str, Any]]:
        if field:
            rows = await self._db.fetchall(
                "SELECT * FROM profile_history WHERE guild_id = ? AND user_id = ? "
                "AND field = ? ORDER BY id DESC LIMIT ?",
                (guild_id, user_id, field, limit))
        else:
            rows = await self._db.fetchall(
                "SELECT * FROM profile_history WHERE guild_id = ? AND user_id = ? "
                "ORDER BY id DESC LIMIT ?", (guild_id, user_id, limit))
        return [dict(r) for r in rows]

    async def add_member_event(
        self, guild_id: int, user_id: int, username: str | None,
        event_type: str, detail: str | None = None,
    ) -> None:
        await self._db.execute(
            """
            INSERT INTO member_events
                (guild_id, user_id, username, event_type, detail, occurred_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (guild_id, user_id, username, event_type,
             (detail or "")[:800] or None, _now()),
        )

    async def event_count(
        self, guild_id: int, user_id: int, event_type: str
    ) -> int:
        row = await self._db.fetchone(
            "SELECT COUNT(*) AS n FROM member_events "
            "WHERE guild_id = ? AND user_id = ? AND event_type = ?",
            (guild_id, user_id, event_type),
        )
        return int(row["n"]) if row else 0

    # ═════════════════════════════════════════════════════════
    # connected accounts (official API data only — currently none)
    # ═════════════════════════════════════════════════════════

    async def save_connected_account(
        self, guild_id: int, user_id: int,
        provider: str, account_name: str | None, account_url: str | None,
    ) -> None:
        await self._db.execute(
            """
            INSERT INTO connected_accounts
                (guild_id, user_id, provider, account_name, account_url,
                 source, collected_at)
            VALUES (?, ?, ?, ?, ?, 'official_api', ?)
            ON CONFLICT (guild_id, user_id, provider) DO UPDATE SET
                account_name = excluded.account_name,
                account_url = excluded.account_url,
                collected_at = excluded.collected_at
            """,
            (guild_id, user_id, provider, account_name, account_url, _now()),
        )

    # ═════════════════════════════════════════════════════════
    # first-run scan bookkeeping
    # ═════════════════════════════════════════════════════════

    async def scan_state(self, guild_id: int) -> dict[str, Any]:
        row = await self._db.fetchone(
            "SELECT * FROM intel_scan_state WHERE guild_id = ?", (guild_id,))
        return dict(row) if row else {"guild_id": guild_id, "scanned": 0}

    async def mark_scan_started(self, guild_id: int) -> None:
        await self._db.execute(
            """
            INSERT INTO intel_scan_state (guild_id, scanned, started_at)
            VALUES (?, 0, ?)
            ON CONFLICT (guild_id) DO UPDATE SET started_at = excluded.started_at
            """,
            (guild_id, _now()),
        )

    async def mark_scan_finished(self, guild_id: int, member_count: int) -> None:
        await self._db.execute(
            """
            INSERT INTO intel_scan_state
                (guild_id, scanned, member_count, finished_at)
            VALUES (?, 1, ?, ?)
            ON CONFLICT (guild_id) DO UPDATE SET
                scanned = 1, member_count = excluded.member_count,
                finished_at = excluded.finished_at
            """,
            (guild_id, member_count, _now()),
        )

    # ═════════════════════════════════════════════════════════
    # 3-level warning system
    # ═════════════════════════════════════════════════════════

    async def get_warning_settings(self, guild_id: int) -> dict[str, Any]:
        cached = self._warn_settings_cache.get(guild_id)
        if cached is not None:
            return cached
        row = await self._db.fetchone(
            "SELECT * FROM warning_settings WHERE guild_id = ?", (guild_id,))
        if row is None:
            await self._db.execute(
                "INSERT OR IGNORE INTO warning_settings (guild_id) VALUES (?)",
                (guild_id,))
            row = await self._db.fetchone(
                "SELECT * FROM warning_settings WHERE guild_id = ?", (guild_id,))
        settings = dict(row) if row else {"guild_id": guild_id,
                                          "level3_action": "kick",
                                          "dm_on_warn": 1,
                                          "reset_after_action": 1}
        self._warn_settings_cache[guild_id] = settings
        return settings

    async def update_warning_setting(
        self, guild_id: int, key: str, value: Any
    ) -> None:
        allowed = {"level3_action", "dm_on_warn", "reset_after_action",
                   "level1_message", "level2_message", "level3_message"}
        if key not in allowed:
            raise ValueError(f"Unknown warning setting: {key}")
        await self.get_warning_settings(guild_id)  # ensure row exists
        await self._db.execute(
            f"UPDATE warning_settings SET {key} = ?, updated_at = ? "
            f"WHERE guild_id = ?",
            (value, _now(), guild_id),
        )
        self._warn_settings_cache.pop(guild_id, None)

    async def add_mod_action(
        self, *, guild_id: int, user_id: int, username: str | None,
        action: str, level: int | None, reason: str | None,
        moderator_id: int | None, moderator_tag: str | None,
        dm_delivered: bool | None,
        history: list[dict[str, Any]] | None = None,
    ) -> int:
        await self._db.conn.execute(
            """
            INSERT INTO mod_actions
                (guild_id, user_id, username, action, level, reason,
                 moderator_id, moderator_tag, dm_delivered, history_json,
                 created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (guild_id, user_id, username, action, level,
             (reason or "")[:500] or None, moderator_id, moderator_tag,
             None if dm_delivered is None else int(dm_delivered),
             json.dumps(history) if history else None, _now()),
        )
        await self._db.conn.commit()
        row = await self._db.fetchone("SELECT last_insert_rowid() AS id")
        return int(row["id"]) if row else 0

    async def get_mod_actions(
        self, guild_id: int, user_id: int, limit: int = 20
    ) -> list[dict[str, Any]]:
        rows = await self._db.fetchall(
            "SELECT * FROM mod_actions WHERE guild_id = ? AND user_id = ? "
            "ORDER BY id DESC LIMIT ?", (guild_id, user_id, limit))
        return [dict(r) for r in rows]
