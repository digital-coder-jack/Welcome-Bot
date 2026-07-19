/**
 * aiClient.js
 * ---------------------------------------------------------------------------
 * Thin HTTP client for the FastAPI + Groq moderation backend.
 *
 * The Discord bot communicates with the AI service ONLY through the two
 * documented endpoints:
 *   - POST /moderate  -> analyse a message for rule violations.
 *   - GET  /health    -> readiness / liveness probe.
 *
 * Reliability principles:
 *   - Every request is bounded by a timeout (AbortController).
 *   - The client "fails open": if the backend errors or times out, we return a
 *     safe "no violation" result so message handling never breaks.
 *   - The response is validated and normalised before returning to callers.
 * ---------------------------------------------------------------------------
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * @typedef {Object} ModerationResult
 * @property {boolean} violation
 * @property {number|null} rule
 * @property {string|null} ruleTitle          exact Forge Protocol rule title
 * @property {string|null} offendingMessage   exact offending message text
 * @property {number} confidence
 * @property {string} reason
 * @property {'none'|'delete'|'warn'|'kick'} action
 */

/** A safe default returned whenever the backend can't be trusted/reached. */
const SAFE_RESULT = Object.freeze({
  violation: false,
  rule: null,
  ruleTitle: null,
  offendingMessage: null,
  confidence: 0,
  reason: 'AI analysis unavailable',
  action: 'none',
});

/**
 * Perform a fetch with a hard timeout via AbortController.
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = config.ai.timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalise and validate a raw backend payload into a ModerationResult.
 * Any malformed field is coerced to its safe default.
 * @param {any} data
 * @returns {ModerationResult}
 */
function normalise(data) {
  if (!data || typeof data !== 'object') return { ...SAFE_RESULT };

  const allowedActions = new Set(['none', 'delete', 'warn', 'kick']);
  const action = allowedActions.has(data.action) ? data.action : 'none';

  let confidence = Number(data.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.min(1, Math.max(0, confidence));

  const rule = Number.isInteger(data.rule) ? data.rule : null;

  return {
    violation: Boolean(data.violation),
    rule,
    ruleTitle: typeof data.rule_title === 'string' && data.rule_title ? data.rule_title : null,
    offendingMessage:
      typeof data.offending_message === 'string' && data.offending_message
        ? data.offending_message.slice(0, 200)
        : null,
    confidence,
    reason: typeof data.reason === 'string' && data.reason ? data.reason : 'No reason provided',
    action,
  };
}

/**
 * Send message content to the backend for AI moderation analysis.
 *
 * @param {object} params
 * @param {string} params.content   The message text to analyse.
 * @param {string} [params.authorId]
 * @param {string} [params.channelId]
 * @returns {Promise<ModerationResult>}
 */
export async function analyzeMessage({ content, authorId, channelId }) {
  const url = `${config.ai.baseUrl.replace(/\/$/, '')}/moderate`;

  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, author_id: authorId, channel_id: channelId }),
    });

    if (!response.ok) {
      logger.warn(`AI backend returned HTTP ${response.status} for /moderate`);
      return { ...SAFE_RESULT };
    }

    const data = await response.json();
    return normalise(data);
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'timed out' : error.message;
    logger.warn(`AI moderation request failed (${reason}); failing open.`);
    return { ...SAFE_RESULT };
  }
}

/* ------------------------------------------------------------------ */
/* Forge Guardian Security System v2.0 — AI Security Engine endpoints  */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} JoinAnalysisResult
 * @property {number|null} riskScore     0–100 (null when AI unavailable)
 * @property {'SAFE'|'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'} threatLevel
 * @property {number} confidence         0–1
 * @property {string[]} reasons
 * @property {'ignore'|'monitor'|'timeout'|'kick'|'ban_recommendation'} recommendedAction
 * @property {boolean} aiAvailable
 */

