/**
 * events/guildBanAdd.js
 * ---------------------------------------------------------------------------
 * The Ban Handler. Fires whenever a member is banned (by a moderator, another
 * bot, or this bot itself).
 *
 *   1. Resolve WHO banned the user and WHY from the guild audit log.
 *   2. Send a Telegram ban notification via the FastAPI backend.
 *   3. Log the ban to the moderation log channel.
 * ---------------------------------------------------------------------------
 */

import { AuditLogEvent, Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { COLORS } from '../utils/embeds.js';
import { formatUTC } from '../utils/time.js';
import { sendLog } from '../services/moderationService.js';
import { notifyBan } from '../services/telegramClient.js';

export default {
  name: Events.GuildBanAdd,
  once: false,

  /**
   * @param {import('discord.js').GuildBan} ban
   */
  async execute(ban) {
    logger.info(`Member banned: ${ban.user.tag} (${ban.user.id}).`);

    // 1. Resolve the moderator and reason from the audit log (best-effort).
    let moderator = 'Unknown';
    let reason = ban.reason ?? 'No reason provided';
    try {
      const audit = await ban.guild.fetchAuditLogs({
        type: AuditLogEvent.MemberBanAdd,
        limit: 5,
      });
      const entry = audit.entries.find(
        (e) => e.target?.id === ban.user.id && Date.now() - e.createdTimestamp < 60_000
      );
      if (entry) {
        moderator = entry.executor?.tag ?? 'Unknown';
        if (entry.reason) reason = entry.reason;
      }
    } catch (error) {
      logger.warn(`Could not read audit log for ban: ${error.message} (needs View Audit Log permission).`);
    }

    // 2. Telegram ban notification via the backend.
    try {
      await notifyBan({
        username: ban.user.tag,
        user_id: ban.user.id,
        server_name: ban.guild.name,
        reason,
        moderator,
        timestamp: formatUTC(Date.now()),
      });
    } catch (error) {
      logger.warn(`Telegram ban notification failed: ${error.message}`);
    }

    // 3. Log the ban.
    await sendLog(ban.guild, {
      action: 'Ban',
      color: COLORS.danger,
      userTag: ban.user.tag,
      userId: ban.user.id,
      moderatorTag: moderator,
      reason,
    });
  },
};
