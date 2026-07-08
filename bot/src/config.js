/**
 * config.js
 * ---------------------------------------------------------------------------
 * Centralised configuration loader.
 *
 * Responsibilities:
 *   - Load environment variables from `.env` exactly once.
 *   - Coerce string env vars into the correct types (number / string).
 *   - Provide safe, documented defaults for tunable auto-moderation values.
 *   - Validate that the critical secrets exist and fail fast if they don't.
 *   - Expose the canonical list of server rules used across the bot.
 *
 * Everything else in the codebase imports from here so there is a single
 * source of truth for configuration.
 * ---------------------------------------------------------------------------
 */

import dotenv from 'dotenv';

const result = dotenv.config();

console.log(result);

/**
 * Read an environment variable as an integer, falling back to `fallback`
 * when the variable is missing or not a valid number.
 *
 * @param {string} key      Environment variable name.
 * @param {number} fallback Default value.
 * @returns {number}
 */
function envInt(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Read a string environment variable, trimming whitespace.
 *
 * @param {string} key
 * @param {string} [fallback='']
 * @returns {string}
 */
function envStr(key, fallback = '') {
  const raw = process.env[key];
  return raw === undefined ? fallback : raw.trim();
}

export const config = Object.freeze({
  // --- Discord core credentials ---
  token: envStr('DISCORD_TOKEN'),
  clientId: envStr('CLIENT_ID'),
  guildId: envStr('GUILD_ID'),

  // --- Channels & roles ---
  channels: Object.freeze({
    welcome: envStr('WELCOME_CHANNEL_ID'),
    goodbye: envStr('GOODBYE_CHANNEL_ID'),
    log: envStr('LOG_CHANNEL_ID'),
  }),
  roles: Object.freeze({
    explorer: envStr('EXPLORER_ROLE_ID'),
  }),

  // --- AI backend (FastAPI + Groq) ---
  ai: Object.freeze({
    baseUrl: envStr('AI_BACKEND_URL', 'http://127.0.0.1:8000'),
    timeoutMs: envInt('AI_REQUEST_TIMEOUT_MS', 8000),
  }),

  // --- Auto-moderation thresholds ---
  autoMod: Object.freeze({
    spamMessageLimit: envInt('SPAM_MESSAGE_LIMIT', 5),
    spamTimeWindowMs: envInt('SPAM_TIME_WINDOW_MS', 7000),
    maxMentions: envInt('MAX_MENTIONS', 5),
    maxEmojis: envInt('MAX_EMOJIS', 10),
    capsPercentThreshold: envInt('CAPS_PERCENT_THRESHOLD', 70),
    capsMinLength: envInt('CAPS_MIN_LENGTH', 10),
  }),

  // --- Moderation policy ---
  maxWarnings: envInt('MAX_WARNINGS', 3),
});

/**
 * The canonical server rules. Moderation actions reference these numbers.
 * Keep in sync with the backend prompt (backend/app/prompts/moderation_prompt.py).
 */
export const SERVER_RULES = Object.freeze([
  { number: 1, title: 'Be Respectful', description: 'Treat every member with respect and courtesy.' },
  { number: 2, title: 'No Hate Speech', description: 'Racism, sexism, homophobia and other hate speech are forbidden.' },
  { number: 3, title: 'Keep It Appropriate', description: 'No NSFW, gore or otherwise inappropriate content.' },
  { number: 4, title: 'No Spamming', description: 'Avoid spam, flooding and repeated messages.' },
  { number: 5, title: 'Use Channels Correctly', description: 'Post content in the appropriate channels.' },
  { number: 6, title: 'No Toxic Behavior', description: 'No harassment, personal attacks or threats.' },
  { number: 7, title: 'Respect Privacy', description: 'Never share anyone\u2019s private information.' },
  { number: 8, title: 'No Advertising', description: 'No unsolicited ads or invite links to other servers.' },
  { number: 9, title: 'Follow Discord ToS', description: 'Abide by the Discord Terms of Service at all times.' },
  { number: 10, title: 'Listen to Staff', description: 'Follow instructions from moderators and administrators.' },
]);

/**
 * Validate that the minimum required secrets are present.
 * Called from index.js at startup so misconfiguration fails fast and loud.
 *
 * @throws {Error} when a required variable is missing.
 */
export function validateConfig() {
  const required = [
    ['DISCORD_TOKEN', config.token],
    ['CLIENT_ID', config.clientId],
  ];

  console.log("config.token =", JSON.stringify(config.token));
  console.log("config.clientId =", JSON.stringify(config.clientId));

  const missing = required
    .filter(([, value]) => !value || value.startsWith('your-'))
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Copy bot/.env.example to bot/.env and fill in the values.'
    );
  }
}
