/**
 * managers/dmContent.js
 * ---------------------------------------------------------------------------
 * Premium Welcome DM content library for Developer's Forge.
 *
 * This module is pure content + templating — no Discord API calls — so it is
 * trivially unit-testable and keeps dmManager.js focused on delivery.
 *
 * Exports:
 *   - BRAND            Visual identity constants (accent colour, logo,
 *                      footer). Logo is overridable via env
 *                      (FORGE_LOGO_URL) without a deploy.
 *   - WELCOME_QUOTES   10 curated inspirational quotes (programming,
 *                      learning, creativity, perseverance).
 *   - pickQuote()      Random quote selector — one per new member.
 *   - buildWelcomeBody(vars)  Renders the premium minimal DM body with
 *                      dynamic variables interpolated.
 *
 * Supported dynamic variables:
 *   {username} {displayName} {memberCount} {joinDate} {serverName}
 * ---------------------------------------------------------------------------
 */

import { config } from '../config.js';

/**
 * Visual identity for the premium welcome DM.
 * `FORGE_LOGO_URL` env var (via config.branding) overrides the default so
 * server owners can rebrand without touching code.
 */
export const BRAND = Object.freeze({
  /** Warm forge amber — premium, dark-mode friendly accent. */
  accent: 0xd97a34,
  /** Developer's Forge logo (embed thumbnail). */
  logoUrl:
    config.branding.forgeLogoUrl ||
    'https://raw.githubusercontent.com/digital-coder-jack/Welcome-Bot/main/bot/assets/branding/forge-guardian-logo.png',
  /** Branded footer line. */
  footer: "Developer's Forge • Learn • Build • Grow",
});

/** Thin, minimal divider — renders cleanly on desktop and mobile widths. */
const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━━━━━━';

/**
 * Header plaque, rendered inside a code block so Discord uses a MONOSPACE
 * font — this guarantees "DEVELOPER'S FORGE" is perfectly centred with
 * even margins on every device (desktop + mobile), unlike proportional
 * fonts where manual spaces drift.
 *
 * Inner width: 27 columns. Padding is computed, not hand-tuned:
 *   "• W E L C O M E •" (18 ch) → 4/5 spaces
 *   "DEVELOPER'S FORGE" (17 ch) → 5/5 spaces
 */
function headerPlaque() {
  const INNER = 27;
  const line = (text) => {
    const pad = INNER - text.length;
    const left = Math.floor(pad / 2);
    return `│${' '.repeat(left)}${text}${' '.repeat(pad - left)}│`;
  };
  return [
    '```',
    `╭${'─'.repeat(INNER)}╮`,
    line('• W E L C O M E •'),
    line("DEVELOPER'S FORGE"),
    `╰${'─'.repeat(INNER)}╯`,
    '```',
  ].join('\n');
}

/**
 * 10 curated inspirational quotes. Each welcome DM randomly features one,
 * keeping the identical premium layout and Developer's Forge identity.
 * @type {ReadonlyArray<string>}
 */
export const WELCOME_QUOTES = Object.freeze([
  '"Small commits. Big dreams."',
  '"First, solve the problem. Then, write the code." — John Johnson',
  '"The best error message is the one that never shows up." — Thomas Fuchs',
  '"Learning never exhausts the mind." — Leonardo da Vinci',
  '"Creativity is intelligence having fun." — Albert Einstein',
  '"It always seems impossible until it\'s done." — Nelson Mandela',
  '"Code is like humor. When you have to explain it, it\'s bad." — Cory House',
  '"The expert in anything was once a beginner." — Helen Hayes',
  '"Make it work, make it right, make it fast." — Kent Beck',
  '"Fall seven times, stand up eight." — Japanese proverb',
]);

/**
 * Pick one random quote from the collection.
 * @returns {string}
 */
export function pickQuote() {
  return WELCOME_QUOTES[Math.floor(Math.random() * WELCOME_QUOTES.length)];
}

/**
 * Interpolate `{placeholders}` in a template string. Unknown placeholders
 * are left untouched so malformed templates never throw.
 *
 * @param {string} template
 * @param {Record<string, string|number>} vars
 * @returns {string}
 */
export function interpolate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  );
}

/**
 * Truncate a string so embed descriptions never overflow Discord's 4096
 * character limit (we cap well below it for safety).
 *
 * @param {string} text
 * @param {number} [max=3800]
 * @returns {string}
 */
export function clamp(text, max = 3800) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Build the full premium minimal welcome DM body.
 *
 * Layout (identical for every variant — only the quote rotates):
 *   header plaque → greeting → identity statement → belief lines →
 *   next steps → rotating quote → sign-off.
 *
 * @param {object} vars
 * @param {string} vars.username      Discord username.
 * @param {string} vars.displayName   Server display name.
 * @param {number} vars.memberCount   Guild member count.
 * @param {string} vars.joinDate      Discord timestamp markup (e.g. <t:..:D>).
 * @param {string} vars.serverName    Guild name.
 * @param {string} [quote]            Pre-selected quote (random if omitted).
 * @returns {string} Rendered description, safely clamped.
 */
export function buildWelcomeBody(vars, quote = pickQuote()) {
  const body = [
    headerPlaque(),
    '',
    'Hello, **{username}**.',
    '',
    'Welcome to {serverName} — you are member **#{memberCount}**, joined {joinDate}.',
    '',
    "This isn't just another Discord server —",
    "it's a place where developers, ethical hackers,",
    'AI enthusiasts, and creators come together',
    'to learn, build, and grow.',
    '',
    DIVIDER,
    '',
    '✨ Every expert was once a beginner.',
    '💡 Every great project started with one idea.',
    '',
    DIVIDER,
    '',
    '📖 Read the Rules',
    '👋 Introduce Yourself',
    '🎭 Choose Your Roles',
    '🚀 Begin Your Journey',
    '',
    DIVIDER,
    '',
    `*${quote}*`,
    '',
    DIVIDER,
    '',
    'Forge your skills.',
    'Build your future.',
    '',
    '🔥 The Forge is waiting, **{displayName}**.',
    '',
    '— Forge Guardian ⚡',
  ].join('\n');

  return clamp(interpolate(body, vars));
}
