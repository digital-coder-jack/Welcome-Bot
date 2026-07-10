/**
 * security/raidManager.js
 * ---------------------------------------------------------------------------
 * Phase 3 — Anti Raid (Forge Guardian Security System v2.0).
 *
 * Detects raids (SECURITY_RAID_JOINS joins within SECURITY_RAID_WINDOW_SEC
 * seconds — default 10 joins / 30 s) and activates Raid Mode:
 *
 *   - Pause welcomes (welcomeManager & DMs check isRaidModeActive()).
 *   - Enable verification hint (server-side flag; suspicious accounts blocked).
 *   - Lock the configured channels (deny @everyone SendMessages).
 *   - Enable slowmode on configured channels.
 *   - Block (timeout) obviously suspicious accounts joining during the raid.
 *   - Notify owner + moderators in the alert channel.
 *   - Telegram raid alert via the backend.
 *
 * Raid Mode auto-disables after SECURITY_RAID_MODE_MINUTES and restores
 * channel permissions/slowmode. Everything is best-effort & fail-safe.
 * ---------------------------------------------------------------------------
 */

import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { notifySecurityAlert } from '../services/telegramClient.js';
import { sendLog } from '../services/moderationService.js';
import { getSettings } from '../database/settingsStore.js';

/** Map<guildId, number[]> join timestamps in the rolling window. */
const joinWindow = new Map();

/** Map<guildId, {activatedAt, expiresAt, timer, locked:[], slowmoded:[]}> */
const raidState = new Map();

/** Whether Raid Mode is currently active for a guild. */
export function isRaidModeActive(guildId) {
  return raidState.has(guildId);
}

/** Current raid mode info (or null). */
export function getRaidState(guildId) {
  const s = raidState.get(guildId);
  return s ? { activatedAt: s.activatedAt, expiresAt: s.expiresAt } : null;
}

/**
 * Track a join for raid detection. Returns true when this join happened
 * during (or triggered) raid mode.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {Promise<boolean>} raidActive
 */
export async function trackJoinForRaid(member) {
  const guild = member.guild;
  const now = Date.now();
  const windowMs = config.security.raidWindowSec * 1000;

  const stamps = (joinWindow.get(guild.id) ?? []).filter((t) => now - t < windowMs);
  stamps.push(now);
  joinWindow.set(guild.id, stamps);

  if (isRaidModeActive(guild.id)) {
    await screenRaidJoiner(member).catch(() => {});
    return true;
  }

  if (stamps.length >= config.security.raidJoinThreshold) {
    await activateRaidMode(guild, {
      joinCount: stamps.length,
      windowSec: config.security.raidWindowSec,
      latest: member,
    }).catch((e) => logger.error(`Raid mode activation failed: ${e.message}`));
    await screenRaidJoiner(member).catch(() => {});
    return true;
  }
  return false;
}

/**
 * During raid mode: block obviously suspicious accounts (very new account or
 * default avatar) with a timeout. NEVER bans — human decision required.
 * @param {import('discord.js').GuildMember} member
 */
async function screenRaidJoiner(member) {
  if (member.user.bot) return;
  const ageDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
  const suspicious = ageDays < config.security.newAccountDays || !member.user.avatar;
  if (!suspicious) return;

  if (member.moderatable) {
    await member
      .timeout(config.security.raidModeMinutes * 60 * 1000, 'Raid Mode: suspicious account auto-restricted')
      .then(() => logger.info(`Raid Mode: restricted suspicious joiner ${member.user.tag}.`))
      .catch(() => {});
  }
}

/**
 * Activate Raid Mode for a guild.
 * @param {import('discord.js').Guild} guild
 * @param {{joinCount:number, windowSec:number, latest?:import('discord.js').GuildMember}} info
 */
