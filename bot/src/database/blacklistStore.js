/**
 * database/blacklistStore.js
 * ---------------------------------------------------------------------------
 * Phase 8 — Blacklist & Whitelist databases (Forge Guardian v2.0).
 *
 * Per guild we maintain OUR OWN lists (never sourced from anywhere outside
 * this bot — no external "global ban lists"):
 *
 *   blacklist.users:   [{ id, reason, addedBy, addedAt }]  auto-flag on join
 *   blacklist.invites: [{ code, reason, addedBy, addedAt }] blocked invite codes
 *   blacklist.servers: [{ id, reason, addedBy, addedAt }]  blocked server IDs
 *                       (matched against invite links posted in chat)
 *   whitelist.users:   [{ id, reason, addedBy, addedAt }]  bypass live security
 *
 * All functions are fail-safe: a storage error never throws into callers.
 * ---------------------------------------------------------------------------
 */

import { createJsonStore } from './jsonStore.js';
import { logger } from '../utils/logger.js';

const store = createJsonStore('security-lists.json');

const LIST_TYPES = Object.freeze(['users', 'invites', 'servers']);

function emptyRecord() {
  return {
    blacklist: { users: [], invites: [], servers: [] },
    whitelist: { users: [] },
  };
}

async function getGuildRecord(guildId) {
  const data = await store.read();
  if (!data[guildId]) data[guildId] = emptyRecord();
  const rec = data[guildId];
  if (!rec.blacklist) rec.blacklist = emptyRecord().blacklist;
  for (const t of LIST_TYPES) if (!Array.isArray(rec.blacklist[t])) rec.blacklist[t] = [];
  if (!rec.whitelist) rec.whitelist = emptyRecord().whitelist;
  if (!Array.isArray(rec.whitelist.users)) rec.whitelist.users = [];
  return rec;
}

/** Normalise an invite value into a bare code. */
function normalizeInvite(value) {
  return String(value)
    .trim()
    .replace(/^https?:\/\/(www\.)?(discord\.gg|discord(app)?\.com\/invite)\//i, '')
    .replace(/[^\w-]/g, '');
}

/**
 * Add an entry to a blacklist.
 * @param {string} guildId
 * @param {'users'|'invites'|'servers'} type
 * @param {string} value        user ID / invite code|url / server ID
 * @param {string} reason
 * @param {string} addedBy      moderator tag
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function addToBlacklist(guildId, type, value, reason = '', addedBy = 'Unknown') {
  try {
    if (!LIST_TYPES.includes(type)) return { ok: false, message: 'Unknown blacklist type.' };
    const rec = await getGuildRecord(guildId);
    const id = type === 'invites' ? normalizeInvite(value) : String(value).trim();
    if (!id) return { ok: false, message: 'Invalid value.' };

    const list = rec.blacklist[type];
    const field = type === 'invites' ? 'code' : 'id';
    if (list.some((e) => e[field] === id)) return { ok: false, message: 'Already blacklisted.' };

    list.push({ [field]: id, reason: String(reason).slice(0, 300), addedBy, addedAt: new Date().toISOString() });
    store.flush();
    return { ok: true, message: `Added \`${id}\` to the ${type} blacklist.` };
  } catch (error) {
    logger.warn(`blacklistStore add failed: ${error.message}`);
    return { ok: false, message: 'Storage error.' };
  }
}

/**
 * Remove an entry from a blacklist.
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function removeFromBlacklist(guildId, type, value) {
  try {
    if (!LIST_TYPES.includes(type)) return { ok: false, message: 'Unknown blacklist type.' };
    const rec = await getGuildRecord(guildId);
    const id = type === 'invites' ? normalizeInvite(value) : String(value).trim();
    const field = type === 'invites' ? 'code' : 'id';
    const before = rec.blacklist[type].length;
    rec.blacklist[type] = rec.blacklist[type].filter((e) => e[field] !== id);
    if (rec.blacklist[type].length === before) return { ok: false, message: 'Not found on the blacklist.' };
    store.flush();
    return { ok: true, message: `Removed \`${id}\` from the ${type} blacklist.` };
  } catch (error) {
    logger.warn(`blacklistStore remove failed: ${error.message}`);
    return { ok: false, message: 'Storage error.' };
  }
}

/** Whether a user ID is blacklisted. Returns the entry or null. */
export async function isUserBlacklisted(guildId, userId) {
  try {
    const rec = await getGuildRecord(guildId);
    return rec.blacklist.users.find((e) => e.id === String(userId)) ?? null;
  } catch {
    return null;
  }
}

/** Whether an invite code is blacklisted. Returns the entry or null. */
export async function isInviteBlacklisted(guildId, code) {
  try {
    const rec = await getGuildRecord(guildId);
    const norm = normalizeInvite(code);
    return rec.blacklist.invites.find((e) => e.code === norm) ?? null;
  } catch {
    return null;
  }
}

/** Whether a server ID is blacklisted. Returns the entry or null. */
export async function isServerBlacklisted(guildId, serverId) {
  try {
    const rec = await getGuildRecord(guildId);
    return rec.blacklist.servers.find((e) => e.id === String(serverId)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Add a user to the whitelist (bypasses live-security detectors).
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function addToWhitelist(guildId, userId, reason = '', addedBy = 'Unknown') {
  try {
    const rec = await getGuildRecord(guildId);
    const id = String(userId).trim();
    if (rec.whitelist.users.some((e) => e.id === id)) return { ok: false, message: 'Already whitelisted.' };
    rec.whitelist.users.push({ id, reason: String(reason).slice(0, 300), addedBy, addedAt: new Date().toISOString() });
    store.flush();
    return { ok: true, message: `Added <@${id}> to the security whitelist.` };
  } catch (error) {
    logger.warn(`blacklistStore whitelist add failed: ${error.message}`);
    return { ok: false, message: 'Storage error.' };
  }
}

/** Remove a user from the whitelist. */
export async function removeFromWhitelist(guildId, userId) {
  try {
    const rec = await getGuildRecord(guildId);
    const id = String(userId).trim();
    const before = rec.whitelist.users.length;
    rec.whitelist.users = rec.whitelist.users.filter((e) => e.id !== id);
    if (rec.whitelist.users.length === before) return { ok: false, message: 'Not on the whitelist.' };
    store.flush();
    return { ok: true, message: `Removed <@${id}> from the security whitelist.` };
  } catch (error) {
    logger.warn(`blacklistStore whitelist remove failed: ${error.message}`);
    return { ok: false, message: 'Storage error.' };
  }
}

/** Whether a user is whitelisted. */
export async function isUserWhitelisted(guildId, userId) {
  try {
    const rec = await getGuildRecord(guildId);
    return rec.whitelist.users.some((e) => e.id === String(userId));
  } catch {
    return false;
  }
}

/** Full lists snapshot (for the /security whitelist & blacklist views). */
export async function getLists(guildId) {
  try {
    const rec = await getGuildRecord(guildId);
    return {
      blacklist: {
        users: [...rec.blacklist.users],
        invites: [...rec.blacklist.invites],
        servers: [...rec.blacklist.servers],
      },
      whitelist: { users: [...rec.whitelist.users] },
    };
  } catch {
    return emptyRecord();
  }
}
