"""
services/security_service.py
---------------------------------------------------------------------------
AI Security Engine (Forge Guardian v2.0) — Groq-powered analysis of member
joins and suspicious live events.

Responsibilities:
  - Call Groq (JSON mode) with the security prompts.
  - Validate/clamp the model output into SecurityAnalysisResponse.
  - Enforce policy: the AI can never return anything stronger than
    'ban_recommendation'.
  - Degrade gracefully: heuristic fallback when Groq is unconfigured/fails,
    so the API always answers and the bot always fails open.
---------------------------------------------------------------------------
"""

import json
from typing import Optional

from groq import Groq

from app.prompts.security_prompt import (
    EVENT_SYSTEM_PROMPT,
    JOIN_SYSTEM_PROMPT,
    build_event_prompt,
    build_join_prompt,
)
from app.schemas.security import (
    JoinAnalysisRequest,
    RecommendedAction,
    SecurityAnalysisResponse,
    SecurityEventRequest,
    ThreatLevel,
)
from app.utils.config import settings
from app.utils.logger import logger


def _classify(score: int) -> ThreatLevel:
    """Map a 0-100 risk score to its threat-level band."""
    if score <= 20:
        return ThreatLevel.SAFE
    if score <= 40:
        return ThreatLevel.LOW
    if score <= 60:
        return ThreatLevel.MEDIUM
    if score <= 80:
        return ThreatLevel.HIGH
    return ThreatLevel.CRITICAL


class SecurityAnalysisService:
    """Service object performing AI security analysis via Groq."""

    def __init__(self) -> None:
        self._client: Optional[Groq] = None

    @property
    def client(self) -> Optional[Groq]:
        """Lazily create and cache the Groq client if a key is configured."""
        if self._client is None and settings.groq_configured:
            self._client = Groq(api_key=settings.groq_api_key)
        return self._client

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    async def analyze_join(self, request: JoinAnalysisRequest) -> SecurityAnalysisResponse:
        """AI join analysis. Falls back to a heuristic when Groq is unavailable."""
        if not settings.groq_configured:
            logger.warning("Groq not configured; using join-analysis heuristic fallback.")
            return self._join_heuristic(request)
        try:
            return self._call_groq(
                JOIN_SYSTEM_PROMPT,
                build_join_prompt(request.model_dump()),
            )
        except Exception as exc:  # noqa: BLE001 - robust catch-all by design.
            logger.error("Groq join analysis failed (%s); using heuristic fallback.", exc)
            return self._join_heuristic(request)

    async def analyze_event(self, request: SecurityEventRequest) -> SecurityAnalysisResponse:
        """AI event analysis. Falls back to a heuristic when Groq is unavailable."""
        if not settings.groq_configured:
            logger.warning("Groq not configured; using event-analysis heuristic fallback.")
            return self._event_heuristic(request)
        try:
            return self._call_groq(
                EVENT_SYSTEM_PROMPT,
                build_event_prompt(request.model_dump()),
            )
        except Exception as exc:  # noqa: BLE001
            logger.error("Groq event analysis failed (%s); using heuristic fallback.", exc)
            return self._event_heuristic(request)

    # ------------------------------------------------------------------ #
    # Groq call + validation
    # ------------------------------------------------------------------ #

    def _call_groq(self, system_prompt: str, user_prompt: str) -> SecurityAnalysisResponse:
        """Perform the Groq chat completion and validate the JSON result."""
        completion = self.client.chat.completions.create(  # type: ignore[union-attr]
            model=settings.groq_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.0,  # deterministic security decisions
            max_tokens=500,
            response_format={"type": "json_object"},
        )
        raw = completion.choices[0].message.content or "{}"
        return self._validate(json.loads(raw), ai_available=True)

    def _validate(self, data: dict, ai_available: bool) -> SecurityAnalysisResponse:
        """Coerce a raw model dict into a safe SecurityAnalysisResponse."""
        # Risk score -> int clamped to [0, 100].
        try:
            risk_score = int(round(float(data.get("risk_score", 0))))
        except (TypeError, ValueError):
            risk_score = 0
        risk_score = max(0, min(100, risk_score))

        # Confidence -> clamp to [0, 1].
        try:
            confidence = float(data.get("confidence", 0.0))
        except (TypeError, ValueError):
            confidence = 0.0
        confidence = max(0.0, min(1.0, confidence))

        # Threat level MUST match the score band (never trust the model here).
        threat_level = _classify(risk_score)

        # Recommended action -> validated enum; policy: never stronger than
        # ban_recommendation (the enum has nothing stronger by construction).
        action_raw = str(data.get("recommended_action", "ignore")).lower()
        try:
            recommended = RecommendedAction(action_raw)
        except ValueError:
            recommended = RecommendedAction.IGNORE

        reasons = data.get("reasons")
        if not isinstance(reasons, list):
            reasons = []
        reasons = [str(r)[:200] for r in reasons if r][:6]

        explanation = str(data.get("explanation") or "").strip()[:300]
        violated_rule = data.get("violated_rule")
        violated_rule = str(violated_rule)[:100] if violated_rule else None

        return SecurityAnalysisResponse(
            risk_score=risk_score,
            threat_level=threat_level,
            confidence=confidence,
            reasons=reasons or ["No reasons provided"],
            explanation=explanation,
            violated_rule=violated_rule,
            recommended_action=recommended,
            ai_available=ai_available,
        )

    # ------------------------------------------------------------------ #
    # Heuristic fallbacks (Groq unavailable)
    # ------------------------------------------------------------------ #

    def _join_heuristic(self, request: JoinAnalysisRequest) -> SecurityAnalysisResponse:
        """Deterministic join fallback: trust the bot's local score + history."""
        score = request.local_risk_score
        reasons = list(request.identity_findings[:4])

        if request.previous_bans > 0:
            score = max(score, 70)
            reasons.append(f"Previously banned {request.previous_bans} time(s)")
        if request.is_new_account and request.has_default_avatar:
            score = max(score, 45)
            reasons.append("New account with default avatar")

        score = max(0, min(100, score))
        level = _classify(score)
        action = (
            RecommendedAction.MONITOR
            if level in (ThreatLevel.MEDIUM, ThreatLevel.HIGH)
            else RecommendedAction.BAN_RECOMMENDATION
            if level == ThreatLevel.CRITICAL
            else RecommendedAction.IGNORE
        )
        return SecurityAnalysisResponse(
            risk_score=score,
            threat_level=level,
            confidence=0.5,
            reasons=reasons or ["Heuristic assessment (AI unavailable)"],
            explanation="Heuristic join assessment based on local signals.",
            violated_rule=None,
            recommended_action=action,
            ai_available=False,
        )

    def _event_heuristic(self, request: SecurityEventRequest) -> SecurityAnalysisResponse:
        """Deterministic event fallback: trust the local detector's score."""
        score = max(0, min(100, request.local_score))
        level = _classify(score)
        action = (
            RecommendedAction.DELETE_MESSAGE
            if level in (ThreatLevel.MEDIUM, ThreatLevel.HIGH)
            else RecommendedAction.BAN_RECOMMENDATION
            if level == ThreatLevel.CRITICAL
            else RecommendedAction.IGNORE
        )
        return SecurityAnalysisResponse(
            risk_score=score,
            threat_level=level,
            confidence=0.5,
            reasons=[request.context or f"Local detector: {request.event_type}"],
            explanation="Heuristic event assessment based on the local detector.",
            violated_rule=request.event_type,
            recommended_action=action,
            ai_available=False,
        )


# Shared singleton used by the routes.
security_service = SecurityAnalysisService()
