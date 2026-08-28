/**
 * managers/onboardingManager.js
 * ---------------------------------------------------------------------------
 * Discord onboarding selection flow.
 *
 * This module owns only the onboarding components and their configured-role
 * synchronization. Profile persistence remains in database/profileStore.js.
 * No roles outside the configured onboarding maps are ever removed.
 * ---------------------------------------------------------------------------
 */

import {
  ActionRowBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
} from 'discord.js';
import { config } from '../config.js';
import {
  ONBOARDING_AGE_GROUPS,
  ONBOARDING_EXPERIENCE_LEVELS,
  ONBOARDING_INTERESTS,
  getProfile,
  updateOnboardingData,
} from '../database/profileStore.js';
import { logger } from '../utils/logger.js';

export const ONBOARDING_PREFIX = 'onboarding';
export const ONBOARDING_STEPS = Object.freeze({
  INTERESTS: 'interests',
  AGE: 'age',
  EXPERIENCE: 'experience',
});

const INTEREST_OPTIONS = Object.freeze([
  { label: 'Cyber Security', value: 'Cyber Security', emoji: '🛡️' },
  { label: 'AI Enthusiast', value: 'AI Enthusiast', emoji: '🤖' },
  { label: 'Web Developer', value: 'Web Developer', emoji: '🌐' },
  { label: 'Programmer', value: 'Programmer', emoji: '💻' },
  { label: 'Vibe Coder', value: 'Vibe Coder', emoji: '⚡' },
  { label: 'ML Enthusiast', value: 'ML Enthusiast', emoji: '🧠' },
  { label: 'Game Developer', value: 'Game Developer', emoji: '🎮' },
  { label: 'App Developer', value: 'App Developer', emoji: '📱' },
  { label: 'UI/UX Designer', value: 'UI/UX Designer', emoji: '🎨' },
  { label: 'DevOps', value: 'DevOps', emoji: '🔧' },
  { label: 'Student', value: 'Student', emoji: '📚' },
  { label: 'Other', value: 'Other', emoji: '🔥' },
]);

const AGE_OPTIONS = Object.freeze([
  { label: '18-', value: '18-', emoji: '🔞' },
  { label: '18+', value: '18+', emoji: '🔓' },
  { label: 'Prefer not to say', value: 'Prefer not to say', emoji: '🤐' },
]);

const EXPERIENCE_OPTIONS = Object.freeze([
  { label: 'Beginner', value: 'Beginner', emoji: '🌱' },
  { label: 'Intermediate', value: 'Intermediate', emoji: '⚙️' },
  { label: 'Advanced', value: 'Advanced', emoji: '🔥' },
  { label: 'Expert', value: 'Expert', emoji: '👑' },
]);

const STEP_LABELS = Object.freeze({
  [ONBOARDING_STEPS.INTERESTS]: 'interests',
  [ONBOARDING_STEPS.AGE]: 'age group',
  [ONBOARDING_STEPS.EXPERIENCE]: 'experience level',
});

const STEP_TO_NEXT = Object.freeze({
  [ONBOARDING_STEPS.INTERESTS]: ONBOARDING_STEPS.AGE,
  [ONBOARDING_STEPS.AGE]: ONBOARDING_STEPS.EXPERIENCE,
});

const STEP_ROLE_MAPS = Object.freeze({
  [ONBOARDING_STEPS.INTERESTS]: () => config.onboarding.roles.interests,
  [ONBOARDING_STEPS.AGE]: () => config.onboarding.roles.ageGroups,
  [ONBOARDING_STEPS.EXPERIENCE]: () => config.onboarding.roles.experience,
});

const STEP_PROFILE_FIELDS = Object.freeze({
  [ONBOARDING_STEPS.INTERESTS]: 'interests',
  [ONBOARDING_STEPS.AGE]: 'ageGroup',
  [ONBOARDING_STEPS.EXPERIENCE]: 'experience',
});

export function onboardingCustomId(userId, step) {
  return `${ONBOARDING_PREFIX}:${userId}:${step}`;
}

