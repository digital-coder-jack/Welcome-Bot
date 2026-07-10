/**
 * security/securityAlerts.js
 * ---------------------------------------------------------------------------
 * Phase 5 — Owner Approval System (Forge Guardian Security System v2.0).
 *
 * For HIGH or CRITICAL threats a Security Alert card is posted to the alert
 * channel with action buttons:
 *
 *   ✅ Ban   ⚠ Kick   🟡 Timeout   📝 Warn   ❌ Ignore
 *
 * Only the server owner, Administrators, or configured moderator roles can
 * execute the buttons. Ban/Kick additionally require the underlying Discord
 * permission. THE BOT NEVER BANS AUTOMATICALLY — every destructive action is
 * an explicit human button press.
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

let alertCounter = 0;

function nextAlertId() {
  alertCounter += 1;
  return `SEC-${Date.now().toString(36).toUpperCase()}-${alertCounter}`;
}

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

/** Owner / Administrator / configured moderator roles may act. */
function canAct(member, guild, securitySettings) {
  if (!member) return false;
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

function alertButtons(alertId, disabled = false) {
  const btn = (action, label, emoji, style) =>
    new ButtonBuilder()
      .setCustomId(`${SECURITY_PREFIX}:${alertId}:${action}`)
      .setLabel(label)
      .setEmoji(emoji)
      .setStyle(style)
      .setDisabled(disabled);

  return [
    new ActionRowBuilder().addComponents(
      btn('ban', 'Ban', '✅', ButtonStyle.Danger),
      btn('kick', 'Kick', '⚠️', ButtonStyle.Danger),
      btn('timeout', 'Timeout', '🟡', ButtonStyle.Primary),
      btn('warn', 'Warn', '📝', ButtonStyle.Secondary),
      btn('ignore', 'Ignore', '❌', ButtonStyle.Secondary)
    ),
  ];
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
        {
          name: '📄 Reasons',
          value: reasons.length ? reasons.map((r) => `• ${r}`).join('\n').slice(0, 1000) : '*None provided*',
        }
      )
      .setFooter({ text: `Alert ${alertId} • Owner / Admins / configured Moderators only` })
      .setTimestamp();
    if (params.avatarUrl) embed.setThumbnail(params.avatarUrl);

    const mention = String(params.threatLevel).toUpperCase() === 'CRITICAL' ? `<@${guild.ownerId}> — **CRITICAL THREAT**` : '';
    const message = await channel.send({
      content: mention || undefined,
      embeds: [embed],
      components: alertButtons(alertId),
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

  const guild = interaction.guild;
  const settings = await getSettings(guild.id);

  if (!canAct(interaction.member, guild, settings.security)) {
    return interaction.reply({
      content: '🚫 Only the Owner, Administrators or configured Moderators can act on security alerts.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const needed = ACTION_PERMISSIONS[action];
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

    switch (action) {
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
    openAlerts.set(alertId, alert);

    // Finalise the card: append resolution + disable buttons.
    const resolvedEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(`✅ Security Alert Resolved — ${alertId}`)
      .setDescription(`${outcome}\nResolved by ${interaction.user} • ${new Date().toUTCString()}`)
      .setTimestamp();
    await interaction.message
      .edit({ embeds: [interaction.message.embeds[0], resolvedEmbed], components: alertButtons(alertId, true) })
      .catch(() => {});

    // Audit + moderation log + Telegram (all best-effort).
    await audit(guild, {
      action: `Security Alert: ${action.charAt(0).toUpperCase() + action.slice(1)}`,
      family: action,
      userTag: alert.userTag,
      userId: alert.userId,
      moderatorTag: interaction.user.tag,
      moderatorId: interaction.user.id,
      reason: outcome,
      buttonPressed: action,
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
      alert_type: `Security Alert Resolved — ${action.toUpperCase()}`,
      severity: threatToSeverity(alert.threatLevel),
      server_name: guild.name,
      username: alert.userTag,
      user_id: alert.userId,
      channel: '',
      details: `${outcome.replace(/\*/g, '')} (alert ${alertId}, decided by ${interaction.user.tag})`,
      timestamp: new Date().toISOString(),
    }).catch(() => {});
  } catch (error) {
    logger.error(`Security alert action "${action}" failed: ${error.stack || error}`);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: '⚠️ Something went wrong executing that action.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  } finally {
    locks.delete(alertId);
  }
}
