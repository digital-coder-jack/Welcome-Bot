/**
 * security/identityAnalyzer.js
 * ---------------------------------------------------------------------------
 * Phase 1 — Identity Analysis (Forge Guardian Security System v2.0).
 *
 * Pure, side-effect-free analysis of a member's identity surface:
 *   - Username
 *   - Global display name
 *   - Server nickname
 *
 * Detections:
 *   - Invisible Unicode characters
 *   - Zero-width characters
 *   - Homoglyph attacks (Cyrillic/Greek/fullwidth look-alikes)
 *   - Emoji abuse
 *   - Scam keywords
 *   - Fake Staff / Moderator / Admin / Discord Employee impersonation
 *
 * Every detector returns findings that feed the risk engine. This module
 * NEVER touches Discord and NEVER throws — a malformed name simply produces
 * an empty analysis (fail safe).
 * ---------------------------------------------------------------------------
 */

/** Zero-width & joiner characters frequently used to evade filters. */
const ZERO_WIDTH_REGEX = /[\u200B\u200C\u200D\u2060\uFEFF]/g;

/** Broader invisible / formatting Unicode (excludes normal whitespace). */
const INVISIBLE_REGEX =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u2000-\u200F\u2028-\u202F\u205F-\u206F\u3164\uFE00-\uFE0F\uFFA0]/g;

/** Custom Discord emoji + Unicode pictographs. */
const CUSTOM_EMOJI_REGEX = /<a?:\w+:\d+>/g;
const UNICODE_EMOJI_REGEX = /\p{Extended_Pictographic}/gu;

/**
 * Common homoglyph map: visually-confusable characters → ASCII equivalent.
 * Used to normalise a name before impersonation checks and to detect
 * homoglyph attacks (name changes after normalisation).
 */
const HOMOGLYPHS = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ѕ': 's',
  'ԁ': 'd', 'ɡ': 'g', 'ⅼ': 'l', 'ո': 'n', 'ᴍ': 'm', 'ᴡ': 'w', 'ν': 'v', 'κ': 'k', 'τ': 't',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N',
  'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Χ': 'X', 'Υ': 'Y', 'ϲ': 'c', '０': '0', '１': '1',
  '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
  '｜': 'l', 'ℓ': 'l', 'ᖴ': 'F', 'Ꭰ': 'D', 'Ꮯ': 'C', 'Ꮪ': 'S',
};

/** Scam keywords commonly found in malicious usernames. */
const SCAM_KEYWORDS = [
  'free nitro', 'nitro free', 'nitro gift', 'free robux', 'gift card',
  'giveaway winner', 'claim prize', 'crypto pump', 'crypto giveaway',
  'airdrop', 'onlyfans', 'nudes', 'hot girls', 'dm for', 'earn money',
  'make money fast', 'investment', 'double your', 'binance gift',
  'steam gift', 'cs:go skins', 'csgo skins', 'hypesquad events',
];

/** Fake staff / authority impersonation patterns. */
const IMPERSONATION_PATTERNS = [
  { label: 'Fake Discord Employee', pattern: /discord\s*(staff|employee|team|support|security|hypesquad|admin|mod)/i },
  { label: 'Fake System/Official', pattern: /^(system|official|verification|verify\s*bot|announcements?)$/i },
  { label: 'Fake Admin', pattern: /\b(admin|administrator|owner)\b/i },
  { label: 'Fake Moderator', pattern: /\b(mod|moderator)\b/i },
  { label: 'Fake Staff', pattern: /\b(staff|support\s*team|helpdesk)\b/i },
];

/**
 * Normalise a name: strip invisibles, fold homoglyphs to ASCII, lowercase.
 * @param {string} name
 * @returns {string}
 */
export function normalizeName(name) {
  if (!name || typeof name !== 'string') return '';
  let out = name.normalize('NFKC').replace(ZERO_WIDTH_REGEX, '').replace(INVISIBLE_REGEX, '');
  out = [...out].map((ch) => HOMOGLYPHS[ch] ?? ch).join('');
  return out.toLowerCase().trim();
}

/**
 * Analyse a single name string. Never throws.
 * @param {string} name
 * @param {string} kind  'username' | 'displayName' | 'nickname'
 * @returns {{kind:string, raw:string, normalized:string, findings:string[], score:number}}
 */
export function analyzeName(name, kind) {
  const result = { kind, raw: name ?? '', normalized: '', findings: [], score: 0 };
  try {
    if (!name || typeof name !== 'string') return result;

    const zeroWidth = (name.match(ZERO_WIDTH_REGEX) || []).length;
    const invisible = (name.match(INVISIBLE_REGEX) || []).length;
    const customEmoji = (name.match(CUSTOM_EMOJI_REGEX) || []).length;
    const unicodeEmoji = (name.match(UNICODE_EMOJI_REGEX) || []).length;

    result.normalized = normalizeName(name);

    if (zeroWidth > 0) {
      result.findings.push(`Zero-width characters (${zeroWidth})`);
      result.score += 15;
    }
    if (invisible > 0) {
      result.findings.push(`Invisible Unicode characters (${invisible})`);
      result.score += 10;
    }

    // Homoglyph attack: normalisation changed alphanumeric content.
    const asciiOnly = name.normalize('NFKC').replace(ZERO_WIDTH_REGEX, '').replace(INVISIBLE_REGEX, '');
    const folded = [...asciiOnly].map((ch) => HOMOGLYPHS[ch] ?? ch).join('');
    if (folded !== asciiOnly && /[a-z]/i.test(folded)) {
      result.findings.push('Homoglyph / look-alike characters');
      result.score += 20;
    }

    // Emoji abuse (many emojis in a name is a common troll/raid marker).
    const emojiTotal = customEmoji + unicodeEmoji;
    if (emojiTotal >= 4) {
      result.findings.push(`Emoji abuse (${emojiTotal} emojis)`);
      result.score += 10;
    }

    // Scam keywords.
    for (const keyword of SCAM_KEYWORDS) {
      if (result.normalized.includes(keyword)) {
        result.findings.push(`Scam keyword: "${keyword}"`);
        result.score += 30;
        break;
      }
    }

    // Impersonation (checked on the normalised name so homoglyphs don't hide it).
    for (const { label, pattern } of IMPERSONATION_PATTERNS) {
      if (pattern.test(result.normalized)) {
        result.findings.push(label);
        result.score += label === 'Fake Discord Employee' ? 35 : 25;
        break; // first (most severe) match wins
      }
    }
  } catch {
    // Fail safe: return whatever was collected so far.
  }
  return result;
}

/**
 * Analyse the complete identity surface of a member.
 * @param {import('discord.js').GuildMember} member
 * @returns {{names:object[], findings:string[], score:number, clean:boolean}}
 */
export function analyzeIdentity(member) {
  const out = { names: [], findings: [], score: 0, clean: true };
  try {
    const username = member.user?.username ?? '';
    const globalName = member.user?.globalName ?? '';
    const nickname = member.nickname ?? '';

    const checks = [
      analyzeName(username, 'username'),
      globalName && globalName !== username ? analyzeName(globalName, 'displayName') : null,
      nickname && nickname !== username ? analyzeName(nickname, 'nickname') : null,
    ].filter(Boolean);

    for (const check of checks) {
      out.names.push(check);
      for (const finding of check.findings) {
        out.findings.push(`[${check.kind}] ${finding}`);
      }
      out.score += check.score;
    }

    out.score = Math.min(100, out.score);
    out.clean = out.findings.length === 0;
  } catch {
    // Fail safe.
  }
  return out;
}
