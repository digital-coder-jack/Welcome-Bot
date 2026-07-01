/**
 * logger.js
 * ---------------------------------------------------------------------------
 * A minimal, dependency-free structured logger.
 *
 * Provides `info`, `warn`, `error`, `debug` and `success` levels, each with an
 * ISO timestamp and ANSI colour for easy scanning in a terminal. Using a
 * single logger (instead of scattered console.log calls) keeps output format
 * consistent and makes it trivial to redirect logs later.
 * ---------------------------------------------------------------------------
 */

const COLORS = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

/** Format the current time as an ISO string for log prefixes. */
function timestamp() {
  return new Date().toISOString();
}

/**
 * Core log function.
 * @param {string} color  ANSI colour code.
 * @param {string} level  Level label, e.g. "INFO".
 * @param {string} message
 */
function write(color, level, message) {
  const line = `${COLORS.gray}${timestamp()}${COLORS.reset} ${color}[${level}]${COLORS.reset} ${message}`;
  // Errors/warnings go to stderr, everything else to stdout.
  if (level === 'ERROR' || level === 'WARN') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (msg) => write(COLORS.blue, 'INFO', msg),
  success: (msg) => write(COLORS.green, 'OK', msg),
  warn: (msg) => write(COLORS.yellow, 'WARN', msg),
  error: (msg) => write(COLORS.red, 'ERROR', msg),
  debug: (msg) => {
    if (process.env.DEBUG === 'true') write(COLORS.magenta, 'DEBUG', msg);
  },
};
