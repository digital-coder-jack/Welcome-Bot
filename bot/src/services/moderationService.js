/**
 * moderationService.js
 * ---------------------------------------------------------------------------
 * The single, reusable moderation engine shared by slash commands, the
 * auto-moderation filters and the AI moderation pipeline.
 *
 * Public actions:
 *   - sendLog(...)        : post a standardised embed to the log channel.
 *   - deleteMessage(...)  : delete a message and log it.
 *   - issueWarning(...)   : add a warning, DM the user, notify Telegram via
 *                           the backend, escalate to a kick on reaching the
 *                           configured maximum, and log everything.
 *   - kickMember(...)     : kick a member, notify Telegram, and log it.
 *   - banMember(...)      : ban a member, and log it (the Telegram ban
 *                           notification is sent by the guildBanAdd event so
 *                           bans by other bots/mods are captured too).
 *
 * Keeping all of this in one place guarantees consistent behaviour, logging
 * and Telegram notifications no matter what triggered the action
 * (command / auto-mod / AI).
 * ---------------------------------------------------------------------------
 */

import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { countWarnings } from '../database/warningStore.js';
import { COLORS, moderationLogEmbed, warningDMEmbed } from '../utils/embeds.js';
import { ruleLabel } from '../utils/rules.js';
import { formatUTC } from '../utils/time.js';
import { notifyKick, notifyWarning } from './telegramClient.js';
import { recordWarning, SEVERITIES } from '../managers/warningManager.js';
import { getSettings } from '../database/settingsStore.js';
import { recordSecurityWarning, recordKick } from '../database/securityStore.js';
import { incrementStat } from '../database/statsStore.js';
import { bumpProfile } from '../database/profileStore.js';

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

  // Phase 6/7: dashboard + member-profile counters (best-effort).
  incrementStat(message.guild.id, 'messagesDeleted').catch(() => {});
  if (source === 'auto') incrementStat(message.guild.id, 'spamBlocked').catch(() => {});
  if (message.author?.id) {
    bumpProfile(message.guild.id, message.author.id, 'moderation', 'deletedMessages').catch(() => {});
    if (source === 'ai') {
      bumpProfile(message.guild.id, message.author.id, 'moderation', 'aiViolations').catch(() => {});
      incrementStat(message.guild.id, 'aiViolations').catch(() => {});
    }
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
 * Kick a member, notify Telegram via the backend, and log the outcome.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {string} reason
 * @param {object} [options]
 * @param {string} [options.moderatorTag='Auto-Mod']  who initiated the kick.
 * @param {number|null} [options.warningCount=null]   warnings at kick time.
 * @returns {Promise<boolean>} whether the kick succeeded.
 */
export async function kickMember(member, reason, { moderatorTag = 'Auto-Mod', warningCount = null } = {}) {
  // Verify the bot actually has permission and can act on this member.
  const me = member.guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.KickMembers) || !member.kickable) {
    logger.warn(`Cannot kick ${member.user.tag}: insufficient permissions or hierarchy.`);
    await sendLog(member.guild, {
      action: 'Kick Failed',
      color: COLORS.danger,
      userTag: member.user.tag,
      userId: member.id,
      moderatorTag,
      reason: `Kick attempted but bot could not act (permissions/hierarchy). Original reason: ${reason}`,
    });
    return false;
  }

  // Capture identity before the kick (the member object degrades afterwards).
  const userTag = member.user.tag;
  const userId = member.id;
  const guildName = member.guild.name;

  try {
    await member.kick(reason);
  } catch (error) {
    logger.warn(`Failed to kick ${userTag}: ${error.message}`);
    return false;
  }

  // Forge Guardian v2.0: record the kick in the security history (best-effort).
  try {
    await recordKick(member.guild.id, userId, reason, moderatorTag);
  } catch (error) {
    logger.warn(`Failed to record kick in security history: ${error.message}`);
  }

  // Telegram kick notification via the backend (best-effort).
  try {
    await notifyKick({
      username: userTag,
      user_id: userId,
      server_name: guildName,
      reason,
      moderator: moderatorTag,
      warning_count: warningCount,
      timestamp: formatUTC(Date.now()),
    });
  } catch (error) {
    logger.warn(`Telegram kick notification failed: ${error.message}`);
  }

  await sendLog(member.guild, {
    action: 'Kick',
    color: COLORS.danger,
    userTag,
    userId,
    moderatorTag,
    reason,
  });
  logger.info(`Kicked ${userTag}: ${reason}`);
  return true;
}

/**
 * Ban a member and log it. The Telegram ban notification is deliberately
 * emitted by the guildBanAdd event (not here) so that bans performed by
 * other moderators/bots are reported identically.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {string} reason
 * @param {object} [options]
 * @param {string} [options.moderatorTag='Auto-Mod']
 * @param {number} [options.deleteMessageSeconds=0]  purge window (max 7 days).
 * @returns {Promise<boolean>} whether the ban succeeded.
 */
