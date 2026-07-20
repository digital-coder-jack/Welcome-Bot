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
import { brandIcon, FORGE_BRAND } from '../managers/brandingManager.js';

/** Brand colours used across embeds. */
export const COLORS = Object.freeze({
  welcome: 0x57f287, // green
  goodbye: 0xed4245, // red
  rules: 0x5865f2, // blurple
  warning: 0xfee75c, // yellow
  danger: 0xed4245, // red
  info: 0x5865f2, // blurple
  intro: 0xeb459e, // fuchsia
});

/** Animated banner GIF used in the welcome DM. */
const WELCOME_GIF = 'https://media.giphy.com/media/xT9IgG50Fb7Mi0prBC/giphy.gif';

/**
 * Welcome embed shown in the welcome channel when a member joins.
 * @param {import('discord.js').GuildMember} member
 * @returns {EmbedBuilder}
 */
export function welcomeEmbed(member) {
  return new EmbedBuilder()
    .setColor(COLORS.welcome)
    .setTitle(`🎉 Welcome to ${member.guild.name}!`)
    .setDescription(
      `Hey ${member}, glad to have you here!\n\n` +
        `You are our **member #${member.guild.memberCount}** 🚀\n` +
        `Check your DMs for the server rules and say hi in **#chill-zone**!`
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 512 }))
    .setFooter({
      text: `User ID: ${member.id}`,
      iconURL: member.guild.iconURL() ?? undefined,
    })
    .setTimestamp();
}

/**
 * Animated welcome DM sent to new members (step 2 of the welcome system).
 * @param {import('discord.js').GuildMember} member
 * @returns {EmbedBuilder}
 */
export function welcomeDMEmbed(member) {
  return new EmbedBuilder()
    .setColor(COLORS.welcome)
    .setTitle(`👋 Welcome to ${member.guild.name}!`)
    .setThumbnail(member.user.displayAvatarURL({ size: 512 }))
    .setImage(WELCOME_GIF)
    .setDescription(
      `Hello ${member.user}!\n\n` +
        `We're excited to have you in **${member.guild.name}**.\n\n` +
        `✨ Your **Forge Member** role has been assigned.\n` +
        `💬 Introduce yourself in the **#dev-intro** channel.\n` +
        `📖 Please read the server rules in the next message.\n\n` +
        `Have fun and enjoy your stay! 🚀`
    )
    .setFooter({
      text: `${member.guild.name}`,
      iconURL: member.guild.iconURL() ?? undefined,
    })
    .setTimestamp();
}

/**
 * Developer Intro message auto-sent to the dev-intro channel when a member
 * joins (step 4 of the welcome system).
 * @param {import('discord.js').GuildMember} member
 * @returns {EmbedBuilder}
 */
export function devIntroEmbed(member) {
  return new EmbedBuilder()
    .setColor(COLORS.intro)
    .setAuthor({
      name: FORGE_BRAND.name,
      iconURL: brandIcon(member.guild, 128),
    })
    .setTitle('👨‍💻 New Developer Joined!')
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setDescription(
      `${member} just joined **${member.guild.name}**!\n\n` +
        `Tell us about yourself:\n` +
        `• 🛠 What do you build? (web, mobile, AI, games...)\n` +
        `• 💻 Favourite languages & frameworks?\n` +
        `• 🎯 What are you working on right now?\n\n` +
        `Drop your intro in **#dev-intro** — we'd love to meet you! 🤝`
    )
    .setFooter({
      text: `Member #${member.guild.memberCount}`,
      iconURL: brandIcon(member.guild, 64),
    })
    .setTimestamp();
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
  // Tiered messaging: 1 = friendly reminder, 2 = serious warning,
  // >= threshold = final notice (human moderator review — never auto-punished).
  let title;
  let description;
  if (count <= 1) {
    title = `💛 A friendly reminder from ${guildName}`;
    description =
      'This is just a gentle heads-up — no action has been taken.\n' +
      'Please take a moment to review the server rules. We appreciate you! 🙏';
  } else if (count < max) {
    title = `⚠️ Serious warning from ${guildName}`;
    description =
      `This is warning **${count} of ${max}**. Please treat this seriously.\n` +
      'Further violations will send your case to the moderation team for review.';
  } else {
    title = `🚨 Final notice from ${guildName}`;
    description =
      'You have reached the warning threshold.\n' +
      '**Your case has been forwarded to the moderation team for human review.**\n' +
      'No automatic punishment has been applied — a moderator will decide the outcome.';
  }

  return new EmbedBuilder()
    .setColor(count >= max ? COLORS.danger : COLORS.warning)
    .setTitle(title)
    .setDescription(description)
    .addFields(
      { name: 'Reason', value: reason || 'No reason provided' },
      { name: 'Warnings', value: `${count} / ${max}`, inline: true }
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
