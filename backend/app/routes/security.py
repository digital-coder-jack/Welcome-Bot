"""
routes/security.py
---------------------------------------------------------------------------
AI Security Engine endpoints (Forge Guardian Security System v2.0):

  POST /security/analyze-join   -> AI analysis of a joining member.
  POST /security/analyze-event  -> AI analysis of a suspicious live event.

Both endpoints ALWAYS return a valid SecurityAnalysisResponse — Groq
failures degrade to a deterministic heuristic inside the service, so the
bot's flow is never disrupted.
---------------------------------------------------------------------------
"""

from fastapi import APIRouter

from app.schemas.security import (
    JoinAnalysisRequest,
    SecurityAnalysisResponse,
    SecurityEventRequest,
)
from app.services.security_service import security_service
from app.utils.logger import logger

router = APIRouter(prefix="/security", tags=["security"])


@router.post("/analyze-join", response_model=SecurityAnalysisResponse)
async def analyze_join(request: JoinAnalysisRequest) -> SecurityAnalysisResponse:
    """Analyse a joining member's complete profile and return the AI verdict."""
    result = await security_service.analyze_join(request)
    logger.info(
        "Join analysis: %s (%s) -> score=%d level=%s action=%s conf=%.2f ai=%s",
        request.username,
        request.user_id,
        result.risk_score,
        result.threat_level.value,
        result.recommended_action.value,
        result.confidence,
        result.ai_available,
    )
    return result


@router.post("/analyze-event", response_model=SecurityAnalysisResponse)
async def analyze_event(request: SecurityEventRequest) -> SecurityAnalysisResponse:
    """Analyse a suspicious live event and return the AI verdict."""
    result = await security_service.analyze_event(request)
    logger.info(
        "Event analysis [%s]: %s (%s) -> score=%d level=%s action=%s ai=%s",
        request.event_type,
        request.username,
        request.user_id,
        result.risk_score,
        result.threat_level.value,
        result.recommended_action.value,
        result.ai_available,
    )
    return result
