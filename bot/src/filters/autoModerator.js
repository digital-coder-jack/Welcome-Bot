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

/** Confidence below which we ignore an AI "violation" to avoid false positives. */
const AI_CONFIDENCE_THRESHOLD = 0.75;

/** Don't waste an AI call on trivially short messages. */
const AI_MIN_LENGTH = 4;

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

  // --- Stage 2: AI moderation ---
  const content = message.content?.trim() ?? '';
  if (content.length < AI_MIN_LENGTH) return;

  const result = await analyzeMessage({
    content,
    authorId: message.author.id,
    channelId: message.channel.id,
  });

  if (!result.violation || result.confidence < AI_CONFIDENCE_THRESHOLD) return;

  logger.info(
    `AI flagged message from ${message.author.tag} ` +
      `(rule ${result.rule}, ${Math.round(result.confidence * 100)}%): ${result.reason}`
  );

  // Log the AI decision itself before taking action.
  await deleteOrWarnFromAI(message, result);
}

/**
 * Translate an AI ModerationResult into concrete actions.
 * @param {import('discord.js').Message} message
 * @param {import('../services/aiClient.js').ModerationResult} result
 */
async function deleteOrWarnFromAI(message, result) {
  const reason = `${result.reason} (AI confidence ${Math.round(result.confidence * 100)}%)`;

  switch (result.action) {
    case 'delete':
      await deleteMessage(message, { reason, rule: result.rule, source: 'ai' });
      break;

    case 'warn':
    case 'kick': {
      // Delete the offending message first, then issue a warning. The warning
      // system itself escalates to a kick automatically at the max threshold,
      // so 'warn' and 'kick' both route through issueWarning for consistency.
      await deleteMessage(message, { reason, rule: result.rule, source: 'ai' });
      if (message.member) {
        await issueWarning({
          guild: message.guild,
          member: message.member,
          reason,
          moderatorId: message.client.user.id,
          moderatorTag: 'AI Moderator',
          rule: result.rule,
          source: 'ai',
        });
      }
      break;
    }

    default:
      // 'none' or unknown: do nothing.
      break;
  }
}
