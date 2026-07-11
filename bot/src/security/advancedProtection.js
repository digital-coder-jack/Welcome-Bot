/**
 * security/advancedProtection.js
 * ---------------------------------------------------------------------------
 * Phase 8 — Advanced Protection (Forge Guardian v2.0).
 *
 * Heuristic-only detectors built EXCLUSIVELY on data the Discord Bot API
 * exposes plus this bot's own internal records. We never fetch, infer or
 * claim anything about bios, other servers, emails, phones, IPs, devices,
 * locations or Nitro — the Bot API does not expose them.
 *
 * Detectors:
 *   - Alt account detection        (heuristics: age + avatar + name pattern
 *                                   + rejoin history)
 *   - Invite farming detection     (one inviter bringing many new accounts
 *                                   in a short window — internal counters)
 *   - Fake Staff detection         (identityAnalyzer signals re-used)
 *   - Fake Discord Employee        (name/keyword heuristics; the real Staff
 *                                   badge would be in public flags)
 *   - Mass account creation        (several joiners created within minutes
 *                                   of each other — classic raid farm)
 *   - Rejoin abuse detection       (internal join/leave history)
 *   - Role abuse detection         (guildMemberUpdate: rapid role grants)
 *   - Permission abuse detection   (dangerous permissions granted via roles)
 *   - Blacklist checks             (users / invites / servers — own DB)
 *   - Reputation score             (activity within THIS server only)
 *
 * Every function is pure/fail-safe and returns findings + score deltas that
 * the join scan and live security merge into the overall risk.
 * ---------------------------------------------------------------------------
 */

import { PermissionFlagsBits } from 'discord.js';
import { getSecurityHistory } from '../database/securityStore.js';
import { isUserBlacklisted, isInviteBlacklisted } from '../database/blacklistStore.js';
import { logger } from '../utils/logger.js';

/* ------------------------------------------------------------------ */
/*  In-memory rolling windows (internal counters only)                 */
/* ------------------------------------------------------------------ */

/** Map<guildId, Map<inviterTag, {stamps:number[], newAccounts:number}>> */
const inviteFarmWindow = new Map();
/** Map<guildId, number[]> account-created timestamps of recent joiners. */
const creationWindow = new Map();
/** Map<guildId:userId, number[]> role-grant timestamps (role abuse). */
const roleGrantWindow = new Map();

const INVITE_FARM_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const INVITE_FARM_THRESHOLD = 5;              // 5+ new accounts from one inviter
const MASS_CREATION_WINDOW_MS = 10 * 60 * 1000; // joiners within 10 min
const MASS_CREATION_SPREAD_MS = 30 * 60 * 1000; // accounts created within 30 min of each other
const MASS_CREATION_THRESHOLD = 3;
const ROLE_ABUSE_WINDOW_MS = 5 * 60 * 1000;
const ROLE_ABUSE_THRESHOLD = 4;

/** Names that impersonate Discord staff/system (heuristic). */
const FAKE_EMPLOYEE_PATTERNS = [
  /discord\s*(staff|employee|team|support|security|hypesquad\s*events?|trust\s*&?\s*safety)/i,
  /system\s*message/i,
  /official\s*discord/i,
];

/** Names that impersonate server staff (heuristic). */
const FAKE_STAFF_PATTERNS = [
  /\b(admin|administrator|moderator|mod|owner|founder|staff)\b/i,
];

/* ------------------------------------------------------------------ */
/*  Join-time checks (called from joinScan)                            */
/* ------------------------------------------------------------------ */

/**
 * Run all Phase-8 join-time heuristics for a joining member.
 * Returns { score, findings[] } to merge into the join risk.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {{code:string, inviterTag:string}} invite
 * @returns {Promise<{score:number, findings:string[]}>}
 */
