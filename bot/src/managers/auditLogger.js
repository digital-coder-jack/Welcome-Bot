/**
 * managers/auditLogger.js
 * ---------------------------------------------------------------------------
 * The Moderation Logging System.
 *
 * Every moderation-relevant action (warnings, panel buttons, confirmations,
 * owner overrides, executed punishments) is:
 *
 *   1. Persisted to an append-only audit trail (audit.json) with a unique
 *      audit trail ID.
 *   2. Posted as a rich embed to the moderation log channel including
 *      moderator, timestamp, reason, old/new warning counts, the button
 *      pressed, confirmation status, channel and message link.
 *
 * The audit trail survives restarts and can be exported for review.
 * ---------------------------------------------------------------------------
 */

import { EmbedBuilder } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { createJsonStore } from '../database/jsonStore.js';

const store = createJsonStore('audit.json');

/** Colours per audit action family. */
const ACTION_COLORS = {
  warning: 0xfee75c,
  panel: 0x5865f2,
  timeout: 0xe67e22,
  mute: 0xe67e22,
  kick: 0xed4245,
  ban: 0x992d22,
  ignore: 0x95a5a6,
  reset: 0x57f287,
  override: 0xeb459e,
  note: 0x3498db,
  cancel: 0x95a5a6,
};

/**
 * Persist an audit entry and post it to the log channel.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} entry
 * @param {string} entry.action        e.g. 'Ban Executed', 'Panel: Ignore'.
 * @param {string} [entry.family]      colour family key (see ACTION_COLORS).
 * @param {string} [entry.userTag]     target user tag.
 * @param {string} [entry.userId]      target user id.
 * @param {string} [entry.moderatorTag]
 * @param {string} [entry.moderatorId]
 * @param {string} [entry.reason]
 * @param {number|null} [entry.oldWarningCount]
 * @param {number|null} [entry.newWarningCount]
 * @param {string} [entry.buttonPressed]
 * @param {string} [entry.confirmationStatus]  'confirmed'|'cancelled'|'pending'|'n/a'
 * @param {string} [entry.channelId]
 * @param {string} [entry.messageLink]
 * @param {object[]} [entry.extraFields]
 * @returns {Promise<string>} the audit trail ID.
 */
export async function audit(guild, entry) {
  const auditId = `AUD-${randomUUID().slice(0, 8).toUpperCase()}`;
  const timestamp = new Date().toISOString();

  // 1. Persist to the append-only trail (keyed per guild).
  try {
    const data = await store.read();
    if (!data[guild.id]) data[guild.id] = [];
    data[guild.id].push({ auditId, timestamp, ...sanitize(entry) });
    // Keep the trail bounded (most recent 2000 entries per guild).
    if (data[guild.id].length > 2000) data[guild.id] = data[guild.id].slice(-2000);
    store.flush();
  } catch (error) {
    logger.warn(`Audit persistence failed: ${error.message}`);
  }

  // 2. Post the log embed (best-effort).
  try {
    const channelId = config.channels.log;
    if (channelId) {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased()) {
        await channel.send({ embeds: [auditEmbed(auditId, timestamp, entry)] });
      }
    }
  } catch (error) {
    logger.warn(`Audit log post failed: ${error.message}`);
  }

  return auditId;
}

/** Strip non-serialisable values before persisting. */
function sanitize(entry) {
  const { extraFields, ...rest } = entry;
  return rest;
}

/** Build the rich audit embed. */
function auditEmbed(auditId, timestamp, entry) {
  const color = ACTION_COLORS[entry.family] ?? 0x5865f2;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🛡️ Moderation — ${entry.action}`)
    .setTimestamp(new Date(timestamp));

  const fields = [];
  if (entry.userTag) fields.push({ name: 'User', value: `${entry.userTag}${entry.userId ? ` (${entry.userId})` : ''}`, inline: true });
  if (entry.moderatorTag) fields.push({ name: 'Moderator', value: `${entry.moderatorTag}${entry.moderatorId ? ` (${entry.moderatorId})` : ''}`, inline: true });
  if (entry.buttonPressed) fields.push({ name: 'Button Pressed', value: entry.buttonPressed, inline: true });
  if (entry.reason) fields.push({ name: 'Reason', value: entry.reason.slice(0, 1000) });
  if (entry.oldWarningCount !== undefined && entry.oldWarningCount !== null) {
    fields.push({ name: 'Warnings (old → new)', value: `${entry.oldWarningCount} → ${entry.newWarningCount ?? entry.oldWarningCount}`, inline: true });
  }
  if (entry.confirmationStatus) fields.push({ name: 'Confirmation', value: entry.confirmationStatus, inline: true });
  if (entry.channelId) fields.push({ name: 'Channel', value: `<#${entry.channelId}>`, inline: true });
  if (entry.messageLink) fields.push({ name: 'Message', value: `[Jump to message](${entry.messageLink})`, inline: true });
  if (Array.isArray(entry.extraFields)) fields.push(...entry.extraFields);

  if (fields.length) embed.addFields(fields);
  embed.setFooter({ text: `Audit Trail ID: ${auditId}` });
  return embed;
}

/**
 * Fetch the most recent audit entries for a guild (newest first).
 * @param {string} guildId
 * @param {number} [limit=10]
 * @returns {Promise<object[]>}
 */
export async function getRecentAudits(guildId, limit = 10) {
  const data = await store.read();
  return (data[guildId] ?? []).slice(-limit).reverse();
}
