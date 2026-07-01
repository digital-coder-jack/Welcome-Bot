/**
 * events/guildMemberAdd.js
 * ---------------------------------------------------------------------------
 * The Welcome System. When a new member joins:
 *   1. Send a welcome embed to the configured welcome channel.
 *   2. Assign the "Explorer" role.
 *   3. DM the server rules to the member.
 *   4. Log the join to the moderation log channel.
 *
 * Every step is best-effort and independently guarded so a failure in one
 * (e.g. DMs closed) never prevents the others.
 * ---------------------------------------------------------------------------
 */

import { Events } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { COLORS, rulesDMEmbed, welcomeEmbed } from '../utils/embeds.js';
import { sendLog } from '../services/moderationService.js';

export default {
  name: Events.GuildMemberAdd,
  once: false,

  /**
   * @param {import('discord.js').GuildMember} member
   */
  async execute(member) {
    if (member.user.bot) return; // Don't welcome bots.

    logger.info(`Member joined: ${member.user.tag} (${member.id}).`);

    // 1. Welcome embed in the welcome channel.
    if (config.channels.welcome) {
      try {
        const channel = await member.guild.channels.fetch(config.channels.welcome);
        if (channel?.isTextBased()) {
          await channel.send({ content: `${member}`, embeds: [welcomeEmbed(member)] });
        }
      } catch (error) {
        logger.warn(`Failed to send welcome message: ${error.message}`);
      }
    }

    // 2. Assign the Explorer role.
    if (config.roles.explorer) {
      try {
        const role = await member.guild.roles.fetch(config.roles.explorer);
        if (role) {
          await member.roles.add(role, 'Auto-assigned Explorer role on join.');
          logger.debug(`Assigned Explorer role to ${member.user.tag}.`);
        } else {
          logger.warn('Explorer role ID configured but role not found.');
        }
      } catch (error) {
        logger.warn(`Failed to assign Explorer role: ${error.message}`);
      }
    }

    // 3. DM the server rules.
    try {
      await member.send({ embeds: [rulesDMEmbed(member.guild.name)] });
    } catch {
      logger.debug(`Could not DM rules to ${member.user.tag} (DMs likely closed).`);
    }

    // 4. Log the join.
    await sendLog(member.guild, {
      action: 'Member Joined',
      color: COLORS.welcome,
      userTag: member.user.tag,
      userId: member.id,
      extraFields: [{ name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true }],
    });
  },
};
