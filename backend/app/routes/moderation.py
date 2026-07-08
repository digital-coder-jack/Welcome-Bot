"""
routes/moderation.py
---------------------------------------------------------------------------
AI moderation endpoint exposed to the Discord bot:

  POST /moderate  -> analyse a message and return a moderation decision.

(The health probe now lives in routes/health.py; the /health path is
unchanged, so the bot's existing client keeps working.)
---------------------------------------------------------------------------
"""

from fastapi import APIRouter

from app.schemas.moderation import ModerationRequest, ModerationResponse
from app.services.groq_service import groq_service
from app.utils.logger import logger

router = APIRouter(tags=["moderation"])


@router.post("/moderate", response_model=ModerationResponse)
async def moderate(request: ModerationRequest) -> ModerationResponse:
    """
    Analyse a single Discord message for rule violations.

    The request body is validated by ModerationRequest; the response always
    conforms to ModerationResponse thanks to the service's validation and
    fallback logic.
    """
    result = await groq_service.moderate(request.content)
    logger.info(
        "Moderated message (author=%s): violation=%s rule=%s action=%s conf=%.2f",
        request.author_id,
        result.violation,
        result.rule,
        result.action.value,
        result.confidence,
    )
    return result
