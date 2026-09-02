/**
 * commands/warnings.js
 * ---------------------------------------------------------------------------
 * /warnings <user>
 *
 * Lists all active warnings for a member, including reason, moderator, source
 * and timestamp. Requires the Moderate Members permission.
 * ---------------------------------------------------------------------------
 */

import { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { config } from '../config.js';
import { COLORS } from '../utils/embeds.js';
import { getWarnings, countWarnings } from '../database/warningStore.js';
import { reviewRow } from '../managers/warningWorkflow.js';

export const data = new SlashCommandBuilder()
  .setName('warnings')
  .setDescription('View all warnings for a member.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .setDMPermission(false)
  .addUserOption((option) =>
    option.setName('user').setDescription('The member to inspect').setRequired(true)
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const targetUser = interaction.options.getUser('user', true);
  const warnings = await getWarnings(interaction.guild.id, targetUser.id);

  if (warnings.length === 0) {
    return interaction.reply({
      content: `\u2705 **${targetUser.tag}** has no warnings.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const activeCount = await countWarnings(interaction.guild.id, targetUser.id);
  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle(`\u26A0\uFE0F Warnings for ${targetUser.tag}`)
    .setDescription(`Active: **${activeCount} / ${config.maxWarnings}** · Historical records: **${warnings.length}**`)
    .setThumbnail(targetUser.displayAvatarURL({ size: 128 }))
    .setTimestamp();

  // Discord embeds allow up to 25 fields; show the most recent 25.
  const recent = warnings.slice(-25);
  for (const [index, w] of recent.entries()) {
    const when = `<t:${Math.floor(new Date(w.timestamp).getTime() / 1000)}:R>`;
    embed.addFields({
      name: `#${warnings.length - recent.length + index + 1} \u2014 ${w.source}`,
      value: `**Rule:** ${w.ruleTitle || (w.rule ? `Rule ${w.rule}` : 'Community rules')}\n**Reason:** ${w.reason}\n**Status:** ${w.status}\n**By:** ${w.moderatorTag}\n**When:** ${when}`,
    });
  }

  const latest = [...warnings].reverse().find((warning) => warning.status === 'active') || warnings[warnings.length - 1];
  return interaction.reply({ embeds: [embed], components: latest ? [reviewRow(latest.id, targetUser.id)] : [], flags: MessageFlags.Ephemeral });
}
