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
const promptedIntroMessages = new Set();
const permissionFailures = new Map();

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
  const failureKey = `${channel.guild?.id}:${channel.id}:${roleId}:${allow}`;
  if (permissionFailures.has(failureKey)) return false;
  try {
    await channel.permissionOverwrites.edit(roleId, { ViewChannel: allow ? true : false }, {
      reason: 'Forge Guardian onboarding visibility policy.',
    });
    return true;
  } catch (error) {
    permissionFailures.set(failureKey, Date.now());
    logger.warn(
      `Onboarding permission update failed: guild=${channel.guild?.id ?? 'unknown'} ` +
      `channel=${channel.id} name=${channel.name ?? 'unknown'} role=${roleId} ` +
      `botRole=${channel.guild?.members?.me?.roles?.highest?.id ?? 'unknown'} ` +
      `error=${error.code ?? 'unknown'} ${error.message}`
    );
    return false;
  }
}

function botCanManageChannel(channel) {
  const me = channel.guild?.members?.me;
  const permissions = me ? channel.permissionsFor(me) : null;
  return Boolean(permissions?.has(PermissionFlagsBits.ViewChannel) && permissions.has(PermissionFlagsBits.ManageChannels));
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
    if (!channel) {
      logger.warn(`Onboarding permission target unavailable: guild=${guild.id} channel=${id}`);
      continue;
    }
    if (channel.guild?.id !== guild.id || channel.type !== ChannelType.GuildCategory) {
      logger.warn(`Onboarding permission target invalid: guild=${guild.id} channel=${id} type=${channel.type}`);
      continue;
    }
    if (!botCanManageChannel(channel)) {
      logger.warn(
        `Onboarding permission target inaccessible to bot: guild=${guild.id} ` +
        `channel=${channel.id} name=${channel.name ?? 'unknown'} ` +
        `botRole=${guild.members.me?.roles?.highest?.id ?? 'unknown'} ` +
        'requires=ViewChannel,ManageChannels'
      );
      continue;
    }
    targets.push(channel);
  }
  for (const id of visibleChannels) {
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (channel && onboardingRole) await applyOverwrite(channel, onboardingRole.id, true, false);
  }
  for (const channel of targets) {
    if (onboardingRole) await applyOverwrite(channel, onboardingRole.id, unlocked, !unlocked);
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

export function verifyButton(memberOrGuild, userId, introMessageId = '') {
  const guildId = memberOrGuild.guild?.id ?? memberOrGuild.id;
  const memberId = userId ?? memberOrGuild.id;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${VERIFY_PREFIX}:${guildId}:${memberId}:${introMessageId}`)
      .setLabel('Verify')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅')
  );
}

export async function handleVerifyInteraction(interaction) {
  const [, guildId, userId, introMessageId] = interaction.customId.split(':');
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
  if (introMessageId && profile.server.introMessageId !== introMessageId) {
    await interaction.reply({ content: 'This verification button is stale. Please use the button below your latest introduction.', ephemeral: true });
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
    introduction: profile.server.introContent ?? '',
    onboarding: profile.onboarding,
    roles: member.roles.cache.filter((role) => role.id !== interaction.guild.id).map((role) => ({ id: role.id, name: role.name })),
    avatar_url: member.user.displayAvatarURL({ extension: 'png', size: 512 }),
    verification_state: 'verified',
    verification_timestamp: new Date().toISOString(),
  };
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
  if (!await notifyGuardianVerification(record)) {
    await member.roles.remove(verifiedRole, 'Guardian persistence failed; reverting verification.').catch(() => {});
    if (onboardingRole) await member.roles.add(onboardingRole, 'Guardian persistence failed; reverting verification.').catch(() => {});
    await configureVisibility(member, onboardingRole, verifiedRole, false);
    await interaction.reply({ content: 'Verification could not be saved. Your channels remain locked; please try again shortly.', ephemeral: true });
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
  if (promptedIntroMessages.has(message.id)) return null;
  promptedIntroMessages.add(message.id);
  logger.info(`Introduction received: guild=${message.guild.id} user=${message.author.id} message=${message.id}`);
  const profile = await updateProfile(message.guild.id, message.author.id, {
    server: {
      introSubmitted: true,
      introMessageId: message.id,
      introChannelId: message.channel.id,
      introContent: message.content,
      introSubmittedAt: new Date().toISOString(),
    },
  });
  return profile;
}

export { configureVisibility };
