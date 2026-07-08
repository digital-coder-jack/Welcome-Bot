/**
 * database/memberStore.js
 * ---------------------------------------------------------------------------
 * Persistence layer for member join information (step 6 of the Welcome
 * System: "Save member information").
 *
 * Same design as warningStore.js:
 *   - Zero external database dependency (works out of the box on Wispbyte).
 *   - Durable: records survive bot restarts (persisted to a JSON file).
 *   - Safe: writes are debounced and performed atomically (write-then-rename)
 *     so a crash mid-write can never corrupt the store.
 *
 * Data shape on disk:
 * {
 *   "<guildId>:<userId>": {
 *     username, displayName, userId, guildId, joinedAt, accountCreated,
 *     memberNumber, inviteCode, inviter, isBot, avatarUrl, assignedRole,
 *     dmStatus, leftAt
 *   }
 * }
 * ---------------------------------------------------------------------------
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'members.json');

/** In-memory cache of the whole store (loaded once on first access). */
let cache = null;
/** Prevents concurrent load() races. */
let loadingPromise = null;
/** Debounce timer handle for persistence. */
let writeTimer = null;

/** Build the composite key used to index member records. */
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
    } catch {
      cache = {}; // First run or corrupt file: start fresh.
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
 * Save (or overwrite) a member's join record.
 *
 * @param {object} record
 * @param {string} record.guildId
 * @param {string} record.userId
 * @param {string} record.username
 * @param {string} record.displayName
 * @param {string} record.joinedAt        ISO timestamp
 * @param {string} record.accountCreated  ISO timestamp
 * @param {number} record.memberNumber
 * @param {string} record.inviteCode
 * @param {string} record.inviter
 * @param {boolean} record.isBot
 * @param {string} record.avatarUrl
 * @param {string} record.assignedRole
 * @param {string} record.dmStatus
 * @returns {Promise<object>} the stored record.
 */
export async function saveMember(record) {
  const store = await load();
  const k = key(record.guildId, record.userId);
  store[k] = { ...record, leftAt: null };
  scheduleFlush();
  return store[k];
}

/**
 * Fetch a member's stored join record, or null when unknown.
 * @param {string} guildId
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function getMember(guildId, userId) {
  const store = await load();
  return store[key(guildId, userId)] ?? null;
}

/**
 * Mark a member as having left the server (keeps the record for history).
 * @param {string} guildId
 * @param {string} userId
 * @param {string} leftAt  ISO timestamp
 * @returns {Promise<object|null>} the updated record, if it existed.
 */
export async function markMemberLeft(guildId, userId, leftAt) {
  const store = await load();
  const k = key(guildId, userId);
  if (!store[k]) return null;
  store[k].leftAt = leftAt;
  scheduleFlush();
  return store[k];
}
