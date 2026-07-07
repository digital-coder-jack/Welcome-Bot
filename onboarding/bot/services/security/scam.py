"""
Scam / phishing / invite-link detection.

Combines:
  • URL extraction (incl. obfuscated forms like hxxp://, dot-spelling)
  • known-bad domain list + suspicious TLDs + URL shorteners
  • scam phrase heuristics (nitro / giveaway / crypto / steam / verification)
  • Discord invite extraction with per-guild whitelist support

All checks are pure functions over the message content — no network calls,
so scanning stays event-loop friendly at any server size.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from bot.services.security.spam import normalize_content

# ── URL extraction ───────────────────────────────────────────

_URL_RE = re.compile(r"(?:https?|hxxps?)://[^\s<>\"']+", re.I)
_OBFUSCATED_DOT = re.compile(r"\b([\w-]+)\s*(?:\(dot\)|\[dot\]|\[\.\]|\(\.\))\s*([a-z]{2,})\b", re.I)
_BARE_DOMAIN = re.compile(
    r"(?<![\w@.])((?:[\w-]+\.)+(?:com|net|org|gg|io|me|ru|xyz|top|click|link|info|site|online|shop|fun|pw|tk|ml|ga|cf|gq))(/[^\s]*)?",
    re.I,
)

_INVITE_RE = re.compile(
    r"(?:https?://)?(?:www\.)?(?:discord\.(?:gg|io|me|li)|discord(?:app)?\.com/invite)/([\w-]+)",
    re.I,
)

# ── threat intelligence (static, curated) ────────────────────

KNOWN_BAD_DOMAINS: frozenset[str] = frozenset({
    "discordnitro.info", "discord-nitro.com", "discord-gift.com", "discordgift.site",
    "discorcl.com", "dlscord.com", "discrod.com", "discord-app.net", "discordc.gift",
    "steamcommunlty.com", "steamcommunitly.com", "steancommunity.com",
    "free-nitro.com", "nitro-drop.com", "nitrogift.site", "discord-airdrop.com",
    "discords.gifts", "discorb.gift", "disord.gg",
})

URL_SHORTENERS: frozenset[str] = frozenset({
    "bit.ly", "tinyurl.com", "goo.gl", "t.co", "is.gd", "cutt.ly", "rb.gy",
    "shorturl.at", "ow.ly", "buff.ly", "adf.ly", "s.id", "tiny.cc", "v.gd",
})

SUSPICIOUS_TLDS: frozenset[str] = frozenset({
    "tk", "ml", "ga", "cf", "gq", "top", "click", "pw", "xyz", "link",
})

#: domains that never need flagging
SAFE_DOMAINS: frozenset[str] = frozenset({
    "discord.com", "discordapp.com", "discord.gg", "github.com", "gitlab.com",
    "stackoverflow.com", "developer.mozilla.org", "youtube.com", "youtu.be",
    "google.com", "docs.google.com", "wikipedia.org", "npmjs.com", "pypi.org",
    "medium.com", "dev.to", "twitter.com", "x.com", "reddit.com",
    "cloudflare.com", "vercel.com", "netlify.com", "developerforge.dev",
})

_SCAM_PHRASES: tuple[tuple[str, re.Pattern], ...] = (
    ("nitro scam", re.compile(r"free\s*(?:discord\s*)?nitro|nitro\s*(?:for\s*free|giveaway|drop|generator)", re.I)),
    ("fake giveaway", re.compile(r"(?:first|1st)\s*\d+\s*(?:users?|people).{0,30}(?:win|get|claim)|claim\s*your\s*(?:prize|gift|reward)", re.I)),
    ("crypto scam", re.compile(r"(?:double|triple|10x)\s*your\s*(?:crypto|btc|eth|bitcoin)|free\s*(?:crypto|bitcoin|btc|eth)\s*(?:airdrop|giveaway)|guaranteed\s*(?:profit|returns)", re.I)),
    ("steam scam", re.compile(r"free\s*steam\s*(?:gift|wallet|games?|codes?)|steam\s*gift\s*card\s*giveaway", re.I)),
    ("fake verification", re.compile(r"verify\s*your\s*(?:account|identity)\s*(?:here|now|at|via)|account\s*(?:will\s*be\s*)?(?:suspended|deleted|banned)\s*(?:unless|if\s*you\s*don)", re.I)),
    ("password phishing", re.compile(r"(?:enter|confirm|send)\s*your\s*(?:password|token|2fa|credentials)|login\s*(?:here|now)\s*to\s*(?:claim|verify|avoid)", re.I)),
    ("qr login scam", re.compile(r"scan\s*(?:this|the)\s*qr\s*(?:code)?\s*to\s*(?:login|claim|verify|get)", re.I)),
)


@dataclass(slots=True)
class ScamVerdict:
    is_scam: bool
    reasons: list[str] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)
    score: int = 0                       # confidence 0-100


@dataclass(slots=True)
class InviteVerdict:
    has_invite: bool
    codes: list[str] = field(default_factory=list)
    blocked_codes: list[str] = field(default_factory=list)


def _domain_of(url: str) -> str:
    d = re.sub(r"^(?:https?|hxxps?)://", "", url, flags=re.I)
    return d.split("/")[0].split("?")[0].lower().removeprefix("www.").split(":")[0]


def extract_urls(content: str) -> list[str]:
    urls = _URL_RE.findall(content)
    for m in _OBFUSCATED_DOT.finditer(content):
        urls.append(f"{m.group(1)}.{m.group(2)}")
    for m in _BARE_DOMAIN.finditer(content):
        candidate = m.group(0)
        if not any(candidate in u for u in urls):
            urls.append(candidate)
    return list(dict.fromkeys(urls))[:10]


class ScamScanner:
    """Pure content scanner; whitelist comes from per-guild settings."""

    def scan(self, content: str, *, whitelist_domains: list[str]) -> ScamVerdict:
        if not content:
            return ScamVerdict(False)

        norm = normalize_content(content)
        reasons: list[str] = []
        score = 0

        # phrase heuristics
        for label, pattern in _SCAM_PHRASES:
            if pattern.search(norm):
                reasons.append(label)
                score += 35

        # URL analysis
        wl = {d.lower().removeprefix("www.") for d in whitelist_domains} | SAFE_DOMAINS
        urls = extract_urls(content)
        flagged_urls: list[str] = []
        for url in urls:
            domain = _domain_of(url)
            if not domain or domain in wl:
                continue
            if domain in KNOWN_BAD_DOMAINS:
                reasons.append(f"known malicious domain: {domain}")
                score += 70
                flagged_urls.append(url)
            elif domain in URL_SHORTENERS:
                reasons.append(f"URL shortener: {domain}")
                score += 15
                flagged_urls.append(url)
            elif domain.rsplit(".", 1)[-1] in SUSPICIOUS_TLDS:
                reasons.append(f"suspicious TLD: {domain}")
                score += 15
                flagged_urls.append(url)
            elif re.search(r"d[il1]sc[o0]rd|n[il1]tr[o0]|ste[a4]m", domain) and \
                    domain not in SAFE_DOMAINS:
                reasons.append(f"lookalike domain: {domain}")
                score += 50
                flagged_urls.append(url)
        if url_obfuscated := ("hxxp" in norm or _OBFUSCATED_DOT.search(content)):
            reasons.append("obfuscated link formatting")
            score += 20

        # a scam phrase + any off-whitelist link is a strong combined signal
        phrase_hit = any(not r.startswith(("known", "URL", "suspicious", "lookalike",
                                           "obfuscated")) for r in reasons)
        if phrase_hit and (flagged_urls or urls):
            score += 20

        score = min(score, 100)
        return ScamVerdict(
            is_scam=score >= 50,
            reasons=reasons,
            urls=flagged_urls or urls,
            score=score,
        )

    # ── invite protection ────────────────────────────────────

    @staticmethod
    def scan_invites(content: str, *, whitelist_codes: list[str],
                     own_guild_codes: set[str]) -> InviteVerdict:
        codes = [m.group(1) for m in _INVITE_RE.finditer(content)]
        if not codes:
            return InviteVerdict(False)
        allowed = {c.lower() for c in whitelist_codes} | {
            c.lower() for c in own_guild_codes}
        blocked = [c for c in codes if c.lower() not in allowed]
        return InviteVerdict(True, codes=codes, blocked_codes=blocked)
