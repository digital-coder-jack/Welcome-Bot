/**
 * security/joinScan.js
 * ---------------------------------------------------------------------------
 * Phase 1 — Join Security Scan orchestrator (Forge Guardian v2.0).
 *
 * Whenever a member joins, performs the complete security scan:
 *
 *   1. Identity Analysis   (identityAnalyzer — names, unicode, homoglyphs,
 *                           scam keywords, fake staff/mod/admin/employee)
 *   2. Account Analysis    (accountAnalyzer — age, new-account, avatar,
 *                           banner, accent color, decoration, badges, flags)
 *   3. Invite Tracking     (invite info passed in from guildMemberAdd)
 *   4. Previous History    (securityStore — joins/leaves/warnings/timeouts/
 *                           kicks/bans/risk scores/rejoin count)
 *   5. AI Join Analysis    (FastAPI + Groq — risk score, threat level,
 *                           confidence, reasons, recommended action)
 *   6. Risk classification (riskEngine — 0–100 → SAFE…CRITICAL)
 *   7. HIGH/CRITICAL       → Owner Approval Security Alert + Telegram
 *
 * The scan result feeds the post-join Security Report (securityReport.js).
 * Fail-safe: every step is independently guarded; a scan failure never
 * disrupts the welcome flow.
 * ---------------------------------------------------------------------------
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { analyzeIdentity } from './identityAnalyzer.js';
import { analyzeAccount } from './accountAnalyzer.js';
import { computeJoinRisk, combineScores, classifyRisk } from './riskEngine.js';
import { analyzeJoin } from '../services/aiClient.js';
import { notifyHighRiskJoin } from '../services/telegramClient.js';
import { getHistorySummary, recordJoin, recordRiskScore } from '../database/securityStore.js';
import { raiseSecurityAlert } from './securityAlerts.js';
import { runAdvancedJoinChecks } from './advancedProtection.js';
import { recordScanTime, incrementStat } from '../database/statsStore.js';
import { updateProfile } from '../database/profileStore.js';
import { logSecurityEvent } from './securityLogger.js';

/**
 * @typedef {Object} JoinScanResult
 * @property {number} riskScore
 * @property {'SAFE'|'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'} threatLevel
 * @property {string[]} reasons
 * @property {object} identity
 * @property {object} account
 * @property {object} history
 * @property {object|null} ai
 * @property {boolean} alertRaised
 * @property {number} scanTimeMs
 */

/** Neutral result used when the scan is disabled or fails hard. */
function safeResult(scanTimeMs = 0) {
  return {
    riskScore: 0,
    threatLevel: 'SAFE',
    reasons: [],
    identity: { findings: [], score: 0, clean: true, names: [] },
    account: null,
    history: null,
    ai: null,
    alertRaised: false,
    scanTimeMs,
  };
}

/**
 * Run the complete join security scan for a member.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {{code:string, inviterTag:string, url:string}} invite  resolved invite.
 * @returns {Promise<JoinScanResult>}
 */
