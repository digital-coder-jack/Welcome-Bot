"""
services/groq_service.py
---------------------------------------------------------------------------
Encapsulates all interaction with the Groq API for message moderation.

Responsibilities:
  - Lazily construct the Groq client from settings.
  - Call the chat completion API in JSON mode with our moderation prompts.
  - Parse and validate the model's JSON into a ModerationResponse.
  - Degrade gracefully: if Groq is unconfigured or errors, fall back to a
    lightweight local heuristic so the API always returns a usable answer.
---------------------------------------------------------------------------
"""

import json
from typing import Optional

from groq import Groq

from app.prompts.moderation_prompt import SYSTEM_PROMPT, build_user_prompt
from app.schemas.moderation import ModerationAction, ModerationResponse
from app.utils.config import settings
from app.utils.logger import logger

# A small keyword heuristic used ONLY as a fallback when Groq is unavailable.
_FALLBACK_TOXIC_KEYWORDS = {
    "idiot", "stupid", "moron", "loser", "trash", "kill yourself", "kys",
    "shut up", "hate you", "dumbass", "fatass",
}


class GroqModerationService:
    """Service object performing AI moderation via Groq."""

    def __init__(self) -> None:
        self._client: Optional[Groq] = None

    @property
    def client(self) -> Optional[Groq]:
        """Lazily create and cache the Groq client if a key is configured."""
        if self._client is None and settings.groq_configured:
            self._client = Groq(api_key=settings.groq_api_key)
        return self._client

    async def moderate(self, content: str) -> ModerationResponse:
        """
        Analyse a message and return a validated ModerationResponse.

        Falls back to a heuristic if Groq is not configured or the call fails.
        """
        if not settings.groq_configured:
            logger.warning("Groq not configured; using heuristic fallback.")
            return self._heuristic(content)

        try:
            return self._call_groq(content)
        except Exception as exc:  # noqa: BLE001 - we want a robust catch-all here.
            logger.error("Groq moderation failed (%s); using heuristic fallback.", exc)
            return self._heuristic(content)

    def _call_groq(self, content: str) -> ModerationResponse:
        """Perform the actual Groq chat completion and parse the result."""
        completion = self.client.chat.completions.create(  # type: ignore[union-attr]
            model=settings.groq_model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": build_user_prompt(content)},
            ],
            temperature=0.0,  # deterministic moderation decisions
            max_tokens=300,
            response_format={"type": "json_object"},
        )

        raw = completion.choices[0].message.content or "{}"
        data = json.loads(raw)
        return self._validate(data)

    def _validate(self, data: dict) -> ModerationResponse:
        """Coerce a raw dict from the model into a safe ModerationResponse."""
        violation = bool(data.get("violation", False))

        # Confidence -> clamp to [0, 1].
        try:
            confidence = float(data.get("confidence", 0.0))
        except (TypeError, ValueError):
            confidence = 0.0
        confidence = max(0.0, min(1.0, confidence))

        # Rule -> integer 1-10 or None.
        rule = data.get("rule")
        if not (isinstance(rule, int) and 1 <= rule <= 10):
            rule = None

        # Action -> validated enum.
        action_raw = str(data.get("action", "none")).lower()
        try:
            action = ModerationAction(action_raw)
        except ValueError:
            action = ModerationAction.NONE

        reason = str(data.get("reason") or "").strip() or "No reason provided"

        # Enforce internal consistency.
        if not violation:
            rule = None
            action = ModerationAction.NONE
        # Downgrade low-confidence violations to no action.
        elif confidence < settings.min_confidence:
            violation = False
            rule = None
            action = ModerationAction.NONE
            reason = "Below confidence threshold"

        return ModerationResponse(
            violation=violation,
            rule=rule,
            confidence=confidence,
            reason=reason[:120],
            action=action,
        )

    def _heuristic(self, content: str) -> ModerationResponse:
        """
        Deterministic keyword-based fallback used when Groq is unavailable.
        Intentionally conservative to avoid false positives.
        """
        lowered = content.lower()
        for keyword in _FALLBACK_TOXIC_KEYWORDS:
            if keyword in lowered:
                return ModerationResponse(
                    violation=True,
                    rule=6,  # No Toxic Behavior
                    confidence=0.8,
                    reason="Detected toxic/insulting language (heuristic).",
                    action=ModerationAction.WARN,
                )

        return ModerationResponse(
            violation=False,
            rule=None,
            confidence=0.5,
            reason="No violation detected (heuristic).",
            action=ModerationAction.NONE,
        )


# Shared singleton used by the routes.
groq_service = GroqModerationService()
