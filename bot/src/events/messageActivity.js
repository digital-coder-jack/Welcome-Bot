/**
 * events/messageActivity.js
 * ---------------------------------------------------------------------------
 * Phase 7 — Member activity tracking (Forge Guardian v2.0).
 *
 * Runs alongside the existing messageCreate auto-moderation handler (the
 * event loader registers both). Updates the member's permanent security
 * profile with IN-SERVER activity only:
 *
 *   - messageCount     (+1 per guild message)
 *   - attachmentsSent  (+n when attachments are present)
 *   - linksShared      (+n links detected in the content)
 *   - lastSeen         (ISO timestamp)
 *
 * Also enforces the Phase-8 blacklisted-server rule: invite links pointing
 * at a blacklisted invite code are deleted (best-effort) and logged.
 *
 * Everything is best-effort — a failure here never affects messaging.
 * ---------------------------------------------------------------------------
 */

import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { bumpProfile, updateProfile } from '../database/profileStore.js';
import { isInviteBlacklisted } from '../database/blacklistStore.js';
import { logSecurityEvent } from '../security/securityLogger.js';
import { deleteMessage } from '../services/moderationService.js';
import { incrementStat } from '../database/statsStore.js';

const LINK_RE = /https?:\/\/\S+/gi;
const INVITE_RE = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/([\w-]+)/gi;

export default {
  name: Events.MessageCreate,
  once: false,

  /**
   * @param {import('discord.js').Message} message
   */
  async execute(message) {
    if (!message.guild || message.author.bot || message.system) return;

    // --- Activity counters (Phase 7) ---
    try {
      const guildId = message.guild.id;
      const userId = message.author.id;

      await bumpProfile(guildId, userId, 'activity', 'messageCount');
      if (message.attachments.size > 0) {
        await bumpProfile(guildId, userId, 'activity', 'attachmentsSent', message.attachments.size);
      }
      const links = message.content?.match(LINK_RE) ?? [];
      if (links.length > 0) {
        await bumpProfile(guildId, userId, 'activity', 'linksShared', links.length);
      }
      await updateProfile(guildId, userId, { activity: { lastSeen: new Date().toISOString() } });
    } catch (error) {
      logger.debug(`Activity tracking failed: ${error.message}`);
    }

    // --- Blacklisted invite / server enforcement (Phase 8) ---
    try {
      const matches = [...(message.content ?? '').matchAll(INVITE_RE)];
      for (const m of matches) {
        const entry = await isInviteBlacklisted(message.guild.id, m[1]);
        if (entry) {
          await deleteMessage(message, {
            reason: `Blacklisted invite link (\`${m[1]}\`): ${entry.reason || 'no reason recorded'}`,
            source: 'auto',
          });
          await incrementStat(message.guild.id, 'threatsBlocked');
          await logSecurityEvent(message.guild, {
            type: 'BLACKLISTED_INVITE',
            severity: 'high',
            summary: `Deleted blacklisted invite \`${m[1]}\` posted by ${message.author.tag}`,
            userTag: message.author.tag,
            userId: message.author.id,
          });
          break;
        }
      }
    } catch (error) {
      logger.debug(`Blacklisted-invite enforcement failed: ${error.message}`);
    }
  },
};
