"""
services/telegram_service.py
---------------------------------------------------------------------------
Complete Telegram notification service.

Responsibilities:
  - Send messages to a Telegram chat via the Bot API (sendMessage / sendPhoto).
  - Format every Discord event (join, leave, warning, kick, ban, security
    alert) into a rich, readable HTML Telegram message.
  - Degrade gracefully: if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are missing
    or the API errors, log and report failure — never raise into a route.

Uses httpx (async) so the FastAPI event loop is never blocked.
---------------------------------------------------------------------------
"""

import html
from typing import Optional

import httpx

from app.schemas.telegram import (
    BanPayload,
    HighRiskJoinPayload,
    KickPayload,
    MemberJoinedPayload,
    MemberLeftPayload,
    OwnerApprovalPayload,
    SecurityAlertPayload,
    TimeoutPayload,
    WarningPayload,
)
from app.utils.config import settings
from app.utils.logger import logger

TELEGRAM_API_BASE = "https://api.telegram.org"

_SEVERITY_EMOJI = {
    "low": "🟢",
    "medium": "🟡",
    "high": "🟠",
    "critical": "🔴",
}

_THREAT_EMOJI = {
    "SAFE": "🟢",
    "LOW": "🔵",
    "MEDIUM": "🟡",
    "HIGH": "🟠",
    "CRITICAL": "🔴",
}


def _esc(value: object) -> str:
    """HTML-escape any value for safe inclusion in a Telegram HTML message."""
    return html.escape(str(value if value is not None else ""), quote=False)


