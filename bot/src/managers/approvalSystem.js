/**
 * managers/approvalSystem.js
 * ---------------------------------------------------------------------------
 * The Moderator Approval Panel + Owner Confirmation flow.
 *
 * Flow:
 *   1. escalateToModerators(member, ...) posts a moderation card to the
 *      configured alert channel with the full member profile and action
 *      buttons: ✅ Ignore, ⚠ Reset Warnings, 🕒 Timeout, 🔇 Mute, 👢 Kick,
 *      🔨 Ban, 📄 View History.
 *   2. Safe actions (Ignore / Reset / Timeout / Mute) execute immediately
 *      after a permission check.
 *   3. High-risk actions (Kick / Ban) NEVER execute directly — they open a
 *      confirmation prompt (✅ Confirm / ❌ Cancel). Only after explicit
 *      confirmation does the bot act.
 *   4. Owner override: the server owner (or the configured owner role) can
 *      always Approve / Reject / Reduce / Reset / Add note, and can cancel
 *      any pending punishment before confirmation.
 *
 * Anti-abuse: per-case processing locks, single state transitions, disabled
 * buttons after resolution, and per-button permission checks make duplicate
 * clicks and moderator races harmless.
 *
 * THE BOT NEVER KICKS OR BANS AUTOMATICALLY. Every kick/ban requires an
 * explicit moderator button press + confirmation.
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
import { logger } from '../utils/logger.js';
import { getSettings } from '../database/settingsStore.js';
import { getWarningProfile, clearWarnings, SEVERITIES } from './warningManager.js';
import {
  openCase,
  getCase,
  attachPanel,
  lockCase,
  unlockCase,
  requestConfirmation,
  cancelConfirmation,
  resolveCase,
  hasOpenCase,
  CASE_STATES,
} from './moderationQueue.js';
import { audit } from './auditLogger.js';
import { accountAge } from '../utils/time.js';
import { config } from '../config.js';
import { reportSecurityEvent } from '../services/securityService.js';

/** customId prefix for all approval-panel buttons. */
export const PANEL_PREFIX = 'modpanel';

/* ------------------------------------------------------------------ */
/* Permission helpers                                                  */
/* ------------------------------------------------------------------ */

/** Whether the interacting member is the server owner / owner role. */
function isOwner(interactionMember, guild, securitySettings) {
  if (interactionMember.id === guild.ownerId) return true;
  if (securitySettings.ownerRoleId && interactionMember.roles?.cache?.has(securitySettings.ownerRoleId)) return true;
  return false;
}

/** Whether the interacting member counts as a moderator for the panel. */
function isModerator(interactionMember, guild, securitySettings) {
  if (isOwner(interactionMember, guild, securitySettings)) return true;
  if (securitySettings.moderatorRoleIds?.some((rid) => interactionMember.roles?.cache?.has(rid))) return true;
  // Fallback: Discord-native moderation permission.
  return interactionMember.permissions?.has(PermissionFlagsBits.ModerateMembers) ?? false;
}

/** Discord permission needed to actually execute an action. */
const ACTION_PERMISSIONS = {
  timeout: PermissionFlagsBits.ModerateMembers,
  mute: PermissionFlagsBits.ModerateMembers,
  kick: PermissionFlagsBits.KickMembers,
  ban: PermissionFlagsBits.BanMembers,
};

/* ------------------------------------------------------------------ */
/* Panel construction                                                  */
/* ------------------------------------------------------------------ */

