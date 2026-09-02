/**
 * security/securityAlerts.js
 * ---------------------------------------------------------------------------
 * Phase 5 — Owner Approval System (Forge Guardian Security System v2.0).
 *
 * For HIGH or CRITICAL threats a Security Alert card is posted to the alert
 * channel with action buttons:
 *
 * STRICT alerts use only ✅ APPROVE and ❌ DENY. Approval is restricted to the
 * server owner and executes the requested BAN/KICK exactly once. The bot never
 * performs a destructive action merely because a threat was detected.
 *
 * This is complementary to the existing warning-threshold Moderator Approval
 * Panel (managers/approvalSystem.js) — that system is untouched.
 * ---------------------------------------------------------------------------
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getSettings } from '../database/settingsStore.js';
import { threatMeta, threatToSeverity } from './riskEngine.js';
import { issueWarning, kickMember, banMember, sendLog } from '../services/moderationService.js';
import { notifyOwnerApproval, notifySecurityAlert } from '../services/telegramClient.js';
import { recordTimeout, recordKick, recordBan, recordSecurityWarning } from '../database/securityStore.js';
import { audit } from '../managers/auditLogger.js';

/** customId prefix for all security-alert buttons. */
export const SECURITY_PREFIX = 'secalert';

/** In-memory registry of open security alerts. Map<alertId, alertData> */
const openAlerts = new Map();
/** Per-alert processing locks (duplicate-click guard). */
const locks = new Set();
const ALERT_TTL_MS = 30 * 60 * 1000;

let alertCounter = 0;

function nextAlertId() {
  alertCounter += 1;
  return `SEC-${Date.now().toString(36).toUpperCase()}-${alertCounter}`;
}

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

/** STRICT destructive decisions are owner-only; other alerts keep existing access. */
function canAct(member, guild, securitySettings, strict = false) {
  if (!member) return false;
  if (strict) return member.id === guild.ownerId;
  if (member.id === guild.ownerId) return true;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (securitySettings.ownerRoleId && member.roles?.cache?.has(securitySettings.ownerRoleId)) return true;
  if (securitySettings.moderatorRoleIds?.some((rid) => member.roles?.cache?.has(rid))) return true;
  return false;
}

const ACTION_PERMISSIONS = {
  ban: PermissionFlagsBits.BanMembers,
  kick: PermissionFlagsBits.KickMembers,
  timeout: PermissionFlagsBits.ModerateMembers,
  warn: null, // any authorised moderator
  ignore: null,
};

/* ------------------------------------------------------------------ */
/* Alert creation                                                      */
/* ------------------------------------------------------------------ */

function alertButtons(alertId, disabled = false, strict = false) {
  const btn = (action, label, emoji, style) =>
    new ButtonBuilder()
      .setCustomId(`${SECURITY_PREFIX}:${alertId}:${action}`)
      .setLabel(label)
      .setEmoji(emoji)
      .setStyle(style)
      .setDisabled(disabled);

  const components = strict
    ? [btn('approve', 'APPROVE', '✅', ButtonStyle.Danger), btn('deny', 'DENY', '❌', ButtonStyle.Secondary)]
    : [btn('ban', 'Ban', '✅', ButtonStyle.Danger), btn('kick', 'Kick', '⚠️', ButtonStyle.Danger), btn('timeout', 'Timeout', '🟡', ButtonStyle.Primary), btn('warn', 'Warn', '📝', ButtonStyle.Secondary), btn('ignore', 'Ignore', '❌', ButtonStyle.Secondary)];
  return [new ActionRowBuilder().addComponents(...components)];
}

/**
 * Create a Security Alert (Owner Approval Request) for a HIGH/CRITICAL threat.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.userTag
 * @param {string} [params.avatarUrl]
 * @param {number} params.riskScore
 * @param {string} params.threatLevel   'HIGH' | 'CRITICAL' (others accepted)
 * @param {string[]} params.reasons
 * @param {string} params.source        e.g. 'Join Scan', 'Live Security', 'AI Engine'
 * @param {string} [params.recommendedAction]
 * @returns {Promise<void>}
 */
