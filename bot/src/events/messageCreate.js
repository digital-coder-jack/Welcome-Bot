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

export default {
  name: Events.MessageCreate,
  once: false,

  /**
   * @param {import('discord.js').Message} message
   */
  async execute(message) {
    // Cheap early exits before any work.
    if (!message.guild || message.author.bot || message.system) return;

    try {
      await moderateMessage(message);
    } catch (error) {
      logger.error(`Auto-moderation failed for message ${message.id}: ${error.message}`);
    }
  },
};