export async function runAdvancedJoinChecks(member, invite) {
  const findings = [];
  let score = 0;
  const guildId = member.guild.id;
  const now = Date.now();

  try {
    /* --- Blacklisted user (own database) --- */
    const blUser = await isUserBlacklisted(guildId, member.id);
    if (blUser) {
      score += 60;
      findings.push(`⛔ User is on this server's blacklist (${blUser.reason || 'no reason recorded'})`);
    }

    /* --- Blacklisted invite (own database) --- */
    if (invite?.code && invite.code !== 'Unknown') {
      const blInvite = await isInviteBlacklisted(guildId, invite.code);
      if (blInvite) {
        score += 30;
        findings.push(`⛔ Joined via blacklisted invite \`${invite.code}\``);
      }
    }

    /* --- Alt account heuristics --- */
    const ageDays = (now - member.user.createdTimestamp) / 86_400_000;
    const history = await getSecurityHistory(guildId, member.id);
    let altSignals = 0;
    if (ageDays < 7) altSignals += 1;
    if (!member.user.avatar) altSignals += 1;
    if (/\d{4,}$/.test(member.user.username)) altSignals += 1; // name + long number
    if ((history.rejoinCount ?? 0) >= 1) altSignals += 1;
    if (altSignals >= 3) {
      score += 20;
      findings.push(`Possible alt account (${altSignals}/4 heuristic signals: new age, default avatar, numeric-suffix name, rejoin history)`);
    }

    /* --- Rejoin abuse --- */
    if ((history.rejoinCount ?? 0) >= 3) {
      score += 15;
      findings.push(`Rejoin abuse: ${history.rejoinCount} rejoins recorded (join/leave cycling)`);
    }

    /* --- Fake Discord Employee (heuristic name check) --- */
    const names = [member.user.username, member.user.globalName ?? '', member.nickname ?? ''];
    for (const name of names) {
      if (name && FAKE_EMPLOYEE_PATTERNS.some((re) => re.test(name))) {
        score += 35;
        findings.push(`Possible fake Discord employee: name "${name}" impersonates Discord staff`);
        break;
      }
    }

    /* --- Fake Staff (server staff impersonation) --- */
    for (const name of names) {
      if (name && FAKE_STAFF_PATTERNS.some((re) => re.test(name))) {
        score += 15;
        findings.push(`Possible fake staff: name "${name}" contains a staff keyword`);
        break;
      }
    }

    /* --- Invite farming (internal counters) --- */
    if (invite?.inviterTag && invite.inviterTag !== 'Unknown' && invite.inviterTag !== 'Vanity URL') {
      if (!inviteFarmWindow.has(guildId)) inviteFarmWindow.set(guildId, new Map());
      const perInviter = inviteFarmWindow.get(guildId);
      const rec = perInviter.get(invite.inviterTag) ?? { stamps: [], newAccounts: 0 };
      rec.stamps = rec.stamps.filter((t) => now - t < INVITE_FARM_WINDOW_MS);
      rec.stamps.push(now);
      if (ageDays < 30) rec.newAccounts += 1;
      perInviter.set(invite.inviterTag, rec);

      if (rec.stamps.length >= INVITE_FARM_THRESHOLD && rec.newAccounts >= Math.ceil(rec.stamps.length / 2)) {
        score += 15;
        findings.push(`Invite farming pattern: ${rec.stamps.length} joins via "${invite.inviterTag}" in the last hour, mostly new accounts`);
      }
    }

    /* --- Mass account creation (raid farm) --- */
    const created = (creationWindow.get(guildId) ?? []).filter(
      (e) => now - e.joinedAt < MASS_CREATION_WINDOW_MS
    );
    created.push({ joinedAt: now, createdAt: member.user.createdTimestamp });
    creationWindow.set(guildId, created);

    const closeCreations = created.filter(
      (e) => Math.abs(e.createdAt - member.user.createdTimestamp) < MASS_CREATION_SPREAD_MS
    );
    if (closeCreations.length >= MASS_CREATION_THRESHOLD) {
      score += 25;
      findings.push(`Mass account creation: ${closeCreations.length} recent joiners have accounts created within 30 minutes of each other`);
    }
  } catch (error) {
    logger.warn(`Advanced join checks failed (failing safe): ${error.message}`);
  }

  return { score: Math.min(60, score), findings };
}

/* ------------------------------------------------------------------ */
/*  Role / permission abuse (called from guildMemberUpdate)            */
/* ------------------------------------------------------------------ */

