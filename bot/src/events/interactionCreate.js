/**
 * events/interactionCreate.js
 * ---------------------------------------------------------------------------
 * Dispatches slash-command interactions to the matching command module loaded
 * into client.commands. Provides consistent, user-friendly error handling so a
 * failing command always sends *some* response instead of hanging.
 * ---------------------------------------------------------------------------
 */

import { Events, MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';
import { handlePanelInteraction, PANEL_PREFIX } from '../managers/approvalSystem.js';
import { handleSecurityAlertInteraction, SECURITY_PREFIX } from '../security/securityAlerts.js';

export default {
  name: Events.InteractionCreate,
  once: false,

  /**
   * @param {import('discord.js').Interaction} interaction
   * @param {import('discord.js').Client} client
   */
  async execute(interaction, client) {
    // --- Forge Guardian v2.0: Security Alert (Owner Approval) buttons ---
    if (interaction.isButton() && interaction.customId.startsWith(`${SECURITY_PREFIX}:`)) {
      try {
        await handleSecurityAlertInteraction(interaction);
      } catch (error) {
        logger.error(`Security alert interaction failed: ${error.stack || error}`);
        const errorReply = {
          content: '\u26A0\uFE0F Something went wrong handling that security action.',
          flags: MessageFlags.Ephemeral,
        };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(errorReply).catch(() => {});
        } else {
          await interaction.reply(errorReply).catch(() => {});
        }
      }
      return;
    }

    // --- Moderation Approval Panel buttons ---
    if (interaction.isButton() && interaction.customId.startsWith(`${PANEL_PREFIX}:`)) {
      try {
        await handlePanelInteraction(interaction);
      } catch (error) {
        logger.error(`Moderation panel interaction failed: ${error.stack || error}`);
        const errorReply = {
          content: '\u26A0\uFE0F Something went wrong handling that moderation action.',
          flags: MessageFlags.Ephemeral,
        };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(errorReply).catch(() => {});
        } else {
          await interaction.reply(errorReply).catch(() => {});
        }
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) {
      logger.warn(`Received unknown command: ${interaction.commandName}`);
      return;
    }

    try {
      await command.execute(interaction, client);
    } catch (error) {
      logger.error(`Command "${interaction.commandName}" failed: ${error.stack || error}`);

      const errorReply = {
        content: '\u26A0\uFE0F Something went wrong while running that command.',
        flags: MessageFlags.Ephemeral,
      };

      // Reply appropriately depending on whether we've already responded.
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorReply).catch(() => {});
      } else {
        await interaction.reply(errorReply).catch(() => {});
      }
    }
  },
};
