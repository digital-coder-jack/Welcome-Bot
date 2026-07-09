/**
 * commands/securityconfig.js
 * ---------------------------------------------------------------------------
 * /securityconfig — the Security Configuration Dashboard (admin only).
 *
 * Subcommands:
 *   view                          Show the current security configuration.
 *   alertchannel <channel>        Set the moderation-alert channel.
 *   ownerrole <role|clear>        Role treated as "owner" for overrides.
 *   modroles add/remove <role>    Roles allowed to use the approval panel.
 *   thresholds [...]              Warning threshold & default timeout length.
 * ---------------------------------------------------------------------------
 */

import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getSettings, updateSettings } from '../database/settingsStore.js';

export const data = new SlashCommandBuilder()
  .setName('securityconfig')
  .setDescription('Configure the security & moderation-approval system.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((sub) => sub.setName('view').setDescription('Show the current security configuration.'))
  .addSubcommand((sub) =>
    sub
      .setName('alertchannel')
      .setDescription('Set the dedicated moderation-alert channel.')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel that receives moderation approval panels')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('ownerrole')
      .setDescription('Set (or clear) the role treated as server owner for overrides.')
      .addRoleOption((opt) => opt.setName('role').setDescription('Owner role (omit to clear)'))
  )
  .addSubcommand((sub) =>
    sub
      .setName('modroles')
      .setDescription('Add or remove a moderator role for the approval panel.')
      .addStringOption((opt) =>
        opt
          .setName('action')
          .setDescription('add / remove')
          .setRequired(true)
          .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' })
      )
      .addRoleOption((opt) => opt.setName('role').setDescription('Moderator role').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('thresholds')
      .setDescription('Tune warning threshold and timeout duration.')
      .addIntegerOption((opt) =>
        opt.setName('warnings').setDescription('Warnings before a moderation panel is raised (1-10)').setMinValue(1).setMaxValue(10)
      )
      .addIntegerOption((opt) =>
        opt.setName('timeout_minutes').setDescription('Default 🕒 Timeout duration in minutes (1-10080)').setMinValue(1).setMaxValue(10080)
      )
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (sub === 'view') {
    const { security } = await getSettings(guildId);
    const modRoles = security.moderatorRoleIds.length > 0 ? security.moderatorRoleIds.map((r) => `<@&${r}>`).join(', ') : '*Discord "Moderate Members" permission*';
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('🛡️ Security Configuration')
      .setDescription('**Policy: the bot never kicks or bans automatically.** All punishments require explicit moderator approval via the panel.')
      .addFields(
        { name: '🚨 Alert Channel', value: security.alertChannelId ? `<#${security.alertChannelId}>` : '*falls back to MOD_ALERT / log channel*', inline: true },
        { name: '👑 Owner Role', value: security.ownerRoleId ? `<@&${security.ownerRoleId}>` : '*server owner only*', inline: true },
        { name: '⚠️ Warning Threshold', value: `${security.warnThreshold}`, inline: true },
        { name: '🕒 Timeout Duration', value: `${security.timeoutMinutes} min`, inline: true },
        { name: '🧑‍⚖️ Moderator Roles', value: modRoles }
      )
      .setFooter({ text: 'Use /securityconfig subcommands to change settings.' });
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'alertchannel') {
    const channel = interaction.options.getChannel('channel', true);
    await updateSettings(guildId, 'security', { alertChannelId: channel.id });
    return interaction.reply({ content: `✅ Moderation alerts will be posted in ${channel}.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'ownerrole') {
    const role = interaction.options.getRole('role');
    await updateSettings(guildId, 'security', { ownerRoleId: role?.id ?? '' });
    return interaction.reply({
      content: role ? `✅ Owner role set to ${role}.` : '✅ Owner role cleared — only the actual server owner can override.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'modroles') {
    const action = interaction.options.getString('action', true);
    const role = interaction.options.getRole('role', true);
    const { security } = await getSettings(guildId);
    let moderatorRoleIds = [...security.moderatorRoleIds];

    if (action === 'add') {
      if (moderatorRoleIds.includes(role.id)) {
        return interaction.reply({ content: 'ℹ️ That role is already a moderator role.', flags: MessageFlags.Ephemeral });
      }
      moderatorRoleIds.push(role.id);
    } else {
      moderatorRoleIds = moderatorRoleIds.filter((r) => r !== role.id);
    }
    await updateSettings(guildId, 'security', { moderatorRoleIds });
    return interaction.reply({
      content: `✅ ${role} ${action === 'add' ? 'added to' : 'removed from'} the moderator roles.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'thresholds') {
    const patch = {};
    const warnings = interaction.options.getInteger('warnings');
    const timeoutMinutes = interaction.options.getInteger('timeout_minutes');
    if (warnings !== null) patch.warnThreshold = warnings;
    if (timeoutMinutes !== null) patch.timeoutMinutes = timeoutMinutes;
    if (Object.keys(patch).length === 0) {
      return interaction.reply({ content: 'ℹ️ Provide at least one option.', flags: MessageFlags.Ephemeral });
    }
    await updateSettings(guildId, 'security', patch);
    return interaction.reply({
      content: `✅ Updated: ${Object.entries(patch).map(([k, v]) => `\`${k}\` → ${v}`).join(', ')}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
