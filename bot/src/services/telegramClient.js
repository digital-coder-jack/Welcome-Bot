/**
 * services/telegramClient.js
 * ---------------------------------------------------------------------------
 * HTTP client for the backend's /telegram/* notification endpoints.
 *
 * The Discord bot NEVER talks to Telegram directly — every notification is
 * relayed through the FastAPI backend, which is the single API for:
 *   • AI moderation           POST /moderate
 *   • Join notifications      POST /telegram/member-joined
 *   • Leave notifications     POST /telegram/member-left
 *   • Warning notifications   POST /telegram/warning
 *   • Kick notifications      POST /telegram/kick
 *   • Ban notifications       POST /telegram/ban
 *   • Security alerts         POST /telegram/security-alert
 *
 * Reliability principles:
 *   - Every request is bounded by a timeout (AbortController).
 *   - Every call "fails open": a backend/network error never throws into the
 *     caller — the bot's Discord-side flow must never break because Telegram
 *     is down.
 * ---------------------------------------------------------------------------
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';

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
 * POST a JSON payload to a backend /telegram/* endpoint (best-effort).
 * @param {string} endpoint  e.g. '/telegram/member-joined'
 * @param {object} payload
 * @returns {Promise<boolean>} whether the backend confirmed delivery.
 */
async function post(endpoint, payload) {
  const url = `${config.ai.baseUrl.replace(/\/$/, '')}${endpoint}`;

  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      logger.warn(`Backend returned HTTP ${response.status} for ${endpoint}`);
      return false;
    }

    const data = await response.json().catch(() => ({}));
    if (data.success) {
      logger.debug(`Telegram notification delivered via ${endpoint}.`);
      return true;
    }
    logger.warn(`Backend accepted ${endpoint} but Telegram delivery failed: ${data.message ?? 'unknown'}`);
    return false;
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'timed out' : error.message;
    logger.warn(`Telegram notify request failed for ${endpoint} (${reason}); failing open.`);
    return false;
  }
}

/**
 * Notify the backend that a member joined.
 * @param {object} payload  matches backend MemberJoinedPayload schema.
 * @returns {Promise<boolean>}
 */
export function notifyMemberJoined(payload) {
  return post('/telegram/member-joined', payload);
}

/**
 * Notify the backend that a member left.
 * @param {object} payload  matches backend MemberLeftPayload schema.
 * @returns {Promise<boolean>}
 */
export function notifyMemberLeft(payload) {
  return post('/telegram/member-left', payload);
}

/**
 * Notify the backend that a warning was issued.
 * @param {object} payload  matches backend WarningPayload schema.
 * @returns {Promise<boolean>}
 */
export function notifyWarning(payload) {
  return post('/telegram/warning', payload);
}

/**
 * Notify the backend that a member was kicked.
 * @param {object} payload  matches backend KickPayload schema.
 * @returns {Promise<boolean>}
 */
export function notifyKick(payload) {
  return post('/telegram/kick', payload);
}

/**
 * Notify the backend that a member was banned.
 * @param {object} payload  matches backend BanPayload schema.
 * @returns {Promise<boolean>}
 */
export function notifyBan(payload) {
  return post('/telegram/ban', payload);
}

/**
 * Send a security alert through the backend.
 * @param {object} payload  matches backend SecurityAlertPayload schema.
 * @returns {Promise<boolean>}
 */
export function notifySecurityAlert(payload) {
  return post('/telegram/security-alert', payload);
}

/* ------------------------------------------------------------------ */
/* Forge Guardian Security System v2.0 — additional notifications      */
/* ------------------------------------------------------------------ */

/**
 * Notify the backend that a member was timed out.
 * @param {object} payload  matches backend TimeoutPayload schema.
 * @returns {Promise<boolean>}
 */
export function notifyTimeout(payload) {
  return post('/telegram/timeout', payload);
}

/**
 * Send a rich HIGH-RISK JOIN report (risk score, threat level, reasons,
 * identity/account findings) to Telegram.
 * @param {object} payload  matches backend HighRiskJoinPayload schema.
 * @returns {Promise<boolean>}
 */
export function notifyHighRiskJoin(payload) {
  return post('/telegram/high-risk-join', payload);
}

/**
 * Send an Owner Approval Request notification (a HIGH/CRITICAL security
 * alert is awaiting a human decision in Discord).
 * @param {object} payload  matches backend OwnerApprovalPayload schema.
 * @returns {Promise<boolean>}
 */
export function notifyOwnerApproval(payload) {
  return post('/telegram/owner-approval', payload);
}
