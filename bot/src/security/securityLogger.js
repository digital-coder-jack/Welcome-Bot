/**
 * security/securityLogger.js
 * ---------------------------------------------------------------------------
 * Phase 6 — Security event log (Forge Guardian v2.0).
 *
 * Central, durable log of every security event the bot generates internally:
 * join scans, threats blocked, spam blocked, scam attempts, raids,
 * lockdowns, blacklist hits, moderation actions...
 *
 *   - Persisted per guild (rolling, capped) via jsonStore → /security logs.
 *   - Optionally mirrored to the SECURITY_LOG_CHANNEL_ID Discord channel
 *     (entirely optional — silently skipped when unset).
 *   - AI analysis events can additionally be mirrored to
 *     AI_ANALYSIS_CHANNEL_ID (also optional).
 *
 * Everything is best-effort and fail-safe.
 * ---------------------------------------------------------------------------
 */

import { EmbedBuilder } from 'discord.js';
import { createJsonStore } from '../database/jsonStore.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const store = createJsonStore('security-log.json');

/** Keep only the newest N events per guild. */
const MAX_EVENTS = 200;

/** Severity → embed color. */
const SEVERITY_COLORS = Object.freeze({
  info: 0x3498db,
  low: 0x57f287,
  medium: 0xfee75c,
  high: 0xe67e22,
  critical: 0xed4245,
});

/**
 * Record a security event (and mirror it to the optional log channel).
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} event
 * @param {string} event.type       e.g. 'JOIN_SCAN', 'THREAT_BLOCKED', 'RAID'
 * @param {'info'|'low'|'medium'|'high'|'critical'} [event.severity='info']
 * @param {string} event.summary    one-line human summary
 * @param {string} [event.userTag]
 * @param {string} [event.userId]
 * @param {string} [event.details]
 * @param {boolean} [event.ai=false]  mirror to AI_ANALYSIS_CHANNEL_ID too
 */
export async function logSecurityEvent(guild, event) {
  const entry = {
    at: new Date().toISOString(),
    type: String(event.type ?? 'EVENT').slice(0, 40),
    severity: event.severity ?? 'info',
    summary: String(event.summary ?? '').slice(0, 300),
    userTag: event.userTag ?? null,
    userId: event.userId ?? null,
    details: event.details ? String(event.details).slice(0, 500) : null,
  };

  // --- 1. Persist to the rolling per-guild log ---
  try {
    const data = await store.read();
    if (!Array.isArray(data[guild.id])) data[guild.id] = [];
    data[guild.id].push(entry);
    if (data[guild.id].length > MAX_EVENTS) {
      data[guild.id] = data[guild.id].slice(-MAX_EVENTS);
    }
    store.flush();
  } catch (error) {
    logger.warn(`securityLogger persist failed: ${error.message}`);
  }

  // --- 2. Mirror to the optional dedicated security-log channel ---
  const channelId = config.channels.securityLog;
  if (channelId) {
    try {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased()) {
        await channel.send({ embeds: [eventEmbed(entry)] });
      }
    } catch (error) {
      logger.debug(`securityLogger channel mirror failed: ${error.message}`);
    }
  }

  // --- 3. Optionally mirror AI analysis events ---
  if (event.ai && config.channels.aiAnalysis) {
    try {
      const channel = await guild.channels.fetch(config.channels.aiAnalysis).catch(() => null);
      if (channel?.isTextBased()) {
        await channel.send({ embeds: [eventEmbed(entry, '🤖 AI Analysis')] });
      }
    } catch (error) {
      logger.debug(`securityLogger AI channel mirror failed: ${error.message}`);
    }
  }
}

/** Build a compact embed for a log entry. */
function eventEmbed(entry, titlePrefix = '🛡️ Security Event') {
  const embed = new EmbedBuilder()
    .setColor(SEVERITY_COLORS[entry.severity] ?? SEVERITY_COLORS.info)
    .setTitle(`${titlePrefix} — ${entry.type}`)
    .setDescription(entry.summary || '*no summary*')
    .setTimestamp(new Date(entry.at));
  if (entry.userTag) {
    embed.addFields({ name: 'User', value: `${entry.userTag}${entry.userId ? ` (\`${entry.userId}\`)` : ''}`, inline: true });
  }
  embed.addFields({ name: 'Severity', value: entry.severity.toUpperCase(), inline: true });
  if (entry.details) embed.addFields({ name: 'Details', value: entry.details.slice(0, 1024) });
  return embed;
}

/**
 * Fetch the newest events for a guild (newest first).
 * @param {string} guildId
 * @param {number} [limit=15]
 * @returns {Promise<object[]>}
 */
export async function getRecentEvents(guildId, limit = 15) {
  try {
    const data = await store.read();
    const list = Array.isArray(data[guildId]) ? data[guildId] : [];
    return list.slice(-limit).reverse();
  } catch (error) {
    logger.warn(`securityLogger read failed: ${error.message}`);
    return [];
  }
}
