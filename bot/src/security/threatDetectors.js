/**
 * security/threatDetectors.js
 * ---------------------------------------------------------------------------
 * Phase 2 — Live Security detectors (Forge Guardian Security System v2.0).
 *
 * Pure, side-effect-free message threat detectors that ADD to (never replace)
 * the existing filters in filters/index.js:
 *
 *   - Scam links / phishing URLs / malware domains
 *   - Fake Nitro / fake giveaways / crypto scams
 *   - Discord invite spam (multiple invites in one message)
 *   - Link spam (many URLs)
 *   - Token leaks (Discord bot/user tokens)
 *   - Unicode abuse / invisible characters in messages
 *   - Mass copy-paste (very long duplicated blocks)
 *   - Channel spam (cross-posting the same content to many channels)
 *
 * Each detector returns null (clean) or a verdict:
 *   { type, reason, severity: 'low'|'medium'|'high'|'critical', score, action }
 *
 * Legacy detectors (spam, flooding, emoji spam, mention spam, CAPS, repeats)
 * continue to live in filters/index.js and still run first.
 * ---------------------------------------------------------------------------
 */

/** URL matcher. */
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

/** Discord invite matcher (same family as filters/index.js). */
const INVITE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg)\/[a-z0-9-]+/gi;

/** Discord token shapes (bot & user tokens, mfa tokens). */
const TOKEN_REGEX = /\b(?:[A-Za-z\d_-]{23,28}\.[A-Za-z\d_-]{6,7}\.[A-Za-z\d_-]{27,}|mfa\.[A-Za-z\d_-]{80,})\b/;

/** Invisible / zero-width characters inside message content. */
const INVISIBLE_MSG_REGEX = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD\u034F\u180E]/g;

/** Known-bad / high-risk domains and URL patterns (phishing, fake nitro, malware). */
const MALICIOUS_DOMAIN_PATTERNS = [
  /d[il1]scord[.-]?(?:n[il1]tro|g[il1]ft|app|airdrop|give)/i, // discord-nitro.xyz, dlscordgift.com...
  /(?:free|get|claim)[-.]?n[il1]tro/i,
  /n[il1]tro[-.]?(?:free|gift|drop|generator)/i,
  /steamc[o0]mmun[il1]ty(?!\.com\b)/i, // fake steam community clones
  /steamcommunutiy|steancommunity|stearncommunity/i,
  /grabify\.link|iplogger\.(?:org|com|ru)|2no\.co|yip\.su|blasze\./i,
  /discorcl|dlscord|discord-app\.(?:net|info|club)|discrod/i,
  /(?:robux|rbx)[-.]?(?:free|gift|generator|claim)/i,
  /bit\.do|shorturl\.at\/[a-z]{4,}/i,
];

/** Scam phrase patterns for message content. */
const SCAM_PHRASES = [
  { label: 'Fake Nitro scam', pattern: /(?:free|claim|get)\s+(?:discord\s+)?nitro|nitro\s+(?:for\s+)?free|nitro\s+giveaway/i, severity: 'high', score: 70 },
  { label: 'Fake giveaway scam', pattern: /(?:you\s+(?:won|win)|winner!?|claim\s+(?:your\s+)?(?:prize|reward|gift))\s*(?:https?:|@|!)/i, severity: 'high', score: 65 },
  { label: 'Crypto scam', pattern: /(?:double\s+your\s+(?:crypto|btc|eth)|crypto\s+giveaway|(?:btc|eth|sol)\s+airdrop|guaranteed\s+(?:profit|returns)|pump\s+signal)/i, severity: 'high', score: 65 },
  { label: 'Steam/trading phishing', pattern: /(?:trade\s+offer|cs:?go\s+skins?|steam\s+gift)\s+.{0,40}https?:/i, severity: 'high', score: 60 },
  { label: 'Account phishing', pattern: /(?:verify\s+your\s+account|account\s+(?:will\s+be\s+)?(?:suspended|deleted|banned))\s+.{0,60}https?:/i, severity: 'critical', score: 80 },
];

/** Detect scam/phishing/malware links & phrases. */
export function detectScamContent(message) {
  const content = message.content ?? '';
  if (!content) return null;

  const urls = content.match(URL_REGEX) || [];
  for (const url of urls) {
    for (const pattern of MALICIOUS_DOMAIN_PATTERNS) {
      if (pattern.test(url)) {
        return {
          type: 'scam-link',
          reason: `Malicious/phishing URL detected: ${url.slice(0, 80)}`,
          severity: 'critical',
          score: 85,
          action: 'delete',
        };
      }
    }
  }

  for (const { label, pattern, severity, score } of SCAM_PHRASES) {
    if (pattern.test(content)) {
      return { type: 'scam-phrase', reason: `${label} detected in message`, severity, score, action: 'delete' };
    }
  }
  return null;
}

