/**
 * database/settingsStore.js
 * ---------------------------------------------------------------------------
 * Per-guild configuration store powering the Configuration Dashboard
 * (/welcomeconfig and /securityconfig).
 *
 * Every setting has a sane default so the bot is fully functional with zero
 * configuration; admins can then tune behaviour at runtime without restarts.
 *
 * Data shape on disk (settings.json):
 * {
 *   "<guildId>": {
 *     welcome: { theme, publicEnabled, dmEnabled, animatedEnabled, randomGif,
 *                websiteUrl, customGifs: [] },
 *     farewell: { dmEnabled, inviteUrl, websiteUrl, bannerUrl },
 *     security: { alertChannelId, ownerRoleId, moderatorRoleIds: [],
 *                 warnThreshold, timeoutMinutes, language }
 *   }
 * }
 * ---------------------------------------------------------------------------
 */

import { createJsonStore } from './jsonStore.js';

const store = createJsonStore('settings.json');

/** Default settings applied for any guild that hasn't been configured. */
export const DEFAULT_SETTINGS = Object.freeze({
  welcome: Object.freeze({
    theme: 'discord-purple', // see themeManager.js for available themes
    publicEnabled: true, // send the public welcome message
    dmEnabled: true, // send the welcome DM
    animatedEnabled: true, // cinematic multi-frame welcome animation
    randomGif: true, // pick a random GIF from the theme collection
    websiteUrl: '', // optional 🌐 Website button target
    customGifs: [], // admin-supplied GIF URLs (override theme GIFs)
  }),
  farewell: Object.freeze({
    dmEnabled: true, // send the premium farewell DM on VOLUNTARY leaves
    inviteUrl: '', // 🌐 Rejoin button target (permanent invite link)
    websiteUrl: '', // 📚 Community Website button target (optional)
    bannerUrl: '', // custom large farewell banner (GIF/image URL)
  }),
  security: Object.freeze({
    alertChannelId: '', // dedicated moderation-alert channel (falls back to log channel)
    ownerRoleId: '', // role treated as "owner" besides the actual guild owner
    moderatorRoleIds: [], // roles allowed to use the moderation approval panel
    warnThreshold: 3, // warnings before a moderation panel is raised
    timeoutMinutes: 60, // default duration for the 🕒 Timeout button
    language: 'en', // reserved for future i18n
  }),
});

/** Deep-merge stored settings over the defaults (shallow per section). */
function withDefaults(stored = {}) {
  return {
    welcome: { ...DEFAULT_SETTINGS.welcome, ...(stored.welcome ?? {}) },
    farewell: { ...DEFAULT_SETTINGS.farewell, ...(stored.farewell ?? {}) },
    security: { ...DEFAULT_SETTINGS.security, ...(stored.security ?? {}) },
  };
}

/**
 * Get the effective settings for a guild (defaults merged in).
 * @param {string} guildId
 * @returns {Promise<{welcome: object, security: object}>}
 */
export async function getSettings(guildId) {
  const data = await store.read();
  return withDefaults(data[guildId]);
}

/**
 * Update one settings section for a guild.
 * @param {string} guildId
 * @param {'welcome'|'farewell'|'security'} section
 * @param {object} patch  Partial settings to merge in.
 * @returns {Promise<object>} the new effective settings for that section.
 */
export async function updateSettings(guildId, section, patch) {
  const data = await store.read();
  if (!data[guildId]) data[guildId] = {};
  data[guildId][section] = { ...(data[guildId][section] ?? {}), ...patch };
  store.flush();
  return withDefaults(data[guildId])[section];
}
