/**
 * database/profileStore.js
 * ---------------------------------------------------------------------------
 * Phase 7 — Permanent Member Security Profile (Forge Guardian v2.0).
 *
 * One durable, structured profile per member (`<guildId>:<userId>`), built
 * ONLY from data the Discord Bot API exposes or that the bot generates
 * internally. We NEVER collect (and never claim to collect) user bios,
 * connected accounts, other servers, email, phone, IP, device, location or
 * Nitro status — the Bot API does not expose them.
 *
 * Profile shape (all fields optional / best-effort):
 *   identity:   username, displayName, nickname, userId, discriminator,
 *               avatarUrl, bannerUrl, accentColor, publicFlags, badges, isBot
 *   account:    accountCreated, joinedServer, accountAgeDays, memberNumber
 *   server:     roles[], highestRole, inviteUsed, inviter,
 *               verificationStatus, forgeMemberStatus, devIntroStatus,
 *               welcomeDmStatus
 *   moderation: warnings, timeouts, kicks, bans, deletedMessages,
 *               aiViolations
 *   security:   riskScore, threatLevel, scamDetections,
 *               suspiciousUsername, suspiciousAvatar,
 *               previousJoins, previousLeaves, rejoinCount, reputation
 *   activity:   messageCount, voiceMinutes, attachmentsSent, linksShared,
 *               lastSeen
 *
 * Activity counters are flushed lazily (debounced by jsonStore) so hot paths
 * (messageCreate) stay cheap. All functions are fail-safe.
 * ---------------------------------------------------------------------------
 */

import { createJsonStore } from './jsonStore.js';
import { logger } from '../utils/logger.js';

const store = createJsonStore('member-profiles.json');

function key(guildId, userId) {
  return `${guildId}:${userId}`;
}

/** Blank profile skeleton. */
export function emptyProfile(guildId, userId) {
  return {
    guildId,
    userId,
    identity: {
      username: null,
      displayName: null,
      nickname: null,
      avatarUrl: null,
      bannerUrl: null,
      accentColor: null,
      publicFlags: 0,
      badges: [],
      isBot: false,
    },
    account: {
      accountCreated: null,
      joinedServer: null,
      accountAgeDays: null,
      memberNumber: null,
    },
    server: {
      roles: [],
      highestRole: null,
      inviteUsed: 'Unknown',
      inviter: 'Unknown',
      verificationStatus: 'Unverified',
      forgeMemberStatus: 'Not assigned',
      devIntroStatus: 'Not sent',
      welcomeDmStatus: 'Not attempted',
    },
    moderation: {
      warnings: 0,
      timeouts: 0,
      kicks: 0,
      bans: 0,
      deletedMessages: 0,
      aiViolations: 0,
    },
    security: {
      riskScore: 0,
      threatLevel: 'SAFE',
      scamDetections: 0,
      suspiciousUsername: false,
      suspiciousAvatar: false,
      previousJoins: 0,
      previousLeaves: 0,
      rejoinCount: 0,
      reputation: 50, // 0–100, in-server activity only (Phase 8)
    },
    activity: {
      messageCount: 0,
      voiceMinutes: 0,
      attachmentsSent: 0,
      linksShared: 0,
      lastSeen: null,
    },
    updatedAt: null,
  };
}

/** Deep-merge stored data over the skeleton so old records gain new fields. */
function withDefaults(guildId, userId, stored) {
  const base = emptyProfile(guildId, userId);
  if (!stored) return base;
  return {
    ...base,
    ...stored,
    identity: { ...base.identity, ...(stored.identity ?? {}) },
    account: { ...base.account, ...(stored.account ?? {}) },
    server: { ...base.server, ...(stored.server ?? {}) },
    moderation: { ...base.moderation, ...(stored.moderation ?? {}) },
    security: { ...base.security, ...(stored.security ?? {}) },
    activity: { ...base.activity, ...(stored.activity ?? {}) },
  };
}

/**
 * Get (a defaults-merged copy of) a member's security profile.
 * @returns {Promise<object>} never null.
 */
export async function getProfile(guildId, userId) {
  try {
    const data = await store.read();
    return withDefaults(guildId, userId, data[key(guildId, userId)]);
  } catch (error) {
    logger.warn(`profileStore getProfile failed: ${error.message}`);
    return emptyProfile(guildId, userId);
  }
}

/**
 * Merge a partial patch into a member's profile. Sections are shallow-merged.
 * @param {string} guildId
 * @param {string} userId
 * @param {object} patch  e.g. { identity: {...}, security: {...} }
 * @returns {Promise<object|null>} the updated profile.
 */
