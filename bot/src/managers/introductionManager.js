/**
 * managers/introductionManager.js
 * ---------------------------------------------------------------------------
 * Single source of truth for the member introduction (onboarding) flow.
 *
 * Exactly ONE introduction per member — never duplicates:
 *
 *   • Membership Screening (Gateway) ENABLED  → member joins with
 *     `member.pending === true`. guildMemberAdd registers the member here
 *     and sends NOTHING. The introduction fires once, from
 *     guildMemberUpdate, the moment the member passes the Gateway
 *     (pending: true → false).
 *
 *   • Membership Screening DISABLED → member joins with
 *     `member.pending === false`. guildMemberAdd sends the introduction
 *     immediately, exactly as before.
 *
 * A TTL'd dedupe registry guarantees the introduction can never fire twice
 * for the same member+join, regardless of gateway re-emits, partial-member
 * updates, or both events racing.
 *
 * The introduction consists of the existing premium experience (unchanged):
 *   1. Public welcome (welcomeManager — themed / cinematic animation).
 *   2. Welcome DM (dmManager — premium plaque embed + rules + buttons).
 *   3. Developer Intro message in the dev-intro channel.
 *
 * Raid Mode / Lockdown pauses are honoured at send time, and every step is
 * best-effort — one failure never blocks the others. This module never
 * throws.
 * ---------------------------------------------------------------------------
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { devIntroEmbed } from '../utils/embeds.js';
import { sendPublicWelcome } from './welcomeManager.js';
import { sendWelcomeDM } from './dmManager.js';
import { isRaidModeActive } from '../security/raidManager.js';
import { isLockdownActive } from '../security/lockdownManager.js';

/** How long a member stays marked as "introduced" (covers rejoin churn). */
const INTRODUCED_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** How long we remember a member awaiting Membership Screening. */
const AWAITING_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Members whose introduction has already been sent.
 * @type {Map<string, number>} key = `${guildId}:${userId}`, value = expiry ts.
 */
const introducedMembers = new Map();

/**
 * Members who joined while Membership Screening was enabled and have not
 * yet passed the Gateway.
 * @type {Map<string, number>} key = `${guildId}:${userId}`, value = expiry ts.
 */
const awaitingScreening = new Map();

/** @param {Map<string, number>} map  Evict expired entries in place. */
function evictExpired(map) {
  const now = Date.now();
  for (const [key, expiry] of map) {
    if (expiry <= now) map.delete(key);
  }
}

/** @returns {string} composite registry key. */
const keyOf = (guildId, userId) => `${guildId}:${userId}`;

/**
 * Register a member who joined behind Membership Screening. Their
 * introduction is deferred until they pass the Gateway.
 *
 * @param {import('discord.js').GuildMember} member
 */
export function registerPendingIntroduction(member) {
  evictExpired(awaitingScreening);
  awaitingScreening.set(keyOf(member.guild.id, member.id), Date.now() + AWAITING_TTL_MS);
  logger.info(
    `Introduction deferred for ${member.user.tag} (${member.id}) — awaiting Membership Screening.`
  );
}

/**
 * Decide whether a guildMemberUpdate represents the member passing the
 * Membership Screening Gateway and therefore owes them their introduction.
 *
 * Two detection paths (both required for correctness):
 *   1. Registry path — the member was registered at join time. Works even
 *      when `oldMember` is a partial (no old `pending` state available).
 *   2. Transition path — `oldMember.pending === true → newMember.pending
 *      === false`. Catches members who joined before a bot restart wiped
 *      the in-memory registry.
 *
 * The final duplicate guard lives in sendMemberIntroduction(), so a member
 * matched by both paths (or by racing events) is still introduced once.
 *
 * @param {import('discord.js').GuildMember|import('discord.js').PartialGuildMember} oldMember
 * @param {import('discord.js').GuildMember} newMember
 * @returns {boolean}
 */
export function shouldSendGatewayIntroduction(oldMember, newMember) {
  if (newMember.user.bot) return false;
  if (newMember.pending !== false) return false; // still behind the Gateway.

  const key = keyOf(newMember.guild.id, newMember.id);
  evictExpired(awaitingScreening);

  if (awaitingScreening.has(key)) {
    awaitingScreening.delete(key);
    return true;
  }
  // Restart-safe fallback: explicit pending → passed transition.
  return !oldMember.partial && oldMember.pending === true;
}

/**
 * Send the full member introduction exactly once.
 *
 * Steps (all best-effort, independently guarded — identical to the
 * long-standing behaviour, now living in one place):
 *   1. Public welcome message.
 *   2. Premium welcome DM (+ rules).
 *   3. Developer Intro message.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {object} [options]
 * @param {'join'|'gateway'} [options.source='join']  What triggered the intro.
 * @returns {Promise<{sent: boolean, dmStatus: string, devIntroSent: boolean}>}
 */
export async function sendMemberIntroduction(member, { source = 'join' } = {}) {
  const result = { sent: false, dmStatus: 'Not attempted', devIntroSent: false };

  if (member.user.bot) return result;

  // --- Duplicate guard: one introduction per member, ever (within TTL) ---
  evictExpired(introducedMembers);
  const key = keyOf(member.guild.id, member.id);
  if (introducedMembers.has(key)) {
    logger.warn(
      `Duplicate introduction suppressed for ${member.user.tag} (${member.id}) [source: ${source}].`
    );
    result.dmStatus = 'Skipped (already introduced)';
    return result;
  }
  introducedMembers.set(key, Date.now() + INTRODUCED_TTL_MS);

  // --- Safety pause: Raid Mode / Lockdown ---
  const lockdownActive = isLockdownActive(member.guild.id);
  if (lockdownActive || isRaidModeActive(member.guild.id)) {
    // Release the dedupe slot — the intro was not actually sent.
    introducedMembers.delete(key);
    result.dmStatus = lockdownActive ? 'Paused (Lockdown)' : 'Paused (Raid Mode)';
    logger.warn(
      `${lockdownActive ? 'Lockdown' : 'Raid Mode'} active — introduction paused for ${member.user.tag}.`
    );
    return result;
  }

  logger.info(`Sending introduction for ${member.user.tag} (${member.id}) [source: ${source}].`);

  // --- Step 1: Premium public welcome (themed, cinematic animation,
  //             random GIFs, buttons, stickers) via welcomeManager ---
  try {
    await sendPublicWelcome(member);
  } catch (error) {
    logger.warn(`Failed to send public welcome: ${error.message}`);
  }

  // --- Step 2: Premium welcome DM (multi-embed journey + buttons +
  //             server rules) via dmManager ---
  try {
    result.dmStatus = await sendWelcomeDM(member);
  } catch (error) {
    result.dmStatus = 'Failed (DMs closed)';
    logger.warn(`Failed to send welcome DM: ${error.message}`);
  }

  // --- Step 3: Auto-send the Developer Intro message ---
  if (config.channels.devIntro) {
    try {
      const channel = await member.guild.channels.fetch(config.channels.devIntro);
      if (channel?.isTextBased()) {
        await channel.send({ content: `${member}`, embeds: [devIntroEmbed(member)] });
        result.devIntroSent = true;
      }
    } catch (error) {
      logger.warn(`Failed to send dev-intro message: ${error.message}`);
    }
  }

  result.sent = true;
  return result;
}
