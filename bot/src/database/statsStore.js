/**
 * database/statsStore.js
 * ---------------------------------------------------------------------------
 * Phase 6 — Guild-level security statistics (Forge Guardian v2.0).
 *
 * Powers the /security dashboard. Layered on the shared jsonStore (atomic
 * writes, debounced flush, crash-safe). All counters are generated
 * INTERNALLY by the bot — nothing is collected beyond what the Discord Bot
 * API exposes or what the bot itself does.
 *
 * Per guild we store:
 *   totals:     { threatsBlocked, spamBlocked, warnings, timeouts, kicks,
 *                 bans, scamAttempts, raidAttempts, messagesDeleted,
 *                 aiViolations, lockdowns, joins, leaves }
 *   daily:      { "<YYYY-MM-DD>": { warnings, threatsBlocked, spamBlocked,
 *                                    scamAttempts, joins, leaves } }
 *   scanTimes:  rolling list of the last N join-scan durations (ms)
 *
 * All functions are fail-safe: a storage error never throws into callers.
 * ---------------------------------------------------------------------------
 */

import { createJsonStore } from './jsonStore.js';
import { logger } from '../utils/logger.js';

const store = createJsonStore('security-stats.json');

/** Keep only the last N scan durations for the average-scan-time metric. */
const MAX_SCAN_SAMPLES = 100;
/** Keep only the last N days of daily buckets. */
const MAX_DAILY_DAYS = 30;

/** Counter names accepted by incrementStat(). */
export const STAT_KEYS = Object.freeze([
  'threatsBlocked',
  'spamBlocked',
  'warnings',
  'timeouts',
  'kicks',
  'bans',
  'scamAttempts',
  'raidAttempts',
  'messagesDeleted',
  'aiViolations',
  'lockdowns',
  'joins',
  'leaves',
]);

/** Stats that also get a per-day bucket for "today" metrics. */
const DAILY_KEYS = new Set(['warnings', 'threatsBlocked', 'spamBlocked', 'scamAttempts', 'joins', 'leaves']);

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function emptyGuildStats() {
  const totals = {};
  for (const k of STAT_KEYS) totals[k] = 0;
  return { totals, daily: {}, scanTimes: [] };
}

async function getGuildRecord(guildId) {
  const data = await store.read();
  if (!data[guildId]) data[guildId] = emptyGuildStats();
  const rec = data[guildId];
  // Backfill any keys added in later versions.
  if (!rec.totals) rec.totals = {};
  for (const k of STAT_KEYS) if (typeof rec.totals[k] !== 'number') rec.totals[k] = 0;
  if (!rec.daily) rec.daily = {};
  if (!Array.isArray(rec.scanTimes)) rec.scanTimes = [];
  return rec;
}

/**
 * Increment a security counter (and its daily bucket when applicable).
 * @param {string} guildId
 * @param {string} key   one of STAT_KEYS
 * @param {number} [by=1]
 */
export async function incrementStat(guildId, key, by = 1) {
  if (!STAT_KEYS.includes(key)) return;
  try {
    const rec = await getGuildRecord(guildId);
    rec.totals[key] += by;

    if (DAILY_KEYS.has(key)) {
      const day = todayKey();
      if (!rec.daily[day]) rec.daily[day] = {};
      rec.daily[day][key] = (rec.daily[day][key] ?? 0) + by;
      pruneDaily(rec);
    }
    store.flush();
  } catch (error) {
    logger.warn(`statsStore incrementStat(${key}) failed: ${error.message}`);
  }
}

/** Drop daily buckets older than MAX_DAILY_DAYS. */
function pruneDaily(rec) {
  const days = Object.keys(rec.daily).sort();
  while (days.length > MAX_DAILY_DAYS) {
    delete rec.daily[days.shift()];
  }
}

/**
 * Record a join-scan duration (used for the Average Scan Time metric).
 * @param {string} guildId
 * @param {number} ms
 */
export async function recordScanTime(guildId, ms) {
  try {
    const rec = await getGuildRecord(guildId);
    rec.scanTimes.push(Math.max(0, Math.round(ms)));
    if (rec.scanTimes.length > MAX_SCAN_SAMPLES) {
      rec.scanTimes = rec.scanTimes.slice(-MAX_SCAN_SAMPLES);
    }
    store.flush();
  } catch (error) {
    logger.warn(`statsStore recordScanTime failed: ${error.message}`);
  }
}

/**
 * Full statistics snapshot for the /security dashboard.
 * @param {string} guildId
 * @returns {Promise<object>}
 */
export async function getStats(guildId) {
  try {
    const rec = await getGuildRecord(guildId);
    const today = rec.daily[todayKey()] ?? {};
    const avgScanMs =
      rec.scanTimes.length > 0
        ? Math.round(rec.scanTimes.reduce((a, b) => a + b, 0) / rec.scanTimes.length)
        : null;

    return {
      totals: { ...rec.totals },
      today: {
        warnings: today.warnings ?? 0,
        threatsBlocked: today.threatsBlocked ?? 0,
        spamBlocked: today.spamBlocked ?? 0,
        scamAttempts: today.scamAttempts ?? 0,
        joins: today.joins ?? 0,
        leaves: today.leaves ?? 0,
      },
      avgScanMs,
      scanSamples: rec.scanTimes.length,
    };
  } catch (error) {
    logger.warn(`statsStore getStats failed: ${error.message}`);
    const empty = emptyGuildStats();
    return { totals: empty.totals, today: {}, avgScanMs: null, scanSamples: 0 };
  }
}

/**
 * Compute a 0–100 Server Security Rating from the stats + current state.
 * Purely internal heuristic — starts at 100 and deducts for recent trouble.
 *
 * @param {object} stats        from getStats()
 * @param {object} [state]      { raidActive, lockdownActive, aiHealthy }
 * @returns {{score:number, grade:string, label:string}}
 */
export function computeSecurityRating(stats, state = {}) {
  let score = 100;

  const t = stats.today ?? {};
  score -= Math.min(15, (t.warnings ?? 0) * 2);
  score -= Math.min(15, (t.threatsBlocked ?? 0) * 3);
  score -= Math.min(10, (t.scamAttempts ?? 0) * 5);
  if (state.raidActive) score -= 25;
  if (state.lockdownActive) score -= 10;
  if (state.aiHealthy === false) score -= 5;

  score = Math.max(0, Math.min(100, Math.round(score)));

  let grade;
  let label;
  if (score >= 90) { grade = 'A+'; label = '🟢 Excellent'; }
  else if (score >= 80) { grade = 'A'; label = '🟢 Strong'; }
  else if (score >= 70) { grade = 'B'; label = '🔵 Good'; }
  else if (score >= 55) { grade = 'C'; label = '🟡 Fair'; }
  else if (score >= 40) { grade = 'D'; label = '🟠 At Risk'; }
  else { grade = 'F'; label = '🔴 Critical'; }

  return { score, grade, label };
}
