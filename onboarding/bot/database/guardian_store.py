"""
GuardianStore — data access layer for the Forge Guardian final update.

Owns guardian_settings (language, alert channel, security-team role),
mod_reviews (the moderator-approval queue) and modlog_entries. The
UNIQUE partial index on pending reviews plus the atomic claim() UPDATE
guarantee that:

  • a member never gets two open security alerts (no duplicates), and
  • two moderators can never execute the same action simultaneously.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

import aiosqlite

from bot.core.logging import get_logger

if TYPE_CHECKING:
    from bot.database.db import Database

log = get_logger("guardian.store")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


GUARDIAN_SETTING_COLUMNS = {
    "language", "security_alerts_channel_id", "modlog_channel_id",
    "security_team_role_id", "notify_owner", "enable_modlog",
}


class GuardianStore:
    """Persistence for Guardian settings, moderation reviews and mod logs."""

    def __init__(self, db: "Database") -> None:
        self._db = db
        self._settings_cache: dict[int, dict[str, Any]] = {}

    # ═════════════════════════════════════════════════════════
    # settings
    # ═════════════════════════════════════════════════════════

    async def get_settings(self, guild_id: int) -> dict[str, Any]:
        cached = self._settings_cache.get(guild_id)
        if cached is not None:
            return cached
        row = await self._db.fetchone(
            "SELECT * FROM guardian_settings WHERE guild_id = ?", (guild_id,))
        if row is None:
            await self._db.execute(
                "INSERT OR IGNORE INTO guardian_settings (guild_id) VALUES (?)",
                (guild_id,))
            row = await self._db.fetchone(
                "SELECT * FROM guardian_settings WHERE guild_id = ?", (guild_id,))
        settings = dict(row) if row else {"guild_id": guild_id, "language": "en"}
        self._settings_cache[guild_id] = settings
        return settings

    async def update_setting(self, guild_id: int, key: str, value: Any) -> None:
        if key not in GUARDIAN_SETTING_COLUMNS:
            raise ValueError(f"Unknown guardian setting: {key}")
        await self.get_settings(guild_id)  # ensure row exists
        await self._db.execute(
            f"UPDATE guardian_settings SET {key} = ?, updated_at = ? "
            f"WHERE guild_id = ?",
            (value, _now(), guild_id))
        self._settings_cache.pop(guild_id, None)

    async def language(self, guild_id: int) -> str:
        return (await self.get_settings(guild_id)).get("language") or "en"

    # ═════════════════════════════════════════════════════════
    # moderation reviews (approval queue)
    # ═════════════════════════════════════════════════════════

    async def create_review(
        self, *, guild_id: int, user_id: int, username: str,
        source: str, violation: str, recommended_action: str,
        confidence: str, risk_score: int | None,
        evidence: list[str], history: list[dict],
        timeline: list[dict] | None = None,
        account_created_at: str | None = None, joined_at: str | None = None,
        roles_text: str | None = None, warning_count: int = 0,
    ) -> int | None:
        """
        Create a pending review. Returns the review id, or None if a
        pending/processing review already exists for this member
        (duplicate-alert prevention via the UNIQUE partial index).
        """
        try:
            await self._db.conn.execute(
                """
                INSERT INTO mod_reviews
                    (guild_id, user_id, username, source, violation,
                     recommended_action, confidence, risk_score,
                     evidence_json, history_json, timeline_json,
                     account_created_at, joined_at, roles_text,
                     warning_count, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
                """,
                (guild_id, user_id, username, source, violation[:500],
                 recommended_action, confidence, risk_score,
                 json.dumps(evidence[:20]), json.dumps(history[:25]),
                 json.dumps(timeline[:25]) if timeline else None,
                 account_created_at, joined_at, (roles_text or "")[:800] or None,
                 warning_count, _now()),
            )
            await self._db.conn.commit()
            row = await self._db.fetchone("SELECT last_insert_rowid() AS id")
            return int(row["id"]) if row else None
        except aiosqlite.IntegrityError:
            log.info("Duplicate review suppressed for user %s in guild %s",
                     user_id, guild_id)
            return None

    async def get_review(self, review_id: int) -> dict[str, Any] | None:
        row = await self._db.fetchone(
            "SELECT * FROM mod_reviews WHERE id = ?", (review_id,))
        return self._parse(row)

    async def get_review_by_message(self, message_id: int) -> dict[str, Any] | None:
        row = await self._db.fetchone(
            "SELECT * FROM mod_reviews WHERE alert_message_id = ?", (message_id,))
        return self._parse(row)

    async def set_alert_message(
        self, review_id: int, channel_id: int, message_id: int,
    ) -> None:
        await self._db.execute(
            "UPDATE mod_reviews SET alert_channel_id = ?, alert_message_id = ? "
            "WHERE id = ?", (channel_id, message_id, review_id))

    async def claim(self, review_id: int, moderator_id: int) -> bool:
        """
        Atomically claim a pending review for processing. Only ONE moderator
        can win this — the WHERE status='pending' guard makes the race safe.
        Returns True if this call acquired the claim.
        """
        cur = await self._db.conn.execute(
            "UPDATE mod_reviews SET status = 'processing', claimed_by = ? "
            "WHERE id = ? AND status = 'pending'",
            (moderator_id, review_id))
        await self._db.conn.commit()
        return cur.rowcount == 1

    async def release(self, review_id: int) -> None:
        """Return a claimed review to pending (action failed / cancelled)."""
        await self._db.execute(
            "UPDATE mod_reviews SET status = 'pending', claimed_by = NULL "
            "WHERE id = ? AND status = 'processing'", (review_id,))

    async def resolve(
        self, review_id: int, *, moderator_id: int, action: str,
    ) -> None:
        status = f"approved_{action}" if action != "dismiss" else "dismissed"
        await self._db.execute(
            "UPDATE mod_reviews SET status = ?, resolved_by = ?, "
            "resolved_action = ?, resolved_at = ? WHERE id = ?",
            (status, moderator_id, action, _now(), review_id))

    async def pending_reviews(self, guild_id: int, limit: int = 10) -> list[dict]:
        rows = await self._db.fetchall(
            "SELECT * FROM mod_reviews WHERE guild_id = ? "
            "AND status IN ('pending', 'processing') "
            "ORDER BY id DESC LIMIT ?", (guild_id, limit))
        return [self._parse(r) for r in rows if r]

    async def has_pending(self, guild_id: int, user_id: int) -> bool:
        row = await self._db.fetchone(
            "SELECT 1 FROM mod_reviews WHERE guild_id = ? AND user_id = ? "
            "AND status IN ('pending', 'processing')", (guild_id, user_id))
        return row is not None

    @staticmethod
    def _parse(row) -> dict[str, Any] | None:
        if row is None:
            return None
        d = dict(row)
        for key in ("evidence_json", "history_json", "timeline_json"):
            raw = d.get(key)
            try:
                d[key.removesuffix("_json")] = json.loads(raw) if raw else []
            except (TypeError, ValueError):
                d[key.removesuffix("_json")] = []
        return d

    # ═════════════════════════════════════════════════════════
    # moderation log entries
    # ═════════════════════════════════════════════════════════

    async def add_modlog(
        self, *, guild_id: int, action: str, user_id: int | None,
        username: str | None, moderator_id: int | None = None,
        reason: str | None = None, channel_id: int | None = None,
        evidence: str | None = None,
    ) -> None:
        await self._db.execute(
            """
            INSERT INTO modlog_entries
                (guild_id, action, user_id, username, moderator_id, reason,
                 channel_id, evidence, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (guild_id, action, user_id, username, moderator_id,
             (reason or "")[:500] or None, channel_id,
             (evidence or "")[:1000] or None, _now()))

    async def modlog_counts(self, guild_id: int, since_iso: str) -> dict[str, int]:
        rows = await self._db.fetchall(
            "SELECT action, COUNT(*) AS n FROM modlog_entries "
            "WHERE guild_id = ? AND created_at >= ? GROUP BY action",
            (guild_id, since_iso))
        return {r["action"]: r["n"] for r in rows}

    # ═════════════════════════════════════════════════════════
    # analytics helpers
    # ═════════════════════════════════════════════════════════

    async def join_counts(self, guild_id: int) -> dict[str, int]:
        """Daily / weekly / monthly join counts from join_history."""
        out: dict[str, int] = {}
        for label, days in (("daily", 1), ("weekly", 7), ("monthly", 30)):
            row = await self._db.fetchone(
                "SELECT COUNT(*) AS n FROM join_history WHERE guild_id = ? "
                f"AND joined_at >= datetime('now', '-{days} days')",
                (guild_id,))
            out[label] = int(row["n"]) if row else 0
        return out

    async def retention(self, guild_id: int) -> tuple[int, int]:
        """(joined last 30d, of those still present) — needs members table."""
        row = await self._db.fetchone(
            "SELECT COUNT(*) AS n FROM join_history WHERE guild_id = ? "
            "AND joined_at >= datetime('now', '-30 days')", (guild_id,))
        joined = int(row["n"]) if row else 0
        row = await self._db.fetchone(
            "SELECT COUNT(DISTINCT j.user_id) AS n FROM join_history j "
            "WHERE j.guild_id = ? AND j.joined_at >= datetime('now', '-30 days') "
            "AND NOT EXISTS (SELECT 1 FROM modlog_entries m WHERE "
            "m.guild_id = j.guild_id AND m.user_id = j.user_id "
            "AND m.action IN ('leave', 'kick', 'ban') "
            "AND m.created_at >= j.joined_at)", (guild_id,))
        stayed = int(row["n"]) if row else 0
        return joined, stayed
