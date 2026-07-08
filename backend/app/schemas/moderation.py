"""
schemas/moderation.py
---------------------------------------------------------------------------
Pydantic models defining the API contract between the Discord bot and this
backend. Validation here guarantees the bot always receives a well-formed,
predictable JSON structure.
---------------------------------------------------------------------------
"""

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator


class ModerationAction(str, Enum):
    """The action the bot should take in response to a message."""

    NONE = "none"
    DELETE = "delete"
    WARN = "warn"
    KICK = "kick"


class ModerationRequest(BaseModel):
    """Payload sent by the bot to POST /moderate."""

    content: str = Field(..., min_length=1, max_length=4000, description="Message text to analyse.")
    author_id: Optional[str] = Field(None, description="Discord user ID of the author.")
    channel_id: Optional[str] = Field(None, description="Discord channel ID.")

    @field_validator("content")
    @classmethod
    def strip_content(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("content must not be empty")
        return stripped


class ModerationResponse(BaseModel):
    """Response returned to the bot from POST /moderate."""

    violation: bool = Field(..., description="Whether the message violates a rule.")
    rule: Optional[int] = Field(None, ge=1, le=10, description="Violated rule number (1-10), if any.")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Model confidence 0-1.")
    reason: str = Field(..., description="Short human-readable explanation.")
    action: ModerationAction = Field(..., description="Recommended action for the bot.")


class HealthResponse(BaseModel):
    """Response returned from GET /health."""

    status: str = Field(..., description="'ok' when the service is healthy.")
    groq_configured: bool = Field(..., description="Whether a Groq API key is configured.")
    model: str = Field(..., description="The Groq model in use.")
    telegram_configured: bool = Field(False, description="Whether Telegram notifications are configured.")
