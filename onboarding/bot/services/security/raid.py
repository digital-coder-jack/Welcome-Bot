"""
Raid Detection — sliding-window join monitor.

Keeps an in-memory deque of recent joins per guild; when the configured
threshold is exceeded (optionally weighted by average risk score) a raid
incident opens. The incident stays open while joins keep flowing and
auto-closes after a quiet period.
"""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field

from bot.core.logging import get_logger

log = get_logger("security.raid")

#: seconds of quiet before an active raid is considered over
RAID_COOLDOWN_SECONDS = 120


@dataclass(slots=True)
class _Join:
    user_id: int
    risk: int
    at: float


@dataclass(slots=True)
class RaidState:
    active: bool = False
    raid_id: int | None = None
    joins: deque = field(default_factory=deque)      # deque[_Join]
    started_at: float = 0.0
    last_join_at: float = 0.0

    def involved_ids(self) -> list[int]:
        return [j.user_id for j in self.joins]

    def avg_risk(self) -> int:
        if not self.joins:
            return 0
        return int(sum(j.risk for j in self.joins) / len(self.joins))


class RaidDetector:
    """Per-guild sliding-window raid detection. Purely in-memory & O(1) amortized."""

    def __init__(self) -> None:
        self._states: dict[int, RaidState] = {}

    def state(self, guild_id: int) -> RaidState:
        return self._states.setdefault(guild_id, RaidState())

    def is_active(self, guild_id: int) -> bool:
        return self.state(guild_id).active

    def record_join(
        self,
        guild_id: int,
        user_id: int,
        risk_score: int,
        *,
        threshold: int,
        window_seconds: int,
        min_risk: int,
    ) -> tuple[bool, RaidState]:
        """
        Register a join; returns (raid_just_triggered, state).

        Trigger logic: joins-in-window ≥ threshold, OR half the threshold
        reached while the average risk of those accounts exceeds min_risk
        (small-but-nasty raids).
        """
        now = time.monotonic()
        st = self.state(guild_id)
        st.joins.append(_Join(user_id, risk_score, now))
        st.last_join_at = now

        # evict entries outside the window (keep them while a raid is active
        # so the incident report covers every involved account)
        if not st.active:
            cutoff = now - window_seconds
            while st.joins and st.joins[0].at < cutoff:
                st.joins.popleft()

        if st.active:
            return False, st

        count = len(st.joins)
        avg_risk = st.avg_risk()
        triggered = count >= threshold or (
            count >= max(2, threshold // 2) and avg_risk >= min_risk
        )
        if triggered:
            st.active = True
            st.started_at = now
            log.warning("Raid triggered in guild %s — %d joins, avg risk %d",
                        guild_id, count, avg_risk)
        return triggered, st

    def maybe_end(self, guild_id: int) -> bool:
        """Return True if an active raid has cooled down and was closed."""
        st = self.state(guild_id)
        if st.active and (time.monotonic() - st.last_join_at) > RAID_COOLDOWN_SECONDS:
            self.reset(guild_id)
            return True
        return False

    def reset(self, guild_id: int) -> None:
        self._states[guild_id] = RaidState()
