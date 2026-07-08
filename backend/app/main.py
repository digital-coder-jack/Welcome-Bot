"""
main.py
---------------------------------------------------------------------------
FastAPI application entry point — the SINGLE API for:

  • AI Moderation          POST /moderate
  • Health                 GET  /health
  • Telegram notifications POST /telegram/member-joined
                           POST /telegram/member-left
                           POST /telegram/warning
                           POST /telegram/kick
                           POST /telegram/ban
                           POST /telegram/security-alert

Run locally with:

    uvicorn app.main:app --host 0.0.0.0 --port 8000
    # or
    python -m app.main
---------------------------------------------------------------------------
"""

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes.health import router as health_router
from app.routes.moderation import router as moderation_router
from app.routes.telegram import router as telegram_router
from app.utils.config import settings
from app.utils.logger import logger


def create_app() -> FastAPI:
    """Application factory: build and configure the FastAPI instance."""
    app = FastAPI(
        title="Discord Moderation & Notification Backend",
        description=(
            "FastAPI service providing AI moderation (Groq), Telegram notifications, "
            "security alerts and join/leave intelligence for the Discord bot."
        ),
        version="2.0.0",
    )

    # CORS (the bot is a server-side client, but this keeps the API flexible).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Mount routes.
    app.include_router(moderation_router)
    app.include_router(telegram_router)
    app.include_router(health_router)

    @app.get("/", tags=["system"])
    async def root() -> dict:
        """Basic service metadata."""
        return {
            "service": "Discord Moderation & Notification Backend",
            "version": "2.0.0",
            "endpoints": [
                "POST /moderate",
                "GET /health",
                "POST /telegram/member-joined",
                "POST /telegram/member-left",
                "POST /telegram/warning",
                "POST /telegram/kick",
                "POST /telegram/ban",
                "POST /telegram/security-alert",
            ],
            "groq_configured": settings.groq_configured,
            "telegram_configured": settings.telegram_configured,
        }

    @app.on_event("startup")
    async def on_startup() -> None:
        if settings.groq_configured:
            logger.info("Backend started. Groq model: %s", settings.groq_model)
        else:
            logger.warning("Backend started WITHOUT a Groq API key; using heuristic fallback.")

        if settings.telegram_configured:
            logger.info("Telegram notifications ENABLED (chat_id=%s).", settings.telegram_chat_id)
        else:
            logger.warning("Telegram notifications DISABLED (missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).")

    return app


app = create_app()


if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )
