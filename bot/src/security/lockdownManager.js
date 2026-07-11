/**
 * security/lockdownManager.js
 * ---------------------------------------------------------------------------
 * Phase 6 — Manual server lockdown (/security lockdown & /security unlock).
 *
 * Unlike Raid Mode (raidManager.js — automatic, self-expiring), lockdown is
 * a MANUAL admin action that stays active until explicitly unlocked.
 *
 *   - Locks the configured channels (deny @everyone SendMessages).
 *     Uses SECURITY_RAID_LOCK_CHANNEL_IDS when set, otherwise all text
 *     channels the bot can manage.
 *   - Pauses welcomes (guildMemberAdd checks isLockdownActive()).
 *   - Everything is best-effort and fully reversible.
 * ---------------------------------------------------------------------------
 */

import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** Map<guildId, {activatedAt:number, by:string, reason:string, locked:string[]}> */
const lockdownState = new Map();

/** Whether a manual lockdown is currently active for a guild. */
export function isLockdownActive(guildId) {
  return lockdownState.has(guildId);
}

/** Current lockdown info (or null). */
export function getLockdownState(guildId) {
  const s = lockdownState.get(guildId);
  return s ? { activatedAt: s.activatedAt, by: s.by, reason: s.reason, lockedCount: s.locked.length } : null;
}

/**
 * Activate manual lockdown.
 * @param {import('discord.js').Guild} guild
 * @param {{by:string, reason:string}} info
 * @returns {Promise<{ok:boolean, lockedCount:number, message:string}>}
 */
export async function activateLockdown(guild, { by = 'Unknown', reason = 'Manual lockdown' } = {}) {
  if (isLockdownActive(guild.id)) {
    return { ok: false, lockedCount: 0, message: 'Lockdown is already active.' };
  }

  const state = { activatedAt: Date.now(), by, reason, locked: [] };
  lockdownState.set(guild.id, state);

  // Determine target channels: configured list, else every manageable text channel.
  let targets = config.security.raidLockChannelIds;
  if (!targets || targets.length === 0) {
    targets = guild.channels.cache
      .filter((c) => c.isTextBased() && !c.isThread() && c.manageable)
      .map((c) => c.id);
  }

  for (const channelId of targets) {
    try {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) continue;
      const everyone = guild.roles.everyone;
      const existing = channel.permissionOverwrites.cache.get(everyone.id);
      const hadDeny = existing?.deny.has(PermissionFlagsBits.SendMessages) ?? false;
      if (!hadDeny) {
        await channel.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason: `Lockdown by ${by}: ${reason}` });
        state.locked.push(channelId);
      }
    } catch (error) {
      logger.warn(`Lockdown: could not lock channel ${channelId}: ${error.message}`);
    }
  }

  logger.warn(`🔒 LOCKDOWN activated for ${guild.name} by ${by} (${state.locked.length} channel(s) locked).`);
  return { ok: true, lockedCount: state.locked.length, message: `Lockdown active — ${state.locked.length} channel(s) locked.` };
}

/**
 * Deactivate manual lockdown and restore channels.
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<{ok:boolean, unlockedCount:number, message:string}>}
 */
export async function deactivateLockdown(guild) {
  const state = lockdownState.get(guild.id);
  if (!state) return { ok: false, unlockedCount: 0, message: 'No lockdown is active.' };
  lockdownState.delete(guild.id);

  let unlocked = 0;
  for (const channelId of state.locked) {
    try {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased()) {
        await channel.permissionOverwrites.edit(
          guild.roles.everyone,
          { SendMessages: null },
          { reason: 'Lockdown ended: channel unlocked' }
        );
        unlocked += 1;
      }
    } catch (error) {
      logger.warn(`Lockdown: could not unlock channel ${channelId}: ${error.message}`);
    }
  }

  logger.info(`🔓 Lockdown deactivated for ${guild.name} (${unlocked} channel(s) unlocked).`);
  return { ok: true, unlockedCount: unlocked, message: `Lockdown lifted — ${unlocked} channel(s) unlocked.` };
}
