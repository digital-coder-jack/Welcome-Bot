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
 * @property {number} confidence
 * @property {string} reason
 * @property {'none'|'delete'|'warn'|'kick'} action
 */

/** A safe default returned whenever the backend can't be trusted/reached. */
const SAFE_RESULT = Object.freeze({
  violation: false,
  rule: null,
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
