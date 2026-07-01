/**
 * commandHandler.js
 * ---------------------------------------------------------------------------
 * Dynamically loads every slash-command module from src/commands/ into the
 * client's command Collection.
 *
 * Each command file must export:
 *   - `data`    : a SlashCommandBuilder instance (the command definition).
 *   - `execute` : async (interaction, client) => any (the command logic).
 *
 * Files without both exports are skipped. The command deploy script
 * (commands/deploy-commands.js) reads the same `data` exports to register
 * commands with Discord's API.
 * ---------------------------------------------------------------------------
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = path.join(__dirname, '..', 'commands');

/** Files in the commands dir that are NOT commands (loaders/scripts). */
const IGNORE = new Set(['deploy-commands.js']);

/**
 * Load all command modules into client.commands.
 * @param {import('discord.js').Client} client
 */
export async function loadCommands(client) {
  let files;
  try {
    files = (await fs.readdir(COMMANDS_DIR)).filter((f) => f.endsWith('.js') && !IGNORE.has(f));
  } catch (error) {
    logger.error(`Could not read commands directory: ${error.message}`);
    return;
  }

  let loaded = 0;
  for (const file of files) {
    const fileUrl = pathToFileURL(path.join(COMMANDS_DIR, file)).href;
    try {
      const module = await import(fileUrl);
      if (!module.data || typeof module.execute !== 'function') {
        logger.warn(`Skipping invalid command file: ${file}`);
        continue;
      }
      client.commands.set(module.data.name, module);
      loaded += 1;
    } catch (error) {
      logger.error(`Failed to load command ${file}: ${error.message}`);
    }
  }

  logger.success(`Loaded ${loaded} slash command(s).`);
}