export async function activateRaidMode(guild, info) {
  if (isRaidModeActive(guild.id)) return;

  const durationMs = config.security.raidModeMinutes * 60 * 1000;
  const state = {
    activatedAt: Date.now(),
    expiresAt: Date.now() + durationMs,
    locked: [],
    slowmoded: [],
    timer: null,
  };
  raidState.set(guild.id, state);
  logger.warn(`🚨 RAID MODE ACTIVATED for ${guild.name}: ${info.joinCount} joins in ${info.windowSec}s.`);

  // --- Lock + slowmode the configured channels (best-effort) ---
  for (const channelId of config.security.raidLockChannelIds) {
    try {
      const channel = await guild.channels.fetch(channelId);
      if (!channel?.isTextBased()) continue;

      // Lock: deny SendMessages for @everyone.
      const everyone = guild.roles.everyone;
      const existing = channel.permissionOverwrites.cache.get(everyone.id);
      const hadDeny = existing?.deny.has(PermissionFlagsBits.SendMessages) ?? false;
      if (!hadDeny) {
        await channel.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason: 'Raid Mode: channel locked' });
        state.locked.push(channelId);
      }

      // Slowmode.
      if ('setRateLimitPerUser' in channel && (channel.rateLimitPerUser ?? 0) < config.security.raidSlowmodeSec) {
        const previous = channel.rateLimitPerUser ?? 0;
        await channel.setRateLimitPerUser(config.security.raidSlowmodeSec, 'Raid Mode: slowmode enabled');
        state.slowmoded.push({ channelId, previous });
      }
    } catch (error) {
      logger.warn(`Raid Mode: could not lock channel ${channelId}: ${error.message}`);
    }
  }

  // --- Notify owner + moderators in the alert channel ---
  try {
    const settings = await getSettings(guild.id);
    const alertChannelId = settings.security.alertChannelId || config.channels.modAlert || config.channels.log;
    if (alertChannelId) {
      const channel = await guild.channels.fetch(alertChannelId).catch(() => null);
      if (channel?.isTextBased()) {
        const embed = new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('🚨 RAID MODE ACTIVATED')
          .setDescription(
            `**${info.joinCount} members joined within ${info.windowSec} seconds.**\n\n` +
              '• Welcomes are paused\n' +
              '• Suspicious new accounts are being auto-restricted (timeout)\n' +
              `• ${state.locked.length} channel(s) locked, ${state.slowmoded.length} slowmoded\n` +
              `• Raid Mode auto-disables <t:${Math.floor(state.expiresAt / 1000)}:R>\n\n` +
              '**No one is being banned automatically — review the member list.**'
          )
          .setTimestamp();
        await channel.send({ content: `<@${guild.ownerId}> @here`, embeds: [embed] });
      }
    }
  } catch (error) {
    logger.warn(`Raid Mode: alert channel notification failed: ${error.message}`);
  }

  // --- Telegram raid alert (via backend; owner-only notifications) ---
  try {
    await notifySecurityAlert({
      alert_type: 'Raid Detected — Raid Mode ACTIVATED',
      severity: 'critical',
      server_name: guild.name,
      username: info.latest?.user?.tag ?? 'Unknown',
      user_id: info.latest?.id ?? '',
      channel: '',
      details:
        `${info.joinCount} joins within ${info.windowSec}s. Raid Mode is active for ` +
        `${config.security.raidModeMinutes} minutes: welcomes paused, channels locked/slowmoded, ` +
        'suspicious accounts auto-restricted. No automatic bans.',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.warn(`Raid Mode: Telegram alert failed: ${error.message}`);
  }

  // --- Moderation log ---
  await sendLog(guild, {
    action: '🚨 Raid Mode Activated',
    color: 0xed4245,
    userTag: 'System',
    userId: guild.client.user.id,
    reason: `${info.joinCount} joins in ${info.windowSec}s`,
  }).catch(() => {});

  // --- Auto-disable timer ---
  state.timer = setTimeout(() => {
    deactivateRaidMode(guild).catch((e) => logger.error(`Raid mode deactivation failed: ${e.message}`));
  }, durationMs);
}

/**
 * Deactivate Raid Mode and restore channels.
 * @param {import('discord.js').Guild} guild
 */
export async function deactivateRaidMode(guild) {
  const state = raidState.get(guild.id);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  raidState.delete(guild.id);

  // Restore locked channels.
  for (const channelId of state.locked) {
    try {
      const channel = await guild.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await channel.permissionOverwrites.edit(
          guild.roles.everyone,
          { SendMessages: null },
          { reason: 'Raid Mode ended: channel unlocked' }
        );
      }
    } catch (error) {
      logger.warn(`Raid Mode: could not unlock channel ${channelId}: ${error.message}`);
    }
  }

  // Restore slowmode.
  for (const { channelId, previous } of state.slowmoded) {
    try {
      const channel = await guild.channels.fetch(channelId);
      if (channel && 'setRateLimitPerUser' in channel) {
        await channel.setRateLimitPerUser(previous, 'Raid Mode ended: slowmode restored');
      }
    } catch (error) {
      logger.warn(`Raid Mode: could not restore slowmode on ${channelId}: ${error.message}`);
    }
  }

  logger.info(`Raid Mode deactivated for ${guild.name}.`);

  // Notify Discord + Telegram (best-effort).
  try {
    const settings = await getSettings(guild.id);
    const alertChannelId = settings.security.alertChannelId || config.channels.modAlert || config.channels.log;
    if (alertChannelId) {
      const channel = await guild.channels.fetch(alertChannelId).catch(() => null);
      if (channel?.isTextBased()) {
        await channel.send('✅ **Raid Mode deactivated.** Channels unlocked and welcomes resumed.');
      }
    }
  } catch {
    /* best-effort */
  }

  try {
    await notifySecurityAlert({
      alert_type: 'Raid Mode Deactivated',
      severity: 'low',
      server_name: guild.name,
      username: 'System',
      user_id: '',
      channel: '',
      details: 'Raid Mode timed out and was automatically disabled. Channels unlocked, welcomes resumed.',
      timestamp: new Date().toISOString(),
    });
  } catch {
    /* best-effort */
  }
}
