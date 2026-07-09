/**
 * managers/warningManager.js
 * ---------------------------------------------------------------------------
 * Smart Warning Levels + Risk Scoring on top of the warningStore.
 *
 * Severity ladder:
 *   🟢 low      — minor slip (spam-ish, caps, emojis).
 *   🟡 medium   — clear rule break (advertising, flooding).
 *   🟠 high     — toxicity, harassment.
 *   🔴 critical — threats, hate speech, doxxing. NEVER triggers automatic
 *                 punishment — it raises an URGENT moderation alert instead.
 *
 * Risk score (0-100) blends: warning count, severity mix, recency of
 * violations and account age. It's displayed on the moderation panel to
 * help moderators make an informed decision.
 * ---------------------------------------------------------------------------
 */

import { addWarning, getWarnings, clearWarnings, countWarnings } from '../database/warningStore.js';

/** Severity metadata used for embeds and scoring. */
export const SEVERITIES = Object.freeze({
  low: { id: 'low', label: '🟢 Low', weight: 5, color: 0x57f287 },
  medium: { id: 'medium', label: '🟡 Medium', weight: 12, color: 0xfee75c },
  high: { id: 'high', label: '🟠 High', weight: 22, color: 0xe67e22 },
  critical: { id: 'critical', label: '🔴 Critical', weight: 35, color: 0xed4245 },
});

/** Keyword heuristics for auto-classifying a warning reason. */
const SEVERITY_PATTERNS = [
  { severity: 'critical', pattern: /threat|doxx|dox\b|hate speech|racis|nazi|kill you|swat|csam|groom/i },
  { severity: 'high', pattern: /harass|toxic|slur|attack|nsfw|gore|bully|insult/i },
  { severity: 'medium', pattern: /advertis|invite link|scam|phish|flood|raid|self.?promo/i },
  { severity: 'low', pattern: /spam|caps|emoji|mention|off.?topic/i },
];

/**
 * Classify a warning reason into a severity id.
 * Explicit severity (when provided by a moderator or the AI) wins.
 *
 * @param {string} reason
 * @param {string} [explicit]  optional explicit severity id.
 * @returns {'low'|'medium'|'high'|'critical'}
 */
export function classifySeverity(reason, explicit) {
  if (explicit && SEVERITIES[explicit]) return explicit;
  const text = reason ?? '';
  for (const { severity, pattern } of SEVERITY_PATTERNS) {
    if (pattern.test(text)) return severity;
  }
  return 'medium';
}

/**
 * Issue (persist) a classified warning. Pure data layer — DMs, Telegram,
 * logging and escalation live in moderationService.
 *
 * @param {object} params  same as warningStore.addWarning plus { severity }.
 * @returns {Promise<{warning: object, total: number, severity: string}>}
 */
export async function recordWarning({ guildId, userId, reason, moderatorId, moderatorTag, source = 'command', severity }) {
  const resolved = classifySeverity(reason, severity);
  const { warning, total } = await addWarning({
    guildId,
    userId,
    reason: `[${resolved.toUpperCase()}] ${reason}`,
    moderatorId,
    moderatorTag,
    source,
  });
  return { warning, total, severity: resolved };
}

/**
 * Extract the severity id embedded in a stored warning reason.
 * Backward compatible: pre-upgrade warnings (no [LEVEL] prefix) => medium.
 *
 * @param {object} warning  stored warning record.
 * @returns {'low'|'medium'|'high'|'critical'}
 */
export function severityOf(warning) {
  const match = /^\[(LOW|MEDIUM|HIGH|CRITICAL)\]/.exec(warning.reason ?? '');
  return match ? match[1].toLowerCase() : 'medium';
}

/**
 * Compute a 0-100 risk score for a member.
 *
 * Components:
 *   - Severity-weighted sum of all warnings.
 *   - Recency boost: violations in the last 24h / 7d weigh extra.
 *   - Account-age factor: very new accounts are riskier.
 *
 * @param {object} params
 * @param {Array<object>} params.warnings           stored warnings.
 * @param {number} params.accountCreatedTimestamp   epoch ms.
 * @returns {number} 0-100.
 */
export function computeRiskScore({ warnings, accountCreatedTimestamp }) {
  const now = Date.now();
  let score = 0;

  for (const w of warnings) {
    const sev = SEVERITIES[severityOf(w)];
    score += sev.weight;

    const age = now - new Date(w.timestamp).getTime();
    if (age < 24 * 60 * 60 * 1000) score += 8; // last 24 hours
    else if (age < 7 * 24 * 60 * 60 * 1000) score += 4; // last week
  }

  const accountAgeDays = (now - accountCreatedTimestamp) / (24 * 60 * 60 * 1000);
  if (accountAgeDays < 7) score += 15;
  else if (accountAgeDays < 30) score += 8;

  return Math.min(100, Math.round(score));
}

/**
 * Human-readable risk band for a score.
 * @param {number} score
 * @returns {string}
 */
export function riskBand(score) {
  if (score >= 75) return '🔴 Critical';
  if (score >= 50) return '🟠 High';
  if (score >= 25) return '🟡 Medium';
  return '🟢 Low';
}

/**
 * Full warning profile used by the moderation panel.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {number} accountCreatedTimestamp
 * @returns {Promise<{warnings: object[], count: number, riskScore: number,
 *                    band: string, recent: object[]}>}
 */
export async function getWarningProfile(guildId, userId, accountCreatedTimestamp) {
  const warnings = await getWarnings(guildId, userId);
  const riskScore = computeRiskScore({ warnings, accountCreatedTimestamp });
  const recent = warnings.slice(-3).reverse();
  return {
    warnings,
    count: warnings.length,
    riskScore,
    band: riskBand(riskScore),
    recent,
  };
}

// Re-export the raw store helpers so callers only import one module.
export { getWarnings, clearWarnings, countWarnings };
