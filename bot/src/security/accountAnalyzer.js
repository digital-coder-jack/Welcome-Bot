/**
 * security/accountAnalyzer.js
 * ---------------------------------------------------------------------------
 * Phase 1 — Account Analysis (Forge Guardian Security System v2.0).
 *
 * Calculates for every joining member:
 *   - Account age (ms / days / human readable)
 *   - New account detection            (< SECURITY_NEW_ACCOUNT_DAYS)
 *   - Recently created detection       (< SECURITY_RECENT_ACCOUNT_DAYS)
 *   - Default avatar detection
 *   - Bot or Human
 *
 * When available through the Discord API it also fetches (best-effort):
 *   - Banner URL
 *   - Accent color
 *   - Avatar decoration
 *   - Public badges / public flags
 *
 * Fail-safe: any API failure degrades to the base analysis; never throws.
 * ---------------------------------------------------------------------------
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { accountAge } from '../utils/time.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Human labels for Discord public user flags (badges). */
const BADGE_LABELS = {
  Staff: 'Discord Staff',
  Partner: 'Partnered Server Owner',
  Hypesquad: 'HypeSquad Events',
  BugHunterLevel1: 'Bug Hunter',
  BugHunterLevel2: 'Bug Hunter Gold',
  HypeSquadOnlineHouse1: 'House Bravery',
  HypeSquadOnlineHouse2: 'House Brilliance',
  HypeSquadOnlineHouse3: 'House Balance',
  PremiumEarlySupporter: 'Early Supporter',
  VerifiedBot: 'Verified Bot',
  VerifiedDeveloper: 'Early Verified Bot Developer',
  CertifiedModerator: 'Moderator Programs Alumni',
  ActiveDeveloper: 'Active Developer',
};

/**
 * Analyse a member's account. Best-effort profile enrichment via force-fetch.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {Promise<object>} account analysis
 */
export async function analyzeAccount(member) {
  const now = Date.now();
  const createdTs = member.user?.createdTimestamp ?? now;
  const ageMs = Math.max(0, now - createdTs);
  const ageDays = Math.floor(ageMs / DAY_MS);

  const analysis = {
    accountCreated: new Date(createdTs).toISOString(),
    accountAgeMs: ageMs,
    accountAgeDays: ageDays,
    accountAgeHuman: accountAge(createdTs),
    isNewAccount: ageDays < config.security.newAccountDays,
    isRecentAccount: ageDays < config.security.recentAccountDays,
    hasDefaultAvatar: !member.user?.avatar,
    isBot: Boolean(member.user?.bot),
    bannerUrl: null,
    accentColor: null,
    avatarDecoration: null,
    badges: [],
    publicFlags: 0,
    score: 0,
    findings: [],
  };

  // --- Best-effort profile enrichment (banner / accent color / badges) ---
  try {
    const fullUser = await member.user.fetch(true); // force-fetch full profile
    analysis.bannerUrl = fullUser.bannerURL?.({ extension: 'png', size: 512 }) ?? null;
    analysis.accentColor = fullUser.hexAccentColor ?? null;
    analysis.avatarDecoration = fullUser.avatarDecorationData?.asset ?? null;
    const flags = fullUser.flags ?? member.user.flags;
    if (flags) {
      analysis.publicFlags = flags.bitfield ?? 0;
      analysis.badges = flags.toArray().map((f) => BADGE_LABELS[f] ?? f);
    }
  } catch (error) {
    logger.debug(`Could not fetch full profile for ${member.user?.tag}: ${error.message}`);
  }

  // --- Risk contribution ---
  if (analysis.isBot) {
    analysis.findings.push('Account is a bot');
  }
  if (analysis.isNewAccount) {
    analysis.findings.push(`Very new account (${ageDays} day(s) old)`);
    analysis.score += 30;
  } else if (analysis.isRecentAccount) {
    analysis.findings.push(`Recently created account (${ageDays} day(s) old)`);
    analysis.score += 15;
  }
  if (analysis.hasDefaultAvatar) {
    analysis.findings.push('Default avatar (no custom avatar set)');
    analysis.score += 10;
  }
  if (analysis.hasDefaultAvatar && analysis.isNewAccount) {
    analysis.findings.push('New account + default avatar (classic raid-account profile)');
    analysis.score += 10;
  }

  analysis.score = Math.min(100, analysis.score);
  return analysis;
}
