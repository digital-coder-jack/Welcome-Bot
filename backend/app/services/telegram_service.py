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
import json
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


def _selection_lines(label: str, values: list[str] | None) -> list[str]:
    selected = [str(value) for value in (values or []) if value]
    return [f"<b>{label}</b>", *[f"• {_esc(value)}" for value in selected or ["Not provided"]]]


def _single_selection(value: str | None) -> str:
    return _esc(value or "Not provided")


def _archive_record(record_type: str, data: dict) -> str:
    """Append machine-readable archive metadata without exposing secrets/content."""
    record = {"schema_version": 1, "record_type": record_type, **data}
    return f"<pre>{_esc('[FORGE_ASSIST] ' + json.dumps(record, ensure_ascii=False, separators=(',', ':')))}</pre>"


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
        """Send a readable member record plus its machine-readable archive record."""
        is_bot = data.bot_or_human.strip().lower() == "bot"
        lines = [
            f"{'🤖' if is_bot else '🎉'} <b>NEW MEMBER JOINED</b>",
            "━━━━━━━━━━━━━━━━━━━━",
            "<b>👤 MEMBER</b>",
            f"Username: {_esc(data.username)}",
            f"Display Name: {_esc(data.display_name)}",
            f"User ID: <code>{_esc(data.user_id)}</code>",
            "",
            "<b>📅 SERVER</b>",
            f"Joined: {_esc(data.join_time)}",
            f"Member #: {data.member_number}",
            f"Invite: <code>{_esc(data.invite_code)}</code>",
            f"Inviter: {_esc(data.inviter)}",
            "",
            "<b>🕐 ACCOUNT</b>",
            f"Created: {_esc(data.account_created)}",
            f"Account Age: {_esc(data.account_age)}",
            f"Account Type: {_esc(data.bot_or_human)}",
            "",
            "<b>🧩 ONBOARDING</b>",
            "🎯 Interests", *_selection_lines("", data.interests)[1:],
            f"📚 Experience\n• {_single_selection(data.experience)}",
            f"💼 Doing\n• {_single_selection(data.work_status)}",
            f"⚧️ Gender\n• {_single_selection(data.gender)}",
            "",
            "<b>🤝 DEFAULT ROLE</b>",
            _esc(data.assigned_role),
            "",
            "<b>📩 STATUS</b>",
            f"Welcome DM: {_esc(data.dm_status)}",
        ]
        if data.avatar_url:
            lines.extend(["", f"🖼️ <b>AVATAR</b> <a href=\"{html.escape(data.avatar_url, quote=True)}\">View</a>"])
        lines.extend(["━━━━━━━━━━━━━━━━━━━━", _archive_record("member_joined", {
            "member": {"user_id": data.user_id, "username": data.username, "display_name": data.display_name},
            "server": data.server_name, "joined_at": data.join_time,
            "account_created": data.account_created, "member_number": data.member_number,
            "invite_code": data.invite_code, "inviter": data.inviter,
            "is_bot": is_bot, "assigned_role": data.assigned_role,
            "onboarding": {"interests": data.interests, "experience": data.experience or "Not provided", "doing": data.work_status or "Not provided", "gender": data.gender or "Not provided"},
        })])
        caption = "\n".join(lines)
        return await self.send_photo(data.avatar_url, caption) if data.avatar_url else await self.send_message(caption)

    async def notify_member_left(self, data: MemberLeftPayload) -> bool:
        """Send a clean departure record while retaining prior onboarding data."""
        lines = [
            "👋 <b>MEMBER LEFT</b>", "━━━━━━━━━━━━━━━━━━━━",
            "<b>👤 MEMBER</b>", f"Username: {_esc(data.username)}", f"Display Name: {_esc(data.display_name or data.username)}", f"User ID: <code>{_esc(data.user_id)}</code>",
            "", "<b>📅 MEMBERSHIP</b>", f"Joined: {_esc(data.joined_at)}", f"Left: {_esc(data.leave_time)}", f"Time in Server: {_esc(data.time_in_server)}", f"Members Now: {data.member_count}",
            "", "<b>🧩 ONBOARDING</b>", "🎯 Interests", *_selection_lines("", data.interests)[1:], f"📚 Experience\n• {_single_selection(data.experience)}", f"💼 Doing\n• {_single_selection(data.work_status)}", f"⚧️ Gender\n• {_single_selection(data.gender)}", "", "<b>🤝 DEFAULT ROLE</b>", _esc(data.default_role),
            "━━━━━━━━━━━━━━━━━━━━", _archive_record("member_left", {"member": {"user_id": data.user_id, "username": data.username, "display_name": data.display_name}, "server": data.server_name, "joined_at": data.joined_at, "left_at": data.leave_time, "time_in_server": data.time_in_server, "member_count": data.member_count, "onboarding": {"interests": data.interests, "experience": data.experience or "Not provided", "doing": data.work_status or "Not provided", "gender": data.gender or "Not provided"}, "default_role": data.default_role})
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
