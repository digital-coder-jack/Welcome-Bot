/**
 * commands/farewellconfig.js
 * ---------------------------------------------------------------------------
 * /farewellconfig — the Premium Farewell DM Configuration Dashboard
 * (admin only).
 *
 * The farewell DM is sent ONLY when a member leaves voluntarily — kicked or
 * banned members never receive it (audit-log verified). It never mentions
 * punishments, warnings or moderation of any kind.
 *
 * Subcommands:
 *   view                    Show the current farewell configuration.
 *   toggle <enabled>        Enable/disable the farewell DM.
 *   links [invite] [website]  Set the 🌐 Rejoin invite and/or the
 *                             📚 Community Website button URLs ("clear" removes).
 *   banner <url|clear>      Set (or clear) the large farewell banner image.
 *   test                    DM yourself a live preview of the farewell.
 * ---------------------------------------------------------------------------
 */

import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getSettings, updateSettings } from '../database/settingsStore.js';
import { sendFarewellDM, BRAND_COLOR } from '../managers/farewellManager.js';

export const data = new SlashCommandBuilder()
  .setName('farewellconfig')
  .setDescription('Configure the premium farewell DM (voluntary leaves only).')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((sub) => sub.setName('view').setDescription('Show the current farewell configuration.'))
  .addSubcommand((sub) =>
    sub
      .setName('toggle')
      .setDescription('Enable or disable the farewell DM.')
      .addBooleanOption((opt) =>
        opt.setName('enabled').setDescription('Farewell DM enabled').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('links')
      .setDescription('Set the 🌐 Rejoin invite and/or 📚 Community Website button URLs.')
      .addStringOption((opt) =>
        opt.setName('invite').setDescription('Permanent invite URL for the Rejoin button, or "clear"')
      )
      .addStringOption((opt) =>
        opt.setName('website').setDescription('Community website URL, or "clear"')
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('banner')
      .setDescription('Set or clear the large farewell banner image/GIF.')
      .addStringOption((opt) =>
        opt.setName('url').setDescription('Direct image/GIF URL, or "clear" for the default').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('test').setDescription('Send yourself a live preview of the farewell DM.')
  );

/** Validate an http(s) URL or the literal "clear". Returns '' for clear, null for invalid. */
function parseUrlOrClear(raw) {
  const value = raw.trim();
  if (value.toLowerCase() === 'clear') return '';
  return /^https?:\/\//i.test(value) ? value : null;
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (sub === 'view') {
    const { farewell } = await getSettings(guildId);
    const embed = new EmbedBuilder()
      .setColor(BRAND_COLOR)
      .setTitle('⚙️ Farewell Configuration')
      .setDescription(
        'The premium farewell DM is sent **only on voluntary leaves** — kicked or banned members never receive it.'
      )
      .addFields(
        { name: '📩 Farewell DM', value: farewell.dmEnabled ? '✅ On' : '❌ Off', inline: true },
        { name: '🌐 Rejoin Invite', value: farewell.inviteUrl || '*not set (vanity URL fallback)*', inline: true },
        { name: '📚 Community Website', value: farewell.websiteUrl || '*not set*', inline: true },
        { name: '🖼️ Custom Banner', value: farewell.bannerUrl || '*curated default*', inline: true }
      )
      .setFooter({ text: 'Use /farewellconfig subcommands to change settings.' });
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'toggle') {
    const enabled = interaction.options.getBoolean('enabled', true);
    await updateSettings(guildId, 'farewell', { dmEnabled: enabled });
    return interaction.reply({
      content: `✅ Farewell DM is now ${enabled ? '**enabled**' : '**disabled**'}.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'links') {
    const patch = {};
    const invite = interaction.options.getString('invite');
    const website = interaction.options.getString('website');

    if (invite === null && website === null) {
      return interaction.reply({
        content: 'ℹ️ Provide `invite` and/or `website` (use "clear" to remove one).',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (invite !== null) {
      const parsed = parseUrlOrClear(invite);
      if (parsed === null) {
        return interaction.reply({ content: '❌ Invite must be an http(s) URL or "clear".', flags: MessageFlags.Ephemeral });
      }
      patch.inviteUrl = parsed;
    }
    if (website !== null) {
      const parsed = parseUrlOrClear(website);
      if (parsed === null) {
        return interaction.reply({ content: '❌ Website must be an http(s) URL or "clear".', flags: MessageFlags.Ephemeral });
      }
      patch.websiteUrl = parsed;
    }

    await updateSettings(guildId, 'farewell', patch);
    const summary = Object.entries(patch)
      .map(([k, v]) => `\`${k}\` → ${v ? `<${v}>` : '*cleared*'}`)
      .join(', ');
    return interaction.reply({ content: `✅ Updated: ${summary}`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'banner') {
    const raw = interaction.options.getString('url', true);
    const parsed = parseUrlOrClear(raw);
    if (parsed === null) {
      return interaction.reply({ content: '❌ Banner must be an http(s) URL or "clear".', flags: MessageFlags.Ephemeral });
    }
    await updateSettings(guildId, 'farewell', { bannerUrl: parsed });
    return interaction.reply({
      content: parsed ? `✅ Farewell banner set to <${parsed}>.` : '✅ Farewell banner reset to the curated default.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'test') {
    // Preview: send the farewell DM to the invoking admin. We pass
    // departureType='voluntary' explicitly so no audit-log read happens.
    const member = interaction.member;
    const status = await sendFarewellDM(member, 'voluntary');
    const messages = {
      Delivered: '✅ Preview sent — check your DMs!',
      Disabled: 'ℹ️ The farewell DM is currently disabled (`/farewellconfig toggle enabled:true`).',
      'Failed (DMs closed)': '❌ Could not DM you — your DMs appear to be closed.',
      'Skipped (not voluntary)': '❌ Preview skipped unexpectedly.',
    };
    return interaction.reply({
      content: messages[status] ?? `ℹ️ Result: ${status}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
