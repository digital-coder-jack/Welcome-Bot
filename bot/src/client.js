/**
 * client.js
 * ---------------------------------------------------------------------------
 * Builds and exports the singleton Discord.js Client.
 *
 * Gateway intents are the permissions the bot requests from Discord's gateway.
 * We request only what we actually use:
 *   - Guilds                 : core guild lifecycle events.
 *   - GuildMembers           : member join / leave (welcome & goodbye).
 *   - GuildMessages          : receive message events (auto-moderation).
 *   - MessageContent         : read message text (required for content-based
 *                              auto-mod & AI analysis). PRIVILEGED intent.
 *   - GuildModeration        : moderation-related gateway events.
 *   - DirectMessages         : send / receive DMs (rules DM).
 *
 * NOTE: GuildMembers and MessageContent are *privileged* intents and must be
 * enabled in the Discord Developer Portal (Bot -> Privileged Gateway Intents).
 * ---------------------------------------------------------------------------
 */

import { Client, Collection, GatewayIntentBits, Partials } from 'discord.js';

export function createClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildInvites, // invite tracking (which invite was used)
    ],
    // Partials let us receive events for uncached objects (e.g. DM channels).
    // Partials.User ensures guildMemberRemove still fires with usable data
    // even when the departing member's User object was never cached.
    partials: [Partials.Channel, Partials.GuildMember, Partials.Message, Partials.User],
  });

  // Collection used by the command handler to store slash commands by name.
  client.commands = new Collection();

  return client;
}
