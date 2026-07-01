/**
 * moderationService.js
 * ---------------------------------------------------------------------------
 * The single, reusable moderation engine shared by slash commands, the
 * auto-moderation filters and the AI moderation pipeline.
 *
 * Public actions:
 *   - sendLog(...)        : post a standardised embed to the log channel.
 *   - deleteMessage(...)  : delete a message and log it.
 *   - issueWarning(...)   : add a warning, DM the user, escalate to a kick on
 *                           reaching the configured maximum, and log everything.
 *
 * Keeping all of this in one place guarantees consistent behaviour and logging
 * no matter what triggered the action (command / auto-mod / AI).
 * ---------------------------------------------------------------------------
 */

import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { addWarning, countWarnings } from '../database/warningStore.js';
import { COLORS, moderationLogEmbed, warningDMEmbed } from '../utils/embeds.js';

/**
 * Resolve the configured log channel from a guild, if any.
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<import('discord.js').TextChannel|null>}
 */
async function resolveLogChannel(guild) {
  if (!config.channels.log) return null;
  try {
    const channel = await guild.channels.fetch(config.channels.log);
    return channel?.isTextBased() ? channel : null;
  } catch {
    return null;
  }
}

/**
 * Post a moderation log embed to the configured log channel (best-effort).
 * @param {import('discord.js').Guild} guild
 * @param {object} logData  see embeds.moderationLogEmbed params.
 */
export async function sendLog(guild, logData) {
  const channel = await resolveLogChannel(guild);
  if (!channel) {
    logger.debug(`No log channel configured; skipping "${logData.action}" log.`);
    return;
  }
  try {
    await channel.send({ embeds: [moderationLogEmbed(logData)] });
  } catch (error) {
    logger.warn(`Failed to send moderation log: ${error.message}`);
  }
}

/**
 * Delete a message and record it in the moderation log.
 * @param {import('discord.js').Message} message
 * @param {object} params
 * @param {string} params.reason
 * @param {number|null} [params.rule]
 * @param {string} [params.source='auto'] 'auto' | 'ai'
 */
export async function deleteMessage(message, { reason, rule = null, source = 'auto' }) {
  try {
    if (message.deletable) await message.delete();
  } catch (error) {
    logger.warn(`Failed to delete message ${message.id}: ${error.message}`);
    return;
  }

  await sendLog(message.guild, {
    action: 'Message Deleted',
    color: COLORS.warning,
    userTag: message.author?.tag,
    userId: message.author?.id,
    moderatorTag: `Auto-Mod (${source})`,
    reason,
    rule,
    extraFields: [
      { name: 'Channel', value: `${message.channel}`, inline: true },
      { name: 'Content', value: (message.content || '*empty*').slice(0, 1000) },
    ],
  });

  logger.info(`Deleted message from ${message.author?.tag} in #${message.channel?.name}: ${reason}`);
}

/**
 * Attempt to kick a member and log the outcome.
 * @param {import('discord.js').GuildMember} member
 * @param {string} reason
 * @returns {Promise<boolean>} whether the kick succeeded.
 */
async function kickMember(member, reason) {
  // Verify the bot actually has permission and can act on this member.
  const me = member.guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.KickMembers) || !member.kickable) {
    logger.warn(`Cannot kick ${member.user.tag}: insufficient permissions or hierarchy.`);
    await sendLog(member.guild, {
      action: 'Kick Failed',
      color: COLORS.danger,
      userTag: member.user.tag,
      userId: member.id,
      moderatorTag: 'Auto-Mod',
      reason: `Reached ${config.maxWarnings} warnings but bot could not kick (permissions/hierarchy).`,
    });
    return false;
  }

  try {
    await member.kick(reason);
    await sendLog(member.guild, {
      action: 'Kick',
      color: COLORS.danger,
      userTag: member.user.tag,
      userId: member.id,
      moderatorTag: 'Auto-Mod',
      reason,
    });
    logger.info(`Kicked ${member.user.tag}: ${reason}`);
    return true;
  } catch (error) {
    logger.warn(`Failed to kick ${member.user.tag}: ${error.message}`);
    return false;
  }
}

/**
 * Issue a warning to a member.
 *
 * Flow:
 *   1. Persist the warning.
 *   2. DM the user (best-effort).
 *   3. Log the warning.
 *   4. If the user has reached the max warnings, kick them and log it.
 *
 * @param {object} params
 * @param {import('discord.js').Guild} params.guild
 * @param {import('discord.js').GuildMember} params.member  target member
 * @param {string} params.reason
 * @param {string} params.moderatorId
 * @param {string} params.moderatorTag
 * @param {number|null} [params.rule]
 * @param {'command'|'auto'|'ai'} [params.source='command']
 * @returns {Promise<{count:number, max:number, kicked:boolean}>}
 */
export async function issueWarning({ guild, member, reason, moderatorId, moderatorTag, rule = null, source = 'command' }) {
  const max = config.maxWarnings;

  // 1. Persist.
  const { total } = await addWarning({
    guildId: guild.id,
    userId: member.id,
    reason,
    moderatorId,
    moderatorTag,
    source,
  });

  // 2. DM the user (never fatal if DMs are closed).
  try {
    await member.send({
      embeds: [warningDMEmbed({ guildName: guild.name, reason, count: total, max })],
    });
  } catch {
    logger.debug(`Could not DM warning to ${member.user.tag} (DMs likely closed).`);
  }

  // 3. Log the warning.
  await sendLog(guild, {
    action: 'Warning',
    color: COLORS.warning,
    userTag: member.user.tag,
    userId: member.id,
    moderatorTag,
    reason,
    rule,
    extraFields: [{ name: 'Warnings', value: `${total} / ${max}`, inline: true }],
  });
  logger.info(`Warned ${member.user.tag} (${total}/${max}) [${source}]: ${reason}`);

  // 4. Escalate to a kick on reaching the maximum.
  let kicked = false;
  if (total >= max) {
    kicked = await kickMember(member, `Reached maximum of ${max} warnings.`);
  }

  return { count: total, max, kicked };
}

/**
 * Convenience: current warning count for a member.
 */
export async function getWarningCount(guildId, userId) {
  return countWarnings(guildId, userId);
}
