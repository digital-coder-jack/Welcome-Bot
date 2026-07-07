"""
Owner-only Telegram notification service.

Sensitive member details are NEVER posted in Discord — they are delivered
privately to the server owner's Telegram chat via the Bot API, with safe
retries and full audit logging. Failures never interrupt Discord flows.
"""
from __future__ import annotations

import asyncio
import html
from typing import TYPE_CHECKING

import aiohttp

from bot.core.config import TelegramConfig
from bot.core.logging import get_logger

if TYPE_CHECKING:
    from bot.database.db import Database

log = get_logger("telegram")

_API_BASE = "https://api.telegram.org/bot{token}/sendMessage"


def esc(value: object) -> str:
    """HTML-escape any value for safe Telegram HTML formatting."""
    return html.escape(str(value)) if value is not None else "—"


class TelegramNotifier:
    """Async Telegram sender with retry + DB audit logging."""

    def __init__(self, config: TelegramConfig, db: "Database") -> None:
        self._config = config
        self._db = db
        self._session: aiohttp.ClientSession | None = None

    async def start(self) -> None:
        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=15)
        )
        if not self._config.enabled:
            log.warning(
                "Telegram credentials missing — owner notifications disabled. "
                "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable."
            )

    async def close(self) -> None:
        if self._session:
            await self._session.close()
            self._session = None

    async def send(
        self,
        text: str,
        *,
        event_type: str,
        guild_id: int | None = None,
        user_id: int | None = None,
    ) -> bool:
        """
        Send an HTML-formatted message to the owner chat.
        Retries transient failures, logs every outcome to the database,
        and never raises — Discord functionality is never interrupted.
        """
        if not self._config.enabled or self._session is None:
            await self._safe_audit(guild_id, user_id, event_type, False, 0,
                                   "telegram disabled / not configured")
            return False

        url = _API_BASE.format(token=self._config.bot_token)
        payload = {
            "chat_id": self._config.chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }

        last_error: str | None = None
        attempts = 0
        for attempt in range(1, self._config.max_retries + 1):
            attempts = attempt
            try:
                async with self._session.post(url, json=payload) as resp:
                    if resp.status == 200:
                        await self._safe_audit(guild_id, user_id, event_type,
                                               True, attempts, None)
                        log.info("Telegram sent [%s] (attempt %d)", event_type, attempt)
                        return True
                    if resp.status == 429:  # rate limited — honour retry_after
                        body = await resp.json(content_type=None)
                        delay = float(
                            body.get("parameters", {}).get("retry_after",
                                                           self._config.retry_delay)
                        )
                        last_error = f"429 rate limited (retry_after={delay})"
                        await asyncio.sleep(delay)
                        continue
                    last_error = f"HTTP {resp.status}: {(await resp.text())[:200]}"
            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"

            if attempt < self._config.max_retries:
                await asyncio.sleep(self._config.retry_delay * attempt)

        log.error("Telegram delivery failed [%s] after %d attempts: %s",
                  event_type, attempts, last_error)
        await self._safe_audit(guild_id, user_id, event_type, False, attempts, last_error)
        return False

    async def _safe_audit(
        self, guild_id: int | None, user_id: int | None,
        event_type: str, success: bool, attempts: int, error: str | None,
    ) -> None:
        try:
            await self._db.log_telegram(
                guild_id=guild_id, user_id=user_id, event_type=event_type,
                success=success, attempts=attempts, error=error,
            )
        except Exception:  # noqa: BLE001 — audit must never break the flow
            log.exception("Failed to write telegram audit log")

    # ── message builders ─────────────────────────────────────

    @staticmethod
    def build_member_joined(data: dict) -> str:
        return (
            "🟢 <b>New Member Joined</b>\n"
            "━━━━━━━━━━━━━━━━━━\n"
            f"👤 <b>Username:</b> {esc(data['username'])}\n"
            f"🏷 <b>Display Name:</b> {esc(data['display_name'])}\n"
            f"🆔 <b>User ID:</b> <code>{esc(data['user_id'])}</code>\n"
            f"🏠 <b>Server:</b> {esc(data['server_name'])}\n"
            f"⏰ <b>Join Time:</b> {esc(data['join_time'])}\n"
            f"📅 <b>Account Created:</b> {esc(data['account_created'])}\n"
            f"⌛ <b>Account Age:</b> {esc(data['account_age'])}\n"
            f"🔢 <b>Member #:</b> {esc(data['member_number'])}\n"
            f"📨 <b>Inviter:</b> {esc(data['inviter'])}\n"
            f"🔗 <b>Invite Code:</b> <code>{esc(data['invite_code'])}</code>\n"
            f"🤖 <b>Type:</b> {esc(data['bot_or_human'])}\n"
            f"🖼 <b>Avatar:</b> {esc(data['avatar_url'])}\n"
            f"💌 <b>Welcome DM:</b> {esc(data['dm_status'])}\n"
            f"🎭 <b>Assigned Role:</b> {esc(data['assigned_role'])}"
        )

    @staticmethod
    def build_forge_unlocked(data: dict) -> str:
        return (
            "🔥 <b>Forge Member Unlocked</b>\n"
            "━━━━━━━━━━━━━━━━━━\n"
            f"👤 <b>Username:</b> {esc(data['username'])}\n"
            f"🆔 <b>User ID:</b> <code>{esc(data['user_id'])}</code>\n"
            f"💬 <b>First Message:</b> {esc(data['first_message'])}\n"
            f"📺 <b>Channel:</b> #{esc(data['channel_name'])}\n"
            f"⏰ <b>Time:</b> {esc(data['time'])}\n"
            f"🎭 <b>New Role:</b> {esc(data['new_role'])}"
        )
