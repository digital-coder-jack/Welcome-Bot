/**
 * managers/moderationQueue.js
 * ---------------------------------------------------------------------------
 * The Moderation Queue — pending moderation cases awaiting human review.
 *
 * When a member reaches the warning threshold (or receives a critical
 * warning) the bot NEVER punishes automatically. Instead a case is queued
 * here and a Moderator Approval Panel is posted to the alert channel
 * (see approvalSystem.js).
 *
 * Anti-abuse guarantees provided by this module:
 *   - One open case per (guild, user): duplicate escalations attach to the
 *     existing case instead of spawning a second panel.
 *   - Atomic case claiming: `claimCase` flips the case state exactly once,
 *     so two moderators pressing buttons simultaneously can never both
 *     execute an action (race-condition safe within the single-threaded
 *     event loop).
 *   - Cases persist to disk so a restart never orphans a pending panel.
 * ---------------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import { createJsonStore } from '../database/jsonStore.js';

const store = createJsonStore('modqueue.json');

/** In-memory hard locks preventing concurrent button processing per case. */
const processing = new Set();

/** Case lifecycle states. */
export const CASE_STATES = Object.freeze({
  OPEN: 'open', // panel posted, awaiting a moderator decision
  AWAITING_CONFIRMATION: 'awaiting_confirmation', // kick/ban pressed, confirmation pending
  RESOLVED: 'resolved', // final decision executed / dismissed
});

function key(guildId, userId) {
  return `${guildId}:${userId}`;
}

/**
 * Create (or return the existing) open case for a member.
 *
 * @param {object} params
 * @param {string} params.guildId
 * @param {string} params.userId
 * @param {string} params.userTag
 * @param {string} params.reason        latest escalation reason.
 * @param {string} params.severity      severity of the triggering warning.
 * @param {number} params.warningCount
 * @returns {Promise<{caseData: object, created: boolean}>}
 */
export async function openCase({ guildId, userId, userTag, reason, severity, warningCount }) {
  const data = await store.read();
  const k = key(guildId, userId);
  const existing = data[k];

  if (existing && existing.state !== CASE_STATES.RESOLVED) {
    // Attach the new escalation to the open case instead of duplicating.
    existing.escalations.push({ reason, severity, warningCount, timestamp: new Date().toISOString() });
    store.flush();
    return { caseData: existing, created: false };
  }

  const caseData = {
    caseId: `CASE-${randomUUID().slice(0, 8).toUpperCase()}`,
    guildId,
    userId,
    userTag,
    state: CASE_STATES.OPEN,
    escalations: [{ reason, severity, warningCount, timestamp: new Date().toISOString() }],
    panelMessageId: null,
    panelChannelId: null,
    pendingAction: null, // { action, moderatorId, moderatorTag, requestedAt }
    resolution: null, // { action, moderatorId, moderatorTag, resolvedAt, note }
    createdAt: new Date().toISOString(),
  };
  data[k] = caseData;
  store.flush();
  return { caseData, created: true };
}

/**
 * Look up a case by its id.
 * @param {string} caseId
 * @returns {Promise<object|null>}
 */
export async function getCase(caseId) {
  const data = await store.read();
  return Object.values(data).find((c) => c.caseId === caseId) ?? null;
}

/**
 * Record where the approval panel for a case was posted.
 */
export async function attachPanel(caseId, channelId, messageId) {
  const c = await getCase(caseId);
  if (!c) return;
  c.panelChannelId = channelId;
  c.panelMessageId = messageId;
  store.flush();
}

/**
 * Acquire the short-lived processing lock for a case. Guarantees only one
 * button interaction is being processed for a case at any moment.
 *
 * @param {string} caseId
 * @returns {boolean} true when the lock was acquired.
 */
export function lockCase(caseId) {
  if (processing.has(caseId)) return false;
  processing.add(caseId);
  return true;
}

/** Release the processing lock. Always call from a finally block. */
export function unlockCase(caseId) {
  processing.delete(caseId);
}

/**
 * Move an OPEN case to AWAITING_CONFIRMATION for a high-risk action.
 * Fails (returns null) when the case is not open — e.g. another moderator
 * already claimed it.
 *
 * @param {string} caseId
 * @param {object} pendingAction  { action, moderatorId, moderatorTag }
 * @returns {Promise<object|null>} the case, or null when unavailable.
 */
export async function requestConfirmation(caseId, pendingAction) {
  const c = await getCase(caseId);
  if (!c || c.state !== CASE_STATES.OPEN) return null;
  c.state = CASE_STATES.AWAITING_CONFIRMATION;
  c.pendingAction = { ...pendingAction, requestedAt: new Date().toISOString() };
  store.flush();
  return c;
}

/**
 * Cancel a pending confirmation, returning the case to OPEN.
 * @param {string} caseId
 * @returns {Promise<object|null>}
 */
export async function cancelConfirmation(caseId) {
  const c = await getCase(caseId);
  if (!c || c.state !== CASE_STATES.AWAITING_CONFIRMATION) return null;
  c.state = CASE_STATES.OPEN;
  c.pendingAction = null;
  store.flush();
  return c;
}

/**
 * Resolve a case with a final decision. Only transitions once: a second
 * resolve attempt returns null (idempotency / duplicate-click protection).
 *
 * @param {string} caseId
 * @param {object} resolution  { action, moderatorId, moderatorTag, note }
 * @returns {Promise<object|null>}
 */
export async function resolveCase(caseId, resolution) {
  const c = await getCase(caseId);
  if (!c || c.state === CASE_STATES.RESOLVED) return null;
  c.state = CASE_STATES.RESOLVED;
  c.resolution = { ...resolution, resolvedAt: new Date().toISOString() };
  c.pendingAction = null;
  store.flush();
  return c;
}

/**
 * Whether a member currently has an unresolved case (used to avoid raising
 * duplicate panels while one is already pending).
 */
export async function hasOpenCase(guildId, userId) {
  const data = await store.read();
  const c = data[key(guildId, userId)];
  return Boolean(c && c.state !== CASE_STATES.RESOLVED);
}
