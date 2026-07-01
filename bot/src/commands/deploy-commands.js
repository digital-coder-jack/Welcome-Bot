/**
 * commands/deploy-commands.js
 * ---------------------------------------------------------------------------
 * Registers the bot's slash commands with Discord's API.
 *
 * Run with:  npm run deploy
 *
 * - If GUILD_ID is set, commands are registered to that single guild. Guild
 *   commands update INSTANTLY and are ideal for development.
 * - If GUILD_ID is empty, commands are registered GLOBALLY. Global commands
 *   can take up to ~1 hour to propagate and are used for production.
 *
 * This script reads every command module's `data` export, so it always stays
 * in sync with the actual commands the bot loads at runtime.
 * ---------------------------------------------------------------------------
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REST, Routes } from 'discord.js';
import { config, validateConfig } from '../config.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IGNORE = new Set(['deploy-commands.js']);

/** Collect the JSON definition of every command module. */
async function collectCommands() {
  const files = (await fs.readdir(__dirname)).filter((f) => f.endsWith('.js') && !IGNORE.has(f));
  const commands = [];

  for (const file of files) {
    const module = await import(pathToFileURL(path.join(__dirname, file)).href);
    if (module.data && typeof module.execute === 'function') {
      commands.push(module.data.toJSON());
    } else {
      logger.warn(`Skipping ${file}: missing data/execute export.`);
    }
  }
  return commands;
}

async function main() {
  validateConfig();

  const commands = await collectCommands();
  logger.info(`Preparing to register ${commands.length} command(s).`);

  const rest = new REST({ version: '10' }).setToken(config.token);

  try {
    if (config.guildId) {
      await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
      logger.success(`Registered ${commands.length} guild command(s) to guild ${config.guildId}.`);
    } else {
      await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
      logger.success(`Registered ${commands.length} global command(s). (May take up to 1 hour to appear.)`);
    }
  } catch (error) {
    logger.error(`Failed to register commands: ${error.stack || error}`);
    process.exit(1);
  }
}

main();
