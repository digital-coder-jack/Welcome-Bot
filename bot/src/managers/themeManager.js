/**
 * managers/themeManager.js
 * ---------------------------------------------------------------------------
 * Welcome-theme registry. A theme controls every visual aspect of the
 * welcome experience:
 *   - Embed colours (primary + accent used across frames)
 *   - The GIF collection (see gifManager.js for random selection)
 *   - Emoji style (decorative emoji set used in embeds)
 *   - Button emojis / labels
 *   - The divider line used in the "premium" formatting
 *
 * Available themes: cyber-blue, discord-purple, galaxy, dark-neon,
 * developer, ai, minimal, space.
 * ---------------------------------------------------------------------------
 */

/**
 * @typedef {object} WelcomeTheme
 * @property {string}   id
 * @property {string}   name       Human-readable name.
 * @property {number}   color      Primary embed colour.
 * @property {number}   accent     Accent colour (final animation frame).
 * @property {string[]} gifs       Welcome GIF pool.
 * @property {string}   divider    Decorative divider line.
 * @property {object}   emojis     Decorative emoji set.
 * @property {object}   buttons    Button emoji overrides.
 */

/** @type {Record<string, WelcomeTheme>} */
const THEMES = {
  'cyber-blue': {
    id: 'cyber-blue',
    name: 'Cyber Blue',
    color: 0x00b3ff,
    accent: 0x00ffe0,
    divider: '🔷━━━━━━━━━━━━━━━━━━━━━━🔷',
    emojis: { spark: '⚡', star: '🔹', rocket: '🚀', wave: '🤖', party: '💠', heart: '💙', shield: '🛡️', chat: '💬', game: '🎮', book: '📖' },
    buttons: { rules: '📖', intro: '💬', community: '🎮', website: '🌐' },
    gifs: [
      'https://media.giphy.com/media/26tn33aiTi1jkl6H6/giphy.gif',
      'https://media.giphy.com/media/077i6AULCXc0FKTj9s/giphy.gif',
      'https://media.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif',
      'https://media.giphy.com/media/l0HlHFRbmaZtBRhXG/giphy.gif',
      'https://media.giphy.com/media/3o7btPCcdNniyf0ArS/giphy.gif',
    ],
  },
  'discord-purple': {
    id: 'discord-purple',
    name: 'Discord Purple',
    color: 0x5865f2,
    accent: 0xeb459e,
    divider: '🎉━━━━━━━━━━━━━━━━━━━━━━🎉',
    emojis: { spark: '✨', star: '🌟', rocket: '🚀', wave: '👋', party: '🎉', heart: '❤️', shield: '🛡️', chat: '💬', game: '🎮', book: '📖' },
    buttons: { rules: '📖', intro: '💬', community: '🎮', website: '🌐' },
    gifs: [
      'https://media.giphy.com/media/xT9IgG50Fb7Mi0prBC/giphy.gif',
      'https://media.giphy.com/media/l4pTfx2qLszoacZRS/giphy.gif',
      'https://media.giphy.com/media/g9582DNuQppxC/giphy.gif',
      'https://media.giphy.com/media/OkJat1YNdoD3W/giphy.gif',
      'https://media.giphy.com/media/26FPJGjhefSJuaRhu/giphy.gif',
    ],
  },
  galaxy: {
    id: 'galaxy',
    name: 'Galaxy',
    color: 0x6a0dad,
    accent: 0x9b59b6,
    divider: '🌌━━━━━━━━━━━━━━━━━━━━━━🌌',
    emojis: { spark: '💫', star: '🌠', rocket: '🚀', wave: '👋', party: '🌌', heart: '💜', shield: '🛡️', chat: '💬', game: '🎮', book: '📖' },
    buttons: { rules: '📖', intro: '💬', community: '🔭', website: '🌐' },
    gifs: [
      'https://media.giphy.com/media/U3qYN8S0j3bpK/giphy.gif',
      'https://media.giphy.com/media/l3vRfNA1p0rvhMSvS/giphy.gif',
      'https://media.giphy.com/media/xTiTnHXbRoaZ1B1Mo8/giphy.gif',
      'https://media.giphy.com/media/3o7TKMt1VVNkHV2PaE/giphy.gif',
      'https://media.giphy.com/media/l0Exk8EUzSLsrErEQ/giphy.gif',
    ],
  },
  'dark-neon': {
    id: 'dark-neon',
    name: 'Dark Neon',
    color: 0xff00ff,
    accent: 0x00ff9f,
    divider: '🟣━━━━━━━━━━━━━━━━━━━━━━🟣',
    emojis: { spark: '⚡', star: '🔮', rocket: '🚀', wave: '😎', party: '🪩', heart: '🖤', shield: '🛡️', chat: '💬', game: '🕹️', book: '📖' },
    buttons: { rules: '📖', intro: '💬', community: '🕹️', website: '🌐' },
    gifs: [
      'https://media.giphy.com/media/3o7aCTfyhYawdOXcFW/giphy.gif',
      'https://media.giphy.com/media/xT9IgIc0lryrxvqVGM/giphy.gif',
      'https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif',
      'https://media.giphy.com/media/26BROrSHlmyzzHf3i/giphy.gif',
      'https://media.giphy.com/media/YnBntKOgnUSBkV7bQH/giphy.gif',
    ],
  },
  developer: {
    id: 'developer',
    name: 'Developer',
    color: 0x2b2d31,
    accent: 0x57f287,
    divider: '⌨️━━━━━━━━━━━━━━━━━━━━━━⌨️',
    emojis: { spark: '💻', star: '🧑‍💻', rocket: '🚀', wave: '👨‍💻', party: '🎊', heart: '💚', shield: '🛡️', chat: '💬', game: '🧩', book: '📖' },
    buttons: { rules: '📖', intro: '💬', community: '🧩', website: '🌐' },
    gifs: [
      'https://media.giphy.com/media/qgQUggAC3Pfv687qPC/giphy.gif',
      'https://media.giphy.com/media/13HgwGsXF0aiGY/giphy.gif',
      'https://media.giphy.com/media/ZVik7pBtu9dNS/giphy.gif',
      'https://media.giphy.com/media/LmNwrBhejkK9EFP504/giphy.gif',
      'https://media.giphy.com/media/juua9i2c2fA0AIp2iq/giphy.gif',
    ],
  },
  ai: {
    id: 'ai',
    name: 'AI',
    color: 0x10a37f,
    accent: 0x74aa9c,
    divider: '🤖━━━━━━━━━━━━━━━━━━━━━━🤖',
    emojis: { spark: '🧠', star: '✨', rocket: '🚀', wave: '🤖', party: '🎉', heart: '💚', shield: '🛡️', chat: '💬', game: '🎮', book: '📖' },
    buttons: { rules: '📖', intro: '💬', community: '🧠', website: '🌐' },
    gifs: [
      'https://media.giphy.com/media/LMcB8XospGZO8UQq87/giphy.gif',
      'https://media.giphy.com/media/S60CrN9iMxFlyp7uM8/giphy.gif',
      'https://media.giphy.com/media/7VzgMsB6FLCilwS30v/giphy.gif',
      'https://media.giphy.com/media/l46Cy1rHbQ92uuLXa/giphy.gif',
      'https://media.giphy.com/media/xT9C25UNTwfZuk85WP/giphy.gif',
    ],
  },
  minimal: {
    id: 'minimal',
    name: 'Minimal',
    color: 0xffffff,
    accent: 0xbdbdbd,
    divider: '──────────────────────────',
    emojis: { spark: '✦', star: '•', rocket: '→', wave: '👋', party: '✦', heart: '♡', shield: '🛡', chat: '💬', game: '🎮', book: '📖' },
    buttons: { rules: '📖', intro: '💬', community: '🎮', website: '🌐' },
    gifs: [
      'https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif',
      'https://media.giphy.com/media/l0MYGb1LuZ3n7dRnO/giphy.gif',
      'https://media.giphy.com/media/xUPGcguWZHRC2HyBRS/giphy.gif',
      'https://media.giphy.com/media/26gsjCZpPolPr3sBy/giphy.gif',
      'https://media.giphy.com/media/3ohzdIuqJoo8QdKlnW/giphy.gif',
    ],
  },
  space: {
    id: 'space',
    name: 'Space',
    color: 0x0b3d91,
    accent: 0xfc3d21,
    divider: '🪐━━━━━━━━━━━━━━━━━━━━━━🪐',
    emojis: { spark: '☄️', star: '⭐', rocket: '🚀', wave: '👨‍🚀', party: '🛸', heart: '💫', shield: '🛡️', chat: '💬', game: '🎮', book: '📖' },
    buttons: { rules: '📖', intro: '💬', community: '🛸', website: '🌐' },
    gifs: [
      'https://media.giphy.com/media/3o7btNa0RUYa5E7iiQ/giphy.gif',
      'https://media.giphy.com/media/l0HU7JI1nzEHZbCXC/giphy.gif',
      'https://media.giphy.com/media/lXiRm5H49zYmHr3i0/giphy.gif',
      'https://media.giphy.com/media/eIm5RIMG6eNni/giphy.gif',
      'https://media.giphy.com/media/B0vFTrb0ZGDf2/giphy.gif',
    ],
  },
};

/** Fallback used whenever a configured theme id is unknown. */
const FALLBACK_THEME_ID = 'discord-purple';

/** List of valid theme ids (for slash-command choices & validation). */
export const THEME_IDS = Object.freeze(Object.keys(THEMES));

/** Choices array ready to feed into a SlashCommandBuilder string option. */
export const THEME_CHOICES = Object.freeze(
  Object.values(THEMES).map((t) => ({ name: t.name, value: t.id }))
);

/**
 * Resolve a theme by id, falling back to the default theme.
 * @param {string} themeId
 * @returns {WelcomeTheme}
 */
export function getTheme(themeId) {
  return THEMES[themeId] ?? THEMES[FALLBACK_THEME_ID];
}

/**
 * Whether a theme id is valid.
 * @param {string} themeId
 * @returns {boolean}
 */
export function isValidTheme(themeId) {
  return Boolean(THEMES[themeId]);
}
