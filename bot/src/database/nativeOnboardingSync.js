/**
 * database/nativeOnboardingSync.js
 * ---------------------------------------------------------------------------
 * Synchronizes Discord Community Onboarding outcomes into the existing member
 * profile. Discord does not expose a member's prompt answers as a dedicated
 * GuildMember field; native onboarding's assigned roles are the only supported
 * member-scoped signal available to this bot.
 *
 * This helper never guesses answers and never creates a second record. It maps
 * only configured role IDs to their exact configured labels and writes through
 * profileStore.updateOnboardingData(), which uses <guildId>:<userId>.
 * ---------------------------------------------------------------------------
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import {
  ONBOARDING_INTERESTS,
  ONBOARDING_EXPERIENCE_LEVELS,
  ONBOARDING_WORK_STATUSES,
  ONBOARDING_GENDERS,
  updateOnboardingData,
} from './profileStore.js';

function selectedLabels(member, roleMap, allowedValues, multiple) {
  const byRoleId = new Map(
    Object.entries(roleMap ?? {})
      .filter(([label, roleId]) => allowedValues.includes(label) && roleId)
      .map(([label, roleId]) => [roleId, label])
  );
  const selected = [...(member.roles?.cache?.keys?.() ?? [])]
    .map((roleId) => byRoleId.get(roleId))
    .filter(Boolean);
  return multiple ? [...new Set(selected)] : selected[0] ?? null;
}

export function nativeOnboardingFromMember(member) {
  return {
    interests: selectedLabels(
      member,
      config.onboarding.roles.interests,
      ONBOARDING_INTERESTS,
      true
    ),
    experience: selectedLabels(
      member,
      config.onboarding.roles.experience,
      ONBOARDING_EXPERIENCE_LEVELS,
      false
    ),
    workStatus: selectedLabels(
      member,
      config.onboarding.roles.workStatus,
      ONBOARDING_WORK_STATUSES,
      false
    ),
    gender: selectedLabels(
      member,
      config.onboarding.roles.gender,
      ONBOARDING_GENDERS,
      false
    ),
  };
}

export async function syncNativeOnboardingFromMember(member) {
  const selections = nativeOnboardingFromMember(member);
  const hasConfiguredSignal =
    selections.interests.length > 0 ||
    selections.experience !== null ||
    selections.workStatus !== null ||
    selections.gender !== null;

  if (!hasConfiguredSignal) {
    logger.debug(`No configured native onboarding roles found for ${member.guild.id}:${member.id}.`);
    return { profile: null, selections, detected: false };
  }

  const profile = await updateOnboardingData(member.guild.id, member.id, selections);
  return { profile, selections, detected: Boolean(profile) };
}

