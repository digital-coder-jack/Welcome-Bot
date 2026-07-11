/**
 * events/voiceStateUpdate.js
 * ---------------------------------------------------------------------------
 * Phase 7 — Voice activity tracking (Forge Guardian v2.0).
 *
 * Tracks voice minutes per member using ONLY gateway events (join/leave of
 * voice channels — data the Bot API provides). When a member disconnects,
 * the session length is added to their profile's `voiceMinutes`.
 *
 * Best-effort: failures never affect voice functionality.
 * ---------------------------------------------------------------------------
 */

import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { bumpProfile } from '../database/profileStore.js';

/** Map<guildId:userId, joinTimestampMs> */
const voiceSessions = new Map();

export default {
  name: Events.VoiceStateUpdate,
  once: false,

  /**
   * @param {import('discord.js').VoiceState} oldState
   * @param {import('discord.js').VoiceState} newState
   */
  async execute(oldState, newState) {
    try {
      const member = newState.member ?? oldState.member;
      if (!member || member.user.bot) return;
      const key = `${member.guild.id}:${member.id}`;

      const joined = !oldState.channelId && newState.channelId;
      const left = oldState.channelId && !newState.channelId;

      if (joined) {
        voiceSessions.set(key, Date.now());
        return;
      }

      if (left) {
        const startedAt = voiceSessions.get(key);
        voiceSessions.delete(key);
        if (!startedAt) return;
        const minutes = Math.round((Date.now() - startedAt) / 60_000);
        if (minutes > 0) {
          await bumpProfile(member.guild.id, member.id, 'activity', 'voiceMinutes', minutes);
          logger.debug(`Voice activity: +${minutes} min for ${member.user.tag}.`);
        }
      }
    } catch (error) {
      logger.debug(`Voice activity tracking failed: ${error.message}`);
    }
  },
};
