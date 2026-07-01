/**
 * commands/warn.js
 * ---------------------------------------------------------------------------
 * /warn <user> [reason]
 *
 * Issues a warning to a member. Requires the Moderate Members permission.
 * All heavy lifting (persistence, DM, logging, auto-kick at max warnings) is
 * delegated to moderationService.issueWarning so behaviour matches AI/auto-mod.
 * ---------------------------------------------------------------------------
 */

import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { issueWarning } from '../services/moderationService.js';

export const data = new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Warn a member for breaking the rules.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .setDMPermission(false)
  .addUserOption((option) =>
    option.setName('user').setDescription('The member to warn').setRequired(true)
  )
  .addStringOption((option) =>
    option.setName('reason').setDescription('Reason for the warning').setRequired(false)
  )
  .addIntegerOption((option) =>
    option
      .setName('rule')
      .setDescription('Rule number this warning relates to (1-10)')
      .setMinValue(1)
      .setMaxValue(10)
      .setRequired(false)
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const targetUser = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') ?? 'No reason provided';
  const rule = interaction.options.getInteger('rule');

  // Fetch the guild member object for the target.
  const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
  if (!member) {
    return interaction.reply({ content: '\u274C That user is not a member of this server.', flags: MessageFlags.Ephemeral });
  }

  // Guard rails: no self-warns, no bot-warns, no warning higher-ranked members.
  if (member.id === interaction.user.id) {
    return interaction.reply({ content: '\u274C You cannot warn yourself.', flags: MessageFlags.Ephemeral });
  }
  if (member.user.bot) {
    return interaction.reply({ content: '\u274C You cannot warn a bot.', flags: MessageFlags.Ephemeral });
  }
  if (member.roles.highest.position >= interaction.member.roles.highest.position) {
    return interaction.reply({
      content: '\u274C You cannot warn a member with an equal or higher role than you.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { count, max, kicked } = await issueWarning({
    guild: interaction.guild,
    member,
    reason,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    rule: rule ?? null,
    source: 'command',
  });

  const summary = kicked
    ? `\u2705 Warned **${member.user.tag}** (${count}/${max}). They reached the maximum and were **kicked**.`
    : `\u2705 Warned **${member.user.tag}** (${count}/${max}). Reason: ${reason}`;

  await interaction.editReply({ content: summary });
}
