/**
 * services/inviteTracker.js
 * ---------------------------------------------------------------------------
 * Tracks guild invite usage so that when a member joins we can determine
 * WHICH invite code was used and WHO the inviter is.
 *
 * How it works:
 *   1. On startup (and on inviteCreate/inviteDelete) we cache every invite's
 *      current `uses` count per guild.
 *   2. When a member joins, we re-fetch the invites and find the one whose
 *      `uses` incremented — that's the invite they used.
 *   3. Vanity URLs are detected as a fallback when no regular invite matched.
 *
 * Requires the bot to have the "Manage Guild" permission to read invites.
 * All functions are best-effort: failures return "Unknown" values rather
 * than throwing.
 * ---------------------------------------------------------------------------
 */

import { logger } from '../utils/logger.js';

/**
 * Per-guild invite cache.
 * Map<guildId, Map<inviteCode, { uses: number, inviterTag: string, inviterId: string }>>
 */
const inviteCache = new Map();

/**
 * Snapshot all invites for a guild into the cache.
 * @param {import('discord.js').Guild} guild
 */
export async function cacheGuildInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    const snapshot = new Map();
    for (const invite of invites.values()) {
      snapshot.set(invite.code, {
        uses: invite.uses ?? 0,
        inviterTag: invite.inviter?.tag ?? 'Unknown',
        inviterId: invite.inviter?.id ?? '',
      });
    }
    inviteCache.set(guild.id, snapshot);
    logger.debug(`Cached ${snapshot.size} invite(s) for guild ${guild.name}.`);
  } catch (error) {
    logger.warn(`Could not cache invites for ${guild.name}: ${error.message} (needs Manage Guild permission).`);
  }
}

/**
 * Cache invites for every guild the client is in. Call once on ready.
 * @param {import('discord.js').Client} client
 */
export async function cacheAllInvites(client) {
  for (const guild of client.guilds.cache.values()) {
    await cacheGuildInvites(guild);
  }
}

/**
 * Record a newly created invite in the cache.
 * @param {import('discord.js').Invite} invite
 */
export function onInviteCreate(invite) {
  if (!invite.guild) return;
  const snapshot = inviteCache.get(invite.guild.id) ?? new Map();
  snapshot.set(invite.code, {
    uses: invite.uses ?? 0,
    inviterTag: invite.inviter?.tag ?? 'Unknown',
    inviterId: invite.inviter?.id ?? '',
  });
  inviteCache.set(invite.guild.id, snapshot);
}

/**
 * Remove a deleted invite from the cache.
 * @param {import('discord.js').Invite} invite
 */
export function onInviteDelete(invite) {
  if (!invite.guild) return;
  inviteCache.get(invite.guild.id)?.delete(invite.code);
}

/**
 * Determine which invite a just-joined member used by diffing the cached
 * `uses` counts against a fresh fetch.
 *
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<{code: string, inviterTag: string, url: string}>}
 */
export async function resolveUsedInvite(guild) {
  const unknown = { code: 'Unknown', inviterTag: 'Unknown', url: 'Unknown' };

  let fresh;
  try {
    fresh = await guild.invites.fetch();
  } catch (error) {
    logger.warn(`Could not fetch invites for ${guild.name}: ${error.message}`);
    return unknown;
  }

  const previous = inviteCache.get(guild.id) ?? new Map();
  let used = null;

  for (const invite of fresh.values()) {
    const before = previous.get(invite.code)?.uses ?? 0;
    if ((invite.uses ?? 0) > before) {
      used = invite;
      break;
    }
  }

  // Update the cache to the fresh snapshot for the next join.
  const snapshot = new Map();
  for (const invite of fresh.values()) {
    snapshot.set(invite.code, {
      uses: invite.uses ?? 0,
      inviterTag: invite.inviter?.tag ?? 'Unknown',
      inviterId: invite.inviter?.id ?? '',
    });
  }
  inviteCache.set(guild.id, snapshot);

  if (used) {
    return {
      code: used.code,
      inviterTag: used.inviter?.tag ?? 'Unknown',
      url: `https://discord.gg/${used.code}`,
    };
  }

  // Fallback: vanity URL (best-effort; per-join vanity uses aren't exposed).
  if (guild.vanityURLCode) {
    return {
      code: guild.vanityURLCode,
      inviterTag: 'Vanity URL',
      url: `https://discord.gg/${guild.vanityURLCode}`,
    };
  }

  return unknown;
}
