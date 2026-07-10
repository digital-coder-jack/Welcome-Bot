/**
 * events/guildMemberRemove.js
 * ---------------------------------------------------------------------------
 * The Goodbye System. When a member leaves (or is kicked/banned):
 *   1. Send a goodbye message to the configured goodbye channel.
 *   2. Send a Telegram member-left notification via the FastAPI backend.
 *   3. Mark the member as left in the local member store.
 *   4. Log the departure to the moderation log channel.
 * ---------------------------------------------------------------------------
 */

import { Events } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { COLORS, goodbyeEmbed } from '../utils/embeds.js';
import { formatDuration, formatUTC } from '../utils/time.js';
import { sendLog } from '../services/moderationService.js';
import { notifyMemberLeft } from '../services/telegramClient.js';
import { markMemberLeft } from '../database/memberStore.js';
import { recordLeave } from '../database/securityStore.js';

export default {
  name: Events.GuildMemberRemove,
  once: false,

  /**
   * @param {import('discord.js').GuildMember|import('discord.js').PartialGuildMember} member
   */
  async execute(member) {
    if (member.user?.bot) return;

    logger.info(`Member left: ${member.user?.tag ?? member.id}.`);

    // 1. Goodbye message.
    if (config.channels.goodbye) {
      try {
        const channel = await member.guild.channels.fetch(config.channels.goodbye);
        if (channel?.isTextBased()) {
          await channel.send({ embeds: [goodbyeEmbed(member)] });
        }
      } catch (error) {
        logger.warn(`Failed to send goodbye message: ${error.message}`);
      }
    }

    // Collect departure details (best-effort — the member may be partial).
    const now = Date.now();
    const joinedTimestamp = member.joinedTimestamp ?? null;
    const roles =
      member.roles?.cache
        ?.filter((role) => role.id !== member.guild.id) // skip @everyone
        .map((role) => role.name)
        .join(', ') || 'None';

    // 2. Telegram member-left notification via the backend.
    try {
      await notifyMemberLeft({
        username: member.user?.username ?? 'Unknown',
        display_name: member.displayName ?? member.user?.username ?? '',
        user_id: member.id,
        server_name: member.guild.name,
        leave_time: formatUTC(now),
        joined_at: joinedTimestamp ? formatUTC(joinedTimestamp) : 'Unknown',
        time_in_server: joinedTimestamp ? formatDuration(now - joinedTimestamp) : 'Unknown',
        member_count: member.guild.memberCount,
        roles,
        avatar_url: member.user?.displayAvatarURL?.({ extension: 'png', size: 512 }) ?? '',
      });
    } catch (error) {
      logger.warn(`Telegram leave notification failed: ${error.message}`);
    }

    // 3. Mark the member as left in the store.
    try {
      await markMemberLeft(member.guild.id, member.id, new Date(now).toISOString());
    } catch (error) {
      logger.warn(`Failed to update member store: ${error.message}`);
    }

    // 3b. Forge Guardian v2.0: record the leave in the security history.
    try {
      await recordLeave(member.guild.id, member.id);
    } catch (error) {
      logger.warn(`Failed to record leave in security history: ${error.message}`);
    }

    // 4. Log the departure.
    await sendLog(member.guild, {
      action: 'Member Left',
      color: COLORS.goodbye,
      userTag: member.user?.tag ?? 'Unknown',
      userId: member.id,
      extraFields: [
        {
          name: 'Time in Server',
          value: joinedTimestamp ? formatDuration(now - joinedTimestamp) : 'Unknown',
          inline: true,
        },
        { name: 'Members Now', value: `${member.guild.memberCount}`, inline: true },
      ],
    });
  },
};