function buildMenu({ userId, step, placeholder, options, minValues, maxValues }) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(onboardingCustomId(userId, step))
    .setPlaceholder(placeholder)
    .setMinValues(minValues)
    .setMaxValues(maxValues)
    .addOptions(
      options.map((option) => ({
        label: option.label,
        value: option.value,
        ...(option.emoji ? { emoji: option.emoji } : {}),
      }))
    );

  return new ActionRowBuilder().addComponents(menu);
}

export function buildInterestsMenu(userId) {
  return buildMenu({
    userId,
    step: ONBOARDING_STEPS.INTERESTS,
    placeholder: 'Select all interests that apply',
    options: INTEREST_OPTIONS,
    minValues: 0,
    maxValues: INTEREST_OPTIONS.length,
  });
}

export function buildAgeMenu(userId) {
  return buildMenu({
    userId,
    step: ONBOARDING_STEPS.AGE,
    placeholder: 'Select your age group',
    options: AGE_OPTIONS,
    minValues: 1,
    maxValues: 1,
  });
}

export function buildExperienceMenu(userId) {
  return buildMenu({
    userId,
    step: ONBOARDING_STEPS.EXPERIENCE,
    placeholder: 'Select your experience level',
    options: EXPERIENCE_OPTIONS,
    minValues: 1,
    maxValues: 1,
  });
}

export function buildStepMenu(userId, step) {
  if (step === ONBOARDING_STEPS.INTERESTS) return buildInterestsMenu(userId);
  if (step === ONBOARDING_STEPS.AGE) return buildAgeMenu(userId);
  if (step === ONBOARDING_STEPS.EXPERIENCE) return buildExperienceMenu(userId);
  return null;
}

function validValuesForStep(step) {
  if (step === ONBOARDING_STEPS.INTERESTS) return ONBOARDING_INTERESTS;
  if (step === ONBOARDING_STEPS.AGE) return ONBOARDING_AGE_GROUPS;
  if (step === ONBOARDING_STEPS.EXPERIENCE) return ONBOARDING_EXPERIENCE_LEVELS;
  return [];
}

export function validateStepValues(step, values) {
  const incoming = Array.isArray(values) ? values : [];
  const allowed = new Set(validValuesForStep(step));
  const unique = [...new Set(incoming)];
  if (step === ONBOARDING_STEPS.AGE || step === ONBOARDING_STEPS.EXPERIENCE) {
    if (unique.length !== 1) return { valid: false, values: [], reason: 'Select exactly one option.' };
  }
  if (unique.some((value) => !allowed.has(value))) {
    return { valid: false, values: [], reason: 'One or more selections are not valid.' };
  }
  return { valid: true, values: unique };
}

function nextOnboardingState(previous, step, values) {
  const current = previous ?? { interests: [], ageGroup: null, experience: null };
  if (step === ONBOARDING_STEPS.INTERESTS) return { ...current, interests: values };
  if (step === ONBOARDING_STEPS.AGE) return { ...current, ageGroup: values[0] };
  return { ...current, experience: values[0] };
}

function roleIdsForSelection(step, value) {
  const map = STEP_ROLE_MAPS[step]?.() ?? {};
  if (step === ONBOARDING_STEPS.INTERESTS) {
    return (Array.isArray(value) ? value : []).map((item) => map[item]).filter(Boolean);
  }
  return value && map[value] ? [map[value]] : [];
}

function previousRoleIdsForStep(step, previous) {
  if (step === ONBOARDING_STEPS.INTERESTS) return roleIdsForSelection(step, previous?.interests);
  if (step === ONBOARDING_STEPS.AGE) return roleIdsForSelection(step, previous?.ageGroup);
  return roleIdsForSelection(step, previous?.experience);
}

function configuredRoleIdsForStep(step) {
  return new Set(Object.values(STEP_ROLE_MAPS[step]?.() ?? {}).filter(Boolean));
}

