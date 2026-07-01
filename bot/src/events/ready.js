/**
 * events/ready.js
 * ---------------------------------------------------------------------------
 * Fired once when the client has successfully connected to Discord.
 * Logs identity, sets the bot's presence, and probes the AI backend so the
 * operator immediately knows whether moderation AI is available.
 * ---------------------------------------------------------------------------
 */

import { ActivityType, Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { checkHealth } from '../services/aiClient.js';

export default {
  name: Events.ClientReady,
  once: true,

  /**
   * @param {import('discord.js').Client} client
   */
  async execute(client) {
    logger.success(`Logged in as ${client.user.tag} (id: ${client.user.id}).`);
    logger.info(`Serving ${client.guilds.cache.size} guild(s).`);

    // Set a helpful presence.
    client.user.setPresence({
      activities: [{ name: 'over the server \u{1F6E1}\uFE0F', type: ActivityType.Watching }],
      status: 'online',
    });

    // Probe the AI backend.
    const healthy = await checkHealth();
    if (healthy) {
      logger.success('AI moderation backend is reachable.');
    } else {
      logger.warn('AI moderation backend is NOT reachable. Local filters still active.');
    }
  },
};