export async function raiseSecurityAlert(guild, params) {
  try {
    const settings = await getSettings(guild.id);
    const channelId =
      config.security.alertChannelId ||
      settings.security.alertChannelId ||
      config.channels.modAlert ||
      config.channels.log;
    if (!channelId) {
      logger.warn('No security alert channel configured; security alert not posted.');
      return;
    }

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) return;

    const alertId = nextAlertId();
    const meta = threatMeta(params.threatLevel);
    const reasons = (params.reasons ?? []).slice(0, 12);
    const strict = String(params.threatLevel).toUpperCase() === 'STRICT' || String(params.threatLevel).toUpperCase() === 'CRITICAL';
    const requestedAction = String(params.recommendedAction ?? '').toLowerCase().includes('kick') ? 'KICK' : 'BAN';

    const embed = new EmbedBuilder()
      .setColor(meta.color)
      .setTitle(`🛡️ Security Alert — ${alertId}`)
      .setDescription(
        `**Threat detected — awaiting human decision.**\n` +
          `The bot will take **NO destructive action** without your approval.`
      )
      .addFields(
        { name: '👤 User', value: `<@${params.userId}> (${params.userTag})`, inline: true },
        { name: '🆔 User ID', value: params.userId, inline: true },
        { name: '📊 Risk Score', value: `**${params.riskScore}/100**`, inline: true },
        { name: '🚨 Threat Level', value: meta.label, inline: true },
        { name: '🔎 Source', value: params.source ?? 'Security Engine', inline: true },
        { name: '🤖 AI Recommendation', value: params.recommendedAction ?? 'review', inline: true },
        ...(strict ? [{
          name: '⚔️ Requested Action',
          value: `**${requestedAction}**\n\n${reasons.length ? reasons.map((r) => `• ${r}`).join('\n').slice(0, 900) : '*No details provided*'}`,
        }, { name: '👑 Owner Approval', value: '⏳ Awaiting approval', inline: true }] : [{
          name: '📄 Reasons',
          value: reasons.length ? reasons.map((r) => `• ${r}`).join('\n').slice(0, 1000) : '*None provided*',
        }]),
      )
      .setFooter({ text: `Alert ${alertId} • Owner / Admins / configured Moderators only` })
      .setTimestamp();
    if (params.avatarUrl) embed.setThumbnail(params.avatarUrl);

    const mention = String(params.threatLevel).toUpperCase() === 'CRITICAL' ? `<@${guild.ownerId}> — **CRITICAL THREAT**` : '';
    const message = await channel.send({
      content: mention || undefined,
      embeds: [embed],
      components: alertButtons(alertId, false, strict),
    });

    openAlerts.set(alertId, {
      alertId,
      guildId: guild.id,
      userId: params.userId,
      userTag: params.userTag,
      riskScore: params.riskScore,
      threatLevel: String(params.threatLevel).toUpperCase(),
      reasons,
      source: params.source ?? 'Security Engine',
      channelId: channel.id,
      messageId: message.id,
      createdAt: Date.now(),
      resolved: false,
      strict,
      requestedAction,
    });

    // Telegram: Owner Approval Request notification (best-effort).
    await notifyOwnerApproval({
      alert_id: alertId,
      server_name: guild.name,
      username: params.userTag,
      user_id: params.userId,
      risk_score: params.riskScore,
      threat_level: String(params.threatLevel).toUpperCase(),
      reasons: reasons.join('; ').slice(0, 800),
      source: params.source ?? 'Security Engine',
      recommended_action: params.recommendedAction ?? 'review',
      timestamp: new Date().toISOString(),
    }).catch(() => {});
  } catch (error) {
    logger.error(`Failed to raise security alert: ${error.stack || error}`);
  }
}

