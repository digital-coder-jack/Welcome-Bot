/**
 * managers/dmManager.js
 * ---------------------------------------------------------------------------
 * The Premium Welcome DM experience.
 *
 * Instead of a single plain embed, new members receive a multi-embed,
 * GIF-separated "journey":
 *
 *   Embed 1: Hero — big animated GIF, personalised greeting, server logo.
 *   Embed 2: Next steps — rules / verification / intro / explore / perks,
 *            separated from the hero by its own themed GIF.
 *   Embed 3: The server rules (kept from the original bot — backward
 *            compatible with the existing rules util).
 *
 * A button row (Rules / Support / Community / Website) is attached to the
 * message. Every step is best-effort: closed DMs never break the join flow.
 * ---------------------------------------------------------------------------
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getSettings } from '../database/settingsStore.js';
import { getTheme } from './themeManager.js';
import { pickWelcomeGif, pickEmojiBurst } from './gifManager.js';
import { rulesDMEmbed } from '../utils/embeds.js';

/**
 * Button row for the welcome DM. All buttons are Link buttons so they work
 * inside DMs (interaction components with customIds also work, but links
 * need zero state and never expire).
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} theme
 * @param {object} welcomeSettings
 * @returns {ActionRowBuilder|null}
 */
function buildDMButtons(guild, theme, welcomeSettings) {
  const row = new ActionRowBuilder();
  const channelLink = (channelId) => `https://discord.com/channels/${guild.id}/${channelId}`;

  if (config.channels.rules || config.channels.welcome) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Rules')
        .setEmoji(theme.buttons.rules)
        .setStyle(ButtonStyle.Link)
        .setURL(channelLink(config.channels.rules || config.channels.welcome))
    );
  }
  if (config.channels.support || config.channels.log) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Support')
        .setEmoji('🛟')
        .setStyle(ButtonStyle.Link)
        .setURL(channelLink(config.channels.support || config.channels.log))
    );
  }
  if (config.channels.community || config.channels.devIntro || config.channels.welcome) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Community')
        .setEmoji(theme.buttons.community)
        .setStyle(ButtonStyle.Link)
        .setURL(channelLink(config.channels.community || config.channels.devIntro || config.channels.welcome))
    );
  }
  if (welcomeSettings.websiteUrl && /^https?:\/\//i.test(welcomeSettings.websiteUrl)) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Website')
        .setEmoji(theme.buttons.website)
        .setStyle(ButtonStyle.Link)
        .setURL(welcomeSettings.websiteUrl)
    );
  }

  return row.components.length > 0 ? row : null;
}

/**
 * Hero embed — the first thing the member sees in their DM.
 */
function heroEmbed(member, theme, gifUrl) {
  const e = theme.emojis;
  const guild = member.guild;

  const embed = new EmbedBuilder()
    .setColor(theme.color)
    .setAuthor({
      name: guild.name,
      iconURL: guild.iconURL({ size: 128 }) ?? undefined,
    })
    .setTitle(`${e.wave} Welcome to ${guild.name}`)
    .setDescription(
      [
        theme.divider,
        '',
        `Hello **${member.user.displayName ?? member.user.username}**!`,
        '',
        `${e.heart} We're happy you joined our community.`,
        '',
        pickEmojiBurst(),
        '',
        theme.divider,
      ].join('\n')
    )
    .setThumbnail(guild.iconURL({ size: 256 }) ?? member.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `${theme.name} theme • You are member #${guild.memberCount}` })
    .setTimestamp();

  if (gifUrl) embed.setImage(gifUrl);
  return embed;
}

/**
 * "What to do next" embed with its own separator GIF.
 */
function nextStepsEmbed(member, theme, gifUrl) {
  const e = theme.emojis;

  const embed = new EmbedBuilder()
    .setColor(theme.accent)
    .setTitle(`${e.spark} Here's what to do next`)
    .setDescription(
      [
        `${e.book} **Read the Rules** — know the community standards.`,
        `${e.shield} **Complete Verification** — unlock all channels.`,
        `${e.chat} **Introduce Yourself** — say hi in the intro channel.`,
        `${e.rocket} **Explore our channels** — find your favourite spots.`,
        `🎁 **Unlock community perks** — roles, events and more.`,
      ].join('\n\n')
    )
    .setFooter({
      text: member.guild.name,
      iconURL: member.guild.iconURL({ size: 64 }) ?? undefined,
    });

  if (gifUrl) embed.setImage(gifUrl);
  return embed;
}

/**
 * Send the full premium welcome DM to a new member. Never throws.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {Promise<'Delivered'|'Disabled'|'Failed (DMs closed)'>} status.
 */
export async function sendWelcomeDM(member) {
  const settings = await getSettings(member.guild.id);
  const wc = settings.welcome;
  if (!wc.dmEnabled) return 'Disabled';

  const theme = getTheme(wc.theme);

  // Use two *different* GIFs for the hero and the section separator.
  const heroGif = pickWelcomeGif(member.guild.id, wc);
  const pool = getTheme(wc.theme).gifs;
  const sectionGif = pool.find((g) => g !== heroGif) ?? heroGif;

  const buttons = buildDMButtons(member.guild, theme, wc);

  try {
    await member.send({
      embeds: [
        heroEmbed(member, theme, heroGif),
        nextStepsEmbed(member, theme, sectionGif),
        rulesDMEmbed(member.guild.name),
      ],
      ...(buttons ? { components: [buttons] } : {}),
    });
    return 'Delivered';
  } catch (error) {
    logger.warn(`Failed to send welcome DM to ${member.user.tag}: ${error.message}`);
    return 'Failed (DMs closed)';
  }
}
