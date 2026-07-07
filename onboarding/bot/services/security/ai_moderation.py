"""
AI Moderation client — analyses messages with the Groq API.

Two operating modes (checked in order):
  1. Direct Groq  — set GROQ_API_KEY (recommended, no extra service needed).
     Uses Groq's OpenAI-compatible REST endpoint in JSON mode.
  2. Backend proxy — set MODERATION_API_URL to reuse the existing FastAPI
     Groq moderation backend (backend/, POST /moderate).

Design goals:
  • assist moderators, never replace them: verdicts below the per-guild
    confidence threshold are ignored by the caller
  • zero impact when unconfigured or unreachable (fail-open)
  • per-user cooldown + content dedupe so busy channels don't hammer the API
"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass

import aiohttp

from bot.core.logging import get_logger
from bot.services.security.spam import content_fingerprint

log = get_logger("security.ai")

_GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

#: minimum seconds between AI checks for the same user
_USER_COOLDOWN = 20.0
#: skip messages shorter than this — small talk is never worth an API call
_MIN_LENGTH = 12

_SYSTEM_PROMPT = """You are the AI moderation assistant for "Developer Forge", \
a friendly Discord community for developers.

Analyse the user message and decide if it clearly violates community standards:
- harassment or personal attacks
- hate speech or discrimination
- threats or incitement of violence
- severe insults / toxic behavior
- self-promotion spam or mass advertising
- scam / phishing attempts

Be conservative: normal conversation, mild profanity, jokes, technical debates,
criticism of code and heated-but-civil disagreement are NOT violations.
Only flag content a reasonable human moderator would act on.

Respond ONLY with a JSON object:
{"violation": bool, "category": "harassment|hate|threat|toxic|spam|scam|other|none",
 "confidence": 0.0-1.0, "reason": "short explanation", 
 "action": "none|warn|delete|timeout"}"""


@dataclass(slots=True)
class AIVerdict:
    checked: bool
    violation: bool = False
    confidence: float = 0.0
    category: str | None = None
    reason: str | None = None
    action: str | None = None


class AIModerationClient:
    """Async Groq moderation client with local rate limiting and dedupe."""

    def __init__(
        self,
        *,
        groq_api_key: str = "",
        groq_model: str = "llama-3.3-70b-versatile",
        backend_url: str = "",
        timeout: float = 10.0,
    ) -> None:
        self._groq_key = groq_api_key
        self._groq_model = groq_model
        self._backend_url = backend_url.rstrip("/") if backend_url else ""
        self._timeout = timeout
        self._session: aiohttp.ClientSession | None = None
        self._user_last_check: dict[tuple[int, int], float] = {}
        self._verdict_cache: dict[str, AIVerdict] = {}

    @property
    def enabled(self) -> bool:
        return bool(self._groq_key or self._backend_url)

    @property
    def mode(self) -> str:
        if self._groq_key:
            return "groq-direct"
        if self._backend_url:
            return "backend-proxy"
        return "disabled"

    async def start(self) -> None:
        if self.enabled:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self._timeout))
            log.info("AI moderation ready — mode=%s model=%s",
                     self.mode, self._groq_model if self._groq_key else "-")
        else:
            log.info("AI moderation disabled (set GROQ_API_KEY or MODERATION_API_URL)")

    async def close(self) -> None:
        if self._session:
            await self._session.close()
            self._session = None

    # ── gatekeeping ──────────────────────────────────────────

    def _should_check(self, guild_id: int, user_id: int, content: str) -> bool:
        if not self.enabled or self._session is None or len(content) < _MIN_LENGTH:
            return False
        now = time.monotonic()
        key = (guild_id, user_id)
        if now - self._user_last_check.get(key, 0.0) < _USER_COOLDOWN:
            return False
        self._user_last_check[key] = now
        return True

    # ── public API ───────────────────────────────────────────

    async def moderate(self, guild_id: int, user_id: int, content: str) -> AIVerdict:
        """Analyse content; returns AIVerdict(checked=False) when skipped."""
        if not self._should_check(guild_id, user_id, content):
            return AIVerdict(checked=False)

        fp = content_fingerprint(content)
        cached = self._verdict_cache.get(fp)
        if cached is not None:
            return cached

        try:
            if self._groq_key:
                verdict = await self._call_groq(content)
            else:
                verdict = await self._call_backend(content)
        except (aiohttp.ClientError, asyncio.TimeoutError, json.JSONDecodeError,
                KeyError, ValueError) as exc:
            log.warning("AI moderation failed (%s) — failing open", exc)
            return AIVerdict(checked=False)

        # bounded cache — dedupe identical spam bursts
        if len(self._verdict_cache) > 500:
            self._verdict_cache.clear()
        self._verdict_cache[fp] = verdict
        return verdict

    # ── transports ───────────────────────────────────────────

    async def _call_groq(self, content: str) -> AIVerdict:
        assert self._session is not None
        payload = {
            "model": self._groq_model,
            "messages": [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": f"Message to analyse:\n{content[:1500]}"},
            ],
            "temperature": 0.0,
            "max_tokens": 200,
            "response_format": {"type": "json_object"},
        }
        headers = {"Authorization": f"Bearer {self._groq_key}"}
        async with self._session.post(_GROQ_URL, json=payload, headers=headers) as resp:
            if resp.status == 429:
                log.warning("Groq rate limited — skipping AI check")
                return AIVerdict(checked=False)
            if resp.status != 200:
                log.warning("Groq HTTP %s: %s", resp.status, (await resp.text())[:200])
                return AIVerdict(checked=False)
            body = await resp.json(content_type=None)

        raw = body["choices"][0]["message"]["content"] or "{}"
        data = json.loads(raw)
        return self._validate(data, category_key="category")

    async def _call_backend(self, content: str) -> AIVerdict:
        assert self._session is not None
        async with self._session.post(
            f"{self._backend_url}/moderate", json={"content": content[:1500]}
        ) as resp:
            if resp.status != 200:
                log.warning("Moderation backend HTTP %s", resp.status)
                return AIVerdict(checked=False)
            data = await resp.json(content_type=None)
        # backend uses "rule" (int) instead of "category"
        data["category"] = str(data.get("rule")) if data.get("rule") is not None else None
        return self._validate(data, category_key="category")

    # ── validation ───────────────────────────────────────────

    @staticmethod
    def _validate(data: dict, *, category_key: str) -> AIVerdict:
        violation = bool(data.get("violation", False))
        try:
            confidence = max(0.0, min(1.0, float(data.get("confidence", 0.0))))
        except (TypeError, ValueError):
            confidence = 0.0
        category = data.get(category_key)
        category = str(category)[:40] if category not in (None, "none") else None
        action = str(data.get("action", "none")).lower()
        if action not in ("none", "warn", "delete", "timeout"):
            action = "none"
        if not violation:
            category, action = None, "none"
        return AIVerdict(
            checked=True,
            violation=violation,
            confidence=confidence,
            category=category,
            reason=(str(data.get("reason") or "")[:200]) or None,
            action=action,
        )
