/**
 * commands/onboarding.js
 * ---------------------------------------------------------------------------
 * Starts the private, three-step Discord onboarding selection flow.
 * ---------------------------------------------------------------------------
 */

import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildInterestsMenu } from '../managers/onboardingManager.js';

export const data = new SlashCommandBuilder()
  .setName('onboarding')
  .setDescription('Choose your interests, age group, and experience level.')
  .setDMPermission(false);

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  await interaction.reply({
    content:
      '## Developer Forge Onboarding\n' +
      'Choose your interests below. You may select multiple options; the next steps will ask for one age group and one experience level.',
    components: [buildInterestsMenu(interaction.user.id)],
    flags: MessageFlags.Ephemeral,
  });
}
