import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getProfile, updateProfile } from '../database/profileStore.js';
import { notifyGuardianVerification } from '../services/telegramClient.js';

export const VERIFY_PREFIX = 'forge-verify';

export async function resolveOnboardingRole(guild) {
  const configured = config.roles.onboarding;
  if (configured) return guild.roles.fetch(configured).catch(() => null);
  const existing = guild.roles.cache.find((role) => role.name.toLowerCase() === 'onboarding');
  if (existing) return existing;
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return null;
  return guild.roles.create({ name: 'Onboarding', reason: 'Unverified member onboarding flow.' }).catch(() => null);
}

async function applyOverwrite(channel, roleId, allow, deny) {
  if (!channel?.permissionOverwrites?.edit) return false;
  try {
    await channel.permissionOverwrites.edit(roleId, { ViewChannel: allow ? true : undefined }, {
      reason: 'Forge Guardian onboarding visibility policy.',
    });
    if (!allow && deny) {
      await channel.permissionOverwrites.edit(roleId, { ViewChannel: false }, {
        reason: 'Forge Guardian hides normal channels from unverified members.',
      });
    }
    return true;
  } catch (error) {
    logger.warn(`Onboarding permission update failed for ${channel.id}: ${error.message}`);
    return false;
  }
}

async function configureVisibility(member, onboardingRole, verifiedRole, unlocked) {
  const guild = member.guild;
  const visibleChannels = [config.channels.devIntro, config.channels.forgeProtocol].filter(Boolean);
  const visibleParents = new Set(
    visibleChannels
      .map((id) => guild.channels.cache.get(id)?.parentId)
      .filter(Boolean)
  );
  const normalCategories = config.channels.normalCategories.length > 0
    ? config.channels.normalCategories
    : guild.channels.cache
      .filter((channel) => channel.type === ChannelType.GuildCategory && !visibleParents.has(channel.id))
      .map((channel) => channel.id);
  const targets = [];
  for (const id of normalCategories) {
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (channel) targets.push(channel);
  }
  for (const id of visibleChannels) {
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (channel) await applyOverwrite(channel, onboardingRole.id, true, false);
  }
  for (const channel of targets) {
    await applyOverwrite(channel, onboardingRole.id, unlocked, !unlocked);
    if (verifiedRole) await applyOverwrite(channel, verifiedRole.id, true, false);
  }
  return { configured: targets.length > 0, visibleChannels };
}

export async function ensureOnboardingState(member) {
  if (member.user?.bot) return { role: null, configured: false };
  const role = await resolveOnboardingRole(member.guild);
  if (!role) {
    logger.warn(`No Onboarding role available for ${member.id}; visibility policy could not be applied.`);
    return { role: null, configured: false };
  }
  if (!member.roles.cache.has(role.id)) {
    await member.roles.add(role, 'Keep new member unverified until Forge Guardian verification.').catch((error) => {
      logger.warn(`Failed to assign Onboarding role to ${member.id}: ${error.message}`);
    });
  }
  const verifiedRole = config.roles.forgeMember ? await member.guild.roles.fetch(config.roles.forgeMember).catch(() => null) : null;
  await configureVisibility(member, role, verifiedRole, false);
  await updateProfile(member.guild.id, member.id, {
    server: { verificationStatus: 'Unverified', onboardingRoleId: role.id },
  });
  return { role, configured: true };
}

export function verifyButton(member) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${VERIFY_PREFIX}:${member.guild.id}:${member.id}`)
      .setLabel('Verify')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅')
  );
}

export async function handleVerifyInteraction(interaction) {
  const [, guildId, userId] = interaction.customId.split(':');
  if (!interaction.guild || interaction.guild.id !== guildId || interaction.user.id !== userId) {
    await interaction.reply({ content: 'This Verify button belongs to another member.', ephemeral: true });
    return;
  }
  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  if (!member) {
    await interaction.reply({ content: 'Member could not be found. Please rejoin or contact staff.', ephemeral: true });
    return;
  }
  const profile = await getProfile(guildId, userId);
  if (profile.server.verificationStatus === 'Verified') {
    await interaction.reply({ content: 'You are already verified.', ephemeral: true });
    return;
  }
  if (!profile.server.onboardingCompleted) {
    await interaction.reply({ content: 'Complete the existing server onboarding first.', ephemeral: true });
    return;
  }
  if (!profile.server.introSubmitted) {
    await interaction.reply({ content: 'Post your introduction in Dev Intro before verifying.', ephemeral: true });
    return;
  }
  const record = {
    guild_id: guildId,
    discord_user_id: userId,
    username: member.user.username,
    display_name: member.displayName ?? member.user.globalName ?? member.user.username,
    onboarding_completed: true,
    intro_submitted: true,
    intro_channel_id: profile.server.introChannelId ?? config.channels.devIntro,
    avatar_url: member.user.displayAvatarURL({ extension: 'png', size: 512 }),
    verification_state: 'verified',
    verification_timestamp: new Date().toISOString(),
  };
  if (!await notifyGuardianVerification(record)) {
    await interaction.reply({ content: 'Verification is temporarily unavailable. Nothing was unlocked; please try again shortly.', ephemeral: true });
    return;
  }
  const onboardingRole = profile.server.onboardingRoleId
    ? await interaction.guild.roles.fetch(profile.server.onboardingRoleId).catch(() => null)
    : await resolveOnboardingRole(interaction.guild);
  const verifiedRole = config.roles.forgeMember ? await interaction.guild.roles.fetch(config.roles.forgeMember).catch(() => null) : null;
  if (!verifiedRole) {
    await interaction.reply({ content: 'Verification is not configured completely yet. Please contact staff.', ephemeral: true });
    return;
  }
  try {
    if (!member.roles.cache.has(verifiedRole.id)) await member.roles.add(verifiedRole, 'Forge Guardian verification completed.');
    if (onboardingRole && member.roles.cache.has(onboardingRole.id)) await member.roles.remove(onboardingRole, 'Forge Guardian verification completed.');
    await configureVisibility(member, onboardingRole ?? { id: 'missing' }, verifiedRole, true);
  } catch (error) {
    logger.warn(`Verification role/permission update failed for ${userId}: ${error.message}`);
    await interaction.reply({ content: 'Verification was saved, but Discord could not finish unlocking your channels. Please contact staff.', ephemeral: true });
    return;
  }
  await updateProfile(guildId, userId, {
    server: {
      verificationStatus: 'Verified',
      verifiedAt: record.verification_timestamp,
      forgeMemberStatus: verifiedRole ? 'Assigned' : 'Not configured',
      onboardingRoleId: onboardingRole?.id ?? null,
    },
  });
  await interaction.reply({ content: '✅ Verification complete. The rest of the community is now unlocked.', ephemeral: true });
}

export async function markOnboardingCompleted(member) {
  await updateProfile(member.guild.id, member.id, { server: { onboardingCompleted: true } });
  return ensureOnboardingState(member);
}

export async function markIntroductionSubmitted(message) {
  const profile = await updateProfile(message.guild.id, message.author.id, {
    server: {
      introSubmitted: true,
      introMessageId: message.id,
      introChannelId: message.channel.id,
      introSubmittedAt: new Date().toISOString(),
    },
  });
  return profile;
}

export { configureVisibility };
