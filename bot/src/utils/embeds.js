/**
 * embeds.js
 * ---------------------------------------------------------------------------
 * Factory functions returning pre-styled discord.js EmbedBuilder instances.
 *
 * Centralising embed construction keeps the bot's visual identity consistent
 * and keeps event/command files focused on logic instead of formatting.
 * ---------------------------------------------------------------------------
 */

import { EmbedBuilder } from 'discord.js';
import { formatRulesList, ruleLabel } from './rules.js';

/** Brand colours used across embeds. */
export const COLORS = Object.freeze({
  welcome: 0x57f287, // green
  goodbye: 0xed4245, // red
  rules: 0x5865f2, // blurple
  warning: 0xfee75c, // yellow
  danger: 0xed4245, // red
  info: 0x5865f2, // blurple
});

/**
 * Welcome embed shown in the welcome channel when a member joins.
 * @param {import('discord.js').GuildMember} member
 * @returns {EmbedBuilder}
 */
export function welcomeEmbed(member) {
  return new EmbedBuilder()
    .setColor(COLORS.welcome)
    .setTitle(`\u{1F44B} Welcome to ${member.guild.name}!`)
    .setDescription(
      `Hey ${member}, we're glad to have you here!\n\n` +
        'You\u2019ve been given the **Explorer** role to get started. ' +
        'Please check your DMs for the server rules and enjoy your stay!'
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields({ name: 'Member Count', value: `You are member #${member.guild.memberCount}`, inline: true })
    .setTimestamp()
    .setFooter({ text: `User ID: ${member.id}` });
}

/**
 * Goodbye embed shown in the goodbye channel when a member leaves.
 * @param {import('discord.js').GuildMember|import('discord.js').PartialGuildMember} member
 * @returns {EmbedBuilder}
 */
export function goodbyeEmbed(member) {
  const tag = member.user?.tag ?? 'A member';
  return new EmbedBuilder()
    .setColor(COLORS.goodbye)
    .setTitle('\u{1F44B} A member has left')
    .setDescription(`**${tag}** has left the server. We're now at **${member.guild.memberCount}** members.`)
    .setThumbnail(member.user?.displayAvatarURL?.({ size: 256 }) ?? null)
    .setTimestamp()
    .setFooter({ text: `User ID: ${member.id}` });
}

/**
 * Rules embed DMed to new members.
 * @param {string} guildName
 * @returns {EmbedBuilder}
 */
export function rulesDMEmbed(guildName) {
  return new EmbedBuilder()
    .setColor(COLORS.rules)
    .setTitle(`\u{1F4DC} ${guildName} \u2014 Server Rules`)
    .setDescription(`Please read and follow our rules:\n\n${formatRulesList()}`)
    .setTimestamp()
    .setFooter({ text: 'Breaking these rules may result in warnings or removal.' });
}

/**
 * DM sent to a user when they receive a warning.
 * @param {object} params
 * @param {string} params.guildName
 * @param {string} params.reason
 * @param {number} params.count   current warning count
 * @param {number} params.max     max warnings before kick
 * @returns {EmbedBuilder}
 */
export function warningDMEmbed({ guildName, reason, count, max }) {
  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle(`\u26A0\uFE0F You have been warned in ${guildName}`)
    .addFields(
      { name: 'Reason', value: reason || 'No reason provided' },
      { name: 'Warnings', value: `${count} / ${max}`, inline: true }
    )
    .setDescription(
      count >= max
        ? 'You have reached the maximum number of warnings and may be removed from the server.'
        : `You have **${max - count}** warning(s) left before removal.`
    )
    .setTimestamp();
}

/**
 * Standardised moderation log embed.
 * @param {object} params
 * @param {string} params.action      e.g. "Warning", "Kick", "Message Deleted"
 * @param {number} params.color       embed colour
 * @param {string} [params.userTag]
 * @param {string} [params.userId]
 * @param {string} [params.moderatorTag]
 * @param {string} [params.reason]
 * @param {number} [params.rule]       optional rule number
 * @param {object[]} [params.extraFields] additional { name, value, inline } fields
 * @returns {EmbedBuilder}
 */
export function moderationLogEmbed({ action, color, userTag, userId, moderatorTag, reason, rule, extraFields = [] }) {
  const embed = new EmbedBuilder()
    .setColor(color ?? COLORS.info)
    .setTitle(`\u{1F6E1}\uFE0F Moderation \u2014 ${action}`)
    .setTimestamp();

  const fields = [];
  if (userTag) fields.push({ name: 'User', value: `${userTag}${userId ? ` (${userId})` : ''}`, inline: true });
  if (moderatorTag) fields.push({ name: 'Moderator', value: moderatorTag, inline: true });
  if (rule) fields.push({ name: 'Rule', value: ruleLabel(rule), inline: true });
  if (reason) fields.push({ name: 'Reason', value: reason });
  fields.push(...extraFields);

  if (fields.length) embed.addFields(fields);
  return embed;
}