/** Build the two button rows for an OPEN panel. */
function panelButtons(caseId, disabled = false) {
  const btn = (action, label, emoji, style) =>
    new ButtonBuilder()
      .setCustomId(`${PANEL_PREFIX}:${caseId}:${action}`)
      .setLabel(label)
      .setEmoji(emoji)
      .setStyle(style)
      .setDisabled(disabled);

  return [
    new ActionRowBuilder().addComponents(
      btn('ignore', 'Ignore', '✅', ButtonStyle.Secondary),
      btn('reset', 'Reset Warnings', '⚠️', ButtonStyle.Secondary),
      btn('timeout', 'Timeout', '🕒', ButtonStyle.Primary),
      btn('mute', 'Mute', '🔇', ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      btn('kick', 'Kick', '👢', ButtonStyle.Danger),
      btn('ban', 'Ban', '🔨', ButtonStyle.Danger),
      btn('history', 'View History', '📄', ButtonStyle.Secondary)
    ),
  ];
}

/** Build the confirmation row for a pending kick/ban. */
function confirmationButtons(caseId, action, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PANEL_PREFIX}:${caseId}:confirm-${action}`)
        .setLabel(`Confirm ${action === 'ban' ? 'Ban' : 'Kick'}`)
        .setEmoji('✅')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`${PANEL_PREFIX}:${caseId}:cancel`)
        .setLabel('Cancel')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    ),
  ];
}

/** Build the moderation card embed for a case. */
async function panelEmbed(guild, member, caseData) {
  const profile = await getWarningProfile(guild.id, member.id, member.user.createdTimestamp);
  const latest = caseData.escalations[caseData.escalations.length - 1];
  const sev = SEVERITIES[latest.severity] ?? SEVERITIES.medium;

  const historyLines =
    profile.recent.length > 0
      ? profile.recent
          .map((w, i) => `\`${i + 1}.\` ${w.reason.slice(0, 90)} — <t:${Math.floor(new Date(w.timestamp).getTime() / 1000)}:R>`)
          .join('\n')
      : '*No prior warnings on record.*';

  return new EmbedBuilder()
    .setColor(sev.color)
    .setTitle(`🚨 Moderation Review Required — ${caseData.caseId}`)
    .setDescription(
      `${member} has reached the warning threshold.\n` +
        `**The bot will take NO action without your approval.**`
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: '👤 Username', value: `${member.user.tag}`, inline: true },
      { name: '🆔 User ID', value: member.id, inline: true },
      { name: '📊 Risk Score', value: `**${profile.riskScore}/100** (${profile.band})`, inline: true },
      { name: '📅 Account Age', value: accountAge(member.user.createdTimestamp), inline: true },
      {
        name: '📥 Joined',
        value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Unknown',
        inline: true,
      },
      { name: '⚠️ Warnings', value: `${profile.count}`, inline: true },
      { name: `${sev.label} — Latest Reason`, value: latest.reason.slice(0, 1000) },
      { name: '📄 Recent Violations', value: historyLines }
    )
    .setFooter({ text: `Case ${caseData.caseId} • Only authorised moderators can act` })
    .setTimestamp();
}

/* ------------------------------------------------------------------ */
/* Escalation entry point                                              */
/* ------------------------------------------------------------------ */

/**
 * Raise (or refresh) a Moderator Approval Panel for a member.
 * Called by moderationService when the warning threshold is reached or a
 * critical warning is issued. Never punishes — only alerts.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {object} params { reason, severity, warningCount }
 * @returns {Promise<void>}
 */
