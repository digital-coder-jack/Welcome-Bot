/**
 * eventHandler.js
 * ---------------------------------------------------------------------------
 * Dynamically loads every event module from src/events/ and binds it to the
 * client.
 *
 * Each event file must default-export an object of the shape:
 *   { name: string, once?: boolean, execute: (...args) => any }
 *
 * `name`  = a discord.js Events value (e.g. Events.ClientReady).
 * `once`  = register with client.once instead of client.on.
 *
 * Adding a new event handler is as simple as creating a new file in
 * src/events/ — no manual registration required.
 * ---------------------------------------------------------------------------
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVENTS_DIR = path.join(__dirname, '..', 'events');

/**
 * Load and register all event modules.
 * @param {import('discord.js').Client} client
 */
export async function loadEvents(client) {
  let files;
  try {
    files = (await fs.readdir(EVENTS_DIR)).filter((f) => f.endsWith('.js'));
  } catch (error) {
    logger.error(`Could not read events directory: ${error.message}`);
    return;
  }

  let loaded = 0;
  for (const file of files) {
    const fileUrl = pathToFileURL(path.join(EVENTS_DIR, file)).href;
    try {
      const module = await import(fileUrl);
      const event = module.default;

      if (!event?.name || typeof event.execute !== 'function') {
        logger.warn(`Skipping invalid event file: ${file}`);
        continue;
      }

      // Wrap execute so one throwing handler can't crash the process.
      const safeExecute = async (...args) => {
        try {
          await event.execute(...args, client);
        } catch (error) {
          logger.error(`Error in event "${event.name}": ${error.stack || error}`);
        }
      };

      if (event.once) {
        client.once(event.name, safeExecute);
      } else {
        client.on(event.name, safeExecute);
      }
      loaded += 1;
    } catch (error) {
      logger.error(`Failed to load event ${file}: ${error.message}`);
    }
  }

  logger.success(`Loaded ${loaded} event handler(s).`);
}
