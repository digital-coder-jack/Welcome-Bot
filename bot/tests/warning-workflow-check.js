import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addWarning,
  addWarningNote,
  appealWarning,
  clearWarnings,
  countWarnings,
  dismissWarning,
  getWarnings,
} from '../src/database/warningStore.js';
import { reviewRow } from '../src/managers/warningWorkflow.js';

const guildId = `phase2-test-guild-${process.pid}`;
const userId = `phase2-test-user-${process.pid}`;

test('warning history stores evidence and suppresses the same incident', async () => {
  const first = await addWarning({
    guildId,
    userId,
    reason: '[HIGH] targeted harassment',
    moderatorId: 'mod-1',
    moderatorTag: 'Moderator',
    source: 'ai',
    severity: 'high',
    rule: 1,
    ruleTitle: 'Be Respectful',
    offendingMessage: 'You are not welcome here.',
    messageId: 'message-1',
    eventId: 'message-1',
  });
  const duplicate = await addWarning({
    guildId,
    userId,
    reason: 'duplicate retry',
    moderatorId: 'mod-2',
    moderatorTag: 'Retry',
    source: 'ai',
    messageId: 'message-1',
    eventId: 'message-1',
  });

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(first.warning.id, duplicate.warning.id);
  assert.equal(first.warning.status, 'active');
  assert.equal(first.warning.ruleTitle, 'Be Respectful');
  assert.equal(first.warning.offendingMessage, 'You are not welcome here.');
  assert.equal(await countWarnings(guildId, userId), 1);
});

test('appeal, dismissal, and internal notes preserve the historical record', async () => {
  const warning = (await getWarnings(guildId, userId))[0];
  const appealed = await appealWarning(guildId, userId, warning.id, 'I was quoting another message.');
  assert.equal(appealed.status, 'appealed');
  assert.equal(appealed.appeal.userId, userId);
  assert.equal(appealed.offendingMessage, warning.offendingMessage);

  const noted = await addWarningNote(guildId, userId, warning.id, {
    moderatorId: 'mod-1',
    moderatorTag: 'Moderator',
    note: 'Reviewed context.',
  });
  assert.equal(noted.notes.length, 1);
  assert.equal(noted.notes[0].note, 'Reviewed context.');

  const dismissed = await dismissWarning(guildId, userId, warning.id, {
    moderatorId: 'mod-1',
    moderatorTag: 'Moderator',
    reason: 'Confirmed quote/context false positive',
  });
  assert.equal(dismissed.status, 'dismissed');
  assert.equal(dismissed.dismissedBy, 'mod-1');
  assert.equal(await countWarnings(guildId, userId), 0);
  assert.equal((await getWarnings(guildId, userId)).length, 1);
});

test('review controls are explicit moderator actions', () => {
  const row = reviewRow('warning-1', 'user-1').toJSON();
  assert.deepEqual(row.components.map((component) => component.label), [
    'Confirm Warning',
    'Dismiss False Positive',
    'Add Review Note',
  ]);
  assert.ok(row.components.every((component) => component.custom_id.startsWith('warning:')));
});

test.after(async () => {
  await clearWarnings(guildId, userId);
});
