/**
 * events/inviteDelete.js
 * ---------------------------------------------------------------------------
 * Keeps the invite tracker's cache up to date when an invite is deleted or
 * expires, so stale codes never pollute the join-diff logic.
 * ---------------------------------------------------------------------------
 */

import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { onInviteDelete } from '../services/inviteTracker.js';

export default {
  name: Events.InviteDelete,
  once: false,

  /**
   * @param {import('discord.js').Invite} invite
   */
  async execute(invite) {
    onInviteDelete(invite);
    logger.debug(`Invite deleted: ${invite.code}.`);
  },
};
