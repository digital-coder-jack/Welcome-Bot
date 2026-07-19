/**
 * managers/farewellManager.js
 * ---------------------------------------------------------------------------
 * The Premium Farewell DM experience — Developer Forge edition.
 *
 * Sent ONLY when a member leaves the server VOLUNTARILY:
 *   - The guild audit log is checked (MemberKick + MemberBanAdd) so kicked
 *     or banned members NEVER receive this message.
 *   - If the audit log is unreadable (missing permission), we additionally
 *     consult the local kick/ban trackers before deciding.
 *
 * Design rules (strictly followed):
 *   - Warm, respectful, professional and premium — never guilt-tripping.
 *   - NEVER mentions punishments, warnings, moderation or rule violations.
 *   - Personalised with the member's username.
 *   - Unicode dividers, clean spacing, tasteful emojis (no emoji spam).
 *   - Animated farewell GIF at the top (embed image), brand thumbnail,
 *     farewell banner, branded footer + timestamp.
 *   - Link buttons: 🌐 Rejoin · 💬 Contact Staff · 📚 Community Website.
 *   - If the member's DMs are closed, the error is silently ignored.
 * ---------------------------------------------------------------------------
 */

import {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getSettings } from '../database/settingsStore.js';

/** Official Developer Forge brand colour (blurple). */
export const BRAND_COLOR = 0x5865f2;

/**
 * Curated animated farewell GIFs — programming / tech / waving goodbye /
 * anime aesthetic. One is picked at random per departure (no config needed).
 */
const FAREWELL_GIFS = Object.freeze([
  'https://media.giphy.com/media/UDc42vuFGgVim/giphy.gif', // anime wave goodbye
  'https://media.giphy.com/media/xUPGcMzwkOY01nj6hi/giphy.gif', // tech goodbye
  'https://media.giphy.com/media/L1R1tvI9svkIWwpVYr/giphy.gif', // waving farewell
  'https://media.giphy.com/media/qUIm5wu6LAAog/giphy.gif', // coding farewell
]);

/** Default farewell banner (large image) — overridable per guild. */
const DEFAULT_FAREWELL_BANNER =
  'https://media.giphy.com/media/3oKIPnAiaMCws8nOsE/giphy.gif';

/** Footer branding line. */
const FOOTER_TEXT =
  'Developer Forge • Different people, different stories — everyone deserves respect.';

/** Section divider used inside the farewell description. */
const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━━';

/** Pick a random farewell GIF. */
function pickFarewellGif() {
  return FAREWELL_GIFS[Math.floor(Math.random() * FAREWELL_GIFS.length)];
}

/**
 * Determine whether the departure was a kick or ban by reading the guild
 * audit log (best-effort — requires View Audit Log). Entries older than
 * 60 seconds are ignored so historic actions never misclassify a new leave.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} userId
 * @returns {Promise<'kick'|'ban'|'voluntary'|'unknown'>}
 */
export async function classifyDeparture(guild, userId) {
  const RECENT_MS = 60_000;
  const now = Date.now();

  try {
    const [kicks, bans] = await Promise.all([
      guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 5 }),
      guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 5 }),
    ]);

    const wasBanned = bans.entries.some(
      (e) => e.target?.id === userId && now - e.createdTimestamp < RECENT_MS
    );
    if (wasBanned) return 'ban';

    const wasKicked = kicks.entries.some(
      (e) => e.target?.id === userId && now - e.createdTimestamp < RECENT_MS
    );
    if (wasKicked) return 'kick';

    return 'voluntary';
  } catch (error) {
    logger.warn(
      `Farewell: could not read audit log (${error.message}) — departure type unknown.`
    );
    return 'unknown';
  }
}

/**
 * Build the premium farewell embed.
 *
 * @param {import('discord.js').GuildMember|import('discord.js').PartialGuildMember} member
 * @param {object} farewellSettings  settings.farewell from settingsStore.
 * @returns {EmbedBuilder}
 */