function desiredRoleIdsForState(state) {
  return new Set([
    ...roleIdsForSelection(ONBOARDING_STEPS.INTERESTS, state.interests),
    ...roleIdsForSelection(ONBOARDING_STEPS.AGE, state.ageGroup),
    ...roleIdsForSelection(ONBOARDING_STEPS.EXPERIENCE, state.experience),
  ]);
}

export function managedRoleChanges(step, previous, next, currentRoleIds = null) {
  const previousIds = new Set(previousRoleIdsForStep(step, previous));
  const desiredIds = desiredRoleIdsForState(next);
  const nextIds = new Set(
    step === ONBOARDING_STEPS.INTERESTS
      ? roleIdsForSelection(step, next.interests)
      : step === ONBOARDING_STEPS.AGE
        ? roleIdsForSelection(step, next.ageGroup)
        : roleIdsForSelection(step, next.experience)
  );

  const managedIds = configuredRoleIdsForStep(step);
  const currentlyAssignedStaleIds = currentRoleIds
    ? [...currentRoleIds].filter((roleId) => managedIds.has(roleId))
    : [];
  const removeCandidates = new Set([...previousIds, ...currentlyAssignedStaleIds]);
  return {
    add: [...nextIds].filter((roleId) => !previousIds.has(roleId)),
    remove: [...removeCandidates].filter((roleId) => !nextIds.has(roleId) && !desiredIds.has(roleId)),
  };
}

async function synchronizeConfiguredRoles(member, step, previous, next) {
  const status = { added: [], removed: [], skipped: [], errors: [] };
  const currentRoleIds = new Set(member.roles?.cache?.keys?.() ?? []);
  const changes = managedRoleChanges(step, previous, next, currentRoleIds);
  const desiredStepRoleIds = new Set(
    step === ONBOARDING_STEPS.INTERESTS
      ? roleIdsForSelection(step, next.interests)
      : step === ONBOARDING_STEPS.AGE
        ? roleIdsForSelection(step, next.ageGroup)
        : roleIdsForSelection(step, next.experience)
  );
  const roleIdsToAdd = new Set([...changes.add, ...desiredStepRoleIds]);

  for (const roleId of changes.remove) {
    if (!currentRoleIds.has(roleId)) continue;
    try {
      const role = await member.guild.roles.fetch(roleId);
      if (!role) {
        status.skipped.push(`Missing role ${roleId} (remove)`);
        continue;
      }
      await member.roles.remove(role, `Onboarding ${step} selection changed.`);
      status.removed.push(role.name);
    } catch (error) {
      status.errors.push(`Could not remove role ${roleId}: ${error.message}`);
      logger.warn(`Onboarding role removal failed for ${member.id}/${roleId}: ${error.message}`);
    }
  }

  for (const roleId of roleIdsToAdd) {
    try {
      const role = await member.guild.roles.fetch(roleId);
      if (!role) {
        status.skipped.push(`Missing role ${roleId} (add)`);
        continue;
      }
      if (currentRoleIds.has(roleId)) continue;
      await member.roles.add(role, `Onboarding ${step} selection.`);
      status.added.push(role.name);
    } catch (error) {
      status.errors.push(`Could not add role ${roleId}: ${error.message}`);
      logger.warn(`Onboarding role assignment failed for ${member.id}/${roleId}: ${error.message}`);
    }
  }

  return status;
}

function roleStatusText(status) {
  const parts = [];
  if (status.added.length) parts.push(`added: ${status.added.join(', ')}`);
  if (status.removed.length) parts.push(`removed: ${status.removed.join(', ')}`);
  if (status.skipped.length) parts.push(`skipped: ${status.skipped.join('; ')}`);
  if (status.errors.length) parts.push(`role errors: ${status.errors.join('; ')}`);
  return parts.length ? parts.join(' · ') : 'no configured role changes';
}

