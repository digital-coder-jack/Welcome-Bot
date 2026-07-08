/**
 * commands/kick.js
 * ---------------------------------------------------------------------------
 * /kick <user> [reason]
 *
 * Kicks a member. Requires the Kick Members permission. The kick is executed
 * through moderationService.kickMember so the Telegram notification (via the
 * FastAPI backend) and moderation-log entry are emitted consistently.
 * ---------------------------------------------------------------------------
 */

import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { kickMember, getWarningCount } from '../services/moderationService.js';

export const data = new SlashCommandBuilder()
  .setName('kick')
  .setDescription('Kick a member from the server.')
  .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
  .setDMPermission(false)
  .addUserOption((option) =>
    option.setName('user').setDescription('The member to kick').setRequired(true)
  )
  .addStringOption((option) =>
    option.setName('reason').setDescription('Reason for the kick').setRequired(false)
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const targetUser = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') ?? 'No reason provided';

  const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
  if (!member) {
    return interaction.reply({ content: '\u274C That user is not a member of this server.', flags: MessageFlags.Ephemeral });
  }

  // Guard rails: no self-kicks, no kicking higher-ranked members.
  if (member.id === interaction.user.id) {
    return interaction.reply({ content: '\u274C You cannot kick yourself.', flags: MessageFlags.Ephemeral });
  }
  if (member.roles.highest.position >= interaction.member.roles.highest.position) {
    return interaction.reply({
      content: '\u274C You cannot kick a member with an equal or higher role than you.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const warningCount = await getWarningCount(interaction.guild.id, member.id);
  const kicked = await kickMember(member, reason, {
    moderatorTag: interaction.user.tag,
    warningCount,
  });

  await interaction.editReply({
    content: kicked
      ? `\u2705 Kicked **${targetUser.tag}**. Reason: ${reason}`
      : `\u274C Could not kick **${targetUser.tag}** (permissions/hierarchy).`,
  });
}
