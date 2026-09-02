/**
 * warningStore.js
 * --------------------------------------------------------------------------
 * Durable warning persistence using the bot's existing atomic JSON storage.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'warnings.json');
let cache = null;
let loadingPromise = null;
let writeTimer = null;

function key(guildId, userId) {
  return `${guildId}:${userId}`;
}

async function load() {
  if (cache) return cache;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      cache = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    } catch (error) {
      cache = {};
      if (error.code !== 'ENOENT') {
        // Preserve the existing fail-safe behavior for corrupt data.
      }
    }
    return cache;
  })();
  return loadingPromise;
}

function scheduleFlush() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${DATA_FILE}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
      await fs.rename(tmp, DATA_FILE);
    } catch {
      // In-memory state remains usable if persistence is temporarily unavailable.
    }
  }, 250);
}

function normalizeWarning(warning) {
  return {
    status: 'active',
    ...warning,
    status: warning.status ?? 'active',
    notes: Array.isArray(warning.notes) ? warning.notes : [],
  };
}

export async function addWarning({
  guildId,
  userId,
  reason,
  moderatorId,
  moderatorTag,
  source = 'command',
  severity = 'medium',
  rule = null,
  ruleTitle = null,
  offendingMessage = null,
  messageId = null,
  eventId = null,
}) {
  const store = await load();
  const k = key(guildId, userId);
  if (!store[k]) store[k] = [];
  const stableEventId = eventId || messageId || null;
  const duplicate = stableEventId && store[k].find((item) => item.eventId === stableEventId);
  if (duplicate) return { warning: normalizeWarning(duplicate), total: countActive(store[k]), duplicate: true };

  const warning = normalizeWarning({
    id: randomUUID(),
    guildId,
    userId,
    reason,
    moderatorId,
    moderatorTag,
    source,
    severity,
    rule,
    ruleTitle,
    offendingMessage,
    messageId,
    eventId: stableEventId,
    timestamp: new Date().toISOString(),
  });
  store[k].push(warning);
  scheduleFlush();
  return { warning, total: countActive(store[k]), duplicate: false };
}

function countActive(warnings) {
  return warnings.filter((warning) => (warning.status ?? 'active') === 'active').length;
}

export async function getWarnings(guildId, userId) {
  const store = await load();
  return (store[key(guildId, userId)] ?? []).map(normalizeWarning);
}

export async function countWarnings(guildId, userId) {
  return countActive(await getWarnings(guildId, userId));
}

export async function getWarningById(guildId, userId, warningId) {
  const warnings = await getWarnings(guildId, userId);
  return warnings.find((warning) => warning.id === warningId) ?? null;
}

export async function findWarningById(userId, warningId) {
  const store = await load();
  for (const [composite, warnings] of Object.entries(store)) {
    if (!composite.endsWith(`:${userId}`)) continue;
    const warning = (warnings ?? []).find((item) => item.id === warningId);
    if (warning) return { guildId: composite.slice(0, -(`:${userId}`).length), warning: normalizeWarning(warning) };
  }
  return null;
}

export async function updateWarning(guildId, userId, warningId, patch) {
  const store = await load();
  const warnings = store[key(guildId, userId)] ?? [];
  const warning = warnings.find((item) => item.id === warningId);
  if (!warning) return null;
  Object.assign(warning, patch, { updatedAt: new Date().toISOString() });
  scheduleFlush();
  return normalizeWarning(warning);
}

export async function dismissWarning(guildId, userId, warningId, { moderatorId, moderatorTag, reason = '' }) {
  return updateWarning(guildId, userId, warningId, {
    status: 'dismissed',
    dismissedBy: moderatorId,
    dismissedByTag: moderatorTag,
    dismissedAt: new Date().toISOString(),
    dismissalReason: reason,
  });
}

export async function appealWarning(guildId, userId, warningId, appealText) {
  return updateWarning(guildId, userId, warningId, {
    status: 'appealed',
    appeal: { text: String(appealText).slice(0, 1000), submittedAt: new Date().toISOString(), userId },
  });
}

export async function addWarningNote(guildId, userId, warningId, { moderatorId, moderatorTag, note }) {
  const warning = await getWarningById(guildId, userId, warningId);
  if (!warning) return null;
  const notes = [...(warning.notes ?? []), {
    moderatorId,
    moderatorTag,
    note: String(note).slice(0, 500),
    timestamp: new Date().toISOString(),
  }];
  return updateWarning(guildId, userId, warningId, { notes });
}

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