export function onboardingResponseText(step, roleStatus, profileSaved, nextStep) {
  const database = profileSaved ? 'profile saved' : 'profile update failed';
  const next = nextStep ? ` Next, select your ${STEP_LABELS[nextStep]}.` : ' Onboarding is complete.';
  return `✅ ${STEP_LABELS[step][0].toUpperCase()}${STEP_LABELS[step].slice(1)} updated — ${database}; ${roleStatusText(roleStatus)}.${next}`;
}

export async function applyOnboardingSelection(member, step, values) {
  const validation = validateStepValues(step, values);
  if (!validation.valid) return { ok: false, validation, roleStatus: null, profile: null };

  const previousProfile = await getProfile(member.guild.id, member.id);
  const previous = previousProfile.onboarding ?? { interests: [], ageGroup: null, experience: null };
  const next = nextOnboardingState(previous, step, validation.values);
  const roleStatus = await synchronizeConfiguredRoles(member, step, previous, next);
  const field = STEP_PROFILE_FIELDS[step];
  const patch = field === 'interests'
    ? { interests: validation.values }
    : { [field]: validation.values[0] };

  const profile = await updateOnboardingData(member.guild.id, member.id, patch);
  return {
    ok: Boolean(profile),
    validation,
    roleStatus,
    profile,
    nextStep: STEP_TO_NEXT[step] ?? null,
  };
}

function parseOnboardingCustomId(customId) {
  const [prefix, userId, step] = String(customId ?? '').split(':');
  if (prefix !== ONBOARDING_PREFIX || !userId || !STEP_PROFILE_FIELDS[step]) return null;
  return { userId, step };
}

async function safeInteractionReply(interaction, payload) {
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
}

export async function handleOnboardingInteraction(interaction) {
  const parsed = parseOnboardingCustomId(interaction.customId);
  if (!parsed) return false;
  logger.info(`Onboarding interaction received: ${interaction.customId} from ${interaction.user.id}.`);

  if (interaction.user.id !== parsed.userId) {
    await safeInteractionReply(interaction, { content: 'This onboarding menu belongs to another member.' });
    return true;
  }
  if (!interaction.guild) {
    await safeInteractionReply(interaction, { content: 'Onboarding can only be completed inside a server.' });
    return true;
  }

  const validation = validateStepValues(parsed.step, interaction.values);
  if (!validation.valid) {
    await safeInteractionReply(interaction, { content: `⚠️ ${validation.reason}` });
    return true;
  }

  try {
    await interaction.deferUpdate();
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const result = await applyOnboardingSelection(member, parsed.step, validation.values);
    logger.info(
      `Onboarding ${parsed.step} selection processed for ${member.guild.id}:${member.id}: ` +
      `profileUpdated=${Boolean(result.profile)}, roleErrors=${result.roleStatus?.errors?.length ?? 0}.`
    );
    if (!result.ok && !result.profile) {
      await interaction.editReply({ content: '⚠️ The onboarding selection could not be saved. Please try again.', components: [] });
      return true;
    }

    const nextMenu = result.nextStep ? buildStepMenu(interaction.user.id, result.nextStep) : null;
    await interaction.editReply({
      content: onboardingResponseText(parsed.step, result.roleStatus, Boolean(result.profile), result.nextStep),
      ...(nextMenu ? { components: [nextMenu] } : { components: [] }),
    });

    if (!result.nextStep && result.profile) {
      const { completePostScreeningOnboarding } = await import('./introductionManager.js');
      const finalFlow = await completePostScreeningOnboarding(member);
      logger.info(
        `Onboarding complete for ${member.guild.id}:${member.id}: ` +
        `dmStatus=${finalFlow.dmStatus}, gatewayIntroduction=${finalFlow.gatewayIntroSent}, ` +
        `chillZoneWelcome=${finalFlow.completed}.`
      );
    }
  } catch (error) {
    logger.warn(`Onboarding interaction failed for ${interaction.user.id}: ${error.message}`);
    await safeInteractionReply(interaction, { content: '⚠️ Onboarding could not be completed safely. Please try again.' });
  }

  return true;
}

