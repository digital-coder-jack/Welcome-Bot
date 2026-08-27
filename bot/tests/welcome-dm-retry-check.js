import assert from 'node:assert/strict';

const { sendMemberIntroduction } = await import('../src/managers/introductionManager.js');

let sendCount = 0;
const member = {
  id: 'user-dm-retry',
  displayName: 'DM Retry User',
  joinedTimestamp: Date.now(),
  user: {
    id: 'user-dm-retry',
    tag: 'dm-retry#0001',
    username: 'dm-retry',
    globalName: 'DM Retry User',
    bot: false,
    createdTimestamp: Date.now() - 86_400_000,
    displayAvatarURL: () => 'https://cdn.example.test/avatar.png',
  },
  guild: {
    id: 'guild-dm-retry',
    name: 'DM Retry Guild',
    memberCount: 5,
    iconURL: () => null,
  },
  async send() {
    sendCount += 1;
    if (sendCount === 1) throw new Error('Temporary DM delivery failure');
    return { id: `dm-${sendCount}` };
  },
};

const first = await sendMemberIntroduction(member, { source: 'audit' });
assert.equal(first.sent, true);
assert.equal(first.dmStatus, 'Failed (DMs closed)');
assert.equal(sendCount, 1);

const retry = await sendMemberIntroduction(member, { source: 'audit-retry' });
assert.equal(retry.sent, false);
assert.equal(retry.dmStatus, 'Delivered');
assert.equal(sendCount, 2);

const duplicateAfterDelivery = await sendMemberIntroduction(member, { source: 'audit-duplicate' });
assert.equal(duplicateAfterDelivery.sent, false);
assert.equal(duplicateAfterDelivery.dmStatus, 'Skipped (already introduced)');
assert.equal(sendCount, 2);

console.log('WELCOME_DM_FAILURE_RETRY=PASS');
console.log('WELCOME_INTRODUCTION_DEDUPE_PRESERVED=PASS');
