"""
Join Risk Analysis — scores new members 0–100 using ONLY data legitimately
available via the Discord API + this bot's own stored history.

Factors (weights sum to a max of 100, clamped):
  • account age (newer ⇒ riskier)
  • default avatar
  • random-looking / deceptive username
  • rejoin history in this server (slightly LOWERS risk — known member)
  • joining during an active raid window
No IP / device / email / phone signals are ever claimed — Discord does not
expose them and this module never guesses.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import discord

# username heuristics ----------------------------------------------------

_RANDOM_SUFFIX = re.compile(r"[a-zA-Z]+\d{5,}$")            # e.g. "john482910"
_MANY_DIGITS = re.compile(r"\d{6,}")
_KEYSMASH = re.compile(r"[bcdfghjklmnpqrstvwxz]{6,}", re.I)  # long consonant runs
_DECEPTIVE_WORDS = re.compile(
    r"(nitro|giveaway|free[\W_]*discord|hypesquad|moderat[oe]r|"
    r"discord[\W_]*(staff|support|team)|steamgift)", re.I,
)
_INVISIBLE_CHARS = re.compile(r"[\u200b-\u200f\u2060\ufeff]")


def username_suspicion(name: str) -> tuple[int, list[str]]:
    """Return (0-25 score, reasons) for how suspicious a username looks."""
    score, reasons = 0, []
    if _DECEPTIVE_WORDS.search(name):
        score += 15
        reasons.append("deceptive keywords in username")
    if _RANDOM_SUFFIX.search(name) or _MANY_DIGITS.search(name):
        score += 8
        reasons.append("random numeric suffix")
    if _KEYSMASH.search(name):
        score += 6
        reasons.append("keysmash pattern")
    if _INVISIBLE_CHARS.search(name):
        score += 10
        reasons.append("invisible unicode characters")
    return min(score, 25), reasons


@dataclass(slots=True)
class RiskResult:
    score: int
    level: str                       # low | medium | high
    emoji: str
    account_age_days: float
    factors: dict[str, Any] = field(default_factory=dict)
    recommendation: str = "No action needed"


class RiskAnalyzer:
    """Stateless scorer — thresholds come from per-guild settings."""

    def analyze(
        self,
        member: discord.Member,
        *,
        previous_joins: int,
        during_raid: bool,
        high_threshold: int = 70,
        medium_threshold: int = 40,
    ) -> RiskResult:
        now = datetime.now(timezone.utc)
        created = member.created_at
        age_days = max((now - created).total_seconds() / 86400.0, 0.0)

        factors: dict[str, Any] = {"account_age_days": round(age_days, 2)}
        score = 0

        # account age — exponential decay: brand-new ≈ 45pts, 30d ≈ 15pts, 1y ≈ 1pt
        age_score = int(45 * math.exp(-age_days / 30.0))
        if age_days < 1:
            age_score = 50
        score += age_score
        factors["age_score"] = age_score

        # default avatar
        if member.avatar is None:
            score += 15
            factors["default_avatar"] = True

        # username patterns
        uname_score, uname_reasons = username_suspicion(member.name)
        score += uname_score
        if uname_reasons:
            factors["username_flags"] = uname_reasons

        # raid context
        if during_raid:
            score += 20
            factors["joined_during_raid"] = True

        # server history — a returning member with history is less risky
        if previous_joins > 0:
            factors["previous_joins"] = previous_joins
            if previous_joins >= 3:
                score += 10          # join/leave cycling is itself suspicious
                factors["join_leave_cycling"] = True
            else:
                score -= 10          # known returning member

        # bots added via OAuth are vetted by admins
        if member.bot:
            score = min(score, 30)
            factors["is_bot"] = True

        score = max(0, min(100, score))

        if score >= high_threshold:
            level, emoji = "high", "🔴"
            rec = "Review immediately — consider manual verification or kick"
        elif score >= medium_threshold:
            level, emoji = "medium", "🟡"
            rec = "Keep an eye on first messages"
        else:
            level, emoji = "low", "🟢"
            rec = "No action needed"

        return RiskResult(
            score=score, level=level, emoji=emoji,
            account_age_days=age_days, factors=factors, recommendation=rec,
        )
