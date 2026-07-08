/**
 * utils/time.js
 * ---------------------------------------------------------------------------
 * Small helpers for formatting timestamps and durations in a human-readable
 * way. Used by the welcome system and Telegram notification payloads.
 * ---------------------------------------------------------------------------
 */

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_MONTH = 30 * MS_PER_DAY;
const MS_PER_YEAR = 365 * MS_PER_DAY;

/**
 * Format a millisecond duration as a compact human string, e.g.
 *   "2 years, 3 months" / "5 days, 4 hours" / "12 minutes".
 *
 * @param {number} ms  Duration in milliseconds (negative values clamp to 0).
 * @returns {string}
 */
export function formatDuration(ms) {
  let remaining = Math.max(0, ms);

  const years = Math.floor(remaining / MS_PER_YEAR);
  remaining -= years * MS_PER_YEAR;
  const months = Math.floor(remaining / MS_PER_MONTH);
  remaining -= months * MS_PER_MONTH;
  const days = Math.floor(remaining / MS_PER_DAY);
  remaining -= days * MS_PER_DAY;
  const hours = Math.floor(remaining / MS_PER_HOUR);
  remaining -= hours * MS_PER_HOUR;
  const minutes = Math.floor(remaining / MS_PER_MINUTE);

  const parts = [];
  if (years) parts.push(`${years} year${years === 1 ? '' : 's'}`);
  if (months) parts.push(`${months} month${months === 1 ? '' : 's'}`);
  if (!years && days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (!years && !months && hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (!years && !months && !days && minutes) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);

  if (parts.length === 0) return 'less than a minute';
  return parts.slice(0, 2).join(', ');
}

/**
 * Format an epoch-ms timestamp as a readable UTC string, e.g.
 *   "2026-07-08 18:30 UTC".
 *
 * @param {number|Date} value  Epoch milliseconds or a Date.
 * @returns {string}
 */
export function formatUTC(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  const iso = date.toISOString(); // 2026-07-08T18:30:12.345Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * Human-readable account age from a creation timestamp until now.
 * @param {number} createdTimestamp  Epoch milliseconds of account creation.
 * @returns {string}
 */
export function accountAge(createdTimestamp) {
  return formatDuration(Date.now() - createdTimestamp);
}
