/**
 * managers/dmManager.js
 * ---------------------------------------------------------------------------
 * The Premium Welcome DM experience — minimal, elegant, dark-mode friendly.
 *
 * Redesigned onboarding modelled on large Discord communities:
 *
 *   Embed 1: Premium welcome — centred monospace "DEVELOPER'S FORGE"
 *            header plaque, official Developer's Forge logo thumbnail,
 *            warm forge accent colour, generous spacing, one randomly-
 *            rotated inspirational quote (10 variants, same layout — see
 *            dmContent.js), timestamp + branded footer. No banner — clean
 *            and minimal by design.
 *   Embed 2: The server rules (unchanged — reuses the existing rules util
 *            for full backward compatibility).
 *
 * Link buttons (Rules / Introduce Yourself / Choose Roles / Community /
 * Support) are attached in RESPONSIVE ROWS: at most 3 buttons per row,
 * balanced across rows. On phones Discord shrinks all buttons in a row to
 * fit — five labelled buttons in one row collapse below the 44×44 px touch
 * target; two balanced rows keep every button comfortably tappable on
 * 320–414 px screens while still looking tidy on desktop.
 *
 * Every step is best-effort: closed DMs never break the join flow — the
 * function resolves with a status string and never throws.
 * ---------------------------------------------------------------------------
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getSettings } from '../database/settingsStore.js';
import { rulesDMEmbed } from '../utils/embeds.js';
import { BRAND, buildWelcomeBody } from './dmContent.js';
import { brandIcon } from './brandingManager.js';

/**
 * Maximum buttons per action row for comfortable touch targets.
 *
 * Discord allows 5 per row, but on a 320–414 px phone five labelled
 * buttons shrink far below Apple/Google's 44×44 px minimum touch target
 * and their labels get ellipsised. Capping at 3 per row keeps every
 * button large, fully labelled and easily tappable on all devices while
 * remaining a single tidy strip on desktop.
 */
const MAX_BUTTONS_PER_ROW = 3;

/**
 * Split a flat button list into balanced action rows.
 *
 * Balancing (5 → 3+2, 4 → 2+2) instead of greedy filling (5 → 3+2 but
 * 4 → 3+1) keeps the rows visually even, so spacing stays consistent and
 * nothing looks orphaned at any viewport width.
 *
 * @param {ButtonBuilder[]} buttons
 * @returns {ActionRowBuilder[]}
 */
export function toBalancedRows(buttons) {
  if (buttons.length === 0) return [];
  const rowCount = Math.ceil(buttons.length / MAX_BUTTONS_PER_ROW);
  const base = Math.floor(buttons.length / rowCount);
  const remainder = buttons.length % rowCount;

  const rows = [];
  let index = 0;
  for (let r = 0; r < rowCount; r += 1) {
    const size = base + (r < remainder ? 1 : 0);
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(index, index + size)));
    index += size;
  }
  return rows;
}

/**
 * Build the welcome-DM buttons as responsive, balanced action rows.
 * All buttons are Link buttons so they work inside DMs (interaction
 * components with customIds also work, but links need zero state and
 * never expire).
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} welcomeSettings
 * @returns {ActionRowBuilder[]} empty array when no channel is configured.
 */
