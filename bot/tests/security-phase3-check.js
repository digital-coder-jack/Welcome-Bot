import assert from 'node:assert/strict';
import test from 'node:test';
import { detectExcessiveMentions } from '../src/filters/index.js';
import { detectScamContent } from '../src/security/threatDetectors.js';
import {
  claimSecurityAlert,
  expireSecurityAlert,
  findSecurityAlertByEvent,
  resolveSecurityAlert,
  saveSecurityAlert,
} from '../src/database/securityAlertStore.js';

const suffix = `${process.pid}-${Date.now()}`;

function message(content, { everyone = false, users = 0, roles = 0 } = {}) {
  return {
    content,
    mentions: {
      everyone,
      users: { size: users },
      roles: { size: roles },
    },
  };
}

test('normal conversation and allowed social links are not threat detections', () => {
  assert.equal(detectScamContent(message('Bro ye kya bakwas hai 😂')), null);
  assert.equal(detectScamContent(message('Check https://www.youtube.com/watch?v=example')), null);
});

test('clear malicious content and mass mentions remain detectable', () => {
  const verdict = detectScamContent(message('Claim free Discord Nitro at https://discord-nitro.xyz/gift'));
  assert.equal(verdict.type, 'scam-link');
  assert.equal(detectExcessiveMentions(message('hello', { users: 1 })), null);
  assert.equal(detectExcessiveMentions(message('@everyone', { everyone: true })).rule, 4);
});

test('strict alert state is persistent and approval is exactly once', async () => {
  const alertId = `SEC-TEST-${suffix}`;
  const eventId = `event-${suffix}`;
  await saveSecurityAlert({
    alertId,
    eventId,
    guildId: 'guild-test',
    userId: 'user-test',
    createdAt: Date.now(),
    ttlMs: 60_000,
    status: 'PENDING',
  });
  assert.equal((await findSecurityAlertByEvent(eventId)).alertId, alertId);
  assert.equal((await claimSecurityAlert(alertId, 'approve')).status, 'APPROVED_PROCESSING');
  assert.equal(await claimSecurityAlert(alertId, 'approve'), null);
  await resolveSecurityAlert(alertId, { status: 'ACTION_EXECUTED', resolvedBy: 'owner-test' });
  assert.equal(await claimSecurityAlert(alertId, 'approve'), null);
});

test('expired strict alerts cannot be claimed', async () => {
  const alertId = `SEC-EXPIRE-${suffix}`;
  await saveSecurityAlert({
    alertId,
    guildId: 'guild-test',
    userId: 'user-test',
    createdAt: Date.now() - 120_000,
    ttlMs: 60_000,
    status: 'PENDING',
  });
  const expired = await expireSecurityAlert(alertId);
  assert.equal(expired.status, 'EXPIRED');
  assert.equal(await claimSecurityAlert(alertId, 'approve'), null);
});
