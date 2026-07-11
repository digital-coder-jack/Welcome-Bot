/**
 * commands/security.js
 * ---------------------------------------------------------------------------
 * Phase 6 — /security — the complete Security Dashboard (Forge Guardian v2.0).
 *
 * Subcommands:
 *   dashboard   Full security dashboard (stats, statuses, rating).
 *   member      Permanent security profile of a member (Phase 7).
 *   server      Server-wide security overview.
 *   scan        On-demand security scan of a member.
 *   logs        Recent security event log.
 *   raid        Raid Mode status / manual control.
 *   lockdown    Activate manual lockdown.
 *   unlock      Lift manual lockdown.
 *   whitelist   Manage the security whitelist (users).
 *   blacklist   Manage blacklists (users / invites / servers).
 *   risk        Current server risk assessment.
 *   settings    Effective security settings.
 *   export      Export security data as a JSON file.
 *
 * Only data available from the Discord Bot API or generated internally by
 * this bot is ever shown. Requires Manage Guild.
 * ---------------------------------------------------------------------------
 */

import {
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../config.js';
import { getSettings } from '../database/settingsStore.js';
import { getStats, computeSecurityRating } from '../database/statsStore.js';
import { getProfile, listProfiles, updateProfile } from '../database/profileStore.js';
import { getSecurityHistory, getHistorySummary } from '../database/securityStore.js';
import { countWarnings } from '../database/warningStore.js';
import {
  addToBlacklist,
  removeFromBlacklist,
  addToWhitelist,
  removeFromWhitelist,
  getLists,
} from '../database/blacklistStore.js';
import { getRecentEvents, logSecurityEvent } from '../security/securityLogger.js';
import { isRaidModeActive, getRaidState, activateRaidMode, deactivateRaidMode } from '../security/raidManager.js';
import { isLockdownActive, getLockdownState, activateLockdown, deactivateLockdown } from '../security/lockdownManager.js';
import { analyzeIdentity } from '../security/identityAnalyzer.js';
import { analyzeAccount } from '../security/accountAnalyzer.js';
import { computeJoinRisk, classifyRisk, clamp, threatMeta } from '../security/riskEngine.js';
import { runAdvancedJoinChecks, computeReputation } from '../security/advancedProtection.js';
import { checkHealth } from '../services/aiClient.js';
import { accountAge, formatUTC } from '../utils/time.js';

export const data = new SlashCommandBuilder()
  .setName('security')
  .setDescription('Forge Guardian — Security Dashboard & tools.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('dashboard').setDescription('Show the full security dashboard.'))
  .addSubcommand((s) =>
    s
      .setName('member')
      .setDescription('Show the permanent security profile of a member.')
      .addUserOption((o) => o.setName('user').setDescription('Member to inspect').setRequired(true))
  )
  .addSubcommand((s) => s.setName('server').setDescription('Server-wide security overview.'))
  .addSubcommand((s) =>
    s
      .setName('scan')
      .setDescription('Run an on-demand security scan on a member.')
      .addUserOption((o) => o.setName('user').setDescription('Member to scan').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('logs')
      .setDescription('Show the recent security event log.')
      .addIntegerOption((o) => o.setName('count').setDescription('How many events (1-25)').setMinValue(1).setMaxValue(25))
  )
  .addSubcommand((s) =>
    s
      .setName('raid')
      .setDescription('Raid Mode status / manual control.')
      .addStringOption((o) =>
        o
          .setName('action')
          .setDescription('status / activate / deactivate')
          .addChoices(
            { name: 'status', value: 'status' },
            { name: 'activate', value: 'activate' },
            { name: 'deactivate', value: 'deactivate' }
          )
      )
  )
  .addSubcommand((s) =>
    s
      .setName('lockdown')
      .setDescription('Lock the server (manual lockdown, stays until /security unlock).')
      .addStringOption((o) => o.setName('reason').setDescription('Reason for the lockdown'))
  )
  .addSubcommand((s) => s.setName('unlock').setDescription('Lift the manual lockdown.'))
  .addSubcommand((s) =>
    s
      .setName('whitelist')
      .setDescription('Manage the security whitelist (bypasses live security).')
      .addStringOption((o) =>
        o
          .setName('action')
          .setDescription('add / remove / view')
          .setRequired(true)
          .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'view', value: 'view' })
      )
      .addUserOption((o) => o.setName('user').setDescription('User to add/remove'))
      .addStringOption((o) => o.setName('reason').setDescription('Why (for add)'))
  )
  .addSubcommand((s) =>
    s
      .setName('blacklist')
      .setDescription('Manage blacklists (users / invites / servers).')
      .addStringOption((o) =>
        o
          .setName('action')
          .setDescription('add / remove / view')
          .setRequired(true)
          .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'view', value: 'view' })
      )
      .addStringOption((o) =>
        o
          .setName('type')
          .setDescription('users / invites / servers')
          .addChoices({ name: 'users', value: 'users' }, { name: 'invites', value: 'invites' }, { name: 'servers', value: 'servers' })
      )
      .addStringOption((o) => o.setName('value').setDescription('User ID / invite code or URL / server ID'))
      .addStringOption((o) => o.setName('reason').setDescription('Why (for add)'))
  )
  .addSubcommand((s) => s.setName('risk').setDescription('Current server risk assessment.'))
  .addSubcommand((s) => s.setName('settings').setDescription('Show the effective security settings.'))
  .addSubcommand((s) => s.setName('export').setDescription('Export security data as a JSON file.'));