function buildDMButtons(guild, welcomeSettings) {
  const buttons = [];
  const channelLink = (channelId) => `https://discord.com/channels/${guild.id}/${channelId}`;

  if (config.channels.rules || config.channels.welcome) {
    buttons.push(
      new ButtonBuilder()
        .setLabel('Rules')
        .setEmoji('📖')
        .setStyle(ButtonStyle.Link)
        .setURL(channelLink(config.channels.rules || config.channels.welcome))
    );
  }
  // 👋 Introduce Yourself — STRICTLY the dev-intro channel. No fallback:
  // if DEV_INTRO_CHANNEL_ID is not configured the button is hidden rather
  // than pointing somewhere wrong (e.g. the gateway/welcome channel).
  if (config.channels.devIntro) {
    buttons.push(
      new ButtonBuilder()
        .setLabel('Introduce Yourself')
        .setEmoji('👋')
        .setStyle(ButtonStyle.Link)
        .setURL(channelLink(config.channels.devIntro))
    );
  }
  if (config.channels.rolesPicker) {
    buttons.push(
      new ButtonBuilder()
        .setLabel('Choose Roles')
        .setEmoji('🎭')
        .setStyle(ButtonStyle.Link)
        .setURL(channelLink(config.channels.rolesPicker))
    );
  }
  if (config.channels.community || config.channels.welcome) {
    buttons.push(
      new ButtonBuilder()
        .setLabel('Community')
        .setEmoji('💬')
        .setStyle(ButtonStyle.Link)
        .setURL(channelLink(config.channels.community || config.channels.welcome))
    );
  }
  if (config.channels.support || config.channels.log) {
    buttons.push(
      new ButtonBuilder()
        .setLabel('Support')
        .setEmoji('🛟')
        .setStyle(ButtonStyle.Link)
        .setURL(channelLink(config.channels.support || config.channels.log))
    );
  }

  return toBalancedRows(buttons);
}

/**
 * Build the premium minimal welcome embed.
 *
 * Design decisions (see task spec):
 *   - No banner — clean, minimal, uncluttered.
 *   - Centred "DEVELOPER'S FORGE" monospace header plaque (dmContent.js)
 *     with computed padding so margins are even on desktop and mobile.
 *   - Warm forge amber accent (BRAND.accent) — elegant in dark & light mode.
 *   - Official Developer's Forge logo as the thumbnail, author icon and
 *     footer icon (auto-falls back to the server icon if unloadable).
 *   - Timestamp + "Developer's Forge • Learn • Build • Grow" footer.
 *   - Body content generated by dmContent.buildWelcomeBody with dynamic
 *     variables and one of 10 rotating quotes.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {EmbedBuilder}
 */
export function premiumWelcomeDMEmbed(member) {
  const guild = member.guild;
  const joinedTs = Math.floor((member.joinedTimestamp ?? Date.now()) / 1000);

  const body = buildWelcomeBody({
    username: member.user.username,
    displayName: member.displayName ?? member.user.globalName ?? member.user.username,
    memberCount: guild.memberCount,
    joinDate: `<t:${joinedTs}:D>`,
    serverName: guild.name,
  });

  return new EmbedBuilder()
    .setColor(BRAND.accent)
    .setAuthor({
      name: guild.name,
      iconURL: brandIcon(guild, 128),
    })
    .setDescription(body)
    .setThumbnail(brandIcon(guild, 512) ?? null)
    .setFooter({
      text: BRAND.footer,
      iconURL: brandIcon(guild, 64),
    })
    .setTimestamp();
}

/**
 * Send the full premium welcome DM to a new member. Never throws.
 *
 * Contract preserved from the previous implementation — callers
 * (events/guildMemberAdd.js) rely on the exact status strings for the
 * Telegram notification, the member store and the security profile.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {Promise<'Delivered'|'Disabled'|'Failed (DMs closed)'>} status.
 */
export async function sendWelcomeDM(member) {
  const settings = await getSettings(member.guild.id);
  const wc = settings.welcome;
  if (!wc.dmEnabled) return 'Disabled';

  const buttonRows = buildDMButtons(member.guild, wc);

  try {
    await member.send({
      embeds: [
        premiumWelcomeDMEmbed(member),
        rulesDMEmbed(member.guild.name),
      ],
      ...(buttonRows.length > 0 ? { components: buttonRows } : {}),
    });
    return 'Delivered';
  } catch (error) {
    // Closed DMs (error 50007) or any other delivery failure must never
    // interrupt the join flow — log and report gracefully.
    logger.warn(`Failed to send welcome DM to ${member.user.tag}: ${error.message}`);
    return 'Failed (DMs closed)';
  }
}
