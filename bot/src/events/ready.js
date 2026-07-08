/**
 * events/ready.js
 * ---------------------------------------------------------------------------
 * Fired once when the client has successfully connected to Discord.
 * Logs identity, sets the bot's presence, primes the invite tracker cache,
 * and probes the AI backend so the operator immediately knows whether the
 * moderation/notification backend is available.
 * ---------------------------------------------------------------------------
 */

import { ActivityType, Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { checkHealth } from '../services/aiClient.js';
import { cacheAllInvites } from '../services/inviteTracker.js';

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

    // Prime the invite tracker so join events can resolve invite usage.
    await cacheAllInvites(client);
    logger.info('Invite tracker cache primed.');

    // Probe the AI/notification backend.
    const healthy = await checkHealth();
    if (healthy) {
      logger.success('Backend (AI moderation + Telegram) is reachable.');
    } else {
      logger.warn('Backend is NOT reachable. Local filters still active; Telegram notifications will fail.');
    }
  },
};