/** Format a nullable value for embeds. */
const v = (x, fallback = '—') => (x === null || x === undefined || x === '' ? fallback : String(x));
/** Yes/No. */
const yn = (b) => (b ? '✅ Yes' : '—');

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'dashboard': return dashboard(interaction);
    case 'member': return memberProfile(interaction);
    case 'server': return serverOverview(interaction);
    case 'scan': return scanMember(interaction);
    case 'logs': return showLogs(interaction);
    case 'raid': return raidControl(interaction);
    case 'lockdown': return lockdown(interaction);
    case 'unlock': return unlock(interaction);
    case 'whitelist': return whitelist(interaction);
    case 'blacklist': return blacklist(interaction);
    case 'risk': return riskView(interaction);
    case 'settings': return settingsView(interaction);
    case 'export': return exportData(interaction);
    default:
      return interaction.reply({ content: 'Unknown subcommand.', flags: MessageFlags.Ephemeral });
  }
}

/* ------------------------------------------------------------------ */
/*  /security dashboard                                                */
/* ------------------------------------------------------------------ */

async function dashboard(interaction) {
  await interaction.deferReply();
  const guild = interaction.guild;

  const [stats, aiHealthy] = await Promise.all([getStats(guild.id), checkHealth()]);
  const raidActive = isRaidModeActive(guild.id);
  const lockActive = isLockdownActive(guild.id);
  const rating = computeSecurityRating(stats, { raidActive, lockdownActive: lockActive, aiHealthy });

  // Current risk: worst of the live states.
  let currentRisk = '🟢 LOW';
  if (raidActive) currentRisk = '🔴 CRITICAL (Raid Mode active)';
  else if (lockActive) currentRisk = '🟠 ELEVATED (Lockdown active)';
  else if ((stats.today.threatsBlocked ?? 0) + (stats.today.scamAttempts ?? 0) >= 3) currentRisk = '🟡 MEDIUM (active threats today)';

  const uptimeSec = Math.floor((interaction.client.uptime ?? 0) / 1000);
  const t = stats.totals;

  const embed = new EmbedBuilder()
    .setColor(rating.score >= 70 ? 0x57f287 : rating.score >= 40 ? 0xfee75c : 0xed4245)
    .setTitle('🛡️ Forge Guardian — Security Dashboard')
    .setDescription(`Real-time security overview for **${guild.name}**.`)
    .addFields(
      { name: '👥 Protected Members', value: `${guild.memberCount}`, inline: true },
      { name: '🚫 Threats Blocked', value: `${t.threatsBlocked}`, inline: true },
      { name: '🧹 Spam Blocked', value: `${t.spamBlocked}`, inline: true },
      { name: '⚠️ Warnings Today', value: `${stats.today.warnings ?? 0}`, inline: true },
      { name: '⚠️ Total Warnings', value: `${t.warnings}`, inline: true },
      { name: '🕒 Timeouts', value: `${t.timeouts}`, inline: true },
      { name: '👢 Kicks', value: `${t.kicks}`, inline: true },
      { name: '🔨 Bans', value: `${t.bans}`, inline: true },
      { name: '🎣 Scam Attempts', value: `${t.scamAttempts}`, inline: true },
      { name: '🌊 Raid Attempts', value: `${t.raidAttempts}`, inline: true },
      { name: '📈 Current Risk', value: currentRisk, inline: true },
      { name: '🤖 AI Status', value: aiHealthy ? '🟢 Online' : '🔴 Offline (local filters active)', inline: true },
      { name: '📨 Telegram Status', value: aiHealthy ? '🟢 Backend reachable' : '🔴 Backend unreachable', inline: true },
      { name: '💾 Database Status', value: '🟢 Online (local JSON stores)', inline: true },
      { name: '🤖 Bot Status', value: `🟢 Online — up ${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`, inline: true },
      { name: '⏱️ Average Scan Time', value: stats.avgScanMs !== null ? `${stats.avgScanMs} ms (${stats.scanSamples} scans)` : 'No scans yet', inline: true },
      { name: '🏆 Server Security Rating', value: `**${rating.grade}** — ${rating.score}/100 ${rating.label}`, inline: true }
    )
    .setFooter({ text: 'Forge Guardian v2.0 • /security <subcommand> for tools' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

/* ------------------------------------------------------------------ */
/*  /security member                                                   */
/* ------------------------------------------------------------------ */

async function memberProfile(interaction) {
  await interaction.deferReply();
  const guild = interaction.guild;
  const user = interaction.options.getUser('user', true);
  const member = await guild.members.fetch(user.id).catch(() => null);

  const [profile, history, warningCount] = await Promise.all([
    getProfile(guild.id, user.id),
    getSecurityHistory(guild.id, user.id),
    countWarnings(guild.id, user.id),
  ]);

  // Live-refresh identity data when the member is present (Bot API only).
  let badges = profile.identity.badges ?? [];
  let bannerUrl = profile.identity.bannerUrl;
  let accentColor = profile.identity.accentColor;
  let publicFlags = profile.identity.publicFlags ?? 0;
  if (member) {
    try {
      const full = await member.user.fetch(true);
      bannerUrl = full.bannerURL?.({ extension: 'png', size: 512 }) ?? bannerUrl;
      accentColor = full.hexAccentColor ?? accentColor;
      const flags = full.flags ?? member.user.flags;
      if (flags) {
        publicFlags = flags.bitfield ?? publicFlags;
        badges = flags.toArray();
      }
    } catch { /* best-effort */ }
  }

  const reputation = computeReputation(profile);
  await updateProfile(guild.id, user.id, { security: { reputation } });

  const meta = threatMeta(profile.security.threatLevel);
  const roles = member
    ? member.roles.cache.filter((r) => r.id !== guild.id).map((r) => `<@&${r.id}>`).slice(0, 10).join(' ') || 'None'
    : (profile.server.roles ?? []).map((r) => r.name).join(', ') || 'None';
  const highestRole = member
    ? (member.roles.highest.id !== guild.id ? member.roles.highest.name : 'None')
    : v(profile.server.highestRole, 'None');

  const identityLines = [
    `**Username:** ${v(member?.user.username ?? profile.identity.username)}`,
    `**Display Name:** ${v(member?.displayName ?? profile.identity.displayName)}`,
    `**Nickname:** ${v(member?.nickname ?? profile.identity.nickname, 'None')}`,
    `**User ID:** \`${user.id}\``,
    `**Bot/Human:** ${(member?.user.bot ?? profile.identity.isBot) ? 'Bot' : 'Human'}`,
    `**Accent Color:** ${v(accentColor, 'Unknown')}`,
    `**Public Flags:** ${publicFlags}`,
    `**Badges:** ${badges.length > 0 ? badges.join(', ') : 'None'}`,
  ].join('\n');

  const created = member?.user.createdTimestamp ?? (profile.account.accountCreated ? Date.parse(profile.account.accountCreated) : null);
  const accountLines = [
    `**Account Created:** ${created ? formatUTC(created) : 'Unknown'}`,
    `**Account Age:** ${created ? accountAge(created) : 'Unknown'}`,
    `**Joined Server:** ${member?.joinedTimestamp ? formatUTC(member.joinedTimestamp) : v(profile.account.joinedServer && formatUTC(Date.parse(profile.account.joinedServer)), 'Unknown')}`,
    `**Member Number:** ${v(profile.account.memberNumber, 'Unknown')}`,
  ].join('\n');

  const serverLines = [
    `**Highest Role:** ${highestRole}`,
    `**Roles:** ${roles}`,
    `**Invite Used:** ${v(profile.server.inviteUsed)}`,
    `**Inviter:** ${v(profile.server.inviter)}`,
    `**Verification:** ${v(profile.server.verificationStatus)}`,
    `**Forge Member:** ${v(profile.server.forgeMemberStatus)}`,
    `**Dev Intro:** ${v(profile.server.devIntroStatus)}`,
    `**Welcome DM:** ${v(profile.server.welcomeDmStatus)}`,
  ].join('\n');

  const m = profile.moderation;
  const moderationLines = [
    `**Warnings:** ${Math.max(warningCount, m.warnings)}`,
    `**Timeouts:** ${history.timeouts.length}`,
    `**Kicks:** ${history.kicks.length}`,
    `**Bans:** ${history.bans.length}`,
    `**Deleted Messages:** ${m.deletedMessages}`,
    `**AI Violations:** ${m.aiViolations}`,
  ].join('\n');

  const s = profile.security;
  const securityLines = [
    `**Risk Score:** ${s.riskScore}/100`,
    `**Threat Level:** ${meta.label}`,
    `**Scam Detections:** ${s.scamDetections}`,
    `**Suspicious Username:** ${yn(s.suspiciousUsername)}`,
    `**Suspicious Avatar:** ${yn(s.suspiciousAvatar)}`,
    `**Previous Joins:** ${history.joins.length}`,
    `**Previous Leaves:** ${history.leaves.length}`,
    `**Rejoin Count:** ${history.rejoinCount ?? 0}`,
    `**Reputation (in-server):** ${reputation}/100`,
  ].join('\n');

  const a = profile.activity;
  const activityLines = [
    `**Messages:** ${a.messageCount}`,
    `**Voice Minutes:** ${a.voiceMinutes}`,
    `**Attachments Sent:** ${a.attachmentsSent}`,
    `**Links Shared:** ${a.linksShared}`,
    `**Last Seen:** ${a.lastSeen ? formatUTC(Date.parse(a.lastSeen)) : 'Unknown'}`,
  ].join('\n');

  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`🗂️ Security Profile — ${user.tag}`)
    .setThumbnail(user.displayAvatarURL({ extension: 'png', size: 256 }))
    .addFields(
      { name: '🪪 Identity', value: identityLines, inline: false },
      { name: '📅 Account', value: accountLines, inline: true },
      { name: '🏰 Server', value: serverLines, inline: true },
      { name: '⚖️ Moderation', value: moderationLines, inline: true },
      { name: '🛡️ Security', value: securityLines, inline: true },
      { name: '📊 Activity', value: activityLines, inline: true }
    )
    .setFooter({ text: 'Only Bot-API data & internal records are stored. Nothing else is collected.' })
    .setTimestamp();
  if (bannerUrl) embed.setImage(bannerUrl);

  return interaction.editReply({ embeds: [embed] });
}

/* ------------------------------------------------------------------ */
/*  /security server                                                   */
/* ------------------------------------------------------------------ */

async function serverOverview(interaction) {
  await interaction.deferReply();
  const guild = interaction.guild;
  const stats = await getStats(guild.id);
  const profiles = await listProfiles(guild.id);
  const lists = await getLists(guild.id);

  const highRisk = profiles.filter((p) => (p.security?.riskScore ?? 0) >= 61).length;
  const tracked = profiles.length;
  const bots = guild.members.cache.filter((mm) => mm.user.bot).size;

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`🏰 Server Security Overview — ${guild.name}`)
    .setThumbnail(guild.iconURL({ extension: 'png', size: 256 }) ?? null)
    .addFields(
      { name: '👥 Members', value: `${guild.memberCount}`, inline: true },
      { name: '🤖 Bots (cached)', value: `${bots}`, inline: true },
      { name: '🗂️ Tracked Profiles', value: `${tracked}`, inline: true },
      { name: '🔴 High-Risk Profiles', value: `${highRisk}`, inline: true },
      { name: '📥 Joins Today', value: `${stats.today.joins ?? 0}`, inline: true },
      { name: '📤 Leaves Today', value: `${stats.today.leaves ?? 0}`, inline: true },
      { name: '⛔ Blacklisted Users', value: `${lists.blacklist.users.length}`, inline: true },
      { name: '⛔ Blacklisted Invites', value: `${lists.blacklist.invites.length}`, inline: true },
      { name: '⛔ Blacklisted Servers', value: `${lists.blacklist.servers.length}`, inline: true },
      { name: '✅ Whitelisted Users', value: `${lists.whitelist.users.length}`, inline: true },
      { name: '🌊 Raid Mode', value: isRaidModeActive(guild.id) ? '🔴 ACTIVE' : '🟢 Inactive', inline: true },
      { name: '🔒 Lockdown', value: isLockdownActive(guild.id) ? '🔴 ACTIVE' : '🟢 Inactive', inline: true },
      { name: '🛡️ Verification Level', value: String(guild.verificationLevel), inline: true },
      { name: '📅 Server Created', value: formatUTC(guild.createdTimestamp), inline: true },
      { name: '👑 Owner', value: `<@${guild.ownerId}>`, inline: true }
    )
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

/* ------------------------------------------------------------------ */
/*  /security scan                                                     */
/* ------------------------------------------------------------------ */

async function scanMember(interaction) {
  await interaction.deferReply();
  const guild = interaction.guild;
  const user = interaction.options.getUser('user', true);
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    return interaction.editReply({ content: '❌ That user is not a member of this server.' });
  }

  const started = Date.now();
  const identity = analyzeIdentity(member);
  const account = await analyzeAccount(member);
  const history = await getHistorySummary(guild.id, user.id);
  const profile = await getProfile(guild.id, user.id);
  const invite = { code: profile.server.inviteUsed ?? 'Unknown', inviterTag: profile.server.inviter ?? 'Unknown', unknown: true };

  const local = computeJoinRisk({ identity, account, invite, history });
  const advanced = await runAdvancedJoinChecks(member, { code: invite.code, inviterTag: invite.inviterTag });
  const score = clamp(local.score + advanced.score);
  const threatLevel = classifyRisk(score);
  const meta = threatMeta(threatLevel);
  const reasons = [...local.reasons, ...advanced.findings];
  const ms = Date.now() - started;

  await updateProfile(guild.id, user.id, {
    security: {
      riskScore: score,
      threatLevel,
      suspiciousUsername: identity.findings.length > 0,
      suspiciousAvatar: Boolean(account?.hasDefaultAvatar),
    },
  });
  await logSecurityEvent(guild, {
    type: 'MANUAL_SCAN',
    severity: score >= 61 ? 'high' : 'info',
    summary: `Manual scan of ${user.tag}: ${score}/100 (${threatLevel})`,
    userTag: user.tag,
    userId: user.id,
  });

  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`🔎 Security Scan — ${user.tag}`)
    .setThumbnail(user.displayAvatarURL({ extension: 'png', size: 256 }))
    .addFields(
      { name: '📈 Risk Score', value: `**${score}/100**`, inline: true },
      { name: '🚨 Threat Level', value: meta.label, inline: true },
      { name: '⏱️ Scan Time', value: `${ms} ms`, inline: true },
      { name: '📅 Account Age', value: account?.accountAgeHuman ?? 'Unknown', inline: true },
      { name: '🖼️ Default Avatar', value: yn(account?.hasDefaultAvatar), inline: true },
      { name: '🔁 Rejoin Count', value: `${history.rejoinCount ?? 0}`, inline: true },
      {
        name: '🧾 Findings',
        value: reasons.length > 0 ? reasons.slice(0, 12).map((r) => `• ${r}`).join('\n').slice(0, 1024) : '✅ No suspicious signals found.',
      }
    )
    .setFooter({ text: 'Heuristics use Bot-API data & internal records only.' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

/* ------------------------------------------------------------------ */
/*  /security logs                                                     */
/* ------------------------------------------------------------------ */

async function showLogs(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const count = interaction.options.getInteger('count') ?? 10;
  const events = await getRecentEvents(interaction.guild.id, count);

  if (events.length === 0) {
    return interaction.editReply({ content: '📜 No security events recorded yet.' });
  }

  const icons = { info: 'ℹ️', low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };
  const lines = events.map((e) => {
    const ts = Math.floor(Date.parse(e.at) / 1000);
    const who = e.userTag ? ` — ${e.userTag}` : '';
    return `${icons[e.severity] ?? 'ℹ️'} <t:${ts}:R> **${e.type}**${who}\n   ${e.summary}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`📜 Security Log — last ${events.length} event(s)`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: 'Rolling log (newest first, max 200 kept per server).' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

/* ------------------------------------------------------------------ */
/*  /security raid                                                     */
/* ------------------------------------------------------------------ */

async function raidControl(interaction) {
  const action = interaction.options.getString('action') ?? 'status';
  const guild = interaction.guild;

  if (action === 'activate') {
    if (isRaidModeActive(guild.id)) {
      return interaction.reply({ content: 'ℹ️ Raid Mode is already active.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply();
    await activateRaidMode(guild, { joinCount: 0, windowSec: 0, latest: null });
    await logSecurityEvent(guild, {
      type: 'RAID_MODE',
      severity: 'critical',
      summary: `Raid Mode manually activated by ${interaction.user.tag}`,
    });
    return interaction.editReply({ content: '🚨 **Raid Mode manually activated.** Welcomes paused, channels locked/slowmoded.' });
  }

  if (action === 'deactivate') {
    if (!isRaidModeActive(guild.id)) {
      return interaction.reply({ content: 'ℹ️ Raid Mode is not active.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply();
    await deactivateRaidMode(guild);
    await logSecurityEvent(guild, {
      type: 'RAID_MODE',
      severity: 'low',
      summary: `Raid Mode manually deactivated by ${interaction.user.tag}`,
    });
    return interaction.editReply({ content: '✅ **Raid Mode deactivated.** Channels restored, welcomes resumed.' });
  }

  // status
  const state = getRaidState(guild.id);
  const embed = new EmbedBuilder()
    .setColor(state ? 0xed4245 : 0x57f287)
    .setTitle('🌊 Raid Mode Status')
    .setDescription(
      state
        ? `🔴 **ACTIVE** since <t:${Math.floor(state.activatedAt / 1000)}:R>\nAuto-disables <t:${Math.floor(state.expiresAt / 1000)}:R>.`
        : '🟢 **Inactive.** Automatic detection is ' +
          (config.security.antiRaidEnabled
            ? `armed (${config.security.raidJoinThreshold} joins / ${config.security.raidWindowSec}s).`
            : 'disabled via SECURITY_ANTI_RAID_ENABLED.')
    )
    .setTimestamp();
  return interaction.reply({ embeds: [embed] });
}

/* ------------------------------------------------------------------ */
/*  /security lockdown & unlock                                        */
/* ------------------------------------------------------------------ */

async function lockdown(interaction) {
  await interaction.deferReply();
  const reason = interaction.options.getString('reason') ?? 'Manual lockdown';
  const result = await activateLockdown(interaction.guild, { by: interaction.user.tag, reason });
  if (result.ok) {
    await logSecurityEvent(interaction.guild, {
      type: 'LOCKDOWN',
      severity: 'high',
      summary: `Lockdown activated by ${interaction.user.tag}: ${reason} (${result.lockedCount} channel(s))`,
    });
  }
  return interaction.editReply({
    content: result.ok
      ? `🔒 **Server lockdown active.** ${result.lockedCount} channel(s) locked. Welcomes paused. Use \`/security unlock\` to lift it.`
      : `ℹ️ ${result.message}`,
  });
}

async function unlock(interaction) {
  await interaction.deferReply();
  const result = await deactivateLockdown(interaction.guild);
  if (result.ok) {
    await logSecurityEvent(interaction.guild, {
      type: 'LOCKDOWN',
      severity: 'low',
      summary: `Lockdown lifted by ${interaction.user.tag} (${result.unlockedCount} channel(s) unlocked)`,
    });
  }
  return interaction.editReply({
    content: result.ok ? `🔓 **Lockdown lifted.** ${result.unlockedCount} channel(s) unlocked.` : `ℹ️ ${result.message}`,
  });
}

/* ------------------------------------------------------------------ */
/*  /security whitelist & blacklist                                    */
/* ------------------------------------------------------------------ */

async function whitelist(interaction) {
  const action = interaction.options.getString('action', true);
  const guildId = interaction.guild.id;

  if (action === 'view') {
    const lists = await getLists(guildId);
    const users = lists.whitelist.users;
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(`✅ Security Whitelist (${users.length})`)
      .setDescription(
        users.length > 0
          ? users.slice(0, 25).map((e) => `• <@${e.id}> — ${e.reason || 'no reason'} *(by ${e.addedBy})*`).join('\n').slice(0, 4000)
          : '*Empty. Whitelisted users bypass live-security detectors.*'
      );
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  const user = interaction.options.getUser('user');
  if (!user) return interaction.reply({ content: '❌ Provide a `user` for add/remove.', flags: MessageFlags.Ephemeral });

  const result =
    action === 'add'
      ? await addToWhitelist(guildId, user.id, interaction.options.getString('reason') ?? '', interaction.user.tag)
      : await removeFromWhitelist(guildId, user.id);

  if (result.ok) {
    await logSecurityEvent(interaction.guild, {
      type: 'WHITELIST',
      severity: 'info',
      summary: `${interaction.user.tag} ${action === 'add' ? 'added' : 'removed'} ${user.tag} ${action === 'add' ? 'to' : 'from'} the whitelist`,
      userTag: user.tag,
      userId: user.id,
    });
  }
  return interaction.reply({ content: `${result.ok ? '✅' : 'ℹ️'} ${result.message}`, flags: MessageFlags.Ephemeral });
}

async function blacklist(interaction) {
  const action = interaction.options.getString('action', true);
  const guildId = interaction.guild.id;

  if (action === 'view') {
    const lists = await getLists(guildId);
    const fmt = (arr, field) =>
      arr.length > 0
        ? arr.slice(0, 15).map((e) => `• \`${e[field]}\` — ${e.reason || 'no reason'}`).join('\n').slice(0, 1024)
        : '*Empty*';
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('⛔ Security Blacklists')
      .addFields(
        { name: `👤 Users (${lists.blacklist.users.length})`, value: fmt(lists.blacklist.users, 'id') },
        { name: `🔗 Invites (${lists.blacklist.invites.length})`, value: fmt(lists.blacklist.invites, 'code') },
        { name: `🏰 Servers (${lists.blacklist.servers.length})`, value: fmt(lists.blacklist.servers, 'id') }
      )
      .setFooter({ text: 'This server\'s own lists — never sourced externally.' });
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  const type = interaction.options.getString('type');
  const value = interaction.options.getString('value');
  if (!type || !value) {
    return interaction.reply({ content: '❌ Provide both `type` and `value` for add/remove.', flags: MessageFlags.Ephemeral });
  }

  const result =
    action === 'add'
      ? await addToBlacklist(guildId, type, value, interaction.options.getString('reason') ?? '', interaction.user.tag)
      : await removeFromBlacklist(guildId, type, value);

  if (result.ok) {
    await logSecurityEvent(interaction.guild, {
      type: 'BLACKLIST',
      severity: 'medium',
      summary: `${interaction.user.tag} ${action === 'add' ? 'added' : 'removed'} \`${value}\` (${type}) ${action === 'add' ? 'to' : 'from'} the blacklist`,
    });
  }
  return interaction.reply({ content: `${result.ok ? '✅' : 'ℹ️'} ${result.message}`, flags: MessageFlags.Ephemeral });
}

/* ------------------------------------------------------------------ */
/*  /security risk                                                     */
/* ------------------------------------------------------------------ */

async function riskView(interaction) {
  await interaction.deferReply();
  const guild = interaction.guild;
  const stats = await getStats(guild.id);
  const raidActive = isRaidModeActive(guild.id);
  const lockActive = isLockdownActive(guild.id);
  const aiHealthy = await checkHealth();
  const rating = computeSecurityRating(stats, { raidActive, lockdownActive: lockActive, aiHealthy });

  const factors = [];
  if (raidActive) factors.push('🔴 Raid Mode is ACTIVE');
  if (lockActive) factors.push('🟠 Manual lockdown is active');
  if ((stats.today.threatsBlocked ?? 0) > 0) factors.push(`🟡 ${stats.today.threatsBlocked} threat(s) blocked today`);
  if ((stats.today.scamAttempts ?? 0) > 0) factors.push(`🟡 ${stats.today.scamAttempts} scam attempt(s) today`);
  if ((stats.today.warnings ?? 0) > 0) factors.push(`🟡 ${stats.today.warnings} warning(s) issued today`);
  if (!aiHealthy) factors.push('🟠 AI backend unreachable (local filters remain active)');
  if (factors.length === 0) factors.push('🟢 No active risk factors detected');

  const embed = new EmbedBuilder()
    .setColor(rating.score >= 70 ? 0x57f287 : rating.score >= 40 ? 0xfee75c : 0xed4245)
    .setTitle('📈 Server Risk Assessment')
    .addFields(
      { name: '🏆 Security Rating', value: `**${rating.grade}** — ${rating.score}/100 ${rating.label}`, inline: false },
      { name: '🧾 Active Risk Factors', value: factors.map((f) => `• ${f}`).join('\n') }
    )
    .setTimestamp();
  return interaction.editReply({ embeds: [embed] });
}

/* ------------------------------------------------------------------ */
/*  /security settings                                                 */
/* ------------------------------------------------------------------ */

async function settingsView(interaction) {
  const { security } = await getSettings(interaction.guild.id);
  const sc = config.security;
  const ch = (id) => (id ? `<#${id}>` : '*not set*');

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('⚙️ Security Settings (effective)')
    .addFields(
      {
        name: '🔀 Master Switches',
        value:
          `Join Scan: ${sc.joinScanEnabled ? '🟢 on' : '🔴 off'} • Live Scan: ${sc.liveScanEnabled ? '🟢 on' : '🔴 off'}\n` +
          `Anti-Raid: ${sc.antiRaidEnabled ? '🟢 on' : '🔴 off'} • AI Analysis: ${sc.aiAnalysisEnabled ? '🟢 on' : '🔴 off'}`,
      },
      {
        name: '🌊 Anti-Raid',
        value: `Trigger: ${sc.raidJoinThreshold} joins / ${sc.raidWindowSec}s • Raid Mode: ${sc.raidModeMinutes} min • Slowmode: ${sc.raidSlowmodeSec}s`,
      },
      {
        name: '⚖️ Thresholds',
        value: `Approval alert at risk ≥ ${sc.approvalThreshold} • Warn threshold: ${security.warnThreshold} • Timeout: ${security.timeoutMinutes} min\nNew account: < ${sc.newAccountDays}d • Recent account: < ${sc.recentAccountDays}d`,
      },
      {
        name: '📡 Channels (all optional)',
        value:
          `Alerts: ${ch(security.alertChannelId || sc.alertChannelId || config.channels.modAlert)}\n` +
          `Security Log: ${ch(config.channels.securityLog)} • AI Analysis: ${ch(config.channels.aiAnalysis)}\n` +
          `Dashboard: ${ch(config.channels.securityDashboard)} • Reports: ${ch(sc.reportChannelId)}\n` +
          `Welcome: ${ch(config.channels.welcome)} • Rules: ${ch(config.channels.rules)}\n` +
          `Dev Intro: ${ch(config.channels.devIntro)} • Support: ${ch(config.channels.support)}`,
      },
      {
        name: '🛡️ Policy',
        value: 'The bot **never kicks or bans automatically** — HIGH/CRITICAL verdicts raise an Owner Approval panel; a human always decides.',
      }
    )
    .setFooter({ text: 'Tune via environment variables & /securityconfig.' });
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/* ------------------------------------------------------------------ */
/*  /security export                                                   */
/* ------------------------------------------------------------------ */

async function exportData(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;

  const [stats, profiles, lists, events] = await Promise.all([
    getStats(guild.id),
    listProfiles(guild.id),
    getLists(guild.id),
    getRecentEvents(guild.id, 200),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    guild: { id: guild.id, name: guild.name, memberCount: guild.memberCount },
    note: 'Contains only Discord Bot API data and internally generated records.',
    statistics: stats,
    memberProfiles: profiles,
    lists,
    recentEvents: events,
  };

  const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  const file = new AttachmentBuilder(buffer, {
    name: `security-export-${guild.id}-${new Date().toISOString().slice(0, 10)}.json`,
  });

  await logSecurityEvent(guild, {
    type: 'EXPORT',
    severity: 'info',
    summary: `Security data exported by ${interaction.user.tag} (${profiles.length} profiles, ${events.length} events)`,
  });

  return interaction.editReply({
    content: `📦 Security export ready — ${profiles.length} profile(s), ${events.length} event(s).`,
    files: [file],
  });
}
