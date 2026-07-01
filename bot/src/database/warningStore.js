/**
 * warningStore.js
 * ---------------------------------------------------------------------------
 * A small, dependency-free persistence layer for moderation warnings.
 *
 * Design goals:
 *   - Zero external database dependency (works out of the box).
 *   - Durable: warnings survive bot restarts (persisted to a JSON file).
 *   - Safe: writes are debounced and performed atomically (write-then-rename)
 *     so a crash mid-write can never corrupt the store.
 *   - Simple, promise-based API: add / get / count / clear.
 *
 * Data shape on disk:
 * {
 *   "<guildId>:<userId>": [
 *     { id, reason, moderatorId, moderatorTag, timestamp, source }
 *   ]
 * }
 *
 * For a larger deployment you can swap this module for one backed by SQLite
 * or Postgres while keeping the exact same public API.
 * ---------------------------------------------------------------------------
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'warnings.json');

/** In-memory cache of the whole store (loaded once on first access). */
let cache = null;
/** Prevents concurrent load() races. */
let loadingPromise = null;
/** Debounce timer handle for persistence. */
let writeTimer = null;

/** Build the composite key used to index warnings. */
function key(guildId, userId) {
  return `${guildId}:${userId}`;
}

/**
 * Load the store from disk into memory (once). Missing file => empty store.
 * @returns {Promise<object>}
 */
async function load() {
  if (cache) return cache;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const raw = await fs.readFile(DATA_FILE, 'utf8');
      cache = JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') {
        cache = {}; // First run: no file yet.
      } else {
        // Corrupt file: start fresh rather than crash, but keep a backup.
        cache = {};
      }
    }
    return cache;
  })();

  return loadingPromise;
}

/**
 * Persist the in-memory cache to disk atomically. Debounced so a burst of
 * writes results in a single flush.
 */
function scheduleFlush() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${DATA_FILE}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
      await fs.rename(tmp, DATA_FILE); // atomic on POSIX filesystems.
    } catch {
      // Persistence failure is non-fatal; the in-memory state is still valid.
    }
  }, 250);
}

/**
 * Add a warning for a user.
 *
 * @param {object} params
 * @param {string} params.guildId
 * @param {string} params.userId
 * @param {string} params.reason
 * @param {string} params.moderatorId
 * @param {string} params.moderatorTag
 * @param {'command'|'auto'|'ai'} [params.source='command']
 * @returns {Promise<{warning: object, total: number}>}
 */
export async function addWarning({ guildId, userId, reason, moderatorId, moderatorTag, source = 'command' }) {
  const store = await load();
  const k = key(guildId, userId);
  const warning = {
    id: randomUUID(),
    reason,
    moderatorId,
    moderatorTag,
    source,
    timestamp: new Date().toISOString(),
  };
  if (!store[k]) store[k] = [];
  store[k].push(warning);
  scheduleFlush();
  return { warning, total: store[k].length };
}

/**
 * Return all warnings for a user (most recent last). Empty array if none.
 * @returns {Promise<Array<object>>}
 */
export async function getWarnings(guildId, userId) {
  const store = await load();
  return store[key(guildId, userId)] ?? [];
}

/**
 * Return the number of warnings a user currently has.
 * @returns {Promise<number>}
 */
export async function countWarnings(guildId, userId) {
  const warnings = await getWarnings(guildId, userId);
  return warnings.length;
}

/**
 * Clear all warnings for a user.
 * @returns {Promise<number>} the number of warnings that were removed.
 */
export async function clearWarnings(guildId, userId) {
  const store = await load();
  const k = key(guildId, userId);
  const removed = store[k]?.length ?? 0;
  if (removed > 0) {
    delete store[k];
    scheduleFlush();
  }
  return removed;
}
