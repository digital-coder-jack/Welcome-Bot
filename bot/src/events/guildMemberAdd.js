/**
 * events/guildMemberAdd.js
 * ---------------------------------------------------------------------------
 * The Welcome System. When a new member joins:
 *
 *   1. Send the member introduction (public welcome + welcome DM + dev-intro)
 *      via managers/introductionManager.js — the single source of truth.
 *      • Membership Screening (Gateway) ENABLED  → the introduction is
 *        DEFERRED: nothing is sent here; it fires exactly once from
 *        guildMemberUpdate after the member passes the Gateway.
 *      • Membership Screening DISABLED → the introduction is sent here,
 *        immediately, exactly once.
 *   2. Assign the "Forge Member" role.
 *   3. Send the full Telegram join notification via the FastAPI backend.
 *   4. Save the member information to the local member store.
 *
 * Additionally, every join is fed to the security service (raid detection &
 * new-account screening).
 *
 * Every step is best-effort and independently guarded so a failure in one
 * (e.g. DMs closed) never prevents the others.
 * ---------------------------------------------------------------------------
 */

import { Events } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { COLORS } from '../utils/embeds.js';
import {
  registerPendingIntroduction,
  completePostScreeningMemberFlow,
} from '../managers/introductionManager.js';
import { accountAge, formatUTC } from '../utils/time.js';
import { sendLog } from '../services/moderationService.js';
import { notifyMemberJoined } from '../services/telegramClient.js';
import { resolveUsedInvite } from '../services/inviteTracker.js';
import { trackJoinForSecurity } from '../services/securityService.js';
import { isDuplicateActiveJoin, saveMember } from '../database/memberStore.js';
import { runJoinScan } from '../security/joinScan.js';
import { trackJoinForRaid, isRaidModeActive } from '../security/raidManager.js';
import { sendSecurityReport } from '../security/securityReport.js';
import { isLockdownActive } from '../security/lockdownManager.js';
import { syncProfileFromMember } from '../database/profileStore.js';
import { syncNativeOnboardingFromMember } from '../database/nativeOnboardingSync.js';
import { assignForgeMemberRole } from '../services/forgeMemberRole.js';

/**
 * Join dedupe guard — Discord's gateway can re-emit GuildMemberAdd for the
 * same member (session resumes / reconnects), which used to double-send the
 * welcome + dev-intro messages. Each processed join is remembered for
 * DEDUPE_TTL_MS; duplicates inside that window are ignored entirely.
 * @type {Map<string, number>} key = `${guildId}:${userId}`, value = expiry ts.
 */
const recentJoins = new Map();
const DEDUPE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Returns true when this member's join was already processed recently.
 * Also opportunistically evicts expired entries so the map never grows.
 *
 * @param {string} guildId
 * @param {string} userId
 * @returns {boolean}
 */
function isDuplicateJoin(guildId, userId) {
  const now = Date.now();
  for (const [key, expiry] of recentJoins) {
    if (expiry <= now) recentJoins.delete(key);
  }
  const key = `${guildId}:${userId}`;
  if (recentJoins.has(key)) return true;
  recentJoins.set(key, now + DEDUPE_TTL_MS);
  return false;
}

