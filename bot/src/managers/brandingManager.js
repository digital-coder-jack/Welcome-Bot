/**
 * managers/brandingManager.js
 * ---------------------------------------------------------------------------
 * Official Developer's Forge branding — single source of truth.
 *
 * The official community logo is used consistently across the whole
 * welcome/onboarding experience (embed thumbnails, author icons and footer
 * icons). The bot avatar, generic Discord icons and placeholder images are
 * never used.
 *
 * Resilience: the logo URL is validated once, in the background, on first
 * use. If the image cannot be loaded (repo moved, CDN outage, bad override
 * URL), every subsequent embed automatically falls back to the Discord
 * server icon — so onboarding never ships a broken image.
 *
 * The logo can be overridden without a deploy via the FORGE_LOGO_URL env
 * var (exposed as config.branding.forgeLogoUrl).
 * ---------------------------------------------------------------------------
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** Canonical hosted copy of bot/assets/branding/developers-forge-logo.png. */
const DEFAULT_LOGO_URL =
  'https://raw.githubusercontent.com/digital-coder-jack/Welcome-Bot/main/bot/assets/branding/developers-forge-logo.png';

/**
 * Official Developer's Forge visual identity.
 * Frozen so no module can mutate the brand at runtime.
 */
export const FORGE_BRAND = Object.freeze({
  /** Community name. */
  name: "Developer's Forge",
  /** Warm forge amber — premium, dark-mode friendly accent. */
  accent: 0xd97a34,
  /** Official Developer's Forge logo (env override → curated default). */
  logoUrl: config.branding.forgeLogoUrl || DEFAULT_LOGO_URL,
  /** Branded footer line. */
  footer: "Developer's Forge • Learn • Build • Grow",
});

/** How long to wait for the logo availability probe before giving up. */
const PROBE_TIMEOUT_MS = 5000;

/**
 * Logo availability state machine:
 *   'unknown'     → not probed yet (logo is used optimistically)
 *   'checking'    → probe in flight (logo still used optimistically)
 *   'ok'          → confirmed loadable
 *   'unavailable' → confirmed broken → fall back to the server icon
 * @type {'unknown'|'checking'|'ok'|'unavailable'}
 */
let logoState = 'unknown';

/**
 * Probe the logo URL once in the background. Never throws; flips
 * `logoState` to 'ok' or 'unavailable' when the result is known.
 * @returns {Promise<void>}
 */
async function probeLogoAvailability() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // HEAD is cheapest; some hosts reject it, so fall back to a ranged GET.
    let res = await fetch(FORGE_BRAND.logoUrl, { method: 'HEAD', signal: controller.signal });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(FORGE_BRAND.logoUrl, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: controller.signal,
      });
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (res.ok && (contentType.startsWith('image/') || contentType === '')) {
      logoState = 'ok';
      logger.debug('Developer\u2019s Forge logo verified — official branding active.');
    } else {
      logoState = 'unavailable';
      logger.warn(
        `Developer's Forge logo unreachable (HTTP ${res.status}) — falling back to the server icon.`
      );
    }
  } catch (error) {
    logoState = 'unavailable';
    logger.warn(`Developer's Forge logo probe failed (${error.message}) — falling back to the server icon.`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the icon URL to use for embed author/footer icons and thumbnails.
 *
 * Returns the official Developer's Forge logo; if the logo has been
 * confirmed unloadable, returns the Discord server icon instead. Never
 * returns the bot avatar or a placeholder.
 *
 * @param {import('discord.js').Guild|null|undefined} guild  Fallback icon source.
 * @param {number} [size=128]  Fallback server-icon size.
 * @returns {string|undefined}
 */
export function brandIcon(guild, size = 128) {
  if (logoState === 'unknown') {
    logoState = 'checking';
    probeLogoAvailability(); // fire-and-forget — deliberately not awaited.
  }
  if (logoState === 'unavailable') {
    return guild?.iconURL?.({ size }) ?? undefined;
  }
  return FORGE_BRAND.logoUrl;
}