function farewellEmbed(member, farewellSettings) {
  const guild = member.guild;
  const username = member.user?.displayName ?? member.user?.username ?? 'friend';
  const logo = guild.iconURL({ size: 256 }) ?? undefined;
  const banner = farewellSettings.bannerUrl || DEFAULT_FAREWELL_BANNER;

  const description = [
    DIVIDER,
    '',
    `👋 Hey **${username}**,`,
    '',
    DIVIDER,
    '',
    `🌸 Thank you for being part of **Developer Forge**.`,
    'Every member brings something valuable to this community — and you did too.',
    '',
    DIVIDER,
    '',
    '💻 Wherever your journey takes you next:',
    '',
    '> **Keep building.**',
    '> **Keep learning.**',
    '> **Keep creating.**',
    '> **Never stop exploring technology.**',
    '',
    DIVIDER,
    '',
    `🏡 Our doors are always open — you're welcome back at **${guild.name}** anytime you choose to return.`,
    '',
    DIVIDER,
    '',
    '💙 Take care.',
    '🚀 Happy Coding.',
    '👋 See you again.',
    '',
    '— **Developer Forge Team**',
  ].join('\n');

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor({ name: 'Developer Forge', iconURL: logo })
    .setTitle('👋 See You Later!')
    .setDescription(description)
    .setImage(banner) // large farewell banner
    .setFooter({ text: FOOTER_TEXT, iconURL: logo })
    .setTimestamp();

  if (logo) embed.setThumbnail(logo); // Developer Forge logo

  return embed;
}

/**
 * Small "hero" embed carrying the animated farewell GIF at the very top of
 * the DM (Discord shows embeds in order, so this renders above the main one).
 *
 * @returns {EmbedBuilder}
 */
function farewellGifEmbed() {
  return new EmbedBuilder().setColor(BRAND_COLOR).setImage(pickFarewellGif());
}

/**
 * Link-button row: Rejoin · Contact Staff · Community Website.
 * Only configured buttons are attached; all are Link buttons so they work
 * in DMs with zero state.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} farewellSettings
 * @returns {Promise<ActionRowBuilder|null>}
 */
async function buildFarewellButtons(guild, farewellSettings) {
  const row = new ActionRowBuilder();

  // 🌐 Rejoin — explicit invite URL, else the guild's vanity URL.
  let rejoinUrl = farewellSettings.inviteUrl || '';
  if (!rejoinUrl && guild.vanityURLCode) {
    rejoinUrl = `https://discord.gg/${guild.vanityURLCode}`;
  }
  if (rejoinUrl && /^https?:\/\//i.test(rejoinUrl)) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Rejoin Developer Forge')
        .setEmoji('🌐')
        .setStyle(ButtonStyle.Link)
        .setURL(rejoinUrl)
    );
  }

  // 💬 Contact Staff — link to the support (or log) channel.
  const staffChannel = config.channels.support || config.channels.log;
  if (staffChannel) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Contact Staff')
        .setEmoji('💬')
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${guild.id}/${staffChannel}`)
    );
  }

  // 📚 Community Website (optional).
  const website = farewellSettings.websiteUrl;
  if (website && /^https?:\/\//i.test(website)) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Community Website')
        .setEmoji('📚')
        .setStyle(ButtonStyle.Link)
        .setURL(website)
    );
  }

  return row.components.length > 0 ? row : null;
}

/**
 * Send the premium farewell DM to a member who left VOLUNTARILY.
 *
 * Safety guarantees:
 *   - Skips bots.
 *   - Skips kicked/banned members (audit log + local trackers).
 *   - Never throws — closed DMs are silently ignored.
 *
 * @param {import('discord.js').GuildMember|import('discord.js').PartialGuildMember} member
 * @param {'kick'|'ban'|'voluntary'|'unknown'} [departureType]  pre-computed
 *        classification (pass it in to avoid a second audit-log read).
 * @returns {Promise<'Delivered'|'Disabled'|'Skipped (not voluntary)'|'Failed (DMs closed)'>}
 */
export async function sendFarewellDM(member, departureType) {
  if (member.user?.bot) return 'Skipped (not voluntary)';

  const settings = await getSettings(member.guild.id);
  const farewell = settings.farewell ?? {};
  if (farewell.dmEnabled === false) return 'Disabled';

  // NEVER send the farewell to kicked or banned members.
  const type = departureType ?? (await classifyDeparture(member.guild, member.id));
  if (type === 'kick' || type === 'ban') {
    logger.info(`Farewell DM skipped for ${member.user?.tag ?? member.id}: departure was a ${type}.`);
    return 'Skipped (not voluntary)';
  }

  const buttons = await buildFarewellButtons(member.guild, farewell);

  try {
    // The member has already left, so resolve the underlying User —
    // GuildMember#send can fail on partial members after departure.
    const user = member.user ?? (await member.client.users.fetch(member.id));
    await user.send({
      embeds: [farewellGifEmbed(), farewellEmbed(member, farewell)],
      ...(buttons ? { components: [buttons] } : {}),
    });
    logger.info(`Premium farewell DM delivered to ${member.user?.tag ?? member.id}.`);
    return 'Delivered';
  } catch (error) {
    // Discord error 50007 = Cannot send messages to this user (DMs closed).
    // Per spec: silently ignore — never let it break the leave flow.
    logger.debug?.(`Farewell DM not delivered (${error.message}).`);
    return 'Failed (DMs closed)';
  }
}