/** Safe default when the AI join analysis is unavailable (fail open). */
const SAFE_JOIN_RESULT = Object.freeze({
  riskScore: null,
  threatLevel: 'SAFE',
  confidence: 0,
  reasons: ['AI join analysis unavailable'],
  recommendedAction: 'ignore',
  aiAvailable: false,
});

const THREAT_LEVELS_SET = new Set(['SAFE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const RECOMMENDED_ACTIONS = new Set(['ignore', 'monitor', 'delete_message', 'warn', 'timeout', 'kick', 'ban_recommendation']);

/** Normalise a raw security-analysis payload from the backend. */
function normaliseSecurity(data, fallback) {
  if (!data || typeof data !== 'object') return { ...fallback };

  let riskScore = Number(data.risk_score);
  riskScore = Number.isFinite(riskScore) ? Math.max(0, Math.min(100, Math.round(riskScore))) : null;

  let confidence = Number(data.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.min(1, Math.max(0, confidence));

  const threatLevel = THREAT_LEVELS_SET.has(String(data.threat_level).toUpperCase())
    ? String(data.threat_level).toUpperCase()
    : 'SAFE';

  const recommendedAction = RECOMMENDED_ACTIONS.has(String(data.recommended_action).toLowerCase())
    ? String(data.recommended_action).toLowerCase()
    : 'ignore';

  const reasons = Array.isArray(data.reasons)
    ? data.reasons.filter((r) => typeof r === 'string').slice(0, 10)
    : [];

  return {
    riskScore,
    threatLevel,
    confidence,
    reasons: reasons.length ? reasons : ['No reasons provided'],
    recommendedAction,
    explanation: typeof data.explanation === 'string' ? data.explanation : '',
    violatedRule: typeof data.violated_rule === 'string' ? data.violated_rule : null,
    aiAvailable: Boolean(data.ai_available ?? true),
  };
}

/**
 * Phase 1/4 — Send the complete member profile to FastAPI for AI join
 * analysis. Groq returns risk score, threat level, confidence, reasons and
 * a recommended action. Fails open to a SAFE result.
 *
 * @param {object} profile  complete member profile (see backend schema).
 * @returns {Promise<JoinAnalysisResult>}
 */
export async function analyzeJoin(profile) {
  const url = `${config.ai.baseUrl.replace(/\/$/, '')}/security/analyze-join`;

  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    });

    if (!response.ok) {
      logger.warn(`AI backend returned HTTP ${response.status} for /security/analyze-join`);
      return { ...SAFE_JOIN_RESULT };
    }

    return normaliseSecurity(await response.json(), SAFE_JOIN_RESULT);
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'timed out' : error.message;
    logger.warn(`AI join analysis failed (${reason}); failing open.`);
    return { ...SAFE_JOIN_RESULT };
  }
}

/**
 * Phase 2/4 — Send a suspicious event (message threat, etc.) to FastAPI for
 * AI analysis. Groq returns threat level, confidence, explanation, violated
 * rule and a recommended action. The AI NEVER bans — at most it returns a
 * 'ban_recommendation'. Fails open to a SAFE result.
 *
 * @param {object} event  { event_type, content, username, user_id, channel, context }
 * @returns {Promise<object>}
 */
export async function analyzeSecurityEvent(event) {
  const url = `${config.ai.baseUrl.replace(/\/$/, '')}/security/analyze-event`;

  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      logger.warn(`AI backend returned HTTP ${response.status} for /security/analyze-event`);
      return { ...SAFE_JOIN_RESULT };
    }

    return normaliseSecurity(await response.json(), SAFE_JOIN_RESULT);
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'timed out' : error.message;
    logger.warn(`AI security-event analysis failed (${reason}); failing open.`);
    return { ...SAFE_JOIN_RESULT };
  }
}

/**
 * Check whether the AI backend is reachable and healthy.
 * @returns {Promise<boolean>}
 */
export async function checkHealth() {
  const url = `${config.ai.baseUrl.replace(/\/$/, '')}/health`;
  try {
    const response = await fetchWithTimeout(url, { method: 'GET' }, 3000);
    return response.ok;
  } catch {
    return false;
  }
}
