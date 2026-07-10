"""
schemas/security.py
---------------------------------------------------------------------------
Pydantic models for the Forge Guardian Security System v2.0 endpoints:

  POST /security/analyze-join   -> AI join analysis (member profile in,
                                   risk score / threat level / reasons /
                                   recommended action out).
  POST /security/analyze-event  -> AI analysis of a suspicious live event
                                   (scam message, token leak, ...).

Threat levels: SAFE | LOW | MEDIUM | HIGH | CRITICAL
Risk bands:    0-20 SAFE · 21-40 LOW · 41-60 MEDIUM/REVIEW · 61-80 HIGH ·
               81-100 CRITICAL

The AI NEVER bans automatically — the strongest recommended action it can
return is 'ban_recommendation', which only raises a human-approval alert.
---------------------------------------------------------------------------
"""

from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


class ThreatLevel(str, Enum):
    """Classification bands for the 0-100 risk score."""

    SAFE = "SAFE"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class RecommendedAction(str, Enum):
    """Actions the AI may recommend. It can never execute a ban itself."""

    IGNORE = "ignore"
    MONITOR = "monitor"
    DELETE_MESSAGE = "delete_message"
    WARN = "warn"
    TIMEOUT = "timeout"
    KICK = "kick"
    BAN_RECOMMENDATION = "ban_recommendation"


class JoinAnalysisRequest(BaseModel):
    """Complete member profile sent by the bot for AI join analysis."""

    username: str = Field(..., description="Discord username.")
    display_name: str = Field("", description="Global display name.")
    nickname: str = Field("", description="Server nickname, if set.")
    user_id: str = Field(..., description="Discord user ID.")
    server_name: str = Field(..., description="Guild name.")
    account_age_days: int = Field(0, ge=0, description="Account age in days.")
    is_new_account: bool = Field(False, description="Account younger than the 'new' threshold.")
    has_default_avatar: bool = Field(False, description="No custom avatar set.")
    is_bot: bool = Field(False, description="Whether the account is a bot.")
    badges: List[str] = Field(default_factory=list, description="Public badges.")
    invite_code: str = Field("Unknown", description="Invite code used to join.")
    inviter: str = Field("Unknown", description="Inviter tag.")
    identity_findings: List[str] = Field(default_factory=list, description="Local identity-scan findings.")
    local_risk_score: int = Field(0, ge=0, le=100, description="Bot-side heuristic risk score.")
    previous_joins: int = Field(0, ge=0)
    previous_warnings: int = Field(0, ge=0)
    previous_kicks: int = Field(0, ge=0)
    previous_bans: int = Field(0, ge=0)
    rejoin_count: int = Field(0, ge=0)


class SecurityEventRequest(BaseModel):
    """A suspicious live event (message threat etc.) for AI analysis."""

    event_type: str = Field(..., description="Detector type, e.g. 'scam-link', 'token-leak'.")
    content: str = Field("", description="Offending message content (truncated).")
    username: str = Field("Unknown", description="Author tag.")
    user_id: str = Field("", description="Author ID.")
    channel: str = Field("", description="Channel name.")
    context: str = Field("", description="Local detector reason / extra context.")
    local_score: int = Field(0, ge=0, le=100, description="Local detector risk score.")


class SecurityAnalysisResponse(BaseModel):
    """Unified AI security analysis result."""

    risk_score: int = Field(..., ge=0, le=100, description="0-100 risk score.")
    threat_level: ThreatLevel = Field(..., description="SAFE|LOW|MEDIUM|HIGH|CRITICAL.")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Model confidence 0-1.")
    reasons: List[str] = Field(default_factory=list, description="Why this score was assigned.")
    explanation: str = Field("", description="Short human-readable explanation.")
    violated_rule: Optional[str] = Field(None, description="Rule/policy violated, if any.")
    recommended_action: RecommendedAction = Field(
        RecommendedAction.IGNORE,
        description="Suggested action. The AI never bans — at most 'ban_recommendation'.",
    )
    ai_available: bool = Field(True, description="False when the heuristic fallback was used.")
