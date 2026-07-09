/**
 * events/guildMemberAdd.js
 * ---------------------------------------------------------------------------
 * The Welcome System. When a new member joins:
 *
 *   1. Send a welcome embed to the configured welcome channel.
 *   2. Send an animated welcome DM (plus the server rules).
 *   3. Assign the "Forge Member" role.
 *   4. Auto-send the Developer Intro message to the dev-intro channel.
 *   5. Send the full Telegram join notification via the FastAPI backend.
 *   6. Save the member information to the local member store.
 *
 * Additionally, every join is fed to the security service (raid detection &
 * new-account screening).
 *
 * Every step is best-effort and independently guarded so a failure in one
 * (e.g. DMs closed) never prevents the others.
 * ---------------------------------------------------------------------------
 */

import { Events } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { devIntroEmbed, COLORS } from '../utils/embeds.js';
import { sendPublicWelcome } from '../managers/welcomeManager.js';
import { sendWelcomeDM } from '../managers/dmManager.js';
import { accountAge, formatUTC } from '../utils/time.js';
import { sendLog } from '../services/moderationService.js';
import { notifyMemberJoined } from '../services/telegramClient.js';
import { resolveUsedInvite } from '../services/inviteTracker.js';
import { trackJoinForSecurity } from '../services/securityService.js';
import { saveMember } from '../database/memberStore.js';

export default {
  name: Events.GuildMemberAdd,
  once: false,

  /**
   * @param {import('discord.js').GuildMember} member
   */
  async execute(member) {
    const isBot = member.user.bot;
    logger.info(`Member joined: ${member.user.tag} (${member.id})${isBot ? ' [BOT]' : ''}.`);

    // Resolve which invite was used (works for bots and humans alike).
    const invite = await resolveUsedInvite(member.guild);

    // Security screening runs for every join, including bots.
    try {
      await trackJoinForSecurity(member);
    } catch (error) {
      logger.warn(`Security join tracking failed: ${error.message}`);
    }

    let dmStatus = 'Not attempted';
    let assignedRole = 'None';

    if (!isBot) {
      // --- Step 1: Premium public welcome (themed, cinematic animation,
      //             random GIFs, buttons, stickers) via welcomeManager ---
      try {
        await sendPublicWelcome(member);
      } catch (error) {
        logger.warn(`Failed to send public welcome: ${error.message}`);
      }

      // --- Step 2: Premium welcome DM (multi-embed journey + buttons +
      //             server rules) via dmManager ---
      try {
        dmStatus = await sendWelcomeDM(member);
      } catch (error) {
        dmStatus = 'Failed (DMs closed)';
        logger.warn(`Failed to send welcome DM: ${error.message}`);
      }

      // --- Step 3: Assign the Forge Member role ---
      if (config.roles.forgeMember) {
        try {
          const role = await member.guild.roles.fetch(config.roles.forgeMember);
          if (role) {
            await member.roles.add(role, 'Auto-assigned Forge Member role on join.');
            assignedRole = role.name;
            logger.debug(`Assigned ${role.name} role to ${member.user.tag}.`);
          } else {
            logger.warn('FORGE_MEMBER_ROLE_ID configured but role not found.');
          }
        } catch (error) {
          logger.warn(`Failed to assign Forge Member role: ${error.message}`);
        }
      }

      // --- Step 4: Auto-send the Developer Intro message ---
      if (config.channels.devIntro) {
        try {
          const channel = await member.guild.channels.fetch(config.channels.devIntro);
          if (channel?.isTextBased()) {
            await channel.send({ content: `${member}`, embeds: [devIntroEmbed(member)] });
          }
        } catch (error) {
          logger.warn(`Failed to send dev-intro message: ${error.message}`);
        }
      }
    }

    // --- Step 5: Telegram join notification via the backend ---
    try {
      await notifyMemberJoined({
        username: member.user.username,
        display_name: member.displayName ?? member.user.globalName ?? member.user.username,
        user_id: member.id,
        server_name: member.guild.name,
        join_time: formatUTC(member.joinedTimestamp ?? Date.now()),
        account_created: formatUTC(member.user.createdTimestamp),
        account_age: accountAge(member.user.createdTimestamp),
        member_number: member.guild.memberCount,
        invite_code: invite.code,
        inviter: invite.inviterTag,
        bot_or_human: isBot ? 'Bot' : 'Human',
        avatar_url: member.user.displayAvatarURL({ extension: 'png', size: 512 }),
        assigned_role: assignedRole,
        dm_status: dmStatus,
        server_invite_used: invite.url,
      });
    } catch (error) {
      logger.warn(`Telegram join notification failed: ${error.message}`);
    }

    // --- Step 6: Save member information ---
    try {
      await saveMember({
        guildId: member.guild.id,
        userId: member.id,
        username: member.user.username,
        displayName: member.displayName ?? member.user.username,
        joinedAt: new Date(member.joinedTimestamp ?? Date.now()).toISOString(),
        accountCreated: new Date(member.user.createdTimestamp).toISOString(),
        memberNumber: member.guild.memberCount,
        inviteCode: invite.code,
        inviter: invite.inviterTag,
        isBot,
        avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 512 }),
        assignedRole,
        dmStatus,
      });
    } catch (error) {
      logger.warn(`Failed to save member information: ${error.message}`);
    }

    // Log the join to the moderation log channel.
    await sendLog(member.guild, {
      action: 'Member Joined',
      color: COLORS.welcome,
      userTag: member.user.tag,
      userId: member.id,
      extraFields: [
        { name: 'Member #', value: `${member.guild.memberCount}`, inline: true },
        { name: 'Invite', value: invite.code, inline: true },
        { name: 'Inviter', value: invite.inviterTag, inline: true },
        { name: 'Account Age', value: accountAge(member.user.createdTimestamp), inline: true },
        { name: 'Type', value: isBot ? 'Bot' : 'Human', inline: true },
        { name: 'DM Status', value: dmStatus, inline: true },
      ],
    });
  },
};
