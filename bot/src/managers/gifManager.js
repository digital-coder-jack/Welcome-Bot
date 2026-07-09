/**
 * managers/gifManager.js
 * ---------------------------------------------------------------------------
 * Animated asset manager.
 *
 * Responsibilities:
 *   - Serve welcome GIFs from the active theme (or admin-supplied custom
 *     GIFs when configured).
 *   - Random selection with "no consecutive repeats" per guild: the last
 *     served GIF for each guild is remembered and excluded from the next
 *     pick whenever the pool has more than one asset.
 *   - Provide the animated "loading" emoji frames used by the cinematic
 *     welcome animation.
 *
 * Lottie support: Discord embeds cannot render .lottie/.json animations, so
 * converted Lottie exports (GIF renders) can simply be added to a theme's
 * `gifs` array or to a guild's `customGifs` setting — the manager treats any
 * URL uniformly.
 * ---------------------------------------------------------------------------
 */

import { getTheme } from './themeManager.js';

/** Map<guildId, string> — the GIF served on the previous join. */
const lastServed = new Map();

/** Spinner/loading pseudo-animation frames (unicode-safe, no nitro needed). */
export const LOADING_FRAMES = Object.freeze(['◐', '◓', '◑', '◒']);

/** A small pool of celebratory sticker-like unicode bursts. */
export const EMOJI_BURSTS = Object.freeze([
  '🎉 🎊 ✨ 🎈 🎇',
  '✨ 🌟 💫 ⭐ ✨',
  '🎊 🥳 🎉 🪅 🎁',
  '🚀 💫 🌠 ☄️ 🛸',
]);

/**
 * Resolve the effective GIF pool for a guild: custom GIFs (if configured)
 * take priority over the theme collection.
 *
 * @param {object} welcomeSettings  settings.welcome from settingsStore.
 * @returns {string[]}
 */
export function getGifPool(welcomeSettings) {
  const custom = Array.isArray(welcomeSettings.customGifs) ? welcomeSettings.customGifs.filter(Boolean) : [];
  if (custom.length > 0) return custom;
  return getTheme(welcomeSettings.theme).gifs;
}

/**
 * Pick a welcome GIF for a guild.
 *   - When randomGif is enabled: uniformly random, avoiding the previously
 *     served GIF when the pool has 2+ entries (no consecutive repetition).
 *   - When disabled: always the first GIF in the pool (stable branding).
 *
 * @param {string} guildId
 * @param {object} welcomeSettings  settings.welcome from settingsStore.
 * @returns {string} GIF URL.
 */
export function pickWelcomeGif(guildId, welcomeSettings) {
  const pool = getGifPool(welcomeSettings);
  if (pool.length === 0) return '';
  if (!welcomeSettings.randomGif || pool.length === 1) return pool[0];

  const previous = lastServed.get(guildId);
  const candidates = pool.filter((url) => url !== previous);
  const source = candidates.length > 0 ? candidates : pool;
  const choice = source[Math.floor(Math.random() * source.length)];

  lastServed.set(guildId, choice);
  return choice;
}

/**
 * Pick a random emoji burst (sticker-style decoration line).
 * @returns {string}
 */
export function pickEmojiBurst() {
  return EMOJI_BURSTS[Math.floor(Math.random() * EMOJI_BURSTS.length)];
}

/**
 * Try to find a guild sticker suitable for welcoming. Returns the first
 * available guild sticker (Discord bots can only send stickers from the
 * same guild). Best-effort: returns null when none exist.
 *
 * @param {import('discord.js').Guild} guild
 * @returns {import('discord.js').Sticker|null}
 */
export function pickGuildSticker(guild) {
  try {
    const stickers = guild.stickers?.cache;
    if (!stickers || stickers.size === 0) return null;
    // Prefer stickers whose name hints at greeting/welcome/party.
    const preferred = stickers.find((s) => /welcome|hello|hi|wave|party|hype/i.test(s.name));
    return preferred ?? stickers.first();
  } catch {
    return null;
  }
}
