/**
 * database/securityStore.js
 * ---------------------------------------------------------------------------
 * Phase 1 — Previous History database (Forge Guardian Security System v2.0).
 *
 * Our own durable per-member security history, layered on the shared
 * jsonStore (atomic writes, debounced flush, crash-safe).
 *
 * Per member (`<guildId>:<userId>`) we store:
 *   - joins:        [{ at, inviteCode, inviter, riskScore, threatLevel }]
 *   - leaves:       [{ at }]
 *   - warnings:     [{ at, reason }]
 *   - timeouts:     [{ at, minutes, reason }]
 *   - kicks:        [{ at, reason, moderator }]
 *   - bans:         [{ at, reason, moderator }]
 *   - riskScores:   [{ at, score, threatLevel }]
 *   - rejoinCount:  number of joins after the first
 *
 * All functions are fail-safe: a storage error never throws into callers.
 * ---------------------------------------------------------------------------
 */

import { createJsonStore } from './jsonStore.js';
import { logger } from '../utils/logger.js';
import { incrementStat } from './statsStore.js';
import { bumpProfile } from './profileStore.js';

/**
 * Phase 6/7 wiring: every history record fans out to the guild statistics
 * (statsStore) and the member's permanent profile (profileStore) so the
 * /security dashboard and member profiles stay accurate from ONE place.
 * Best-effort — mirror failures never affect the primary history write.
 */
function mirror(guildId, userId, statKey, profileField) {
  incrementStat(guildId, statKey).catch(() => {});
  if (profileField) bumpProfile(guildId, userId, 'moderation', profileField).catch(() => {});
}

const store = createJsonStore('security-history.json');

/** Cap per-list history so the file can't grow unbounded. */
const MAX_ENTRIES = 50;

function key(guildId, userId) {
  return `${guildId}:${userId}`;
}

function emptyRecord() {
  return {
    joins: [],
    leaves: [],
    warnings: [],
    timeouts: [],
    kicks: [],
    bans: [],
    riskScores: [],
    rejoinCount: 0,
  };
}

/**
 * Get (a copy of) a member's full security history.
 * @param {string} guildId
 * @param {string} userId
 * @returns {Promise<object>} history record (never null).
 */
export async function getSecurityHistory(guildId, userId) {
  try {
    const data = await store.read();
    const record = data[key(guildId, userId)];
    return record ? { ...emptyRecord(), ...record } : emptyRecord();
  } catch (error) {
    logger.warn(`securityStore read failed: ${error.message}`);
    return emptyRecord();
  }
}

/** Internal: append an event to a member's history list (capped). */
async function append(guildId, userId, listName, entry) {
  try {
    const data = await store.read();
    const k = key(guildId, userId);
    if (!data[k]) data[k] = emptyRecord();
    const record = data[k];
    if (!Array.isArray(record[listName])) record[listName] = [];
    record[listName].push(entry);
    if (record[listName].length > MAX_ENTRIES) {
      record[listName] = record[listName].slice(-MAX_ENTRIES);
    }
    store.flush();
    return record;
  } catch (error) {
    logger.warn(`securityStore append(${listName}) failed: ${error.message}`);
    return null;
  }
}

/**
 * Record a join. Also increments rejoinCount when this is not the first join.
 * @returns {Promise<object|null>} the updated record.
 */
export async function recordJoin(guildId, userId, { inviteCode = 'Unknown', inviter = 'Unknown' } = {}) {
  try {
    const data = await store.read();
    const k = key(guildId, userId);
    if (!data[k]) data[k] = emptyRecord();
    const record = data[k];
    if (!Array.isArray(record.joins)) record.joins = [];
    if (record.joins.length > 0) {
      record.rejoinCount = (record.rejoinCount ?? 0) + 1;
    }
    record.joins.push({ at: new Date().toISOString(), inviteCode, inviter });
    if (record.joins.length > MAX_ENTRIES) record.joins = record.joins.slice(-MAX_ENTRIES);
    store.flush();
    incrementStat(guildId, 'joins').catch(() => {});
    return record;
  } catch (error) {
    logger.warn(`securityStore recordJoin failed: ${error.message}`);
    return null;
  }
}

/** Record a leave. */
export function recordLeave(guildId, userId) {
  incrementStat(guildId, 'leaves').catch(() => {});
  return append(guildId, userId, 'leaves', { at: new Date().toISOString() });
}

/** Record a warning. */
export function recordSecurityWarning(guildId, userId, reason = '') {
  mirror(guildId, userId, 'warnings', 'warnings');
  return append(guildId, userId, 'warnings', { at: new Date().toISOString(), reason: String(reason).slice(0, 300) });
}

/** Record a timeout. */
export function recordTimeout(guildId, userId, minutes = 0, reason = '') {
  mirror(guildId, userId, 'timeouts', 'timeouts');
  return append(guildId, userId, 'timeouts', {
    at: new Date().toISOString(),
    minutes,
    reason: String(reason).slice(0, 300),
  });
}

/** Record a kick. */
export function recordKick(guildId, userId, reason = '', moderator = 'Unknown') {
  mirror(guildId, userId, 'kicks', 'kicks');
  return append(guildId, userId, 'kicks', { at: new Date().toISOString(), reason: String(reason).slice(0, 300), moderator });
}

/** Record a ban. */
export function recordBan(guildId, userId, reason = '', moderator = 'Unknown') {
  mirror(guildId, userId, 'bans', 'bans');
  return append(guildId, userId, 'bans', { at: new Date().toISOString(), reason: String(reason).slice(0, 300), moderator });
}

/** Record a computed risk score. */
export function recordRiskScore(guildId, userId, score, threatLevel) {
  return append(guildId, userId, 'riskScores', { at: new Date().toISOString(), score, threatLevel });
}

/**
 * Compact summary used by the risk engine and the AI join analysis.
 * @returns {Promise<object>}
 */
export async function getHistorySummary(guildId, userId) {
  const h = await getSecurityHistory(guildId, userId);
  const lastRisk = h.riskScores[h.riskScores.length - 1] ?? null;
  return {
    previousJoins: h.joins.length,
    previousLeaves: h.leaves.length,
    previousWarnings: h.warnings.length,
    previousTimeouts: h.timeouts.length,
    previousKicks: h.kicks.length,
    previousBans: h.bans.length,
    rejoinCount: h.rejoinCount ?? 0,
    lastRiskScore: lastRisk?.score ?? null,
    lastThreatLevel: lastRisk?.threatLevel ?? null,
  };
}
