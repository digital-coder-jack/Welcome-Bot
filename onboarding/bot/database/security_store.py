"""
SecurityStore — data access layer for the Security & Protection module.

Wraps the shared Database with every security-domain query so cogs and
services never touch SQL. Settings are cached per guild with TTL-less
invalidation on write (single-process bot ⇒ always coherent).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from bot.core.logging import get_logger

if TYPE_CHECKING:
    from bot.database.db import Database

log = get_logger("security.store")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


#: columns editable through the dashboard, with type coercion hints
SETTING_COLUMNS: dict[str, type] = {
    # toggles
    "enable_security": int, "enable_ai_moderation": int, "enable_spam_filter": int,
    "enable_scam_detection": int, "enable_raid_detection": int,
    "enable_invite_protection": int, "enable_badword_filter": int,
    "enable_mention_filter": int, "enable_duplicate_filter": int,
    "enable_username_check": int, "enable_telegram_alerts": int,
    # thresholds
    "raid_join_threshold": int, "raid_window_seconds": int, "raid_min_risk": int,
    "raid_auto_lockdown": int, "spam_message_limit": int, "spam_window_seconds": int,
    "duplicate_limit": int, "mention_user_limit": int, "mention_role_limit": int,
    "emoji_limit": int, "caps_ratio": float, "caps_min_length": int,
    "timeout_minutes": int, "high_risk_score": int, "medium_risk_score": int,
    "ai_min_confidence": float,
    # punishments
    "punish_spam": str, "punish_scam": str, "punish_mention": str,
    "punish_invite": str, "punish_badword": str, "punish_duplicate": str,
    "punish_ai": str,
    # JSON lists
    "whitelist_domains_json": str, "whitelist_invites_json": str,
    "bad_words_json": str, "allowed_roles_json": str, "ignored_channels_json": str,
    "ignored_roles_json": str, "ignored_users_json": str,
    # runtime
    "raid_mode_active": int, "raid_mode_since": str,
}

_JSON_LIST_KEYS = (
    "whitelist_domains_json", "whitelist_invites_json", "bad_words_json",
    "allowed_roles_json", "ignored_channels_json", "ignored_roles_json",
    "ignored_users_json",
)


class SecurityStore:
    """All persistence for security events, settings and histories."""

    def __init__(self, db: "Database") -> None:
        self._db = db
        self._settings_cache: dict[int, dict[str, Any]] = {}

    # ── settings (dashboard) ─────────────────────────────────

    async def get_settings(self, guild_id: int) -> dict[str, Any]:
        """Return guild security settings (cached, JSON lists parsed)."""
        cached = self._settings_cache.get(guild_id)
        if cached is not None:
            return cached

        row = await self._db.fetchone(
            "SELECT * FROM security_settings WHERE guild_id = ?", (guild_id,)
        )
        if row is None:
            await self._db.execute(
                "INSERT OR IGNORE INTO security_settings (guild_id) VALUES (?)",
                (guild_id,),
            )
            row = await self._db.fetchone(
                "SELECT * FROM security_settings WHERE guild_id = ?", (guild_id,)
            )
        settings = dict(row) if row else {"guild_id": guild_id}

        for key in _JSON_LIST_KEYS:
            raw = settings.get(key)
            try:
                settings[key.removesuffix("_json")] = json.loads(raw) if raw else []
            except (TypeError, ValueError):
                settings[key.removesuffix("_json")] = []

        self._settings_cache[guild_id] = settings
        return settings

    async def update_setting(self, guild_id: int, key: str, value: Any) -> None:
        if key not in SETTING_COLUMNS:
            raise ValueError(f"Unknown security setting: {key}")
        await self.get_settings(guild_id)  # ensure row exists
        await self._db.execute(
            f"UPDATE security_settings SET {key} = ?, updated_at = ? WHERE guild_id = ?",
            (value, _now(), guild_id),
        )
        self._settings_cache.pop(guild_id, None)

    async def update_json_list(self, guild_id: int, key: str, items: list) -> None:
        """Persist one of the *_json list settings."""
        if key not in _JSON_LIST_KEYS:
            raise ValueError(f"Not a JSON list setting: {key}")
        await self.update_setting(guild_id, key, json.dumps(items))

    def invalidate(self, guild_id: int) -> None:
        self._settings_cache.pop(guild_id, None)

    # ── unified event log ────────────────────────────────────

    async def log_event(
        self,
        *,
        guild_id: int,
        event_type: str,
        user_id: int | None = None,
        username: str | None = None,
        channel_id: int | None = None,
        message_id: int | None = None,
        risk_score: int | None = None,
        evidence: str | None = None,
        action_taken: str | None = None,
        moderator_id: int | None = None,
        telegram_status: str | None = None,
    ) -> int:
        """Insert a security event; returns the new row id."""
        await self._db.conn.execute(
            """
            INSERT INTO security_events
                (guild_id, user_id, username, event_type, channel_id, message_id,
                 risk_score, evidence, action_taken, moderator_id, telegram_status,
                 created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (guild_id, user_id, username, event_type, channel_id, message_id,
             risk_score, (evidence or "")[:1500] or None, action_taken,
             moderator_id, telegram_status, _now()),
        )
        await self._db.conn.commit()
        row = await self._db.fetchone("SELECT last_insert_rowid() AS id")
        return int(row["id"]) if row else 0

    async def set_event_telegram_status(self, event_id: int, status: str) -> None:
        await self._db.execute(
            "UPDATE security_events SET telegram_status = ? WHERE id = ?",
            (status, event_id),
        )

    async def recent_events(
        self, guild_id: int, *, event_type: str | None = None, limit: int = 10
    ) -> list[dict[str, Any]]:
        if event_type:
            rows = await self._db.fetchall(
                "SELECT * FROM security_events WHERE guild_id = ? AND event_type = ? "
                "ORDER BY id DESC LIMIT ?", (guild_id, event_type, limit))
        else:
            rows = await self._db.fetchall(
                "SELECT * FROM security_events WHERE guild_id = ? "
                "ORDER BY id DESC LIMIT ?", (guild_id, limit))
        return [dict(r) for r in rows]

    async def event_counts(self, guild_id: int, since_iso: str) -> dict[str, int]:
        rows = await self._db.fetchall(
            "SELECT event_type, COUNT(*) AS n FROM security_events "
            "WHERE guild_id = ? AND created_at >= ? GROUP BY event_type",
            (guild_id, since_iso),
        )
        return {r["event_type"]: r["n"] for r in rows}

    # ── warnings ─────────────────────────────────────────────

    async def add_warning(
        self, *, guild_id: int, user_id: int, username: str | None,
        reason: str, event_type: str | None = None, moderator_id: int | None = None,
    ) -> int:
        await self._db.execute(
            """
            INSERT INTO warnings (guild_id, user_id, username, reason, event_type,
                                  moderator_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (guild_id, user_id, username, reason[:500], event_type,
             moderator_id, _now()),
        )
        row = await self._db.fetchone(
            "SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ? AND user_id = ?",
            (guild_id, user_id),
        )
        return int(row["n"]) if row else 1

    async def warning_count(self, guild_id: int, user_id: int) -> int:
        row = await self._db.fetchone(
            "SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ? AND user_id = ?",
            (guild_id, user_id),
        )
        return int(row["n"]) if row else 0

    # ── punishments ──────────────────────────────────────────

    async def add_punishment(
        self, *, guild_id: int, user_id: int, username: str | None,
        punishment: str, reason: str | None, duration_secs: int | None = None,
        event_type: str | None = None, moderator_id: int | None = None,
        success: bool = True, error: str | None = None,
    ) -> None:
        await self._db.execute(
            """
            INSERT INTO punishments
                (guild_id, user_id, username, punishment, reason, duration_secs,
                 event_type, moderator_id, success, error, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (guild_id, user_id, username, punishment, (reason or "")[:500] or None,
             duration_secs, event_type, moderator_id, int(success), error, _now()),
        )

    # ── raids ────────────────────────────────────────────────

    async def open_raid(
        self, *, guild_id: int, join_count: int, avg_risk: int,
        user_ids: list[int], actions: list[str],
    ) -> int:
        await self._db.conn.execute(
            """
            INSERT INTO raid_history
                (guild_id, started_at, join_count, avg_risk, user_ids_json,
                 actions_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (guild_id, _now(), join_count, avg_risk,
             json.dumps(user_ids), json.dumps(actions), _now()),
        )
        await self._db.conn.commit()
        row = await self._db.fetchone("SELECT last_insert_rowid() AS id")
        return int(row["id"]) if row else 0

    async def update_raid(
        self, raid_id: int, *, join_count: int, avg_risk: int,
        user_ids: list[int],
    ) -> None:
        await self._db.execute(
            "UPDATE raid_history SET join_count = ?, avg_risk = ?, user_ids_json = ? "
            "WHERE id = ?",
            (join_count, avg_risk, json.dumps(user_ids), raid_id),
        )

    async def close_raid(self, raid_id: int) -> None:
        await self._db.execute(
            "UPDATE raid_history SET ended_at = ? WHERE id = ?", (_now(), raid_id)
        )

    # ── risk scores ──────────────────────────────────────────

    async def add_risk_score(
        self, *, guild_id: int, user_id: int, username: str,
        risk_score: int, risk_level: str, factors: dict[str, Any],
        account_age_days: float, during_raid: bool,
    ) -> None:
        await self._db.execute(
            """
            INSERT INTO risk_scores
                (guild_id, user_id, username, risk_score, risk_level, factors_json,
                 account_age_days, during_raid, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (guild_id, user_id, username, risk_score, risk_level,
             json.dumps(factors), account_age_days, int(during_raid), _now()),
        )

    async def previous_join_count(self, guild_id: int, user_id: int) -> int:
        row = await self._db.fetchone(
            "SELECT COUNT(*) AS n FROM join_history WHERE guild_id = ? AND user_id = ?",
            (guild_id, user_id),
        )
        return int(row["n"]) if row else 0

    # ── AI moderation results ────────────────────────────────

    async def add_ai_result(
        self, *, guild_id: int, user_id: int | None, channel_id: int | None,
        message_id: int | None, content: str, violation: bool,
        confidence: float | None, category: str | None, reason: str | None,
        action: str | None,
    ) -> None:
        await self._db.execute(
            """
            INSERT INTO ai_moderation_results
                (guild_id, user_id, channel_id, message_id, content, violation,
                 confidence, category, reason, action, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (guild_id, user_id, channel_id, message_id, content[:1000],
             int(violation), confidence, category, reason, action, _now()),
        )
