/**
 * index.js
 * ---------------------------------------------------------------------------
 * Application entry point.
 *
 * Boot sequence:
 *   1. Validate required environment variables (fail fast).
 *   2. Create the Discord client.
 *   3. Dynamically load event listeners (handlers/eventHandler.js).
 *   4. Dynamically load slash commands (handlers/commandHandler.js).
 *   5. Install process-level safety nets for unhandled errors.
 *   6. Log in to Discord.
 * ---------------------------------------------------------------------------
 */

import { config, validateConfig } from './config.js';
import { createClient } from './client.js';
import { loadEvents } from './handlers/eventHandler.js';
import { loadCommands } from './handlers/commandHandler.js';
import { logger } from './utils/logger.js';

async function bootstrap() {
  // 1. Validate configuration before doing anything else.
  try {
    validateConfig();
  } catch (error) {
    logger.error(`Configuration error: ${error.message}`);
    process.exit(1);
  }

  // 2. Create the client.
  const client = createClient();

  // 3 & 4. Load events and commands.
  await loadEvents(client);
  await loadCommands(client);

  // 5. Global safety nets so one bad handler never kills the process silently.
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled promise rejection: ${reason instanceof Error ? reason.stack : reason}`);
  });
  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception: ${error.stack || error}`);
  });

  // 6. Log in.
  try {
    await client.login(config.token);
  } catch (error) {
    logger.error(`Failed to log in to Discord: ${error.message}`);
    process.exit(1);
  }
}

bootstrap();