export async function updateProfile(guildId, userId, patch) {
  try {
    const data = await store.read();
    const k = key(guildId, userId);
    const current = withDefaults(guildId, userId, data[k]);
    const next = { ...current };
    for (const [section, value] of Object.entries(patch)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && typeof next[section] === 'object') {
        next[section] = { ...next[section], ...value };
      } else {
        next[section] = value;
      }
    }
    next.updatedAt = new Date().toISOString();
    data[k] = next;
    store.flush();
    return next;
  } catch (error) {
    logger.warn(`profileStore updateProfile failed: ${error.message}`);
    return null;
  }
}

/**
 * Increment a numeric counter inside a profile section.
 * @param {string} guildId
 * @param {string} userId
 * @param {'moderation'|'security'|'activity'} section
 * @param {string} field
 * @param {number} [by=1]
 */
export async function bumpProfile(guildId, userId, section, field, by = 1) {
  try {
    const data = await store.read();
    const k = key(guildId, userId);
    const current = withDefaults(guildId, userId, data[k]);
    if (typeof current[section]?.[field] !== 'number') return null;
    current[section][field] += by;
    current.activity.lastSeen = new Date().toISOString();
    current.updatedAt = current.activity.lastSeen;
    data[k] = current;
    store.flush();
    return current;
  } catch (error) {
    logger.warn(`profileStore bumpProfile failed: ${error.message}`);
    return null;
  }
}

/**
 * Refresh the identity/account/server sections of a profile from a live
 * GuildMember object (only Bot-API-exposed fields).
 *
 * @param {import('discord.js').GuildMember} member
 * @param {object} [extra]  { inviteUsed, inviter, memberNumber, welcomeDmStatus,
 *                            forgeMemberStatus, devIntroStatus, bannerUrl,
 *                            accentColor, badges, publicFlags }
 * @returns {Promise<object|null>}
 */
export async function syncProfileFromMember(member, extra = {}) {
  try {
    const roles = member.roles?.cache
      ?.filter((r) => r.id !== member.guild.id)
      .map((r) => ({ id: r.id, name: r.name })) ?? [];
    const highest = member.roles?.highest && member.roles.highest.id !== member.guild.id
      ? member.roles.highest.name
      : null;

    const identity = {
      username: member.user.username,
      displayName: member.displayName ?? member.user.globalName ?? member.user.username,
      nickname: member.nickname ?? null,
      avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 512 }),
      isBot: Boolean(member.user.bot),
    };
    if (extra.bannerUrl !== undefined) identity.bannerUrl = extra.bannerUrl;
    if (extra.accentColor !== undefined) identity.accentColor = extra.accentColor;
    if (extra.badges !== undefined) identity.badges = extra.badges;
    if (extra.publicFlags !== undefined) identity.publicFlags = extra.publicFlags;

    const account = {
      accountCreated: new Date(member.user.createdTimestamp).toISOString(),
      joinedServer: member.joinedTimestamp ? new Date(member.joinedTimestamp).toISOString() : null,
      accountAgeDays: Math.floor((Date.now() - member.user.createdTimestamp) / 86_400_000),
    };
    if (extra.memberNumber !== undefined) account.memberNumber = extra.memberNumber;

    const server = { roles, highestRole: highest };
    if (extra.inviteUsed !== undefined) server.inviteUsed = extra.inviteUsed;
    if (extra.inviter !== undefined) server.inviter = extra.inviter;
    if (extra.welcomeDmStatus !== undefined) server.welcomeDmStatus = extra.welcomeDmStatus;
    if (extra.forgeMemberStatus !== undefined) server.forgeMemberStatus = extra.forgeMemberStatus;
    if (extra.devIntroStatus !== undefined) server.devIntroStatus = extra.devIntroStatus;
    if (extra.verificationStatus !== undefined) server.verificationStatus = extra.verificationStatus;

    return await updateProfile(member.guild.id, member.id, { identity, account, server });
  } catch (error) {
    logger.warn(`profileStore syncProfileFromMember failed: ${error.message}`);
    return null;
  }
}

/**
 * List all profiles for a guild (used by /security export & server overview).
 * @param {string} guildId
 * @returns {Promise<object[]>}
 */
export async function listProfiles(guildId) {
  try {
    const data = await store.read();
    const prefix = `${guildId}:`;
    return Object.entries(data)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => withDefaults(guildId, k.slice(prefix.length), v));
  } catch (error) {
    logger.warn(`profileStore listProfiles failed: ${error.message}`);
    return [];
  }
}
