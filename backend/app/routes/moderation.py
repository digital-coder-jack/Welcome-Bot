"""
routes/moderation.py
---------------------------------------------------------------------------
HTTP endpoints exposed to the Discord bot:

  POST /moderate  -> analyse a message and return a moderation decision.
  GET  /health    -> readiness/liveness probe with backend status.

The bot communicates with this backend ONLY through these two endpoints.
---------------------------------------------------------------------------
"""

from fastapi import APIRouter

from app.schemas.moderation import HealthResponse, ModerationRequest, ModerationResponse
from app.services.groq_service import groq_service
from app.utils.config import settings
from app.utils.logger import logger

router = APIRouter()


@router.post("/moderate", response_model=ModerationResponse, tags=["moderation"])
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


@router.get("/health", response_model=HealthResponse, tags=["system"])
async def health() -> HealthResponse:
    """Report service health and configuration status."""
    return HealthResponse(
        status="ok",
        groq_configured=settings.groq_configured,
        model=settings.groq_model,
    )