/* ------------------------------------------------------------------ */
/* Button handling                                                     */
/* ------------------------------------------------------------------ */

/**
 * Handle a button interaction whose customId starts with `secalert:`.
 * Wired in from events/interactionCreate.js.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleSecurityAlertInteraction(interaction) {
  const [, alertId, action] = interaction.customId.split(':');

  const alert = openAlerts.get(alertId);
  if (!alert) {
    return interaction.reply({
      content: '❌ This security alert no longer exists (bot may have restarted).',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (alert.resolved) {
    return interaction.reply({ content: `ℹ️ Alert ${alertId} was already resolved.`, flags: MessageFlags.Ephemeral });
  }
  if (Date.now() - alert.createdAt > ALERT_TTL_MS) {
    alert.resolved = true;
    alert.resolution = 'expired';
    openAlerts.set(alertId, alert);
    return interaction.reply({ content: `⌛ Alert ${alertId} has expired and cannot be processed.`, flags: MessageFlags.Ephemeral });
  }

  const guild = interaction.guild;
  const settings = await getSettings(guild.id);

  if (!canAct(interaction.member, guild, settings.security, alert.strict)) {
    return interaction.reply({
      content: alert.strict ? '🚫 Only the server owner can approve or deny a STRICT security alert.' : '🚫 Only the Owner, Administrators or configured Moderators can act on security alerts.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const effectiveAction = alert.strict ? (action === 'approve' ? alert.requestedAction.toLowerCase() : 'ignore') : action;
  const needed = ACTION_PERMISSIONS[effectiveAction];
  const isOwnerOrAdmin =
    interaction.member.id === guild.ownerId ||
    interaction.member.permissions.has(PermissionFlagsBits.Administrator);
  if (needed && !interaction.member.permissions.has(needed) && !isOwnerOrAdmin) {
    return interaction.reply({
      content: '🚫 You lack the Discord permission required for that action.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Duplicate-click guard.
  if (locks.has(alertId)) {
    return interaction.reply({
      content: '⏳ Another moderator is acting on this alert right now.',
      flags: MessageFlags.Ephemeral,
    });
  }
  locks.add(alertId);

  try {
    await interaction.deferUpdate();
    const member = await guild.members.fetch(alert.userId).catch(() => null);
    const reason = `Security alert ${alertId} (${alert.threatLevel}, risk ${alert.riskScore}) — approved by ${interaction.user.tag}`;
    let outcome = '';

    switch (effectiveAction) {
      case 'ban': {
        if (member) {
          const ok = await banMember(member, reason, { moderatorTag: interaction.user.tag });
          outcome = ok ? `🔨 **${alert.userTag}** was banned.` : '❌ Ban failed (permissions/hierarchy).';
          if (ok) await recordBan(guild.id, alert.userId, reason, interaction.user.tag);
        } else {
          // Member left — ban by ID so they can't rejoin.
          outcome = await guild.members
            .ban(alert.userId, { reason })
            .then(() => {
              recordBan(guild.id, alert.userId, reason, interaction.user.tag);
              return `🔨 **${alert.userTag}** was banned (by ID — user had left).`;
            })
            .catch((e) => `❌ Ban failed: ${e.message}`);
        }
        break;
      }
      case 'kick': {
        if (!member) {
          outcome = '⚠️ Member is no longer in the server — no action taken.';
        } else {
          const ok = await kickMember(member, reason, { moderatorTag: interaction.user.tag });
          outcome = ok ? `👢 **${alert.userTag}** was kicked.` : '❌ Kick failed (permissions/hierarchy).';
          if (ok) await recordKick(guild.id, alert.userId, reason, interaction.user.tag);
        }
        break;
      }
      case 'timeout': {
        const minutes = config.security.timeoutMinutes;
        if (!member) {
          outcome = '⚠️ Member is no longer in the server — no action taken.';
        } else if (!member.moderatable) {
          outcome = '❌ Bot cannot timeout this member (hierarchy/permissions).';
        } else {
          outcome = await member
            .timeout(minutes * 60 * 1000, reason)
            .then(async () => {
              await recordTimeout(guild.id, alert.userId, minutes, reason);
              // Telegram timeout notification (best-effort).
              const { notifyTimeout } = await import('../services/telegramClient.js');
              await notifyTimeout({
                username: alert.userTag,
                user_id: alert.userId,
                server_name: guild.name,
                reason,
                moderator: interaction.user.tag,
                duration_minutes: minutes,
                timestamp: new Date().toISOString(),
              }).catch(() => {});
              return `🟡 **${alert.userTag}** was timed out for **${minutes} minutes**.`;
            })
            .catch((e) => `❌ Timeout failed: ${e.message}`);
        }
        break;
      }
      case 'warn': {
        if (!member) {
          outcome = '⚠️ Member is no longer in the server — no action taken.';
        } else {
          await issueWarning({
            guild,
            member,
            reason: `Security alert ${alertId}: ${alert.reasons[0] ?? alert.threatLevel + ' threat'}`,
            moderatorId: interaction.user.id,
            moderatorTag: interaction.user.tag,
            source: 'command',
            severity: alert.threatLevel === 'CRITICAL' ? 'high' : 'medium',
          });
          await recordSecurityWarning(guild.id, alert.userId, `Security alert ${alertId}`);
          outcome = `📝 **${alert.userTag}** was warned.`;
        }
        break;
      }
      case 'ignore':
      default:
        outcome = `❌ Alert dismissed — no action taken against **${alert.userTag}**.`;
        break;
    }

    alert.resolved = true;
    alert.resolvedBy = interaction.user.id;
    alert.resolution = effectiveAction;
    openAlerts.set(alertId, alert);

    // Finalise the card: append resolution + disable buttons.
    const resolvedEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(`✅ Security Alert Resolved — ${alertId}`)
      .setDescription(`${outcome}\nResolved by ${interaction.user} • ${new Date().toUTCString()}`)
      .setTimestamp();
    await interaction.message
      .edit({ embeds: [interaction.message.embeds[0], resolvedEmbed], components: alertButtons(alertId, true, alert.strict) })
      .catch(() => {});

    // Audit + moderation log + Telegram (all best-effort).
    await audit(guild, {
      action: `Security Alert: ${effectiveAction.charAt(0).toUpperCase() + effectiveAction.slice(1)}`,
      family: action,
      userTag: alert.userTag,
      userId: alert.userId,
      moderatorTag: interaction.user.tag,
      moderatorId: interaction.user.id,
      reason: outcome,
      buttonPressed: action,
      effectiveAction,
      confirmationStatus: 'confirmed',
      channelId: interaction.channelId,
      messageLink: interaction.message.url,
    }).catch(() => {});

    await sendLog(guild, {
      action: `Security Alert Resolved (${action})`,
      color: 0x57f287,
      userTag: alert.userTag,
      userId: alert.userId,
      moderatorTag: interaction.user.tag,
      reason: outcome,
    }).catch(() => {});

    await notifySecurityAlert({
      alert_type: `Security Alert ${effectiveAction === 'ignore' ? 'Denied' : 'Approved'} — ${effectiveAction.toUpperCase()}`,
      severity: threatToSeverity(alert.threatLevel),
      server_name: guild.name,
      username: alert.userTag,
      user_id: alert.userId,
      channel: '',
      details: `${outcome.replace(/\*/g, '')} (alert ${alertId}, decided by ${interaction.user.tag})`,
      timestamp: new Date().toISOString(),
    }).catch(() => {});
  } catch (error) {
    logger.error(`Security alert action failed for alert ${alertId}: ${error.message}`);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: '⚠️ Something went wrong executing that action.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  } finally {
    locks.delete(alertId);
  }
}