/** Permissions considered dangerous when suddenly granted. */
const DANGEROUS_PERMS = [
  ['Administrator', PermissionFlagsBits.Administrator],
  ['Ban Members', PermissionFlagsBits.BanMembers],
  ['Kick Members', PermissionFlagsBits.KickMembers],
  ['Manage Guild', PermissionFlagsBits.ManageGuild],
  ['Manage Roles', PermissionFlagsBits.ManageRoles],
  ['Manage Channels', PermissionFlagsBits.ManageChannels],
  ['Manage Webhooks', PermissionFlagsBits.ManageWebhooks],
  ['Mention Everyone', PermissionFlagsBits.MentionEveryone],
];

/**
 * Inspect a member update for role/permission abuse.
 * Returns null when clean, otherwise { findings[], severity }.
 *
 * @param {import('discord.js').GuildMember} oldMember
 * @param {import('discord.js').GuildMember} newMember
 * @returns {{findings:string[], severity:'medium'|'high'}|null}
 */
export function detectRoleAbuse(oldMember, newMember) {
  try {
    const added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
    if (added.size === 0) return null;

    const findings = [];
    let severity = 'medium';
    const now = Date.now();

    // Rapid role grants (role abuse).
    const k = `${newMember.guild.id}:${newMember.id}`;
    const stamps = (roleGrantWindow.get(k) ?? []).filter((t) => now - t < ROLE_ABUSE_WINDOW_MS);
    for (let i = 0; i < added.size; i += 1) stamps.push(now);
    roleGrantWindow.set(k, stamps);
    if (stamps.length >= ROLE_ABUSE_THRESHOLD) {
      findings.push(`Role abuse pattern: ${stamps.length} roles granted to ${newMember.user.tag} within 5 minutes`);
    }

    // Dangerous permission grants (permission abuse).
    const gained = [];
    for (const role of added.values()) {
      for (const [label, bit] of DANGEROUS_PERMS) {
        if (role.permissions.has(bit) && !oldMember.permissions.has(bit)) {
          gained.push(`${label} (via @${role.name})`);
        }
      }
    }
    if (gained.length > 0) {
      severity = 'high';
      findings.push(`Permission abuse watch: ${newMember.user.tag} gained dangerous permission(s): ${[...new Set(gained)].join(', ')}`);
    }

    return findings.length > 0 ? { findings, severity } : null;
  } catch (error) {
    logger.warn(`detectRoleAbuse failed: ${error.message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Reputation score (this server's activity only)                     */
/* ------------------------------------------------------------------ */

/**
 * Compute a 0–100 reputation score from a member's IN-SERVER profile only.
 * Positive: tenure, messages, voice minutes. Negative: warnings, timeouts,
 * deleted messages, AI violations, scam detections, rejoin cycling.
 *
 * @param {object} profile  from profileStore.getProfile()
 * @returns {number} 0–100
 */
export function computeReputation(profile) {
  try {
    let rep = 50; // neutral baseline

    // Tenure (up to +15).
    if (profile.account?.joinedServer) {
      const tenureDays = (Date.now() - Date.parse(profile.account.joinedServer)) / 86_400_000;
      rep += Math.min(15, Math.floor(tenureDays / 7)); // +1 per week
    }

    // Positive activity (up to +25).
    const a = profile.activity ?? {};
    rep += Math.min(15, Math.floor((a.messageCount ?? 0) / 50));
    rep += Math.min(10, Math.floor((a.voiceMinutes ?? 0) / 60));

    // Negative moderation history.
    const m = profile.moderation ?? {};
    rep -= (m.warnings ?? 0) * 5;
    rep -= (m.timeouts ?? 0) * 8;
    rep -= (m.deletedMessages ?? 0) * 2;
    rep -= (m.aiViolations ?? 0) * 4;
    rep -= (m.kicks ?? 0) * 15;
    rep -= (m.bans ?? 0) * 25;

    // Negative security history.
    const s = profile.security ?? {};
    rep -= (s.scamDetections ?? 0) * 10;
    if ((s.rejoinCount ?? 0) >= 2) rep -= 5;

    return Math.max(0, Math.min(100, Math.round(rep)));
  } catch {
    return 50;
  }
}
