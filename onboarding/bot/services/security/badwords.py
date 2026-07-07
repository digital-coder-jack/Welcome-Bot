"""
Bad Word Filter — custom word list with regex support, unicode
normalization and leetspeak/similar-character bypass detection.

Word list entries (configured per guild via the dashboard):
  • "word"          — plain, matched on word boundaries after normalization
  • "regex:pattern" — raw regex, case-insensitive

Compiled patterns are cached per guild and invalidated when the list changes.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from bot.core.logging import get_logger

log = get_logger("security.badwords")

# leet / homoglyph folding applied AFTER NFKC normalization + casefold
_SUBSTITUTIONS = str.maketrans({
    "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b",
    "@": "a", "$": "s", "!": "i", "|": "i", "+": "t",
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y",  # cyrillic
})
_SEPARATORS = re.compile(r"[\s._\-*~`'\"^]+")


def fold(text: str) -> str:
    """Normalize text so 'b @ d w 0 r d' folds to 'badword'."""
    text = unicodedata.normalize("NFKC", text).casefold()
    text = text.translate(_SUBSTITUTIONS)
    return _SEPARATORS.sub("", text)


@dataclass(slots=True)
class BadWordVerdict:
    matched: bool
    word: str | None = None
    via: str = ""                      # plain | folded | regex


@dataclass(slots=True)
class _Compiled:
    plain: list[str] = field(default_factory=list)          # folded words
    patterns: list[re.Pattern] = field(default_factory=list)
    source_key: str = ""


class BadWordFilter:
    """Guild-scoped compiled filter with cache."""

    def __init__(self) -> None:
        self._cache: dict[int, _Compiled] = {}

    def _compile(self, guild_id: int, words: list[str]) -> _Compiled:
        key = "|".join(words)
        cached = self._cache.get(guild_id)
        if cached and cached.source_key == key:
            return cached

        compiled = _Compiled(source_key=key)
        for entry in words:
            entry = entry.strip()
            if not entry:
                continue
            if entry.startswith("regex:"):
                try:
                    compiled.patterns.append(re.compile(entry[6:], re.I))
                except re.error as exc:
                    log.warning("Invalid badword regex %r: %s", entry, exc)
            else:
                compiled.plain.append(fold(entry))
        self._cache[guild_id] = compiled
        return compiled

    def check(self, guild_id: int, content: str, words: list[str]) -> BadWordVerdict:
        if not content or not words:
            return BadWordVerdict(False)
        compiled = self._compile(guild_id, words)

        folded = fold(content)
        for word in compiled.plain:
            if word and word in folded:
                return BadWordVerdict(True, word=word, via="folded")

        for pattern in compiled.patterns:
            m = pattern.search(content)
            if m:
                return BadWordVerdict(True, word=m.group(0)[:40], via="regex")

        return BadWordVerdict(False)

    def invalidate(self, guild_id: int) -> None:
        self._cache.pop(guild_id, None)
