/**
 * services/securityService.js
 * ---------------------------------------------------------------------------
 * The security handler. Detects and reports security-relevant events, and
 * relays every one of them to Telegram through the backend
 * (POST /telegram/security-alert).
 *
 * Detections implemented here:
 *   - Raid detection      : too many joins within a rolling time window.
 *   - New-account alert   : an account younger than a threshold joins.
 *   - AI violation alert  : high-confidence AI moderation flags.
 *   - Generic reporter    : reportSecurityEvent() for any other subsystem.
 *
 * Every alert is best-effort: a Telegram/backend failure never disrupts the
 * bot's Discord-side behaviour.
 * ---------------------------------------------------------------------------
 */

import { logger } from '../utils/logger.js';
import { notifySecurityAlert } from './telegramClient.js';

/** Rolling window (ms) used for raid detection. */
const RAID_WINDOW_MS = 60_000;
/** Number of joins within the window that triggers a raid alert. */
const RAID_JOIN_THRESHOLD = 8;
/** Accounts younger than this (ms) trigger a new-account alert. 7 days. */
const NEW_ACCOUNT_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
/** Cooldown (ms) between consecutive raid alerts per guild. */
const RAID_ALERT_COOLDOWN_MS = 5 * 60_000;

/** Map<guildId, number[]> - join timestamps within the rolling window. */
const joinTimestamps = new Map();
/** Map<guildId, number> - last time a raid alert was sent. */
const lastRaidAlert = new Map();

/**
 * Report ANY security event to Telegram via the backend.
 *
 * @param {object} params
 * @param {string} params.alertType   e.g. 'Raid Suspected', 'AI Violation'
 * @param {'low'|'medium'|'high'|'critical'} [params.severity='medium']
 * @param {string} params.serverName
 * @param {string} [params.username='Unknown']
 * @param {string} [params.userId='']
 * @param {string} [params.channel='']
 * @param {string} params.details
 * @returns {Promise<boolean>}
 */
export async function reportSecurityEvent({
  alertType,
  severity = 'medium',
  serverName,
  username = 'Unknown',
  userId = '',
  channel = '',
  details,
}) {
  logger.info(`Security event [${alertType}/${severity}]: ${details}`);
  return notifySecurityAlert({
    alert_type: alertType,
    severity,
    server_name: serverName,
    username,
    user_id: userId,
    channel,
    details,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Track a member join for raid detection and new-account screening.
 * Call this from guildMemberAdd for every join (including bots).
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {Promise<void>}
 */
export async function trackJoinForSecurity(member) {
  const guild = member.guild;
  const now = Date.now();

  // --- Raid detection: count joins in the rolling window ---
  const stamps = (joinTimestamps.get(guild.id) ?? []).filter(
    (t) => now - t < RAID_WINDOW_MS
  );
  stamps.push(now);
  joinTimestamps.set(guild.id, stamps);

  if (stamps.length >= RAID_JOIN_THRESHOLD) {
    const last = lastRaidAlert.get(guild.id) ?? 0;
    if (now - last > RAID_ALERT_COOLDOWN_MS) {
      lastRaidAlert.set(guild.id, now);
      await reportSecurityEvent({
        alertType: 'Raid Suspected',
        severity: 'critical',
        serverName: guild.name,
        details:
          `${stamps.length} members joined within ${Math.round(RAID_WINDOW_MS / 1000)}s. ` +
          `Latest: ${member.user.tag} (${member.id}). Review the member list and consider enabling raid protection.`,
      });
    }
  }

  // --- New-account screening ---
  const accountAgeMs = now - member.user.createdTimestamp;
  if (accountAgeMs < NEW_ACCOUNT_THRESHOLD_MS) {
    const days = Math.max(0, Math.floor(accountAgeMs / (24 * 60 * 60 * 1000)));
    await reportSecurityEvent({
      alertType: 'New Account Joined',
      severity: 'high',
      serverName: guild.name,
      username: member.user.tag,
      userId: member.id,
      details:
        `Account is only ${days} day(s) old (created ${new Date(member.user.createdTimestamp).toISOString()}). ` +
        'Young accounts are a common raid/scam vector — keep an eye on this member.',
    });
  }
}

/**
 * Report a high-confidence AI moderation violation as a security alert.
 * Called by the auto-moderation pipeline after the AI flags a message.
 *
 * @param {import('discord.js').Message} message
 * @param {{rule: number|null, confidence: number, reason: string, action: string}} result
 * @returns {Promise<void>}
 */
export async function reportAIViolation(message, result) {
  await reportSecurityEvent({
    alertType: 'AI Violation',
    severity: result.action === 'kick' ? 'high' : 'medium',
    serverName: message.guild?.name ?? 'Unknown',
    username: message.author?.tag ?? 'Unknown',
    userId: message.author?.id ?? '',
    channel: message.channel?.name ? `#${message.channel.name}` : '',
    details:
      `${result.reason} — rule ${result.rule ?? 'n/a'}, ` +
      `confidence ${Math.round(result.confidence * 100)}%, action: ${result.action}. ` +
      `Message: "${(message.content ?? '').slice(0, 200)}"`,
  });
}
