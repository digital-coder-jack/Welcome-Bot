/**
 * commands/ban.js
 * ---------------------------------------------------------------------------
 * /ban <user> [reason] [delete_days]
 *
 * Bans a member. Requires the Ban Members permission. The ban is executed
 * through moderationService.banMember; the Telegram ban notification is then
 * emitted automatically by the guildBanAdd event (which also captures bans
 * performed by other moderators or bots).
 * ---------------------------------------------------------------------------
 */

import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { banMember } from '../services/moderationService.js';

export const data = new SlashCommandBuilder()
  .setName('ban')
  .setDescription('Ban a member from the server.')
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .setDMPermission(false)
  .addUserOption((option) =>
    option.setName('user').setDescription('The member to ban').setRequired(true)
  )
  .addStringOption((option) =>
    option.setName('reason').setDescription('Reason for the ban').setRequired(false)
  )
  .addIntegerOption((option) =>
    option
      .setName('delete_days')
      .setDescription('Delete this many days of their messages (0-7)')
      .setMinValue(0)
      .setMaxValue(7)
      .setRequired(false)
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const targetUser = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') ?? 'No reason provided';
  const deleteDays = interaction.options.getInteger('delete_days') ?? 0;

  const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
  if (!member) {
    return interaction.reply({ content: '\u274C That user is not a member of this server.', flags: MessageFlags.Ephemeral });
  }

  // Guard rails: no self-bans, no banning higher-ranked members.
  if (member.id === interaction.user.id) {
    return interaction.reply({ content: '\u274C You cannot ban yourself.', flags: MessageFlags.Ephemeral });
  }
  if (member.roles.highest.position >= interaction.member.roles.highest.position) {
    return interaction.reply({
      content: '\u274C You cannot ban a member with an equal or higher role than you.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const banned = await banMember(member, reason, {
    moderatorTag: interaction.user.tag,
    deleteMessageSeconds: deleteDays * 24 * 60 * 60,
  });

  await interaction.editReply({
    content: banned
      ? `\u2705 Banned **${targetUser.tag}**. Reason: ${reason}`
      : `\u274C Could not ban **${targetUser.tag}** (permissions/hierarchy).`,
  });
}
