"""
Spam / mention / duplicate detection — pure in-memory, event-loop friendly.

Tracks a short rolling window of messages per (guild, user) and flags:
  • message-rate flooding          • duplicate / copy-paste (incl. cross-channel)
  • emoji spam                     • excessive capital letters
  • character flooding             • repeated attachments / stickers
  • mention spam (@everyone/@here, users, roles)

Every check returns a SpamVerdict so the cog can log evidence uniformly.
"""
from __future__ import annotations

import hashlib
import re
import time
import unicodedata
from collections import deque
from dataclasses import dataclass
from typing import Any

import discord

_EMOJI_CUSTOM = re.compile(r"<a?:\w+:\d+>")
# broad unicode emoji ranges (good enough for counting, no external deps)
_EMOJI_UNICODE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF]"
)
_REPEATED_CHARS = re.compile(r"(.)\1{9,}")          # same char 10+ times
_REPEATED_SEQ = re.compile(r"(.{3,12})\1{4,}")       # short pattern repeated 5+


def normalize_content(text: str) -> str:
    """Casefold + unicode-normalize so 'ＦＲＥＥ ＮＩＴＲＯ' == 'free nitro'."""
    return unicodedata.normalize("NFKC", text).casefold().strip()


def content_fingerprint(text: str) -> str:
    norm = re.sub(r"\s+", " ", normalize_content(text))
    return hashlib.sha1(norm.encode()).hexdigest()


@dataclass(slots=True)
class SpamVerdict:
    is_spam: bool
    spam_type: str | None = None     # rate|duplicate|emoji|caps|flood|attachments|mentions
    detail: str = ""


@dataclass(slots=True)
class _Msg:
    at: float
    fingerprint: str
    channel_id: int
    had_attachment: bool
    had_sticker: bool


class SpamDetector:
    """Sliding-window per-user message analysis (memory-bounded)."""

    def __init__(self, history_size: int = 12) -> None:
        self._history: dict[tuple[int, int], deque] = {}
        self._history_size = history_size

    def _window(self, guild_id: int, user_id: int) -> deque:
        key = (guild_id, user_id)
        win = self._history.get(key)
        if win is None:
            win = deque(maxlen=self._history_size)
            self._history[key] = win
        return win

    # ── rate / duplicate / repeated media ────────────────────

    def record_and_check(
        self,
        message: discord.Message,
        *,
        rate_limit: int,
        rate_window: int,
        duplicate_limit: int,
    ) -> list[SpamVerdict]:
        assert message.guild is not None
        now = time.monotonic()
        win = self._window(message.guild.id, message.author.id)
        fp = content_fingerprint(message.content) if message.content else ""
        win.append(_Msg(
            at=now, fingerprint=fp, channel_id=message.channel.id,
            had_attachment=bool(message.attachments),
            had_sticker=bool(message.stickers),
        ))

        verdicts: list[SpamVerdict] = []

        # message-rate flooding
        recent = [m for m in win if now - m.at <= rate_window]
        if len(recent) >= rate_limit:
            verdicts.append(SpamVerdict(
                True, "rate",
                f"{len(recent)} messages in {rate_window}s (limit {rate_limit})",
            ))

        # duplicates — same fingerprint, any channel (cross-channel copy-paste)
        if fp:
            dupes = [m for m in win if m.fingerprint == fp and now - m.at <= 120]
            if len(dupes) >= duplicate_limit:
                channels = {m.channel_id for m in dupes}
                kind = "cross-channel copy-paste" if len(channels) > 1 else "repeated message"
                verdicts.append(SpamVerdict(
                    True, "duplicate",
                    f"{kind}: sent {len(dupes)}× within 2 min",
                ))

        # repeated attachments / stickers bursts
        media = [m for m in win if (m.had_attachment or m.had_sticker) and now - m.at <= 30]
        if len(media) >= 4:
            verdicts.append(SpamVerdict(
                True, "attachments", f"{len(media)} attachments/stickers in 30s",
            ))

        return verdicts

    # ── single-message content checks ────────────────────────

    @staticmethod
    def check_content(
        content: str,
        *,
        emoji_limit: int,
        caps_ratio: float,
        caps_min_length: int,
    ) -> list[SpamVerdict]:
        verdicts: list[SpamVerdict] = []
        if not content:
            return verdicts

        emoji_count = len(_EMOJI_CUSTOM.findall(content)) + len(
            _EMOJI_UNICODE.findall(content))
        if emoji_count > emoji_limit:
            verdicts.append(SpamVerdict(
                True, "emoji", f"{emoji_count} emojis (limit {emoji_limit})"))

        letters = [c for c in content if c.isalpha()]
        if len(letters) >= caps_min_length:
            upper = sum(1 for c in letters if c.isupper())
            ratio = upper / len(letters)
            if ratio >= caps_ratio:
                verdicts.append(SpamVerdict(
                    True, "caps", f"{ratio:.0%} capital letters"))

        if _REPEATED_CHARS.search(content) or _REPEATED_SEQ.search(content):
            verdicts.append(SpamVerdict(True, "flood", "character/pattern flooding"))

        return verdicts

    # ── mention analysis ─────────────────────────────────────

    @staticmethod
    def check_mentions(
        message: discord.Message,
        *,
        user_limit: int,
        role_limit: int,
    ) -> SpamVerdict:
        details: list[str] = []
        if message.mention_everyone:
            details.append("@everyone/@here abuse")
        if len(message.mentions) > user_limit:
            details.append(f"{len(message.mentions)} user mentions (limit {user_limit})")
        if len(message.role_mentions) > role_limit:
            details.append(f"{len(message.role_mentions)} role mentions (limit {role_limit})")
        if details:
            return SpamVerdict(True, "mentions", "; ".join(details))
        return SpamVerdict(False)

    # ── housekeeping ─────────────────────────────────────────

    def prune(self, max_age: float = 600.0) -> None:
        """Drop stale per-user windows (called periodically by the cog)."""
        now = time.monotonic()
        stale = [k for k, win in self._history.items()
                 if not win or now - win[-1].at > max_age]
        for k in stale:
            del self._history[k]

    def stats(self) -> dict[str, Any]:
        return {"tracked_users": len(self._history)}