export async function escalateToModerators(member, { reason, severity, warningCount }) {
  const guild = member.guild;
  const settings = await getSettings(guild.id);

  const alreadyOpen = await hasOpenCase(guild.id, member.id);
  const { caseData, created } = await openCase({
    guildId: guild.id,
    userId: member.id,
    userTag: member.user.tag,
    reason,
    severity,
    warningCount,
  });

  // Resolve the alert channel: dashboard setting > env var > log channel.
  const channelId = settings.security.alertChannelId || config.channels.modAlert || config.channels.log;
  if (!channelId) {
    logger.warn('No security alert channel configured; moderation panel not posted.');
    return;
  }

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const embed = await panelEmbed(guild, member, caseData);

  try {
    if (alreadyOpen && !created && caseData.panelChannelId && caseData.panelMessageId) {
      // Refresh the existing panel instead of posting a duplicate.
      const existing = await channel.messages.fetch(caseData.panelMessageId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed], components: panelButtons(caseData.caseId) });
        return;
      }
    }

    const mention = severity === 'critical' ? '@here — **URGENT (critical severity)**' : '';
    const message = await channel.send({
      content: mention || undefined,
      embeds: [embed],
      components: panelButtons(caseData.caseId),
    });
    await attachPanel(caseData.caseId, channel.id, message.id);

    await audit(guild, {
      action: 'Moderation Panel Raised',
      family: 'panel',
      userTag: member.user.tag,
      userId: member.id,
      reason,
      oldWarningCount: warningCount,
      newWarningCount: warningCount,
      confirmationStatus: 'pending',
      channelId: channel.id,
      messageLink: message.url,
      extraFields: [{ name: 'Severity', value: SEVERITIES[severity]?.label ?? severity, inline: true }],
    });

    // Mirror critical escalations to the Telegram security pipeline.
    if (severity === 'critical') {
      await reportSecurityEvent({
        alertType: 'Critical Moderation Case',
        severity: 'critical',
        serverName: guild.name,
        username: member.user.tag,
        userId: member.id,
        details: `Case ${caseData.caseId}: ${reason}. Awaiting moderator review — no automatic action taken.`,
      }).catch(() => {});
    }
  } catch (error) {
    logger.warn(`Failed to post moderation panel: ${error.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Button interaction handling                                         */
/* ------------------------------------------------------------------ */

/**
 * Handle a button interaction whose customId starts with `modpanel:`.
 * Wired in from events/interactionCreate.js.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handlePanelInteraction(interaction) {
  const [, caseId, action] = interaction.customId.split(':');

  const caseData = await getCase(caseId);
  if (!caseData) {
    return interaction.reply({ content: '❌ This moderation case no longer exists.', flags: MessageFlags.Ephemeral });
  }

  const guild = interaction.guild;
  const settings = await getSettings(guild.id);
  const sec = settings.security;

  // --- Permission gate: only configured moderators / owner may act ---
  if (!isModerator(interaction.member, guild, sec)) {
    return interaction.reply({
      content: '🚫 You are not authorised to use the moderation panel.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // --- View History is read-only and always allowed for moderators ---
  if (action === 'history') {
    return showHistory(interaction, caseData);
  }

  // --- Resolved cases accept no further actions ---
  if (caseData.state === CASE_STATES.RESOLVED) {
    return interaction.reply({
      content: `ℹ️ Case ${caseId} was already resolved (${caseData.resolution?.action ?? 'unknown'}).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // --- Anti-abuse: per-case processing lock (duplicate click guard) ---
  if (!lockCase(caseId)) {
    return interaction.reply({
      content: '⏳ Another moderator is acting on this case right now. Please wait.',
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    if (action === 'kick' || action === 'ban') {
      await beginConfirmation(interaction, caseData, action, sec);
    } else if (action === 'confirm-kick' || action === 'confirm-ban') {
      await executeConfirmed(interaction, caseData, action.replace('confirm-', ''), sec);
    } else if (action === 'cancel') {
      await cancelPending(interaction, caseData, sec);
    } else if (action === 'ignore') {
      await resolveSafe(interaction, caseData, 'ignore', sec);
    } else if (action === 'reset') {
      await resolveSafe(interaction, caseData, 'reset', sec);
    } else if (action === 'timeout') {
      await resolveSafe(interaction, caseData, 'timeout', sec);
    } else if (action === 'mute') {
      await resolveSafe(interaction, caseData, 'mute', sec);
    } else {
      await interaction.reply({ content: '❌ Unknown panel action.', flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    logger.error(`Panel action "${action}" failed: ${error.stack || error}`);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '⚠️ Something went wrong executing that action.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  } finally {
    unlockCase(caseId);
  }
}

/* ------------------------------------------------------------------ */
/* Action implementations                                              */
/* ------------------------------------------------------------------ */

/** 📄 View History — ephemeral warning history + risk profile. */
async function showHistory(interaction, caseData) {
  const member = await interaction.guild.members.fetch(caseData.userId).catch(() => null);
  const createdTs = member?.user.createdTimestamp ?? Date.now();
  const profile = await getWarningProfile(caseData.guildId, caseData.userId, createdTs);

  const lines =
    profile.warnings.length > 0
      ? profile.warnings
          .slice(-15)
          .reverse()
          .map(
            (w, i) =>
              `\`${i + 1}.\` ${w.reason.slice(0, 120)}\n   ↳ by **${w.moderatorTag}** (${w.source}) <t:${Math.floor(new Date(w.timestamp).getTime() / 1000)}:R>`
          )
          .join('\n')
      : '*No warnings on record.*';

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📄 Warning History — ${caseData.userTag}`)
    .setDescription(lines.slice(0, 4000))
    .addFields(
      { name: 'Total Warnings', value: `${profile.count}`, inline: true },
      { name: 'Risk Score', value: `${profile.riskScore}/100 (${profile.band})`, inline: true }
    )
    .setFooter({ text: `Case ${caseData.caseId}` });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

  await audit(interaction.guild, {
    action: 'Panel: View History',
    family: 'panel',
    userTag: caseData.userTag,
    userId: caseData.userId,
    moderatorTag: interaction.user.tag,
    moderatorId: interaction.user.id,
    buttonPressed: '📄 View History',
    confirmationStatus: 'n/a',
    channelId: interaction.channelId,
  });
}

/** Step 1 of a high-risk action: open the confirmation prompt. */
async function beginConfirmation(interaction, caseData, action, sec) {
  // Executing moderator must hold the underlying Discord permission.
  if (!interaction.member.permissions.has(ACTION_PERMISSIONS[action]) && !isOwner(interaction.member, interaction.guild, sec)) {
    return interaction.reply({
      content: `🚫 You need the **${action === 'ban' ? 'Ban Members' : 'Kick Members'}** permission for this action.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const updated = await requestConfirmation(caseData.caseId, {
    action,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
  });
  if (!updated) {
    return interaction.reply({
      content: '⏳ This case already has a pending confirmation from another moderator.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const warnEmbed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`⚠️ Are you sure you want to ${action.toUpperCase()} ${caseData.userTag}?`)
    .setDescription(
      `Requested by ${interaction.user}.\n\n` +
        `• Press **✅ Confirm ${action === 'ban' ? 'Ban' : 'Kick'}** to execute.\n` +
        `• Press **❌ Cancel** to abort.\n\n` +
        `👑 The **server owner** can cancel this pending punishment at any time before confirmation.`
    )
    .setFooter({ text: `Case ${caseData.caseId} • This action will be fully logged` })
    .setTimestamp();

  await interaction.update({
    embeds: [interaction.message.embeds[0], warnEmbed],
    components: confirmationButtons(caseData.caseId, action),
  });

  await audit(interaction.guild, {
    action: `Panel: ${action === 'ban' ? 'Ban' : 'Kick'} Requested`,
    family: action,
    userTag: caseData.userTag,
    userId: caseData.userId,
    moderatorTag: interaction.user.tag,
    moderatorId: interaction.user.id,
    buttonPressed: action === 'ban' ? '🔨 Ban' : '👢 Kick',
    confirmationStatus: 'pending',
    channelId: interaction.channelId,
    messageLink: interaction.message.url,
  });
}

/** Step 2: the confirmation button was pressed — actually execute. */
async function executeConfirmed(interaction, caseData, action, sec) {
  if (caseData.state !== CASE_STATES.AWAITING_CONFIRMATION || caseData.pendingAction?.action !== action) {
    return interaction.reply({ content: 'ℹ️ There is no matching pending action to confirm.', flags: MessageFlags.Ephemeral });
  }

  const owner = isOwner(interaction.member, interaction.guild, sec);
  const isRequester = interaction.user.id === caseData.pendingAction.moderatorId;

  // Confirmation may come from the requesting moderator or the owner.
  if (!isRequester && !owner) {
    return interaction.reply({
      content: '🚫 Only the requesting moderator or the server owner can confirm this action.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!interaction.member.permissions.has(ACTION_PERMISSIONS[action]) && !owner) {
    return interaction.reply({ content: '🚫 You lack the Discord permission for this action.', flags: MessageFlags.Ephemeral });
  }

  const resolved = await resolveCase(caseData.caseId, {
    action,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    note: `Confirmed ${action}`,
  });
  if (!resolved) {
    return interaction.reply({ content: 'ℹ️ This case was already resolved.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferUpdate();

  const member = await interaction.guild.members.fetch(caseData.userId).catch(() => null);
  const reason = `Approved via moderation panel ${caseData.caseId} by ${interaction.user.tag}`;
  let outcome;

  if (!member) {
    outcome = '⚠️ Member is no longer in the server — no action taken.';
  } else if (action === 'kick') {
    outcome = member.kickable
      ? await member.kick(reason).then(() => `👢 **${caseData.userTag}** was kicked.`).catch((e) => `❌ Kick failed: ${e.message}`)
      : '❌ Bot cannot kick this member (hierarchy/permissions).';
  } else {
    outcome = member.bannable
      ? await member.ban({ reason }).then(() => `🔨 **${caseData.userTag}** was banned.`).catch((e) => `❌ Ban failed: ${e.message}`)
      : '❌ Bot cannot ban this member (hierarchy/permissions).';
  }

  await finalisePanel(interaction, caseData, `${outcome}\nResolved by ${interaction.user} • Case ${caseData.caseId}`);

  const profile = await getWarningProfile(caseData.guildId, caseData.userId, member?.user.createdTimestamp ?? Date.now());
  await audit(interaction.guild, {
    action: `${action === 'ban' ? 'Ban' : 'Kick'} Executed (Approved)`,
    family: action,
    userTag: caseData.userTag,
    userId: caseData.userId,
    moderatorTag: interaction.user.tag,
    moderatorId: interaction.user.id,
    reason,
    oldWarningCount: profile.count,
    newWarningCount: profile.count,
    buttonPressed: `✅ Confirm ${action === 'ban' ? 'Ban' : 'Kick'}`,
    confirmationStatus: 'confirmed',
    channelId: interaction.channelId,
    messageLink: interaction.message.url,
  });
}

/** ❌ Cancel — abort a pending kick/ban (requester or owner override). */
async function cancelPending(interaction, caseData, sec) {
  if (caseData.state !== CASE_STATES.AWAITING_CONFIRMATION) {
    return interaction.reply({ content: 'ℹ️ Nothing is pending confirmation on this case.', flags: MessageFlags.Ephemeral });
  }

  const owner = isOwner(interaction.member, interaction.guild, sec);
  const isRequester = interaction.user.id === caseData.pendingAction?.moderatorId;
  if (!isRequester && !owner) {
    return interaction.reply({
      content: '🚫 Only the requesting moderator or the server owner can cancel this.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const pendingAction = caseData.pendingAction?.action ?? 'action';
  await cancelConfirmation(caseData.caseId);

  // Restore the original panel (case returns to OPEN).
  await interaction.update({
    embeds: [interaction.message.embeds[0]],
    components: panelButtons(caseData.caseId),
  });

  await audit(interaction.guild, {
    action: owner && !isRequester ? `Owner Override: ${pendingAction} Cancelled` : `Panel: ${pendingAction} Cancelled`,
    family: owner && !isRequester ? 'override' : 'cancel',
    userTag: caseData.userTag,
    userId: caseData.userId,
    moderatorTag: interaction.user.tag,
    moderatorId: interaction.user.id,
    buttonPressed: '❌ Cancel',
    confirmationStatus: 'cancelled',
    channelId: interaction.channelId,
    messageLink: interaction.message.url,
  });
}

/** Safe actions: ignore / reset / timeout / mute. */
async function resolveSafe(interaction, caseData, action, sec) {
  if (action === 'timeout' || action === 'mute') {
    if (!interaction.member.permissions.has(ACTION_PERMISSIONS[action]) && !isOwner(interaction.member, interaction.guild, sec)) {
      return interaction.reply({
        content: '🚫 You need the **Moderate Members** permission for this action.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  const resolved = await resolveCase(caseData.caseId, {
    action,
    moderatorId: interaction.user.id,
    moderatorTag: interaction.user.tag,
    note: action,
  });
  if (!resolved) {
    return interaction.reply({ content: 'ℹ️ This case was already resolved by another moderator.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferUpdate();

  const member = await interaction.guild.members.fetch(caseData.userId).catch(() => null);
  const oldCount = (await getWarningProfile(caseData.guildId, caseData.userId, member?.user.createdTimestamp ?? Date.now())).count;
  let newCount = oldCount;
  let outcome;

  if (action === 'ignore') {
    outcome = `✅ Case dismissed — no action taken against **${caseData.userTag}**.`;
  } else if (action === 'reset') {
    await clearWarnings(caseData.guildId, caseData.userId);
    newCount = 0;
    outcome = `⚠️ All warnings for **${caseData.userTag}** were reset (${oldCount} → 0).`;
  } else if (action === 'timeout' || action === 'mute') {
    const minutes = action === 'mute' ? Math.max(sec.timeoutMinutes * 2, 120) : sec.timeoutMinutes;
    if (!member) {
      outcome = '⚠️ Member is no longer in the server — no action taken.';
    } else if (!member.moderatable) {
      outcome = '❌ Bot cannot timeout this member (hierarchy/permissions).';
    } else {
      await member
        .timeout(minutes * 60 * 1000, `Moderation panel ${caseData.caseId} (${action}) by ${interaction.user.tag}`)
        .then(() => {
          outcome = `${action === 'mute' ? '🔇' : '🕒'} **${caseData.userTag}** was ${action === 'mute' ? 'muted' : 'timed out'} for **${minutes} minutes**.`;
        })
        .catch((e) => {
          outcome = `❌ Timeout failed: ${e.message}`;
        });
    }
  }

  await finalisePanel(interaction, caseData, `${outcome}\nResolved by ${interaction.user} • Case ${caseData.caseId}`);

  await audit(interaction.guild, {
    action: `Panel: ${action.charAt(0).toUpperCase() + action.slice(1)}`,
    family: action === 'ignore' ? 'ignore' : action === 'reset' ? 'reset' : action,
    userTag: caseData.userTag,
    userId: caseData.userId,
    moderatorTag: interaction.user.tag,
    moderatorId: interaction.user.id,
    reason: outcome,
    oldWarningCount: oldCount,
    newWarningCount: newCount,
    buttonPressed: action,
    confirmationStatus: 'n/a',
    channelId: interaction.channelId,
    messageLink: interaction.message.url,
  });
}

/** Replace the panel with a resolution summary and disable all buttons. */
async function finalisePanel(interaction, caseData, summary) {
  const resolvedEmbed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`✅ Case Resolved — ${caseData.caseId}`)
    .setDescription(summary)
    .setTimestamp();

  await interaction.message
    .edit({
      embeds: [interaction.message.embeds[0], resolvedEmbed],
      components: panelButtons(caseData.caseId, true), // disabled buttons
    })
    .catch(() => {});
}