export async function runJoinScan(member, invite) {
  const started = Date.now();
  if (!config.security.joinScanEnabled) return safeResult();

  const result = safeResult();

  try {
    // --- 1. Identity Analysis ---
    try {
      result.identity = analyzeIdentity(member);
    } catch (error) {
      logger.warn(`Join scan: identity analysis failed: ${error.message}`);
    }

    // --- 2. Account Analysis (includes best-effort profile enrichment) ---
    try {
      result.account = await analyzeAccount(member);
    } catch (error) {
      logger.warn(`Join scan: account analysis failed: ${error.message}`);
    }

    // --- 3/4. Invite + Previous History ---
    const inviteInfo = {
      code: invite?.code ?? 'Unknown',
      inviterTag: invite?.inviterTag ?? 'Unknown',
      unknown: !invite || invite.code === 'Unknown',
      vanity: invite?.inviterTag === 'Vanity URL',
    };

    try {
      result.history = await getHistorySummary(member.guild.id, member.id);
    } catch (error) {
      logger.warn(`Join scan: history lookup failed: ${error.message}`);
    }

    // --- 6a. Local risk score ---
    const local = computeJoinRisk({
      identity: result.identity,
      account: result.account,
      invite: inviteInfo,
      history: result.history,
    });
    result.reasons = local.reasons;

    // --- Phase 8: Advanced Protection heuristics (alts, invite farming,
    //             fake staff/employee, mass creation, rejoin abuse,
    //             own blacklists). Heuristics only — Bot-API data + internal
    //             records; adds to the local score before the AI merge. ---
    let advancedScore = 0;
    try {
      const advanced = await runAdvancedJoinChecks(member, inviteInfo);
      advancedScore = advanced.score;
      for (const f of advanced.findings) {
        if (!result.reasons.includes(f)) result.reasons.push(f);
      }
    } catch (error) {
      logger.warn(`Join scan: advanced protection failed: ${error.message}`);
    }
    const localScore = Math.min(100, local.score + advancedScore);

    // --- 5. AI Join Analysis (Groq via FastAPI; fails open) ---
    if (config.security.aiAnalysisEnabled) {
      try {
        result.ai = await analyzeJoin({
          username: member.user.username,
          display_name: member.user.globalName ?? '',
          nickname: member.nickname ?? '',
          user_id: member.id,
          server_name: member.guild.name,
          account_age_days: result.account?.accountAgeDays ?? 0,
          is_new_account: result.account?.isNewAccount ?? false,
          has_default_avatar: result.account?.hasDefaultAvatar ?? false,
          is_bot: member.user.bot,
          badges: result.account?.badges ?? [],
          invite_code: inviteInfo.code,
          inviter: inviteInfo.inviterTag,
          identity_findings: result.identity.findings,
          local_risk_score: Math.min(100, local.score + advancedScore),
          previous_joins: result.history?.previousJoins ?? 0,
          previous_warnings: result.history?.previousWarnings ?? 0,
          previous_kicks: result.history?.previousKicks ?? 0,
          previous_bans: result.history?.previousBans ?? 0,
          rejoin_count: result.history?.rejoinCount ?? 0,
        });
        if (result.ai?.aiAvailable && Array.isArray(result.ai.reasons)) {
          for (const r of result.ai.reasons) {
            if (r && !result.reasons.includes(r)) result.reasons.push(`AI: ${r}`);
          }
        }
      } catch (error) {
        logger.warn(`Join scan: AI analysis failed: ${error.message}`);
      }
    }

    // --- 6b. Combine local + AI scores and classify ---
    result.riskScore = combineScores(localScore, result.ai?.aiAvailable ? result.ai.riskScore : null);
    result.threatLevel = classifyRisk(result.riskScore);

    // --- Persist join + risk score to our own database ---
    try {
      await recordJoin(member.guild.id, member.id, {
        inviteCode: inviteInfo.code,
        inviter: inviteInfo.inviterTag,
      });
      await recordRiskScore(member.guild.id, member.id, result.riskScore, result.threatLevel);
    } catch (error) {
      logger.warn(`Join scan: history persistence failed: ${error.message}`);
    }

    // --- 7. HIGH/CRITICAL → Owner Approval + Telegram high-risk report ---
    if (result.riskScore >= config.security.approvalThreshold) {
      try {
        await raiseSecurityAlert(member.guild, {
          userId: member.id,
          userTag: member.user.tag,
          avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
          riskScore: result.riskScore,
          threatLevel: result.threatLevel,
          reasons: result.reasons,
          source: 'Join Security Scan',
          recommendedAction: result.ai?.recommendedAction ?? 'review',
        });
        result.alertRaised = true;
      } catch (error) {
        logger.warn(`Join scan: security alert failed: ${error.message}`);
      }

      try {
        await notifyHighRiskJoin({
          username: member.user.tag,
          user_id: member.id,
          server_name: member.guild.name,
          risk_score: result.riskScore,
          threat_level: result.threatLevel,
          confidence: result.ai?.confidence ?? 0,
          reasons: result.reasons.join('; ').slice(0, 900),
          account_age: result.account?.accountAgeHuman ?? 'Unknown',
          invite_code: inviteInfo.code,
          inviter: inviteInfo.inviterTag,
          rejoin_count: result.history?.rejoinCount ?? 0,
          avatar_url: member.user.displayAvatarURL({ extension: 'png', size: 512 }),
          recommended_action: result.ai?.recommendedAction ?? 'review',
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.warn(`Join scan: Telegram high-risk notification failed: ${error.message}`);
      }
    }
  } catch (error) {
    logger.error(`Join scan failed hard (failing safe): ${error.stack || error}`);
  }

  result.scanTimeMs = Date.now() - started;
  logger.info(
    `Join scan for ${member.user.tag}: risk ${result.riskScore}/100 (${result.threatLevel}) in ${result.scanTimeMs}ms.`
  );

  // --- Phase 6/7: dashboard metrics + permanent profile + event log ---
  try {
    await recordScanTime(member.guild.id, result.scanTimeMs);
    if (result.alertRaised) await incrementStat(member.guild.id, 'threatsBlocked');
    await updateProfile(member.guild.id, member.id, {
      security: {
        riskScore: result.riskScore,
        threatLevel: result.threatLevel,
        suspiciousUsername: (result.identity?.findings?.length ?? 0) > 0,
        suspiciousAvatar: Boolean(result.account?.hasDefaultAvatar),
        previousJoins: result.history?.previousJoins ?? 0,
        previousLeaves: result.history?.previousLeaves ?? 0,
        rejoinCount: result.history?.rejoinCount ?? 0,
      },
    });
    await logSecurityEvent(member.guild, {
      type: 'JOIN_SCAN',
      severity: result.riskScore >= 81 ? 'critical' : result.riskScore >= 61 ? 'high' : result.riskScore >= 41 ? 'medium' : 'info',
      summary: `Join scan: ${member.user.tag} — ${result.riskScore}/100 (${result.threatLevel}) in ${result.scanTimeMs}ms`,
      userTag: member.user.tag,
      userId: member.id,
      ai: Boolean(result.ai?.aiAvailable),
    });
  } catch (error) {
    logger.warn(`Join scan: dashboard/profile wiring failed: ${error.message}`);
  }
  return result;
}
