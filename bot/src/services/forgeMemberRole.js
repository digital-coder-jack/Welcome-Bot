import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Assign the configured default role after Discord membership screening has
 * completed. This is deliberately separate from onboarding answers.
 * @param {import('discord.js').GuildMember} member
 * @returns {Promise<string>} assigned role name or a safe status string.
 */
export async function assignForgeMemberRole(member) {
  const roleId = config.roles.forgeMember;
  if (!roleId) return 'Not configured';

  const me = member.guild.members.me ?? await member.guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    logger.warn(`Forge-Members assignment skipped: bot lacks Manage Roles in guild ${member.guild.id}.`);
    return 'Failed (missing Manage Roles)';
  }

  const role = await member.guild.roles.fetch(roleId).catch(() => null);
  if (!role) {
    logger.warn(`Forge-Members assignment skipped: configured role not found in guild ${member.guild.id}.`);
    return 'Failed (role not found)';
  }
  if (role.id === member.guild.id || role.position >= me.roles.highest.position) {
    logger.warn(`Forge-Members assignment skipped: role hierarchy prevents assignment in guild ${member.guild.id}.`);
    return 'Failed (role hierarchy)';
  }

  if (member.roles.cache.has(role.id)) return role.name;
  try {
    await member.roles.add(role, 'Auto-assigned Forge-Members after onboarding completion.');
    logger.debug(`Forge-Members assigned in guild ${member.guild.id} to user ${member.id}.`);
    return role.name;
  } catch (error) {
    logger.warn(`Forge-Members assignment failed in guild ${member.guild.id}: ${error.message}`);
    return 'Failed (Discord API)';
  }
}
