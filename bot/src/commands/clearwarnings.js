/**
 * commands/clearwarnings.js
 * ---------------------------------------------------------------------------
 * /clearwarnings <user>
 *
 * Removes ALL warnings for a member. Because this is a destructive reset, it
 * requires the elevated Manage Server permission and logs the action.
 * ---------------------------------------------------------------------------
 */

import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { COLORS } from '../utils/embeds.js';
import { clearWarnings } from '../database/warningStore.js';
import { sendLog } from '../services/moderationService.js';

export const data = new SlashCommandBuilder()
  .setName('clearwarnings')
  .setDescription('Clear all warnings for a member.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addUserOption((option) =>
    option.setName('user').setDescription('The member whose warnings to clear').setRequired(true)
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const targetUser = interaction.options.getUser('user', true);
  const removed = await clearWarnings(interaction.guild.id, targetUser.id);

  if (removed === 0) {
    return interaction.reply({
      content: `\u2139\uFE0F **${targetUser.tag}** had no warnings to clear.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // Log the clear action.
  await sendLog(interaction.guild, {
    action: 'Warnings Cleared',
    color: COLORS.info,
    userTag: targetUser.tag,
    userId: targetUser.id,
    moderatorTag: interaction.user.tag,
    reason: `Cleared ${removed} warning(s).`,
  });

  return interaction.reply({
    content: `\u2705 Cleared **${removed}** warning(s) for **${targetUser.tag}**.`,
    flags: MessageFlags.Ephemeral,
  });
}
