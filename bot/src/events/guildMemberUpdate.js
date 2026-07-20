/**
 * events/guildMemberUpdate.js
 * ---------------------------------------------------------------------------
 * 1. Membership Screening (Gateway) introduction dispatch:
 *    When a member passes the Gateway (pending: true → false), the member
 *    introduction (public welcome + welcome DM + dev-intro) is sent exactly
 *    once via managers/introductionManager.js. When Screening is disabled
 *    members never arrive pending, so this path simply never fires —
 *    guildMemberAdd handles them. There is never a duplicate introduction.
 *
 * 2. Phase 8 — Role & permission abuse watcher (Forge Guardian v2.0).
 *
 * On every member update, checks for:
 *   - Role abuse: many roles granted to one member in a short window.
 *   - Permission abuse: dangerous permissions (Administrator, Ban, Kick,
 *     Manage Guild/Roles/Channels/Webhooks, Mention Everyone) suddenly
 *     gained via role grants.
 *
 * Findings are logged to the security event log and reported to the
 * alert channel + Telegram. THE BOT NEVER REVERTS ROLES AUTOMATICALLY —
 * this is a watchdog; humans decide.
 *
 * Also keeps the member's permanent profile roles list in sync (Phase 7).
 * ---------------------------------------------------------------------------
 */

import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { detectRoleAbuse } from '../security/advancedProtection.js';
import { logSecurityEvent } from '../security/securityLogger.js';
import { reportSecurityEvent } from '../services/securityService.js';
import { updateProfile } from '../database/profileStore.js';
import { config } from '../config.js';
import {
  shouldSendGatewayIntroduction,
  sendMemberIntroduction,
} from '../managers/introductionManager.js';

export default {
  name: Events.GuildMemberUpdate,
  once: false,

  /**
   * @param {import('discord.js').GuildMember|import('discord.js').PartialGuildMember} oldMember
   * @param {import('discord.js').GuildMember} newMember
   */
  async execute(oldMember, newMember) {
    // --- Membership Screening: send the deferred introduction exactly once
    //     after the member passes the Gateway (best-effort, never throws) ---
    try {
      if (shouldSendGatewayIntroduction(oldMember, newMember)) {
        const intro = await sendMemberIntroduction(newMember, { source: 'gateway' });
        if (intro.sent) {
          logger.info(
            `Gateway passed — introduction sent for ${newMember.user.tag} (${newMember.id}).`
          );
          // Keep the permanent profile's onboarding fields current.
          await updateProfile(newMember.guild.id, newMember.id, {
            server: {
              welcomeDmStatus: intro.dmStatus,
              devIntroStatus: intro.devIntroSent ? 'Sent' : 'Not sent',
              verificationStatus: 'Passed gateway',
            },
          }).catch(() => {});
        }
      }
    } catch (error) {
      logger.warn(`Gateway introduction dispatch failed: ${error.message}`);
    }

    // --- Phase 7: keep profile roles/nickname in sync (best-effort) ---
    try {
      const roles = newMember.roles.cache
        .filter((r) => r.id !== newMember.guild.id)
        .map((r) => ({ id: r.id, name: r.name }));
      const highestRole =
        newMember.roles.highest.id !== newMember.guild.id ? newMember.roles.highest.name : null;
      const forgeMemberStatus =
        config.roles.forgeMember && newMember.roles.cache.has(config.roles.forgeMember)
          ? 'Assigned'
          : undefined;
      const patch = { server: { roles, highestRole }, identity: { nickname: newMember.nickname ?? null } };
      if (forgeMemberStatus) patch.server.forgeMemberStatus = forgeMemberStatus;
      await updateProfile(newMember.guild.id, newMember.id, patch);
    } catch (error) {
      logger.debug(`Profile role sync failed: ${error.message}`);
    }

    // --- Phase 8: role / permission abuse detection ---
    if (oldMember.partial) return; // can't diff roles without the old state.
    try {
      const abuse = detectRoleAbuse(oldMember, newMember);
      if (!abuse) return;

      logger.warn(`Role/permission abuse watch: ${abuse.findings.join(' | ')}`);

      await logSecurityEvent(newMember.guild, {
        type: 'ROLE_ABUSE_WATCH',
        severity: abuse.severity,
        summary: abuse.findings[0],
        userTag: newMember.user.tag,
        userId: newMember.id,
        details: abuse.findings.join('\n'),
      });

      await reportSecurityEvent({
        alertType: 'Role/Permission Abuse Watch',
        severity: abuse.severity,
        serverName: newMember.guild.name,
        username: newMember.user.tag,
        userId: newMember.id,
        details: `${abuse.findings.join('; ')}. No automatic action taken — review the audit log.`,
      });
    } catch (error) {
      logger.warn(`Role abuse watcher failed: ${error.message}`);
    }
  },
};
