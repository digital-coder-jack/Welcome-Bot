/**
 * events/guildMemberRemove.js
 * ---------------------------------------------------------------------------
 * The Goodbye System. When a member leaves (or is kicked/banned):
 *   1. Send a goodbye message to the configured goodbye channel.
 *   2. Log the departure to the moderation log channel.
 * ---------------------------------------------------------------------------
 */

import { Events } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { COLORS, goodbyeEmbed } from '../utils/embeds.js';
import { sendLog } from '../services/moderationService.js';

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

    // 2. Log the departure.
    await sendLog(member.guild, {
      action: 'Member Left',
      color: COLORS.goodbye,
      userTag: member.user?.tag ?? 'Unknown',
      userId: member.id,
    });
  },
};
