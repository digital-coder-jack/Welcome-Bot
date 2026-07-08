/**
 * events/inviteCreate.js
 * ---------------------------------------------------------------------------
 * Keeps the invite tracker's cache up to date when a new invite is created,
 * so the "which invite was used" diff on member join stays accurate.
 * ---------------------------------------------------------------------------
 */

import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { onInviteCreate } from '../services/inviteTracker.js';

export default {
  name: Events.InviteCreate,
  once: false,

  /**
   * @param {import('discord.js').Invite} invite
   */
  async execute(invite) {
    onInviteCreate(invite);
    logger.debug(`Invite created: ${invite.code} by ${invite.inviter?.tag ?? 'Unknown'}.`);
  },
};