/** Detect Discord invite spam (2+ different invites in one message). */
export function detectInviteSpam(message) {
  const invites = message.content?.match(INVITE_REGEX) || [];
  if (new Set(invites.map((i) => i.toLowerCase())).size >= 2) {
    return {
      type: 'invite-spam',
      reason: `Multiple Discord invites in one message (${invites.length})`,
      severity: 'high',
      score: 60,
      action: 'delete',
    };
  }
  return null;
}

/** Detect link spam (4+ URLs in one message). */
export function detectLinkSpam(message) {
  const urls = message.content?.match(URL_REGEX) || [];
  if (urls.length >= 4) {
    return {
      type: 'link-spam',
      reason: `Link spam (${urls.length} URLs in one message)`,
      severity: 'medium',
      score: 45,
      action: 'delete',
    };
  }
  return null;
}

/** Detect leaked Discord tokens. */
export function detectTokenLeak(message) {
  if (TOKEN_REGEX.test(message.content ?? '')) {
    return {
      type: 'token-leak',
      reason: 'Possible Discord token leaked in message',
      severity: 'critical',
      score: 90,
      action: 'delete',
    };
  }
  return null;
}

/** Detect Unicode abuse / invisible-character flooding. */
export function detectUnicodeAbuse(message) {
  const content = message.content ?? '';
  const invisible = (content.match(INVISIBLE_MSG_REGEX) || []).length;
  if (invisible >= 5) {
    return {
      type: 'unicode-abuse',
      reason: `Invisible/zero-width character abuse (${invisible} chars)`,
      severity: 'medium',
      score: 40,
      action: 'delete',
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Stateful detectors: mass copy-paste & channel spam                  */
/* ------------------------------------------------------------------ */

/** Map<guildId:userId, {hash, count, channels:Set, first:number}> */
const pasteTracker = new Map();
const PASTE_WINDOW_MS = 60_000;
const PASTE_MIN_LENGTH = 120;

function cheapHash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * Detect mass copy-paste (same long block 3+ times) and channel spam
 * (same content posted in 3+ different channels within the window).
 */
export function detectMassCopyPaste(message) {
  const content = (message.content ?? '').trim();
  if (content.length < PASTE_MIN_LENGTH) return null;

  const key = `${message.guild.id}:${message.author.id}`;
  const hash = cheapHash(content.toLowerCase());
  const now = Date.now();

  let entry = pasteTracker.get(key);
  if (!entry || entry.hash !== hash || now - entry.first > PASTE_WINDOW_MS) {
    entry = { hash, count: 0, channels: new Set(), first: now };
  }
  entry.count += 1;
  entry.channels.add(message.channel.id);
  pasteTracker.set(key, entry);

  // Opportunistic pruning to bound memory.
  if (pasteTracker.size > 2000) {
    for (const [k, v] of pasteTracker) {
      if (now - v.first > PASTE_WINDOW_MS) pasteTracker.delete(k);
    }
  }

  if (entry.channels.size >= 3) {
    return {
      type: 'channel-spam',
      reason: `Same content cross-posted to ${entry.channels.size} channels`,
      severity: 'high',
      score: 65,
      action: 'delete',
    };
  }
  if (entry.count >= 3) {
    return {
      type: 'mass-copy-paste',
      reason: `Mass copy-paste detected (${entry.count}x the same long block)`,
      severity: 'medium',
      score: 50,
      action: 'delete',
    };
  }
  return null;
}

/**
 * Run all v2 threat detectors in priority order (most severe first).
 * @param {import('discord.js').Message} message
 * @returns {null|object} the first verdict, or null when clean.
 */
export function runThreatDetectors(message) {
  const detectors = [
    detectTokenLeak,
    detectScamContent,
    detectInviteSpam,
    detectMassCopyPaste,
    detectLinkSpam,
    detectUnicodeAbuse,
  ];
  for (const detect of detectors) {
    try {
      const verdict = detect(message);
      if (verdict) return verdict;
    } catch {
      // A broken detector never blocks the pipeline (fail safe).
    }
  }
  return null;
}