class TelegramService:
    """Service object that formats and delivers Telegram notifications."""

    def __init__(self) -> None:
        self._timeout = httpx.Timeout(10.0, connect=5.0)

    # ------------------------------------------------------------------ #
    # Low-level senders
    # ------------------------------------------------------------------ #

    @property
    def configured(self) -> bool:
        """Whether both the bot token and chat id are configured."""
        return settings.telegram_configured

    def _url(self, method: str) -> str:
        return f"{TELEGRAM_API_BASE}/bot{settings.telegram_bot_token}/{method}"

    async def send_message(self, text: str, disable_preview: bool = True) -> bool:
        """Send an HTML-formatted text message to the configured chat."""
        if not self.configured:
            logger.warning("Telegram not configured; skipping notification.")
            return False

        payload = {
            "chat_id": settings.telegram_chat_id,
            "text": text[:4096],  # Telegram hard limit.
            "parse_mode": "HTML",
            "disable_web_page_preview": disable_preview,
        }

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(self._url("sendMessage"), json=payload)
            data = response.json()
            if response.status_code == 200 and data.get("ok"):
                return True
            logger.error("Telegram sendMessage failed: HTTP %s — %s", response.status_code, data)
            return False
        except Exception as exc:  # noqa: BLE001 - never propagate into routes.
            logger.error("Telegram sendMessage error: %s", exc)
            return False

    async def send_photo(self, photo_url: str, caption: str) -> bool:
        """
        Send a photo with an HTML caption. Falls back to a plain text message
        if the photo send fails (e.g. invalid avatar URL).
        """
        if not self.configured:
            logger.warning("Telegram not configured; skipping notification.")
            return False

        payload = {
            "chat_id": settings.telegram_chat_id,
            "photo": photo_url,
            "caption": caption[:1024],  # Telegram caption hard limit.
            "parse_mode": "HTML",
        }

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(self._url("sendPhoto"), json=payload)
            data = response.json()
            if response.status_code == 200 and data.get("ok"):
                return True
            logger.warning(
                "Telegram sendPhoto failed (HTTP %s); falling back to text. %s",
                response.status_code,
                data,
            )
            return await self.send_message(caption)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Telegram sendPhoto error (%s); falling back to text.", exc)
            return await self.send_message(caption)

    # ------------------------------------------------------------------ #
    # Event notifications
    # ------------------------------------------------------------------ #

    async def notify_member_joined(self, data: MemberJoinedPayload) -> bool:
        """Send the full member-joined intelligence report to Telegram."""
        is_bot = data.bot_or_human.strip().lower() == "bot"
        header_emoji = "🤖" if is_bot else "🎉"

        lines = [
            f"{header_emoji} <b>NEW MEMBER JOINED</b>",
            "━━━━━━━━━━━━━━━━━━━━",
            f"👤 <b>Username:</b> {_esc(data.username)}",
            f"🏷 <b>Display Name:</b> {_esc(data.display_name)}",
            f"🆔 <b>User ID:</b> <code>{_esc(data.user_id)}</code>",
            f"🌐 <b>Server:</b> {_esc(data.server_name)}",
            f"🕒 <b>Join Time:</b> {_esc(data.join_time)}",
            f"📅 <b>Account Created:</b> {_esc(data.account_created)}",
            f"⏳ <b>Account Age:</b> {_esc(data.account_age)}",
            f"🔢 <b>Member Number:</b> #{data.member_number}",
            f"🔗 <b>Invite Code:</b> <code>{_esc(data.invite_code)}</code>",
            f"🙋 <b>Inviter:</b> {_esc(data.inviter)}",
            f"🧬 <b>Bot or Human:</b> {_esc(data.bot_or_human)}",
            f"🎭 <b>Assigned Role:</b> {_esc(data.assigned_role)}",
            f"✉️ <b>DM Status:</b> {_esc(data.dm_status)}",
            f"📨 <b>Server Invite Used:</b> {_esc(data.server_invite_used)}",
            "━━━━━━━━━━━━━━━━━━━━",
        ]
        if data.avatar_url:
            lines.append(f"🖼 <b>Avatar:</b> <a href=\"{html.escape(data.avatar_url, quote=True)}\">View</a>")

        caption = "\n".join(lines)

        if data.avatar_url:
            return await self.send_photo(data.avatar_url, caption)
        return await self.send_message(caption)

    async def notify_member_left(self, data: MemberLeftPayload) -> bool:
        """Send a member-left notification to Telegram."""
        lines = [
            "👋 <b>MEMBER LEFT</b>",
            "━━━━━━━━━━━━━━━━━━━━",
            f"👤 <b>Username:</b> {_esc(data.username)}",
            f"🏷 <b>Display Name:</b> {_esc(data.display_name or data.username)}",
            f"🆔 <b>User ID:</b> <code>{_esc(data.user_id)}</code>",
            f"🌐 <b>Server:</b> {_esc(data.server_name)}",
            f"🕒 <b>Leave Time:</b> {_esc(data.leave_time)}",
            f"📅 <b>Joined At:</b> {_esc(data.joined_at)}",
            f"⏳ <b>Time in Server:</b> {_esc(data.time_in_server)}",
            f"🎭 <b>Roles:</b> {_esc(data.roles)}",
            f"👥 <b>Members Now:</b> {data.member_count}",
            "━━━━━━━━━━━━━━━━━━━━",
        ]
        return await self.send_message("\n".join(lines))

    async def notify_warning(self, data: WarningPayload) -> bool:
        """Send a warning notification to Telegram."""
        lines = [
            "⚠️ <b>MEMBER WARNED</b>",
            "━━━━━━━━━━━━━━━━━━━━",
            f"👤 <b>User:</b> {_esc(data.username)} (<code>{_esc(data.user_id)}</code>)",
            f"🌐 <b>Server:</b> {_esc(data.server_name)}",
            f"📄 <b>Reason:</b> {_esc(data.reason)}",
        ]
        if data.rule:
            lines.append(f"📏 <b>Rule:</b> {_esc(data.rule)}")
        lines.extend(
            [
                f"🛡 <b>Moderator:</b> {_esc(data.moderator)}",
                f"🔢 <b>Warnings:</b> {data.warning_count} / {data.max_warnings}",
                f"⚙️ <b>Source:</b> {_esc(data.source)}",
                f"🕒 <b>Time:</b> {_esc(data.timestamp)}",
                "━━━━━━━━━━━━━━━━━━━━",
            ]
        )
        if data.warning_count >= data.max_warnings:
            lines.append("🚨 <b>Maximum warnings reached — removal triggered.</b>")
        return await self.send_message("\n".join(lines))

    async def notify_kick(self, data: KickPayload) -> bool:
        """Send a kick notification to Telegram."""
        lines = [
            "🥾 <b>MEMBER KICKED</b>",
            "━━━━━━━━━━━━━━━━━━━━",
            f"👤 <b>User:</b> {_esc(data.username)} (<code>{_esc(data.user_id)}</code>)",
            f"🌐 <b>Server:</b> {_esc(data.server_name)}",
            f"📄 <b>Reason:</b> {_esc(data.reason)}",
            f"🛡 <b>Moderator:</b> {_esc(data.moderator)}",
        ]
        if data.warning_count is not None:
            lines.append(f"🔢 <b>Warnings at Kick:</b> {data.warning_count}")
        lines.extend(
            [
                f"🕒 <b>Time:</b> {_esc(data.timestamp)}",
                "━━━━━━━━━━━━━━━━━━━━",
            ]
        )
        return await self.send_message("\n".join(lines))

    async def notify_ban(self, data: BanPayload) -> bool:
        """Send a ban notification to Telegram."""
        lines = [
            "🔨 <b>MEMBER BANNED</b>",
            "━━━━━━━━━━━━━━━━━━━━",
            f"👤 <b>User:</b> {_esc(data.username)} (<code>{_esc(data.user_id)}</code>)",
            f"🌐 <b>Server:</b> {_esc(data.server_name)}",
            f"📄 <b>Reason:</b> {_esc(data.reason)}",
            f"🛡 <b>Moderator:</b> {_esc(data.moderator)}",
            f"🕒 <b>Time:</b> {_esc(data.timestamp)}",
            "━━━━━━━━━━━━━━━━━━━━",
        ]
        return await self.send_message("\n".join(lines))

    async def notify_security_alert(self, data: SecurityAlertPayload) -> bool:
        """Send a security alert to Telegram."""
        severity = data.severity.strip().lower()
        emoji = _SEVERITY_EMOJI.get(severity, "🟡")

        lines = [
            f"🚨 <b>SECURITY ALERT</b> {emoji} <b>{_esc(severity.upper())}</b>",
            "━━━━━━━━━━━━━━━━━━━━",
            f"📛 <b>Type:</b> {_esc(data.alert_type)}",
            f"🌐 <b>Server:</b> {_esc(data.server_name)}",
        ]
        if data.username and data.username != "Unknown":
            user_line = f"👤 <b>User:</b> {_esc(data.username)}"
            if data.user_id:
                user_line += f" (<code>{_esc(data.user_id)}</code>)"
            lines.append(user_line)
        if data.channel:
            lines.append(f"💬 <b>Channel:</b> {_esc(data.channel)}")
        lines.extend(
            [
                f"📄 <b>Details:</b> {_esc(data.details)}",
                f"🕒 <b>Time:</b> {_esc(data.timestamp)}",
                "━━━━━━━━━━━━━━━━━━━━",
            ]
        )
        return await self.send_message("\n".join(lines))

    # ------------------------------------------------------------------ #
    # Forge Guardian Security System v2.0 notifications
    # ------------------------------------------------------------------ #

    async def notify_timeout(self, data: TimeoutPayload) -> bool:
        """Send a member-timeout notification to Telegram."""
        lines = [
            "🟡 <b>MEMBER TIMED OUT</b>",
            "━━━━━━━━━━━━━━━━━━━━",
            f"👤 <b>User:</b> {_esc(data.username)} (<code>{_esc(data.user_id)}</code>)",
            f"🌐 <b>Server:</b> {_esc(data.server_name)}",
            f"📄 <b>Reason:</b> {_esc(data.reason)}",
            f"🛡 <b>Moderator:</b> {_esc(data.moderator)}",
            f"⏲ <b>Duration:</b> {data.duration_minutes} minutes",
            f"🕒 <b>Time:</b> {_esc(data.timestamp)}",
            "━━━━━━━━━━━━━━━━━━━━",
        ]
        return await self.send_message("\n".join(lines))

    async def notify_high_risk_join(self, data: HighRiskJoinPayload) -> bool:
        """Send a rich high-risk join report to Telegram."""
        emoji = _THREAT_EMOJI.get(data.threat_level.upper(), "🟡")
        lines = [
            f"🚨 <b>HIGH RISK JOIN</b> {emoji} <b>{_esc(data.threat_level.upper())}</b>",
            "━━━━━━━━━━━━━━━━━━━━",
            f"👤 <b>User:</b> {_esc(data.username)} (<code>{_esc(data.user_id)}</code>)",
            f"🌐 <b>Server:</b> {_esc(data.server_name)}",
            f"📊 <b>Risk Score:</b> <b>{data.risk_score}/100</b>",
            f"🎯 <b>AI Confidence:</b> {round(data.confidence * 100)}%",
            f"⏳ <b>Account Age:</b> {_esc(data.account_age)}",
            f"🔗 <b>Invite:</b> <code>{_esc(data.invite_code)}</code> by {_esc(data.inviter)}",
            f"🔁 <b>Rejoin Count:</b> {data.rejoin_count}",
            f"🤖 <b>Recommended:</b> {_esc(data.recommended_action)}",
            f"📄 <b>Reasons:</b> {_esc(data.reasons)}",
            f"🕒 <b>Time:</b> {_esc(data.timestamp)}",
            "━━━━━━━━━━━━━━━━━━━━",
            "⚠️ <b>No automatic action taken — awaiting human approval in Discord.</b>",
        ]
        caption = "\n".join(lines)
        if data.avatar_url:
            return await self.send_photo(data.avatar_url, caption)
        return await self.send_message(caption)

    async def notify_owner_approval(self, data: OwnerApprovalPayload) -> bool:
        """Send an Owner Approval Request notification to Telegram."""
        emoji = _THREAT_EMOJI.get(data.threat_level.upper(), "🟠")
        lines = [
            f"🛎 <b>OWNER APPROVAL REQUEST</b> {emoji} <b>{_esc(data.threat_level.upper())}</b>",
            "━━━━━━━━━━━━━━━━━━━━",
            f"🆔 <b>Alert:</b> <code>{_esc(data.alert_id)}</code>",
            f"👤 <b>User:</b> {_esc(data.username)} (<code>{_esc(data.user_id)}</code>)",
            f"🌐 <b>Server:</b> {_esc(data.server_name)}",
            f"📊 <b>Risk Score:</b> <b>{data.risk_score}/100</b>",
            f"🔎 <b>Source:</b> {_esc(data.source)}",
            f"🤖 <b>AI Recommendation:</b> {_esc(data.recommended_action)}",
            f"📄 <b>Reasons:</b> {_esc(data.reasons)}",
            f"🕒 <b>Time:</b> {_esc(data.timestamp)}",
            "━━━━━━━━━━━━━━━━━━━━",
            "👉 <b>Open Discord to approve: ✅ Ban · ⚠ Kick · 🟡 Timeout · 📝 Warn · ❌ Ignore</b>",
        ]
        return await self.send_message("\n".join(lines))


# Shared singleton used by the routes.
telegram_service = TelegramService()