export default {
  name: Events.GuildMemberAdd,
  once: false,

  /**
   * @param {import('discord.js').GuildMember} member
   */
  async execute(member) {
    const isBot = member.user.bot;

    // Ignore duplicate join events (gateway re-emits or a bot restart). The
    // persistent record is checked first; the in-memory guard covers races.
    if (await isDuplicateActiveJoin(member.guild.id, member.id, member.joinedTimestamp)) {
      logger.warn(`Persistent duplicate GuildMemberAdd ignored for ${member.user.tag} (${member.id}).`);
      return;
    }
    if (isDuplicateJoin(member.guild.id, member.id)) {
      logger.warn(`Duplicate GuildMemberAdd ignored for ${member.user.tag} (${member.id}).`);
      return;
    }

    logger.info(`Member joined: ${member.user.tag} (${member.id})${isBot ? ' [BOT]' : ''}.`);

    // Resolve which invite was used (works for bots and humans alike).
    const invite = await resolveUsedInvite(member.guild);

    // Security screening runs for every join, including bots.
    try {
      await trackJoinForSecurity(member);
    } catch (error) {
      logger.warn(`Security join tracking failed: ${error.message}`);
    }

    // --- Forge Guardian v2.0: Anti-Raid tracking (Phase 3) ---
    let raidActive = false;
    if (config.security.antiRaidEnabled) {
      try {
        raidActive = await trackJoinForRaid(member);
      } catch (error) {
        logger.warn(`Anti-raid tracking failed: ${error.message}`);
      }
    }

    // --- Forge Guardian v2.0: complete Join Security Scan (Phase 1) ---
    let scan = null;
    try {
      scan = await runJoinScan(member, invite);
    } catch (error) {
      logger.warn(`Join security scan failed: ${error.message}`);
    }

    let dmStatus = 'Not attempted';
    let assignedRole = 'None';
    let devIntroSent = false;
    let telegramSent = false;
    let databaseSaved = false;
    let nativeOnboarding = {
      interests: [],
      experience: null,
      workStatus: null,
      gender: null,
    };

    // During Raid Mode or manual Lockdown, welcomes are paused (safety);
    // everything else continues.
    const lockdownActive = isLockdownActive(member.guild.id);
    const welcomesPaused = raidActive || isRaidModeActive(member.guild.id) || lockdownActive;
    if (welcomesPaused) {
      dmStatus = lockdownActive ? 'Paused (Lockdown)' : 'Paused (Raid Mode)';
      logger.warn(`${lockdownActive ? 'Lockdown' : 'Raid Mode'} active — welcome flow paused for ${member.user.tag}.`);
    }

    if (!isBot && !welcomesPaused) {
      // Membership Screening still defers the existing welcome/introduction.
      // Native Discord Server Onboarding is handled by Discord itself; this bot
      // must not send a second onboarding UI into the Gateway channel.
      if (member.pending === true) {
        registerPendingIntroduction(member);
        dmStatus = 'Deferred (membership screening)';
      } else {
        const finalFlow = await completePostScreeningMemberFlow(member);
        dmStatus = finalFlow.dmStatus;
        devIntroSent = finalFlow.gatewayIntroSent;
      }

      // Assign the default role only after the member has completed the
      // required screening flow. It is never treated as an answer.
      assignedRole = await assignForgeMemberRole(member);
    }

    // --- Phase 7: synchronize native Discord Onboarding outcomes ---
    // Discord does not expose prompt answers as a GuildMember field. Native
    // onboarding-assigned roles are the supported member-scoped signal, and
    // only configured role IDs are mapped here.
    try {
      const nativeSync = await syncNativeOnboardingFromMember(member);
      nativeOnboarding = nativeSync.selections;
    } catch (error) {
      logger.warn(`Failed to sync native onboarding data: ${error.message}`);
    }

    // --- Step 3: Telegram join notification via the backend ---
    try {
      telegramSent = await notifyMemberJoined({
        username: member.user.username,
        display_name: member.displayName ?? member.user.globalName ?? member.user.username,
        user_id: member.id,
        server_name: member.guild.name,
        join_time: formatUTC(member.joinedTimestamp ?? Date.now()),
        account_created: formatUTC(member.user.createdTimestamp),
        account_age: accountAge(member.user.createdTimestamp),
        member_number: member.guild.memberCount,
        invite_code: invite.code,
        inviter: invite.inviterTag,
        bot_or_human: isBot ? 'Bot' : 'Human',
        avatar_url: member.user.displayAvatarURL({ extension: 'png', size: 512 }),
        assigned_role: assignedRole,
        dm_status: dmStatus,
        server_invite_used: invite.url,
        interests: nativeOnboarding.interests,
        experience: nativeOnboarding.experience,
        work_status: nativeOnboarding.workStatus,
        gender: nativeOnboarding.gender,
      });
    } catch (error) {
      logger.warn(`Telegram join notification failed: ${error.message}`);
    }

    // --- Step 4: Save member information ---
    try {
      databaseSaved = Boolean(await saveMember({
        guildId: member.guild.id,
        userId: member.id,
        username: member.user.username,
        displayName: member.displayName ?? member.user.username,
        joinedAt: new Date(member.joinedTimestamp ?? Date.now()).toISOString(),
        accountCreated: new Date(member.user.createdTimestamp).toISOString(),
        memberNumber: member.guild.memberCount,
        inviteCode: invite.code,
        inviter: invite.inviterTag,
        isBot,
        avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 512 }),
        assignedRole,
        dmStatus,
      }));
    } catch (error) {
      logger.warn(`Failed to save member information: ${error.message}`);
    }

    // --- Phase 7: create/refresh the permanent security profile ---
    try {
      await syncProfileFromMember(member, {
        inviteUsed: invite.code,
        inviter: invite.inviterTag,
        memberNumber: member.guild.memberCount,
        welcomeDmStatus: dmStatus,
        forgeMemberStatus: assignedRole !== 'None' ? `Assigned (${assignedRole})` : 'Not assigned',
        devIntroStatus: devIntroSent ? 'Sent' : 'Not sent',
        verificationStatus: member.pending ? 'Pending (membership screening)' : 'Passed gateway',
        bannerUrl: scan?.account?.bannerUrl ?? undefined,
        accentColor: scan?.account?.accentColor ?? undefined,
        badges: scan?.account?.badges ?? undefined,
        publicFlags: scan?.account?.publicFlags ?? undefined,
      });
    } catch (error) {
      logger.warn(`Failed to sync security profile: ${error.message}`);
    }

    // --- Forge Guardian v2.0: post the Security Report (best-effort) ---
    if (scan) {
      try {
        await sendSecurityReport(member, {
          scan,
          invite,
          assignedRole,
          dmStatus,
          devIntroSent,
          telegramSent,
          databaseSaved,
        });
      } catch (error) {
        logger.warn(`Security report failed: ${error.message}`);
      }
    }

    // Log the join to the moderation log channel.
    await sendLog(member.guild, {
      action: 'Member Joined',
      color: COLORS.welcome,
      userTag: member.user.tag,
      userId: member.id,
      extraFields: [
        { name: 'Member #', value: `${member.guild.memberCount}`, inline: true },
        { name: 'Invite', value: invite.code, inline: true },
        { name: 'Inviter', value: invite.inviterTag, inline: true },
        { name: 'Account Age', value: accountAge(member.user.createdTimestamp), inline: true },
        { name: 'Type', value: isBot ? 'Bot' : 'Human', inline: true },
        { name: 'DM Status', value: dmStatus, inline: true },
        { name: 'Onboarding', value: member.pending === true ? 'Pending' : 'Completed / not required', inline: true },
        { name: 'Default Role', value: assignedRole, inline: true },
        ...(scan
          ? [{ name: 'Risk Score', value: `${scan.riskScore}/100 (${scan.threatLevel})`, inline: true }]
          : []),
      ],
    });
  },
};
