/**
 * filters/index.js
 * ---------------------------------------------------------------------------
 * Pure auto-moderation detectors + a lightweight per-user activity tracker.
 *
 * Each detector inspects a message (and optionally recent history) and returns
 * either `null` (clean) or a verdict object:
 *   { type, reason, rule, action }
 *
 * Detectors are intentionally side-effect free: they never touch Discord. The
 * caller (filters/autoModerator.js) decides how to act on a verdict. This makes
 * the logic trivial to unit-test and reason about.
 *
 * Covered checks (map to server rules):
 *   - Invite links       -> Rule 8  (No Advertising)
 *   - Excessive mentions -> Rule 4  (No Spamming)
 *   - Emoji spam         -> Rule 4  (No Spamming)
 *   - Caps spam          -> Rule 4  (No Spamming)
 *   - Repeated messages  -> Rule 4  (No Spamming)
 *   - Rapid spam / flood -> Rule 4  (No Spamming)
 * ---------------------------------------------------------------------------
 */

import { config } from '../config.js';

/** Discord invite links (discord.gg, discord.com/invite, discordapp.com/invite). */
const INVITE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg|discord\.gg\/invite)\/[a-z0-9-]+/i;

/** Unicode emoji + custom Discord emoji matcher. */
const CUSTOM_EMOJI_REGEX = /<a?:\w+:\d+>/g;
const UNICODE_EMOJI_REGEX = /\p{Extended_Pictographic}/gu;

/**
 * Detect Discord invite links.
 * @param {import('discord.js').Message} message
 * @returns {null|object}
 */
export function detectInviteLinks(message) {
  if (INVITE_REGEX.test(message.content)) {
    return { type: 'invite', reason: 'Posting server invite links is not allowed.', rule: 8, action: 'delete' };
  }
  return null;
}

/**
 * Detect excessive user/role mentions.
 * @param {import('discord.js').Message} message
 * @returns {null|object}
 */
export function detectExcessiveMentions(message) {
  const mentionCount = message.mentions.users.size + message.mentions.roles.size;
  if (mentionCount > config.autoMod.maxMentions) {
    return {
      type: 'mentions',
      reason: `Too many mentions (${mentionCount}); the limit is ${config.autoMod.maxMentions}.`,
      rule: 4,
      action: 'delete',
    };
  }
  return null;
}

/**
 * Detect emoji spam (custom + unicode emojis combined).
 * @param {import('discord.js').Message} message
 * @returns {null|object}
 */
export function detectEmojiSpam(message) {
  const custom = (message.content.match(CUSTOM_EMOJI_REGEX) || []).length;
  const unicode = (message.content.match(UNICODE_EMOJI_REGEX) || []).length;
  const total = custom + unicode;
  if (total > config.autoMod.maxEmojis) {
    return {
      type: 'emoji',
      reason: `Too many emojis (${total}); the limit is ${config.autoMod.maxEmojis}.`,
      rule: 4,
      action: 'delete',
    };
  }
  return null;
}

/**
 * Detect excessive capital letters ("CAPS spam").
 * Only applies to messages of at least `capsMinLength` letters.
 * @param {import('discord.js').Message} message
 * @returns {null|object}
 */
export function detectCapsSpam(message) {
  const letters = message.content.replace(/[^a-zA-Z]/g, '');
  if (letters.length < config.autoMod.capsMinLength) return null;

  const upper = message.content.replace(/[^A-Z]/g, '').length;
  const percent = (upper / letters.length) * 100;

  if (percent >= config.autoMod.capsPercentThreshold) {
    return {
      type: 'caps',
      reason: `Excessive capital letters (${Math.round(percent)}%).`,
      rule: 4,
      action: 'delete',
    };
  }
  return null;
}

/**
 * ---------------------------------------------------------------------------
 * Per-user activity tracker for spam & repeated-message detection.
 * Kept in-memory (Map) with automatic pruning of old entries.
 * ---------------------------------------------------------------------------
 */
class ActivityTracker {
  constructor() {
    /** @type {Map<string, {content:string, timestamp:number}[]>} */
    this.history = new Map();
  }

  /** key = guildId:userId */
  #key(message) {
    return `${message.guild.id}:${message.author.id}`;
  }

  /**
   * Record a message and return the recent (within window) history for the user.
   * @param {import('discord.js').Message} message
   * @returns {{content:string, timestamp:number}[]}
   */
  record(message) {
    const key = this.#key(message);
    const now = Date.now();
    const windowMs = config.autoMod.spamTimeWindowMs;

    const entries = (this.history.get(key) || []).filter((e) => now - e.timestamp < windowMs);
    entries.push({ content: message.content.trim().toLowerCase(), timestamp: now });
    this.history.set(key, entries);
    return entries;
  }
}

const tracker = new ActivityTracker();

/**
 * Detect rapid spam (too many messages in the time window) and repeated
 * identical messages. Uses the shared ActivityTracker.
 *
 * @param {import('discord.js').Message} message
 * @returns {null|object}
 */
export function detectSpamAndRepeats(message) {
  const entries = tracker.record(message);

  // Rapid spam / flooding.
  if (entries.length >= config.autoMod.spamMessageLimit) {
    return {
      type: 'spam',
      reason: `Sending messages too quickly (${entries.length} in ${config.autoMod.spamTimeWindowMs / 1000}s).`,
      rule: 4,
      action: 'delete',
    };
  }

  // Repeated identical messages (3+ of the same content in the window).
  const current = message.content.trim().toLowerCase();
  if (current.length > 0) {
    const identical = entries.filter((e) => e.content === current).length;
    if (identical >= 3) {
      return {
        type: 'repeat',
        reason: 'Repeating the same message repeatedly.',
        rule: 4,
        action: 'delete',
      };
    }
  }

  return null;
}

/**
 * Run every synchronous detector in priority order and return the first
 * verdict found (or null if the message is clean).
 *
 * @param {import('discord.js').Message} message
 * @returns {null|{type:string, reason:string, rule:number, action:string}}
 */
export function runAllFilters(message) {
  const detectors = [
    detectInviteLinks,
    detectExcessiveMentions,
    detectEmojiSpam,
    detectCapsSpam,
    detectSpamAndRepeats,
  ];

  for (const detect of detectors) {
    const verdict = detect(message);
    if (verdict) return verdict;
  }
  return null;
}
