/**
 * events/messageCreate.js
 * ---------------------------------------------------------------------------
 * Entry point for auto-moderation. Every message is routed through the
 * moderation pipeline (local rule filters + AI analysis). The pipeline itself
 * decides exemptions and actions; this handler just forwards the message and
 * guards against errors.
 * ---------------------------------------------------------------------------
 */

import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { moderateMessage } from '../filters/autoModerator.js';
import { config } from '../config.js';
import { markIntroductionSubmitted, verifyButton } from '../managers/verificationManager.js';

export default {
  name: Events.MessageCreate,
  once: false,

  /**
   * @param {import('discord.js').Message} message
   */
  async execute(message) {
    // Cheap early exits before any work.
    if (!message.guild || message.author.bot || message.system) return;

    if (config.channels.devIntro && message.channel.id === config.channels.devIntro) {
      try {
        if ((message.content ?? '').trim().length < 10) {
          await message.reply({ content: 'Please include a real introduction (at least 10 characters) before verifying.' });
          return;
        }
        const profile = await markIntroductionSubmitted(message);
        if (!profile) return;
        logger.info(`Verification UI creation started: guild=${message.guild.id} user=${message.author.id} intro=${message.id}`);
        const verificationMessage = await message.reply({
          content: 'Introduction received. When you are ready, verify below.',
          components: [verifyButton(message.guild, message.author.id, message.id)],
        });
        logger.info(`Verification UI sent successfully: guild=${message.guild.id} user=${message.author.id} message=${verificationMessage.id}`);
      } catch (error) {
        logger.warn(`Verification UI send failed: guild=${message.guild?.id ?? 'unknown'} user=${message.author?.id ?? 'unknown'} error=${error.code ?? 'unknown'} ${error.message}`);
      }
    }

    try {
      await moderateMessage(message);
    } catch (error) {
      logger.error(`Auto-moderation failed for message ${message.id}: ${error.message}`);
    }
  },
};
