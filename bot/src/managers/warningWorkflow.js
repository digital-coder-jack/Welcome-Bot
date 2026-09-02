/**
 * Phase 2 warning lifecycle controls.
 * Appeals are member-owned; review actions require existing moderator permissions.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  addWarningNote,
  appealWarning,
  dismissWarning,
  findWarningById,
  getWarningById,
  updateWarning,
} from '../database/warningStore.js';

export const WARNING_PREFIX = 'warning';

export function reviewRow(warningId, userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${WARNING_PREFIX}:confirm:${warningId}:${userId}`).setLabel('Confirm Warning').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${WARNING_PREFIX}:dismiss:${warningId}:${userId}`).setLabel('Dismiss False Positive').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${WARNING_PREFIX}:note:${warningId}:${userId}`).setLabel('Add Review Note').setStyle(ButtonStyle.Secondary),
  );
}

function isModerator(interaction) {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator),
  );
}

export async function handleWarningInteraction(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[1];
  const warningId = parts[2];
  const targetUserId = parts[3];

  if (interaction.isButton() && action === 'appeal') {
    const found = await findWarningById(interaction.user.id, warningId);
    if (!found) return interaction.reply({ content: 'This warning could not be found.', ephemeral: true });
    if (found.warning.userId !== interaction.user.id) return interaction.reply({ content: 'You can only appeal your own warning.', ephemeral: true });
    const modal = new ModalBuilder().setCustomId(`${WARNING_PREFIX}:appeal-submit:${warningId}`).setTitle('Appeal Warning');
    const input = new TextInputBuilder()
      .setCustomId('appeal_reason')
      .setLabel('Why was this warning incorrect?')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1000);
    return interaction.showModal(modal.addComponents(new ActionRowBuilder().addComponents(input)));
  }

  if (interaction.isModalSubmit() && action === 'appeal-submit') {
    const found = await findWarningById(interaction.user.id, warningId);
    if (!found || found.warning.userId !== interaction.user.id) {
      return interaction.reply({ content: 'This warning could not be found.', ephemeral: true });
    }
    if (found.warning.status === 'dismissed') return interaction.reply({ content: 'This warning has already been dismissed.', ephemeral: true });
    await appealWarning(found.guildId, interaction.user.id, warningId, interaction.fields.getTextInputValue('appeal_reason'));
    return interaction.reply({ content: 'Your appeal was submitted privately for moderator review.', ephemeral: true });
  }

  if (!interaction.guild || !isModerator(interaction)) {
    return interaction.reply({ content: 'Only authorized moderators can review warnings.', ephemeral: true });
  }
  const warning = await getWarningById(interaction.guild.id, targetUserId, warningId);
  if (!warning) return interaction.reply({ content: 'Warning not found.', ephemeral: true });

  if (action === 'dismiss') {
    await dismissWarning(interaction.guild.id, targetUserId, warningId, {
      moderatorId: interaction.user.id,
      moderatorTag: interaction.user.tag,
      reason: 'Dismissed by moderator review',
    });
    return interaction.update({ content: 'Warning dismissed as a false positive. Historical evidence was retained.', components: [] });
  }
  if (action === 'confirm') {
    await updateWarning(interaction.guild.id, targetUserId, warningId, {
      status: 'reviewed',
      reviewedBy: interaction.user.id,
      reviewedByTag: interaction.user.tag,
      reviewedAt: new Date().toISOString(),
    });
    return interaction.update({ content: 'Warning confirmed and marked reviewed.', components: [] });
  }
  if (action === 'note') {
    const modal = new ModalBuilder().setCustomId(`${WARNING_PREFIX}:note-submit:${warningId}:${targetUserId}`).setTitle('Internal Review Note');
    const input = new TextInputBuilder().setCustomId('review_note').setLabel('Internal note').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500);
    return interaction.showModal(modal.addComponents(new ActionRowBuilder().addComponents(input)));
  }
  if (action === 'note-submit' && interaction.isModalSubmit()) {
    await addWarningNote(interaction.guild.id, targetUserId, warningId, {
      moderatorId: interaction.user.id,
      moderatorTag: interaction.user.tag,
      note: interaction.fields.getTextInputValue('review_note'),
    });
    return interaction.reply({ content: 'Internal review note saved.', ephemeral: true });
  }
  return interaction.reply({ content: 'Unknown warning action.', ephemeral: true });
}
