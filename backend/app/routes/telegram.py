"""
routes/telegram.py
---------------------------------------------------------------------------
HTTP endpoints for every Telegram notification the Discord bot triggers:

  POST /telegram/member-joined   -> full member-join intelligence report.
  POST /telegram/member-left     -> departure notification.
  POST /telegram/warning         -> warning issued notification.
  POST /telegram/kick            -> member kicked notification.
  POST /telegram/ban             -> member banned notification.
  POST /telegram/security-alert  -> raid / scam / AI-violation alerts.

Every endpoint validates its payload with the schemas in schemas/telegram.py
and always returns a TelegramResponse — a failed Telegram delivery never
raises an HTTP 5xx so the bot's flow is never disrupted.
---------------------------------------------------------------------------
"""

from fastapi import APIRouter

from app.schemas.telegram import (
    BanPayload,
    KickPayload,
    MemberJoinedPayload,
    MemberLeftPayload,
    SecurityAlertPayload,
    TelegramResponse,
    WarningPayload,
)
from app.services.telegram_service import telegram_service
from app.utils.logger import logger

router = APIRouter(prefix="/telegram", tags=["telegram"])


@router.post("/member-joined", response_model=TelegramResponse)
async def member_joined(payload: MemberJoinedPayload) -> TelegramResponse:
    """Relay a new-member intelligence report to Telegram."""
    logger.info(
        "Member joined: %s (%s) in %s — member #%d",
        payload.username,
        payload.user_id,
        payload.server_name,
        payload.member_number,
    )
    delivered = await telegram_service.notify_member_joined(payload)
    return TelegramResponse(
        success=delivered,
        message="Member-joined notification sent." if delivered else "Telegram delivery failed.",
    )


@router.post("/member-left", response_model=TelegramResponse)
async def member_left(payload: MemberLeftPayload) -> TelegramResponse:
    """Relay a member-left notification to Telegram."""
    logger.info(
        "Member left: %s (%s) from %s",
        payload.username,
        payload.user_id,
        payload.server_name,
    )
    delivered = await telegram_service.notify_member_left(payload)
    return TelegramResponse(
        success=delivered,
        message="Member-left notification sent." if delivered else "Telegram delivery failed.",
    )


@router.post("/warning", response_model=TelegramResponse)
async def warning(payload: WarningPayload) -> TelegramResponse:
    """Relay a warning notification to Telegram."""
    logger.info(
        "Warning: %s (%s) — %d/%d [%s]",
        payload.username,
        payload.user_id,
        payload.warning_count,
        payload.max_warnings,
        payload.source,
    )
    delivered = await telegram_service.notify_warning(payload)
    return TelegramResponse(
        success=delivered,
        message="Warning notification sent." if delivered else "Telegram delivery failed.",
    )


@router.post("/kick", response_model=TelegramResponse)
async def kick(payload: KickPayload) -> TelegramResponse:
    """Relay a kick notification to Telegram."""
    logger.info("Kick: %s (%s) by %s", payload.username, payload.user_id, payload.moderator)
    delivered = await telegram_service.notify_kick(payload)
    return TelegramResponse(
        success=delivered,
        message="Kick notification sent." if delivered else "Telegram delivery failed.",
    )


@router.post("/ban", response_model=TelegramResponse)
async def ban(payload: BanPayload) -> TelegramResponse:
    """Relay a ban notification to Telegram."""
    logger.info("Ban: %s (%s) by %s", payload.username, payload.user_id, payload.moderator)
    delivered = await telegram_service.notify_ban(payload)
    return TelegramResponse(
        success=delivered,
        message="Ban notification sent." if delivered else "Telegram delivery failed.",
    )


@router.post("/security-alert", response_model=TelegramResponse)
async def security_alert(payload: SecurityAlertPayload) -> TelegramResponse:
    """Relay a security alert to Telegram."""
    logger.info(
        "Security alert [%s/%s]: %s",
        payload.alert_type,
        payload.severity,
        payload.details[:100],
    )
    delivered = await telegram_service.notify_security_alert(payload)
    return TelegramResponse(
        success=delivered,
        message="Security alert sent." if delivered else "Telegram delivery failed.",
    )
