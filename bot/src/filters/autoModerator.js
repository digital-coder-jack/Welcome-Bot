/**
 * autoModerator.js
 * ---------------------------------------------------------------------------
 * Orchestrates the full moderation pipeline for a single message:
 *
 *   1. Fast, local, rule-based filters (spam, invites, mentions, caps, emoji).
 *      -> If any fires, delete the message and stop (cheap, no API cost).
 *
 *   2. AI moderation (FastAPI + Groq) for nuanced content (toxicity,
 *      harassment, hate speech, threats, personal attacks).
 *      -> Act on the returned action: delete and/or warn.
 *
 * Actions are executed through the shared moderationService so logging and
 * escalation behave identically to slash-command moderation.
 * ---------------------------------------------------------------------------
 */

import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { runAllFilters } from './index.js';
import { analyzeMessage } from '../services/aiClient.js';
import { deleteMessage, issueWarning } from '../services/moderationService.js';
import { reportAIViolation } from '../services/securityService.js';
import { runLiveSecurity } from '../security/liveSecurity.js';

/**
 * Forge Protocol v4 — ZERO FALSE POSITIVE POLICY:
 * a formal warning requires >= 95% AI confidence. Verdicts below this are
 * treated as NO VIOLATION (the backend enforces the same threshold; this is
 * defence in depth).
 */
const AI_CONFIDENCE_THRESHOLD = 0.95;

/** Don't waste an AI call on trivially short messages. */
const AI_MIN_LENGTH = 4;

/** How many surrounding channel messages to send as conversation context. */
const CONTEXT_MESSAGES = 6;

/**
 * Message IDs that already produced a moderation action.
 * Forge Protocol: never warn twice for the same message.
 */
const actionedMessageIds = new Set();
const ACTIONED_CACHE_LIMIT = 2000;

/** Remember a message as actioned (bounded LRU-ish cache). */
function markActioned(messageId) {
  actionedMessageIds.add(messageId);
  if (actionedMessageIds.size > ACTIONED_CACHE_LIMIT) {
    const first = actionedMessageIds.values().next().value;
    actionedMessageIds.delete(first);
  }
}

/**
 * Fetch the previous messages in the channel and render them as a compact
 * transcript (oldest first). The Forge Protocol requires reading the
 * surrounding conversation before judging a message. Best-effort — returns
 * an empty string when history can't be fetched.
 *
 * @param {import('discord.js').Message} message
 * @returns {Promise<string>}
 */
async function fetchConversationContext(message) {
  try {
    const fetched = await message.channel.messages.fetch({
      limit: CONTEXT_MESSAGES,
      before: message.id,
    });
    const lines = [...fetched.values()]
      .reverse() // oldest first
      .filter((m) => !m.system)
      .map((m) => `${m.author?.tag ?? 'unknown'}: ${(m.content || '[non-text content]').slice(0, 200)}`);
    return lines.join('\n').slice(0, 4000);
  } catch {
    return '';
  }
}

/**
 * Determine whether a message should be exempt from auto-moderation.
 * We skip bots, system messages, DMs, and members with Manage Messages
 * (moderators/admins) so staff aren't auto-moderated.
 * @param {import('discord.js').Message} message
 * @returns {boolean}
 */
function isExempt(message) {
  if (!message.guild) return true; // DMs
  if (message.author.bot || message.system) return true;
  const perms = message.member?.permissions;
  if (perms?.has(PermissionFlagsBits.ManageMessages)) return true;
  return false;
}

/**
 * Run the complete moderation pipeline on a message.
 * @param {import('discord.js').Message} message
 * @returns {Promise<void>}
 */
export async function moderateMessage(message) {
  if (isExempt(message)) return;

  // --- Stage 1: local rule-based filters ---
  const verdict = runAllFilters(message);
  if (verdict) {
    await deleteMessage(message, { reason: verdict.reason, rule: verdict.rule, source: 'auto' });
    return; // Local filter handled it; skip the AI call.
  }

  // --- Stage 1.5: Forge Guardian v2.0 Live Security (Phase 2) ---
  // Scam links, phishing, fake nitro, crypto scams, token leaks, unicode
  // abuse, mass copy-paste, channel spam + AI security analysis.
  try {
    const handled = await runLiveSecurity(message);
    if (handled) return; // Threat handled; skip the legacy AI call.
  } catch (error) {
    logger.warn(`Live security pipeline failed (continuing): ${error.message}`);
  }

  // --- Stage 2: AI moderation (Forge Guardian / Forge Protocol v4) ---
  const content = message.content?.trim() ?? '';
  if (content.length < AI_MIN_LENGTH) return;

  // Never act twice on the same message (dedupe guard).
  if (actionedMessageIds.has(message.id)) return;

  // Forge Protocol: read the surrounding conversation before judging.
  const context = await fetchConversationContext(message);

  const result = await analyzeMessage({
    content,
    authorId: message.author.id,
    channelId: message.channel.id,
    context,
  });

  // ZERO FALSE POSITIVE POLICY: below 95% confidence => NO VIOLATION.
  if (!result.violation || result.confidence < AI_CONFIDENCE_THRESHOLD) return;

  // A warning verdict must carry the exact rule + offending message; if the
  // verdict is incomplete, a Forge Protocol verification step failed =>
  // DO NOT WARN.
  if ((result.action === 'warn' || result.action === 'kick') && (!result.rule || !result.ruleTitle)) {
    logger.info('AI verdict incomplete (missing rule/title); Forge Protocol says DO NOT WARN.');
    return;
  }

  markActioned(message.id);

  logger.info(
    `AI flagged message from ${message.author.tag} ` +
      `(rule ${result.rule}, ${Math.round(result.confidence * 100)}%): ${result.reason}`
  );

  // Security handler: relay the AI violation to Telegram via the backend.
  try {
    await reportAIViolation(message, result);
  } catch (error) {
    logger.warn(`Security alert for AI violation failed: ${error.message}`);
  }

  // Act on the AI decision.
  await deleteOrWarnFromAI(message, result);
}

/**
 * Translate an AI ModerationResult into concrete actions.
 * @param {import('discord.js').Message} message
 * @param {import('../services/aiClient.js').ModerationResult} result
 */
async function deleteOrWarnFromAI(message, result) {
  const reason = `${result.reason} (AI confidence ${Math.round(result.confidence * 100)}%)`;
  // Forge Protocol warning format: Member, Rule Number, Rule Name,
  // Exact Message, Reason, Confidence %, Timestamp.
  const forge = {
    ruleTitle: result.ruleTitle,
    offendingMessage: result.offendingMessage || message.content?.slice(0, 200),
    confidence: result.confidence,
  };

  switch (result.action) {
    case 'delete':
      await deleteMessage(message, { reason, rule: result.rule, source: 'ai' });
      break;

    case 'warn':
    case 'kick': {
      // Delete the offending message first, then issue a warning.
      // POLICY: the bot NEVER kicks/bans automatically. An AI 'kick'
      // recommendation is treated as a HIGH-severity warning; reaching the
      // threshold (or critical severity) raises a Moderator Approval Panel
      // where a human decides the outcome.
      await deleteMessage(message, { reason, rule: result.rule, source: 'ai' });
      if (message.member) {
        await issueWarning({
          guild: message.guild,
          member: message.member,
          reason,
          moderatorId: message.client.user.id,
          moderatorTag: 'Forge Guardian (AI)',
          rule: result.rule,
          source: 'ai',
          severity: result.action === 'kick' ? 'high' : undefined,
          forge,
          messageId: message.id,
        });
      }
      break;
    }

    default:
      // 'none' or unknown: do nothing.
      break;
  }
}
