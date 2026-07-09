/**
 * commands/welcomeconfig.js
 * ---------------------------------------------------------------------------
 * /welcomeconfig — the Welcome Configuration Dashboard (admin only).
 *
 * Subcommands:
 *   view                       Show the current welcome configuration.
 *   theme <theme>              Choose one of the 8 welcome themes.
 *   toggles [...]              Enable/disable DM, public welcome, animation,
 *                              random GIF selection.
 *   website <url|clear>        Set (or clear) the 🌐 Website button URL.
 *   gifs add <url> / clear     Manage the custom GIF collection (overrides
 *                              the theme GIF pool when non-empty).
 * ---------------------------------------------------------------------------
 */

import { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getSettings, updateSettings } from '../database/settingsStore.js';
import { getTheme, THEME_CHOICES, isValidTheme } from '../managers/themeManager.js';
import { getGifPool } from '../managers/gifManager.js';

export const data = new SlashCommandBuilder()
  .setName('welcomeconfig')
  .setDescription('Configure the premium welcome system.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((sub) => sub.setName('view').setDescription('Show the current welcome configuration.'))
  .addSubcommand((sub) =>
    sub
      .setName('theme')
      .setDescription('Choose the welcome theme.')
      .addStringOption((opt) =>
        opt
          .setName('theme')
          .setDescription('Theme to use')
          .setRequired(true)
          .addChoices(...THEME_CHOICES)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('toggles')
      .setDescription('Enable/disable welcome features.')
      .addBooleanOption((opt) => opt.setName('public').setDescription('Public welcome message enabled'))
      .addBooleanOption((opt) => opt.setName('dm').setDescription('Welcome DM enabled'))
      .addBooleanOption((opt) => opt.setName('animated').setDescription('Cinematic multi-frame animation enabled'))
      .addBooleanOption((opt) => opt.setName('random_gif').setDescription('Random GIF selection enabled'))
  )
  .addSubcommand((sub) =>
    sub
      .setName('website')
      .setDescription('Set or clear the 🌐 Website button URL.')
      .addStringOption((opt) =>
        opt.setName('url').setDescription('https:// URL, or "clear" to remove the button').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('gifs')
      .setDescription('Manage the custom welcome GIF collection.')
      .addStringOption((opt) =>
        opt
          .setName('action')
          .setDescription('add / clear')
          .setRequired(true)
          .addChoices({ name: 'add', value: 'add' }, { name: 'clear', value: 'clear' })
      )
      .addStringOption((opt) => opt.setName('url').setDescription('GIF URL (required for add)'))
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (sub === 'view') {
    const { welcome } = await getSettings(guildId);
    const theme = getTheme(welcome.theme);
    const pool = getGifPool(welcome);
    const embed = new EmbedBuilder()
      .setColor(theme.color)
      .setTitle('⚙️ Welcome Configuration')
      .addFields(
        { name: '🎨 Theme', value: theme.name, inline: true },
        { name: '📢 Public Welcome', value: welcome.publicEnabled ? '✅ On' : '❌ Off', inline: true },
        { name: '📩 Welcome DM', value: welcome.dmEnabled ? '✅ On' : '❌ Off', inline: true },
        { name: '🎬 Animated Welcome', value: welcome.animatedEnabled ? '✅ On' : '❌ Off', inline: true },
        { name: '🎲 Random GIF', value: welcome.randomGif ? '✅ On' : '❌ Off', inline: true },
        { name: '🌐 Website', value: welcome.websiteUrl || '*not set*', inline: true },
        {
          name: `🖼️ GIF Pool (${pool.length})`,
          value: welcome.customGifs.length > 0 ? `${welcome.customGifs.length} custom GIF(s) override the theme pool.` : `Using the **${theme.name}** theme collection.`,
        }
      )
      .setFooter({ text: 'Use /welcomeconfig subcommands to change settings.' });
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'theme') {
    const themeId = interaction.options.getString('theme', true);
    if (!isValidTheme(themeId)) {
      return interaction.reply({ content: '❌ Unknown theme.', flags: MessageFlags.Ephemeral });
    }
    await updateSettings(guildId, 'welcome', { theme: themeId });
    return interaction.reply({
      content: `✅ Welcome theme set to **${getTheme(themeId).name}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'toggles') {
    const patch = {};
    const map = { public: 'publicEnabled', dm: 'dmEnabled', animated: 'animatedEnabled', random_gif: 'randomGif' };
    for (const [option, key] of Object.entries(map)) {
      const value = interaction.options.getBoolean(option);
      if (value !== null) patch[key] = value;
    }
    if (Object.keys(patch).length === 0) {
      return interaction.reply({ content: 'ℹ️ Provide at least one toggle option.', flags: MessageFlags.Ephemeral });
    }
    await updateSettings(guildId, 'welcome', patch);
    const summary = Object.entries(patch)
      .map(([k, v]) => `\`${k}\` → ${v ? '✅ on' : '❌ off'}`)
      .join(', ');
    return interaction.reply({ content: `✅ Updated: ${summary}`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'website') {
    const url = interaction.options.getString('url', true).trim();
    if (url.toLowerCase() === 'clear') {
      await updateSettings(guildId, 'welcome', { websiteUrl: '' });
      return interaction.reply({ content: '✅ Website button removed.', flags: MessageFlags.Ephemeral });
    }
    if (!/^https?:\/\//i.test(url)) {
      return interaction.reply({ content: '❌ The URL must start with http:// or https://.', flags: MessageFlags.Ephemeral });
    }
    await updateSettings(guildId, 'welcome', { websiteUrl: url });
    return interaction.reply({ content: `✅ Website button set to <${url}>.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'gifs') {
    const action = interaction.options.getString('action', true);
    const { welcome } = await getSettings(guildId);

    if (action === 'clear') {
      await updateSettings(guildId, 'welcome', { customGifs: [] });
      return interaction.reply({
        content: '✅ Custom GIF collection cleared — the theme collection is active again.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const url = interaction.options.getString('url')?.trim();
    if (!url || !/^https?:\/\/\S+\.(gif|webp)(\?\S*)?$/i.test(url)) {
      return interaction.reply({ content: '❌ Provide a direct .gif / .webp URL.', flags: MessageFlags.Ephemeral });
    }
    if (welcome.customGifs.includes(url)) {
      return interaction.reply({ content: 'ℹ️ That GIF is already in the collection.', flags: MessageFlags.Ephemeral });
    }
    const customGifs = [...welcome.customGifs, url].slice(0, 25);
    await updateSettings(guildId, 'welcome', { customGifs });
    return interaction.reply({
      content: `✅ GIF added — the custom collection now has **${customGifs.length}** GIF(s).`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
