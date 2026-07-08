"""
routes/health.py
---------------------------------------------------------------------------
System / health endpoints:

  GET /health -> readiness/liveness probe with backend configuration status.

The path is unchanged from the previous architecture (GET /health) so the
existing Discord bot health probe keeps working without modification.
---------------------------------------------------------------------------
"""

from fastapi import APIRouter

from app.schemas.moderation import HealthResponse
from app.utils.config import settings

router = APIRouter(tags=["system"])


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Report service health and configuration status."""
    return HealthResponse(
        status="ok",
        groq_configured=settings.groq_configured,
        model=settings.groq_model,
        telegram_configured=settings.telegram_configured,
    )
