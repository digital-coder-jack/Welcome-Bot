/**
 * security/liveSecurity.js
 * ---------------------------------------------------------------------------
 * Phase 2 — Live Security orchestrator (Forge Guardian v2.0).
 *
 * Runs on every message AFTER the legacy filters (filters/index.js) pass,
 * adding the v2 threat detectors (scam links, phishing, fake nitro, crypto
 * scams, token leaks, unicode abuse, mass copy-paste, channel spam...).
 *
 * When a detector fires:
 *   1. The message is deleted (fail-safe).
 *   2. The event is sent to the AI Security Engine (Phase 4 — Groq via
 *      FastAPI) for threat level / confidence / explanation / violated rule /
 *      recommended action.
 *   3. Action is taken per the combined verdict:
 *        ignore | delete | warn | timeout | (kick/ban → Owner Approval only)
 *      THE AI NEVER BANS — HIGH/CRITICAL verdicts raise a Security Alert
 *      with human-approval buttons instead.
 *   4. Telegram is notified via the backend.
 *
 * Everything is best-effort: a failure in any step never breaks messaging.
 * ---------------------------------------------------------------------------
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { runThreatDetectors } from './threatDetectors.js';
import { analyzeSecurityEvent } from '../services/aiClient.js';
import { deleteMessage, issueWarning } from '../services/moderationService.js';
import { reportSecurityEvent } from '../services/securityService.js';
import { raiseSecurityAlert } from './securityAlerts.js';
import { recordTimeout } from '../database/securityStore.js';
import { clamp, classifyRisk } from './riskEngine.js';
import { isUserWhitelisted } from '../database/blacklistStore.js';
import { incrementStat } from '../database/statsStore.js';
import { bumpProfile } from '../database/profileStore.js';
import { logSecurityEvent } from './securityLogger.js';

/**
 * Run the v2 live-security pipeline on a message.
 * Returns true when a threat was detected and handled (caller can stop).
 *
 * @param {import('discord.js').Message} message
 * @returns {Promise<boolean>}
 */
export async function runLiveSecurity(message) {
  if (!config.security.liveScanEnabled) return false;

  // --- Local threat detectors ---
  let verdict = null;
  try {
    verdict = runThreatDetectors(message);
  } catch (error) {
    logger.warn(`Live security detectors failed: ${error.message}`);
  }
  if (!verdict) return false;

  // Phase 8: whitelisted users bypass the live-security detectors.
  try {
    if (await isUserWhitelisted(message.guild.id, message.author.id)) {
      logger.debug(`Live security: ${message.author.tag} is whitelisted — skipping.`);
      return false;
    }
  } catch {
    /* fail open to normal processing */
  }

  logger.info(`Live security: ${verdict.type} from ${message.author.tag} — ${verdict.reason}`);

  // --- 1. Delete the offending message (fail-safe) ---
  try {
    await deleteMessage(message, { reason: verdict.reason, rule: null, source: 'auto' });
  } catch (error) {
    logger.warn(`Live security: delete failed: ${error.message}`);
  }

  // --- 2. AI Security Engine analysis (Phase 4; fails open) ---
  let ai = null;
  if (config.security.aiAnalysisEnabled) {
    try {
      ai = await analyzeSecurityEvent({
        event_type: verdict.type,
        content: (message.content ?? '').slice(0, 1500),
        username: message.author.tag,
        user_id: message.author.id,
        channel: message.channel?.name ?? '',
        context: verdict.reason,
        local_score: verdict.score,
      });
    } catch (error) {
      logger.warn(`Live security: AI analysis failed: ${error.message}`);
    }
  }

  const combinedScore = clamp(Math.max(verdict.score, ai?.aiAvailable ? (ai.riskScore ?? 0) : 0));
  const threatLevel = classifyRisk(combinedScore);
  const recommended = ai?.aiAvailable ? ai.recommendedAction : null;

  // --- Phase 6/7: dashboard statistics + member profile + event log ---
  try {
    const guildId = message.guild.id;
    await incrementStat(guildId, 'threatsBlocked');
    const type = String(verdict.type ?? '').toLowerCase();
    if (type.includes('spam')) await incrementStat(guildId, 'spamBlocked');
    if (type.includes('scam') || type.includes('phish') || type.includes('nitro')) {
      await incrementStat(guildId, 'scamAttempts');
      await bumpProfile(guildId, message.author.id, 'security', 'scamDetections');
    }
    await logSecurityEvent(message.guild, {
      type: `THREAT_${String(verdict.type ?? 'UNKNOWN').toUpperCase().slice(0, 30)}`,
      severity: verdict.severity ?? 'medium',
      summary: `${verdict.reason} — combined risk ${combinedScore}/100 (${threatLevel})`,
      userTag: message.author.tag,
      userId: message.author.id,
      ai: Boolean(ai?.aiAvailable),
    });
  } catch (error) {
    logger.warn(`Live security: stats wiring failed: ${error.message}`);
  }

  // --- 3. Act on the combined verdict (never auto-ban) ---
  try {
    const member = message.member;

    if (combinedScore >= config.security.approvalThreshold) {
      // HIGH/CRITICAL → Owner Approval Security Alert (human decides).
      await raiseSecurityAlert(message.guild, {
        userId: message.author.id,
        userTag: message.author.tag,
        avatarUrl: message.author.displayAvatarURL({ extension: 'png', size: 256 }),
        riskScore: combinedScore,
        threatLevel,
        reasons: [verdict.reason, ...(ai?.aiAvailable && ai.explanation ? [`AI: ${ai.explanation}`] : [])],
        source: 'Live Security (message)',
        recommendedAction: recommended ?? 'review',
      });
    }

    if (member) {
      if (recommended === 'timeout' && member.moderatable) {
        const minutes = config.security.timeoutMinutes;
        await member
          .timeout(minutes * 60 * 1000, `Live security: ${verdict.reason}`)
          .then(() => recordTimeout(message.guild.id, member.id, minutes, verdict.reason))
          .catch(() => {});
      } else if (verdict.severity === 'high' || verdict.severity === 'critical' || recommended === 'warn') {
        // Serious local detections always at least warn (uses the existing
        // warning pipeline: DM + Telegram + escalation panel at threshold).
        await issueWarning({
          guild: message.guild,
          member,
          reason: verdict.reason,
          moderatorId: message.client.user.id,
          moderatorTag: 'Forge Guardian',
          source: 'auto',
          severity: verdict.severity === 'critical' ? 'high' : verdict.severity,
        });
      }
    }
  } catch (error) {
    logger.warn(`Live security: action failed: ${error.message}`);
  }

  // --- 4. Telegram security alert via backend (best-effort) ---
  try {
    await reportSecurityEvent({
      alertType: `Live Security: ${verdict.type}`,
      severity: verdict.severity,
      serverName: message.guild.name,
      username: message.author.tag,
      userId: message.author.id,
      channel: message.channel?.name ? `#${message.channel.name}` : '',
      details:
        `${verdict.reason}. Combined risk ${combinedScore}/100 (${threatLevel}).` +
        (ai?.aiAvailable ? ` AI: ${ai.explanation || 'n/a'} → ${ai.recommendedAction}.` : ' AI unavailable.') +
        ` Message: "${(message.content ?? '').slice(0, 150)}"`,
    });
  } catch (error) {
    logger.warn(`Live security: Telegram alert failed: ${error.message}`);
  }

  return true;
}
