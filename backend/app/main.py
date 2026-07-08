"""
main.py
---------------------------------------------------------------------------
FastAPI application entry point for the AI moderation backend.

Creates the app, configures CORS, mounts the moderation routes, and provides a
root informational endpoint. Run with:

    uvicorn app.main:app --host 0.0.0.0 --port 8000
    # or
    python -m app.main
---------------------------------------------------------------------------
"""
from app.routes.telegram import router as telegram_router
app.include_router(moderation_router)
app.include_router(telegram_router)
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes.moderation import router as moderation_router
from app.utils.config import settings
from app.utils.logger import logger


def create_app() -> FastAPI:
    """Application factory: build and configure the FastAPI instance."""
    app = FastAPI(
        title="Discord AI Moderation Backend",
        description="FastAPI + Groq service that analyses Discord messages for rule violations.",
        version="1.0.0",
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

    @app.get("/", tags=["system"])
    async def root() -> dict:
        """Basic service metadata."""
        return {
            "service": "Discord AI Moderation Backend",
            "version": "1.0.0",
            "endpoints": ["POST /moderate", "GET /health"],
            "groq_configured": settings.groq_configured,
        }

    @app.on_event("startup")
    async def on_startup() -> None:
        if settings.groq_configured:
            logger.info("Backend started. Groq model: %s", settings.groq_model)
        else:
            logger.warning("Backend started WITHOUT a Groq API key; using heuristic fallback.")

    return app


app = create_app()


if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )
