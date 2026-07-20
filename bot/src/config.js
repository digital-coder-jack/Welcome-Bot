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

dotenv.config({ override: false });

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

/**
 * Read a comma-separated environment variable into a trimmed string array.
 *
 * @param {string} key
 * @returns {string[]}
 */
function envList(key) {
  const raw = process.env[key];
  if (!raw) return [];
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Read a boolean environment variable ('true'/'1'/'yes' => true).
 *
 * @param {string} key
 * @param {boolean} fallback
 * @returns {boolean}
 */
function envBool(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
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
    devIntro: envStr('DEV_INTRO_CHANNEL_ID') || envStr('DEVINTRO_CHANNEL_ID'),
    // Optional channels used by the premium welcome buttons & mod alerts.
    rules: envStr('RULES_CHANNEL_ID'), // 📖 Rules button target
    community: envStr('COMMUNITY_CHANNEL_ID'), // 🎮 Community button target
    support: envStr('SUPPORT_CHANNEL_ID'), // 🛟 Support button target (DM)
    rolesPicker: envStr('ROLES_CHANNEL_ID'), // 🎭 Choose Roles button target (DM)
    modAlert: envStr('MOD_ALERT_CHANNEL_ID'), // 🚨 default moderation-alert channel
    // --- Dedicated security channels (v2.0 — every one is OPTIONAL) ---
    securityLog: envStr('SECURITY_LOG_CHANNEL_ID'), // 📜 mirrored security event log
    aiAnalysis: envStr('AI_ANALYSIS_CHANNEL_ID'), // 🤖 mirrored AI analysis events
    securityDashboard: envStr('SECURITY_DASHBOARD_CHANNEL_ID'), // 📊 auto-posted dashboards
  }),
  roles: Object.freeze({
    forgeMember: envStr('FORGE_MEMBER_ROLE_ID'),
  }),

  // --- Premium Welcome DM branding (optional overrides, curated defaults
  // --- live in managers/dmContent.js) ---
  branding: Object.freeze({
    welcomeBannerUrl: envStr('WELCOME_BANNER_URL'),
    forgeLogoUrl: envStr('FORGE_LOGO_URL'),
  }),

  // --- AI backend (FastAPI + Groq) ---
  ai: Object.freeze({
    baseUrl: envStr('AI_BACKEND_URL', 'https://welcome-bot-bice.vercel.app'),
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

  // --- Forge Guardian Security System v2.0 (all optional, safe defaults) ---
  security: Object.freeze({
    /** Master switch for the join security scan (Phase 1). */
    joinScanEnabled: envBool('SECURITY_JOIN_SCAN_ENABLED', true),
    /** Master switch for live message security (Phase 2). */
    liveScanEnabled: envBool('SECURITY_LIVE_SCAN_ENABLED', true),
    /** Master switch for anti-raid (Phase 3). */
    antiRaidEnabled: envBool('SECURITY_ANTI_RAID_ENABLED', true),
    /** Master switch for AI join/message analysis (Phase 4). */
    aiAnalysisEnabled: envBool('SECURITY_AI_ANALYSIS_ENABLED', true),

    /** Accounts younger than this (days) are "new". */
    newAccountDays: envInt('SECURITY_NEW_ACCOUNT_DAYS', 7),
    /** Accounts younger than this (days) are "recently created". */
    recentAccountDays: envInt('SECURITY_RECENT_ACCOUNT_DAYS', 30),

    /** Raid detection: joins within window that trigger Raid Mode. */
    raidJoinThreshold: envInt('SECURITY_RAID_JOINS', 10),
    /** Raid detection rolling window (seconds). */
    raidWindowSec: envInt('SECURITY_RAID_WINDOW_SEC', 30),
    /** How long Raid Mode stays active (minutes) before auto-disable. */
    raidModeMinutes: envInt('SECURITY_RAID_MODE_MINUTES', 15),
    /** Slowmode (seconds) applied to locked channels during Raid Mode. */
    raidSlowmodeSec: envInt('SECURITY_RAID_SLOWMODE_SEC', 30),
    /** Channels to lock during Raid Mode (comma-separated IDs). */
    raidLockChannelIds: Object.freeze(envList('SECURITY_RAID_LOCK_CHANNEL_IDS')),

    /** Channel for security alerts / owner-approval panels (falls back to modAlert/log). */
    alertChannelId: envStr('SECURITY_ALERT_CHANNEL_ID'),
    /** Channel for the post-join Security Report (falls back to alert channel). */
    reportChannelId: envStr('SECURITY_REPORT_CHANNEL_ID'),
    /** Whether to post the animated Security Report after every join. */
    joinReportEnabled: envBool('SECURITY_JOIN_REPORT_ENABLED', true),

    /** Risk score at/above which an Owner Approval security alert is raised. */
    approvalThreshold: envInt('SECURITY_APPROVAL_THRESHOLD', 61),
    /** Default timeout (minutes) for the 🟡 Timeout security-alert button. */
    timeoutMinutes: envInt('SECURITY_TIMEOUT_MINUTES', 60),
  }),
});

/**
 * The canonical server rules. Moderation actions reference these numbers.
 * Keep in sync with the backend prompt (backend/app/prompts/moderation_prompt.py).
 */
export const SERVER_RULES = Object.freeze([
  { number: 1, title: 'Be Respectful', description: 'Treat everyone with kindness and respect. No bullying, harassment, threats, insults, or personal attacks.' },
  { number: 2, title: 'No Hate Speech', description: 'No discrimination or hateful content based on race, religion, nationality, ethnicity, disability, gender, sexuality, or any protected characteristic.' },
  { number: 3, title: 'Keep It Appropriate', description: 'No NSFW, explicit sexual content, graphic gore, illegal content, or other clearly inappropriate material.' },
  { number: 4, title: 'No Spamming', description: 'No message flooding, repeated messages, repeated emojis, excessive mentions, mass pings, copypasta flooding, or intentional disruption.' },
  { number: 5, title: 'Use Channels Correctly', description: 'Use channels for their intended purpose. Off-topic chats are politely redirected, not warned, unless abuse is intentional.' },
  { number: 6, title: 'No Toxic Behavior', description: 'No trolling, baiting, provoking, flaming, starting drama, encouraging arguments, or intentionally making members uncomfortable.' },
  { number: 7, title: 'Respect Privacy', description: 'Never share personal information without permission. Never encourage doxxing or expose private information.' },
  { number: 8, title: 'No Advertising', description: 'No promotion of Discord servers, products, services, referral links, social media, or self-promotion without staff approval.' },
  { number: 9, title: 'No Recruitment, Hiring, or Referral Posts', description: 'No hiring posts, internships, recruitment, talent hunting, referral requests, team recruitment, or job advertisements unless approved by staff.' },
  { number: 10, title: 'Follow Discord Terms of Service', description: 'Only obvious violations of Discord\u2019s Terms of Service and Community Guidelines are enforced.' },
  { number: 11, title: 'Listen to Staff', description: 'Ignoring official moderator instructions may result in moderation.' },
]);

/** Highest valid Forge Protocol rule number (kept in sync with SERVER_RULES). */
export const MAX_RULE = SERVER_RULES[SERVER_RULES.length - 1].number;

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
