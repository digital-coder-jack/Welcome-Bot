/**
 * security/securityReport.js
 * ---------------------------------------------------------------------------
 * Security Report (Forge Guardian Security System v2.0).
 *
 * After every successful join, posts a rich scan report to the configured
 * report channel showing:
 *
 *   Scan Progress · Risk Score · Threat Level · Username Check ·
 *   Account Age Check · Avatar Check · Invite Check · AI Analysis ·
 *   Scam Detection · Role Assignment · Welcome DM Status ·
 *   Developer Intro Status · Forge Member Role Status · Telegram Status ·
 *   Database Status · Scan Time
 *
 * Entirely best-effort: a report failure never affects the welcome flow.
 * Disable with SECURITY_JOIN_REPORT_ENABLED=false.
 * ---------------------------------------------------------------------------
 */

import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getSettings } from '../database/settingsStore.js';
import { threatMeta } from './riskEngine.js';

const PASS = '✅';
const WARN = '⚠️';
const FAIL = '❌';

/** Render a 10-segment progress bar for the risk score. */
function riskBar(score) {
  const filled = Math.round((score / 100) * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

/**
 * Post the post-join Security Report embed.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {object} params
 * @param {import('./joinScan.js').JoinScanResult} params.scan
 * @param {{code:string, inviterTag:string}} params.invite
 * @param {string} params.assignedRole    Forge Member role name or 'None'
 * @param {string} params.dmStatus        welcome DM delivery status
 * @param {boolean} params.devIntroSent
 * @param {boolean} params.telegramSent
 * @param {boolean} params.databaseSaved
 * @returns {Promise<void>}
 */
export async function sendSecurityReport(member, params) {
  if (!config.security.joinReportEnabled) return;

  try {
    const settings = await getSettings(member.guild.id);
    const channelId =
      config.security.reportChannelId ||
      config.security.alertChannelId ||
      settings.security.alertChannelId ||
      config.channels.modAlert ||
      config.channels.log;
    if (!channelId) return;

    const channel = await member.guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) return;

    const { scan, invite } = params;
    const meta = threatMeta(scan.threatLevel);

    const identityClean = scan.identity?.clean !== false;
    const scamFindings = (scan.identity?.findings ?? []).filter((f) => /scam|fake/i.test(f));
    const account = scan.account;

    const usernameCheck = identityClean
      ? `${PASS} Clean`
      : `${WARN} ${scan.identity.findings.length} finding(s)`;
    const accountAgeCheck = account
      ? account.isNewAccount
        ? `${FAIL} New (${account.accountAgeDays}d)`
        : account.isRecentAccount
          ? `${WARN} Recent (${account.accountAgeDays}d)`
          : `${PASS} ${account.accountAgeHuman}`
      : `${WARN} Unavailable`;
    const avatarCheck = account
      ? account.hasDefaultAvatar
        ? `${WARN} Default avatar`
        : `${PASS} Custom avatar`
      : `${WARN} Unavailable`;
    const inviteCheck =
      invite?.code && invite.code !== 'Unknown'
        ? `${PASS} ${invite.code} (${invite.inviterTag})`
        : `${WARN} Unknown invite`;
    const aiCheck = scan.ai?.aiAvailable
      ? `${PASS} ${scan.ai.threatLevel} (${Math.round((scan.ai.confidence ?? 0) * 100)}%)`
      : `${WARN} Unavailable (local scan only)`;
    const scamCheck = scamFindings.length ? `${FAIL} ${scamFindings[0]}` : `${PASS} None detected`;

    const embed = new EmbedBuilder()
      .setColor(meta.color)
      .setTitle('🛡️ Security Report — Join Scan Complete')
      .setDescription(
        `**Member:** ${member} (${member.user.tag})\n` +
          `**Scan Progress:** \`[${riskBar(scan.riskScore)}]\` **100% complete**\n` +
          `**Risk Score:** **${scan.riskScore}/100** · **Threat Level:** ${meta.label}`
      )
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '👤 Username Check', value: usernameCheck, inline: true },
        { name: '📅 Account Age Check', value: accountAgeCheck, inline: true },
        { name: '🖼 Avatar Check', value: avatarCheck, inline: true },
        { name: '🔗 Invite Check', value: inviteCheck, inline: true },
        { name: '🤖 AI Analysis', value: aiCheck, inline: true },
        { name: '🎣 Scam Detection', value: scamCheck, inline: true },
        { name: '🎭 Role Assignment', value: params.assignedRole !== 'None' ? `${PASS} ${params.assignedRole}` : `${WARN} None`, inline: true },
        { name: '✉️ Welcome DM', value: params.dmStatus?.toLowerCase().includes('fail') ? `${WARN} ${params.dmStatus}` : `${PASS} ${params.dmStatus}`, inline: true },
        { name: '💬 Developer Intro', value: params.devIntroSent ? `${PASS} Sent` : `${WARN} Skipped`, inline: true },
        { name: '🔨 Forge Member Role', value: params.assignedRole !== 'None' ? `${PASS} Assigned` : `${WARN} Not assigned`, inline: true },
        { name: '📨 Telegram', value: params.telegramSent ? `${PASS} Notified` : `${WARN} Failed/Skipped`, inline: true },
        { name: '💾 Database', value: params.databaseSaved ? `${PASS} Saved` : `${WARN} Failed`, inline: true }
      )
      .setFooter({ text: `Scan time: ${scan.scanTimeMs}ms • Forge Guardian v2.0` })
      .setTimestamp();

    if (scan.reasons.length > 0) {
      embed.addFields({
        name: '📄 Risk Reasons',
        value: scan.reasons.slice(0, 8).map((r) => `• ${r}`).join('\n').slice(0, 1000),
      });
    }

    await channel.send({ embeds: [embed] });
  } catch (error) {
    logger.warn(`Security report failed: ${error.message}`);
  }
}
