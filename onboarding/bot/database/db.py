"""
Async database abstraction layer (aiosqlite).

Every query lives here — cogs and services never touch SQL directly.
Swapping to Postgres later only requires re-implementing this module.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiosqlite

from bot.core.logging import get_logger

log = get_logger("database")

# All schema*.sql files in this package are applied on connect (additive).
_SCHEMA_DIR = Path(__file__).parent


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Database:
    """Thin async wrapper around aiosqlite with domain-level methods."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._conn: aiosqlite.Connection | None = None

    # ── lifecycle ────────────────────────────────────────────

    async def connect(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = await aiosqlite.connect(self._path)
        self._conn.row_factory = aiosqlite.Row
        for schema in sorted(_SCHEMA_DIR.glob("schema*.sql")):
            await self._conn.executescript(schema.read_text(encoding="utf-8"))
            log.debug("Applied schema: %s", schema.name)
        await self._conn.commit()
        log.info("Database ready at %s", self._path)

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()
            self._conn = None
            log.info("Database connection closed")

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("Database not connected — call connect() first")
        return self._conn

    async def _execute(self, sql: str, params: tuple = ()) -> None:
        await self.conn.execute(sql, params)
        await self.conn.commit()

    async def _fetchone(self, sql: str, params: tuple = ()) -> aiosqlite.Row | None:
        async with self.conn.execute(sql, params) as cur:
            return await cur.fetchone()

    async def _fetchall(self, sql: str, params: tuple = ()) -> list[aiosqlite.Row]:
        async with self.conn.execute(sql, params) as cur:
            return list(await cur.fetchall())

    # public escape hatches for domain stores (e.g. SecurityStore)
    execute = _execute
    fetchone = _fetchone
    fetchall = _fetchall

    # ── guild settings (dashboard) ───────────────────────────

    async def get_guild_settings(self, guild_id: int) -> dict[str, Any]:
        row = await self._fetchone(
            "SELECT * FROM guild_settings WHERE guild_id = ?", (guild_id,)
        )
        if row is None:
            await self._execute(
                "INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)", (guild_id,)
            )
            row = await self._fetchone(
                "SELECT * FROM guild_settings WHERE guild_id = ?", (guild_id,)
            )
        settings = dict(row) if row else {"guild_id": guild_id}
        raw_labels = settings.get("button_labels_json")
        settings["button_labels"] = json.loads(raw_labels) if raw_labels else {}
        return settings

    async def update_guild_setting(self, guild_id: int, key: str, value: Any) -> None:
        allowed = {
            "enable_welcome", "enable_welcome_image", "enable_welcome_dm",
            "enable_telegram", "enable_invite_tracking", "enable_activity_unlock",
            "enable_auto_role", "welcome_channel_id", "rules_channel_id",
            "dev_intro_channel_id", "chill_zone_channel_id", "tech_news_channel_id",
            "new_member_role_id", "forge_member_role_id", "remove_new_member_role",
            "website_url", "embed_color", "embed_footer", "branding",
            "server_logo_url", "unlock_reaction", "button_labels_json",
        }
        if key not in allowed:
            raise ValueError(f"Unknown guild setting: {key}")
        await self.get_guild_settings(guild_id)  # ensure row exists
        await self._execute(
            f"UPDATE guild_settings SET {key} = ?, updated_at = ? WHERE guild_id = ?",
            (value, _now(), guild_id),
        )

    # ── welcome settings ─────────────────────────────────────

    async def get_welcome_settings(self, guild_id: int) -> dict[str, Any]:
        row = await self._fetchone(
            "SELECT * FROM welcome_settings WHERE guild_id = ?", (guild_id,)
        )
        return dict(row) if row else {"guild_id": guild_id}

    async def update_welcome_setting(self, guild_id: int, key: str, value: Any) -> None:
        allowed = {"welcome_title", "welcome_message", "dm_message", "image_style"}
        if key not in allowed:
            raise ValueError(f"Unknown welcome setting: {key}")
        await self._execute(
            "INSERT OR IGNORE INTO welcome_settings (guild_id) VALUES (?)", (guild_id,)
        )
        await self._execute(
            f"UPDATE welcome_settings SET {key} = ?, updated_at = ? WHERE guild_id = ?",
            (value, _now(), guild_id),
        )

    # ── members ──────────────────────────────────────────────

    async def upsert_member_join(
        self,
        *,
        guild_id: int,
        user_id: int,
        username: str,
        display_name: str,
        is_bot: bool,
        member_number: int,
        joined_at: str,
        account_created_at: str,
        invite_code: str | None,
        inviter_id: int | None,
        inviter_name: str | None,
    ) -> None:
        await self._execute(
            """
            INSERT INTO members (
                guild_id, user_id, username, display_name, is_bot, member_number,
                joined_at, account_created_at, invite_code, inviter_id, inviter_name,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (guild_id, user_id) DO UPDATE SET
                username = excluded.username,
                display_name = excluded.display_name,
                member_number = excluded.member_number,
                joined_at = excluded.joined_at,
                invite_code = excluded.invite_code,
                inviter_id = excluded.inviter_id,
                inviter_name = excluded.inviter_name,
                updated_at = excluded.updated_at
            """,
            (
                guild_id, user_id, username, display_name, int(is_bot), member_number,
                joined_at, account_created_at, invite_code, inviter_id, inviter_name,
                _now(),
            ),
        )

    async def get_member(self, guild_id: int, user_id: int) -> dict[str, Any] | None:
        row = await self._fetchone(
            "SELECT * FROM members WHERE guild_id = ? AND user_id = ?",
            (guild_id, user_id),
        )
        return dict(row) if row else None

    async def set_member_flag(
        self, guild_id: int, user_id: int, flag: str, value: Any
    ) -> None:
        allowed = {
            "welcome_sent", "dm_sent", "forge_member_awarded",
            "telegram_sent", "telegram_status",
            "first_message_time", "first_message_channel",
        }
        if flag not in allowed:
            raise ValueError(f"Unknown member flag: {flag}")
        await self._execute(
            f"UPDATE members SET {flag} = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?",
            (value, _now(), guild_id, user_id),
        )

    # ── join / invite history ────────────────────────────────

    async def add_join_history(
        self,
        *,
        guild_id: int,
        user_id: int,
        joined_at: str,
        joined_channel: int | None,
        member_number: int,
        invite_code: str | None,
        inviter_id: int | None,
    ) -> None:
        await self._execute(
            """
            INSERT INTO join_history
                (guild_id, user_id, joined_at, joined_channel, member_number,
                 invite_code, inviter_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (guild_id, user_id, joined_at, joined_channel, member_number,
             invite_code, inviter_id),
        )

    async def add_invite_history(
        self,
        *,
        guild_id: int,
        invite_code: str,
        inviter_id: int | None,
        inviter_name: str | None,
        used_by: int | None,
        uses: int | None,
    ) -> None:
        await self._execute(
            """
            INSERT INTO invite_history
                (guild_id, invite_code, inviter_id, inviter_name, used_by, used_at, uses)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (guild_id, invite_code, inviter_id, inviter_name, used_by, _now(), uses),
        )

    # ── DM status ────────────────────────────────────────────

    async def log_dm(
        self, guild_id: int, user_id: int, dm_type: str,
        success: bool, error: str | None = None,
    ) -> None:
        await self._execute(
            """
            INSERT INTO dm_status (guild_id, user_id, dm_type, success, error, sent_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (guild_id, user_id, dm_type, int(success), error, _now()),
        )

    # ── role rewards ─────────────────────────────────────────

    async def record_role_reward(
        self, guild_id: int, user_id: int, role_id: int, reward_key: str
    ) -> bool:
        """Insert reward record. Returns False if already granted (idempotent)."""
        try:
            await self._execute(
                """
                INSERT INTO role_rewards (guild_id, user_id, role_id, reward_key, granted_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (guild_id, user_id, role_id, reward_key, _now()),
            )
            return True
        except aiosqlite.IntegrityError:
            return False

    async def has_role_reward(self, guild_id: int, user_id: int, reward_key: str) -> bool:
        row = await self._fetchone(
            "SELECT 1 FROM role_rewards WHERE guild_id = ? AND user_id = ? AND reward_key = ?",
            (guild_id, user_id, reward_key),
        )
        return row is not None

    # ── activity progress ────────────────────────────────────

    async def try_claim_first_message(
        self,
        *,
        guild_id: int,
        user_id: int,
        message_id: int,
        channel_id: int,
        content: str,
        timestamp: str,
    ) -> bool:
        """
        Atomically claim the 'first message' slot for a member.
        Returns True only for the very first successful claim — guarantees
        the reward is processed exactly once even under message bursts.
        """
        try:
            await self._execute(
                """
                INSERT INTO activity_progress
                    (guild_id, user_id, first_message_id, first_message_time,
                     first_message_channel, first_message_content, completed, completed_at)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?)
                """,
                (guild_id, user_id, message_id, timestamp, channel_id,
                 content[:500], _now()),
            )
            return True
        except aiosqlite.IntegrityError:
            return False

    async def has_completed_activity(self, guild_id: int, user_id: int) -> bool:
        row = await self._fetchone(
            "SELECT completed FROM activity_progress WHERE guild_id = ? AND user_id = ?",
            (guild_id, user_id),
        )
        return bool(row and row["completed"])

    # ── telegram logs ────────────────────────────────────────

    async def log_telegram(
        self,
        *,
        guild_id: int | None,
        user_id: int | None,
        event_type: str,
        success: bool,
        attempts: int,
        error: str | None = None,
    ) -> None:
        await self._execute(
            """
            INSERT INTO telegram_logs
                (guild_id, user_id, event_type, success, attempts, error, sent_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (guild_id, user_id, event_type, int(success), attempts, error, _now()),
        )
