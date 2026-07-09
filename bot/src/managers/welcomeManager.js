/**
 * managers/welcomeManager.js
 * ---------------------------------------------------------------------------
 * The Premium Public Welcome experience.
 *
 * Two modes (selected by settings.welcome.animatedEnabled):
 *
 *   1. Cinematic "video-style" welcome — a single message that is edited
 *      through 5 sequential frames (loading → reveal), simulating a welcome
 *      animation. GIF stays constant across edits so it keeps looping like
 *      an autoplaying video while text/colour change around it.
 *
 *   2. Static premium welcome — one beautifully decorated embed.
 *
 * Both end in the same final premium embed with interactive buttons
 * (Rules / Introduce Yourself / Community / optional Website) and, when the
 * guild has stickers, a follow-up sticker message.
 * ---------------------------------------------------------------------------
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getSettings } from '../database/settingsStore.js';
import { getTheme } from './themeManager.js';
import { pickWelcomeGif, pickEmojiBurst, pickGuildSticker, LOADING_FRAMES } from './gifManager.js';

/** Delay between animation frames (ms). Keep >= 1500 to respect rate limits. */
const FRAME_DELAY_MS = 2200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the interactive button row for welcome messages.
 * Link buttons point at channels via https://discord.com/channels/... URLs so
 * they stay clickable forever without any interaction-handling state.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} theme
 * @param {object} welcomeSettings
 * @returns {ActionRowBuilder|null}
 */
export function buildWelcomeButtons(guild, theme, welcomeSettings) {
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
  if (config.channels.devIntro) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Introduce Yourself')
        .setEmoji(theme.buttons.intro)
        .setStyle(ButtonStyle.Link)
        .setURL(channelLink(config.channels.devIntro))
    );
  }
  if (config.channels.community || config.channels.welcome) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Community')
        .setEmoji(theme.buttons.community)
        .setStyle(ButtonStyle.Link)
        .setURL(channelLink(config.channels.community || config.channels.welcome))
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
 * The final premium welcome embed (Frame 5 / static mode).
 *
 * @param {import('discord.js').GuildMember} member
 * @param {object} theme
 * @param {string} gifUrl
 * @returns {EmbedBuilder}
 */
export function premiumWelcomeEmbed(member, theme, gifUrl) {
  const e = theme.emojis;
  const guild = member.guild;
  const createdTs = Math.floor(member.user.createdTimestamp / 1000);
  const joinedTs = Math.floor((member.joinedTimestamp ?? Date.now()) / 1000);

  const embed = new EmbedBuilder()
    .setColor(theme.accent)
    .setAuthor({
      name: `${guild.name} • New Member`,
      iconURL: guild.iconURL({ size: 128 }) ?? undefined,
    })
    .setTitle(`${e.wave} Welcome, ${member.displayName}!`)
    .setDescription(
      [
        theme.divider,
        '',
        `${e.spark} We're excited to have you here, ${member}!`,
        '',
        `${e.star} You are our **#${guild.memberCount}** member.`,
        '',
        `${e.book} Read the rules`,
        `${e.chat} Introduce yourself`,
        `${e.game} Explore the community`,
        `${e.shield} Complete verification`,
        '',
        `${e.heart} Enjoy your stay!`,
        '',
        theme.divider,
        '',
        pickEmojiBurst(),
      ].join('\n')
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 512 }))
    .addFields(
      { name: `${e.star} Member`, value: `#${guild.memberCount}`, inline: true },
      { name: '📅 Account Created', value: `<t:${createdTs}:R>`, inline: true },
      { name: '⏰ Joined', value: `<t:${joinedTs}:R>`, inline: true }
    )
    .setFooter({
      text: `${theme.name} theme • ${guild.name} • ID: ${member.id}`,
      iconURL: guild.iconURL({ size: 64 }) ?? undefined,
    })
    .setTimestamp();

  if (gifUrl) embed.setImage(gifUrl);
  return embed;
}

/**
 * Build one intermediate animation frame.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {object} theme
 * @param {string} gifUrl
 * @param {number} step        0-based frame index.
 * @param {string} headline    Frame headline text.
 * @param {string} body        Frame body text.
 * @returns {EmbedBuilder}
 */
function animationFrame(member, theme, gifUrl, step, headline, body) {
  const spinner = LOADING_FRAMES[step % LOADING_FRAMES.length];
  const progress = '🟩'.repeat(step + 1) + '⬜'.repeat(Math.max(0, 4 - (step + 1)));

  const embed = new EmbedBuilder()
    .setColor(theme.color)
    .setTitle(`${spinner} ${headline}`)
    .setDescription(`${theme.divider}\n\n${body}\n\n${progress}\n\n${theme.divider}`)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter({
      text: `${member.guild.name} • preparing welcome...`,
      iconURL: member.guild.iconURL({ size: 64 }) ?? undefined,
    });

  if (gifUrl) embed.setImage(gifUrl);
  return embed;
}

/**
 * Send the public welcome message for a new member, honouring the guild's
 * configured theme + animation settings. Never throws.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {Promise<void>}
 */
export async function sendPublicWelcome(member) {
  const settings = await getSettings(member.guild.id);
  const wc = settings.welcome;
  if (!wc.publicEnabled || !config.channels.welcome) return;

  let channel;
  try {
    channel = await member.guild.channels.fetch(config.channels.welcome);
  } catch {
    channel = null;
  }
  if (!channel?.isTextBased()) return;

  const theme = getTheme(wc.theme);
  const gifUrl = pickWelcomeGif(member.guild.id, wc);
  const buttons = buildWelcomeButtons(member.guild, theme, wc);
  const finalPayload = {
    content: `${member}`,
    embeds: [premiumWelcomeEmbed(member, theme, gifUrl)],
    ...(buttons ? { components: [buttons] } : {}),
  };

  try {
    if (!wc.animatedEnabled) {
      await channel.send(finalPayload);
    } else {
      // --- Cinematic 5-frame welcome animation ---
      const e = theme.emojis;
      const frames = [
        ['A new member appeared!', `${e.spark} Someone just joined **${member.guild.name}**...`],
        ['Loading your community...', `${e.party} Rolling out the red carpet for ${member}...`],
        ['Preparing your experience...', `${e.rocket} Setting up channels, roles and perks...`],
        [`Welcome, ${member.displayName}!`, `${e.wave} Almost there — finishing touches...`],
      ];

      const message = await channel.send({
        content: `${member}`,
        embeds: [animationFrame(member, theme, gifUrl, 0, frames[0][0], frames[0][1])],
      });

      for (let i = 1; i < frames.length; i += 1) {
        await sleep(FRAME_DELAY_MS);
        await message.edit({
          embeds: [animationFrame(member, theme, gifUrl, i, frames[i][0], frames[i][1])],
        });
      }

      // Frame 5: the final premium welcome (buttons attach here).
      await sleep(FRAME_DELAY_MS);
      await message.edit(finalPayload);
    }

    // Follow up with a guild sticker when one is available (best-effort).
    const sticker = pickGuildSticker(member.guild);
    if (sticker) {
      await channel.send({ stickers: [sticker.id] }).catch(() => {});
    }
  } catch (error) {
    logger.warn(`Failed to send public welcome: ${error.message}`);
  }
}
