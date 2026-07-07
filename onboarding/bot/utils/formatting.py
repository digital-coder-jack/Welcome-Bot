"""Small shared formatting helpers."""
from __future__ import annotations

from datetime import datetime, timezone


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def human_age(created_at: datetime) -> str:
    """Human-readable account age like '2 years, 3 months' or '5 days'."""
    delta = utcnow() - created_at
    days = delta.days
    if days < 1:
        hours = delta.seconds // 3600
        return f"{hours} hour{'s' if hours != 1 else ''}" if hours else "less than an hour"
    years, rem = divmod(days, 365)
    months, days_left = divmod(rem, 30)
    parts: list[str] = []
    if years:
        parts.append(f"{years} year{'s' if years != 1 else ''}")
    if months:
        parts.append(f"{months} month{'s' if months != 1 else ''}")
    if not parts:
        parts.append(f"{days_left} day{'s' if days_left != 1 else ''}")
    return ", ".join(parts[:2])


def discord_ts(dt: datetime, style: str = "F") -> str:
    """Discord native timestamp markup."""
    return f"<t:{int(dt.timestamp())}:{style}>"


def ordinal(n: int) -> str:
    suffix = "th" if 11 <= (n % 100) <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"