export async function banMember(member, reason, { moderatorTag = 'Auto-Mod', deleteMessageSeconds = 0 } = {}) {
  const me = member.guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.BanMembers) || !member.bannable) {
    logger.warn(`Cannot ban ${member.user.tag}: insufficient permissions or hierarchy.`);
    await sendLog(member.guild, {
      action: 'Ban Failed',
      color: COLORS.danger,
      userTag: member.user.tag,
      userId: member.id,
      moderatorTag,
      reason: `Ban attempted but bot could not act (permissions/hierarchy). Original reason: ${reason}`,
    });
    return false;
  }

  try {
    await member.ban({ reason, deleteMessageSeconds });
    logger.info(`Banned ${member.user.tag}: ${reason}`);
    return true;
  } catch (error) {
    logger.warn(`Failed to ban ${member.user.tag}: ${error.message}`);
    return false;
  }
}

/**
 * Issue a warning to a member.
 *
 * IMPORTANT POLICY: The bot NEVER automatically kicks or bans anyone based
 * on warnings. Reaching the threshold (or receiving a critical-severity
 * warning) raises a Moderator Approval Panel in the alert channel instead —
 * a human moderator must explicitly approve any punishment.
 *
 * Flow:
 *   1. Classify & persist the warning (smart severity levels).
 *   2. DM the user a tiered notice:
 *        Warning 1 → friendly reminder.
 *        Warning 2 → serious warning.
 *        Warning 3+ / critical → final notice (case under moderator review).
 *   3. Send the Telegram warning notification via the backend.
 *   4. Log the warning.
 *   5. At the threshold or on critical severity: escalate to the
 *      Moderator Approval Panel (approvalSystem). NO automatic punishment.
 *
 * @param {object} params
 * @param {import('discord.js').Guild} params.guild
 * @param {import('discord.js').GuildMember} params.member  target member
 * @param {string} params.reason
 * @param {string} params.moderatorId
 * @param {string} params.moderatorTag
 * @param {number|null} [params.rule]
 * @param {'command'|'auto'|'ai'} [params.source='command']
 * @param {'low'|'medium'|'high'|'critical'} [params.severity]  explicit severity.
 * @returns {Promise<{count:number, max:number, kicked:boolean, escalated:boolean, severity:string}>}
 */
export async function issueWarning({ guild, member, reason, moderatorId, moderatorTag, rule = null, source = 'command', severity }) {
  const settings = await getSettings(guild.id);
  const max = settings.security.warnThreshold || config.maxWarnings;

  // 1. Classify & persist.
  const { total, severity: resolvedSeverity } = await recordWarning({
    guildId: guild.id,
    userId: member.id,
    reason,
    moderatorId,
    moderatorTag,
    source,
    severity,
  });

  // 2. Tiered DM (never fatal if DMs are closed).
  try {
    await member.send({
      embeds: [warningDMEmbed({ guildName: guild.name, reason, count: total, max })],
    });
  } catch {
    logger.debug(`Could not DM warning to ${member.user.tag} (DMs likely closed).`);
  }

  // 3. Telegram warning notification via the backend (best-effort).
  try {
    await notifyWarning({
      username: member.user.tag,
      user_id: member.id,
      server_name: guild.name,
      reason: `[${resolvedSeverity.toUpperCase()}] ${reason}`,
      rule: rule ? ruleLabel(rule) : null,
      moderator: moderatorTag,
      warning_count: total,
      max_warnings: max,
      source,
      timestamp: formatUTC(Date.now()),
    });
  } catch (error) {
    logger.warn(`Telegram warning notification failed: ${error.message}`);
  }

  // 3b. Forge Guardian v2.0: record the warning in the security history.
  try {
    await recordSecurityWarning(guild.id, member.id, reason);
  } catch (error) {
    logger.warn(`Failed to record warning in security history: ${error.message}`);
  }

  // 4. Log the warning.
  await sendLog(guild, {
    action: 'Warning',
    color: SEVERITIES[resolvedSeverity]?.color ?? COLORS.warning,
    userTag: member.user.tag,
    userId: member.id,
    moderatorTag,
    reason,
    rule,
    extraFields: [
      { name: 'Warnings', value: `${total} / ${max}`, inline: true },
      { name: 'Severity', value: SEVERITIES[resolvedSeverity]?.label ?? resolvedSeverity, inline: true },
    ],
  });
  logger.info(`Warned ${member.user.tag} (${total}/${max}) [${source}/${resolvedSeverity}]: ${reason}`);

  // 5. Escalate to the Moderator Approval Panel — NEVER auto-punish.
  //    (Lazy import breaks the circular dependency with approvalSystem.)
  let escalated = false;
  if (total >= max || resolvedSeverity === 'critical') {
    try {
      const { escalateToModerators } = await import('../managers/approvalSystem.js');
      await escalateToModerators(member, { reason, severity: resolvedSeverity, warningCount: total });
      escalated = true;
    } catch (error) {
      logger.error(`Failed to escalate to moderators: ${error.stack || error}`);
    }
  }

  // `kicked` is kept in the return shape for backward compatibility with
  // existing callers — it is now ALWAYS false (no automatic kicks).
  return { count: total, max, kicked: false, escalated, severity: resolvedSeverity };
}

/**
 * Convenience: current warning count for a member.
 */
export async function getWarningCount(guildId, userId) {
  return countWarnings(guildId, userId);
}
