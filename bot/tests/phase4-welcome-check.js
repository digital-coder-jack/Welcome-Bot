import assert from 'node:assert/strict';
import test from 'node:test';
import { ButtonBuilder } from 'discord.js';

process.env.WELCOME_CHANNEL_ID = 'welcome-channel';
process.env.RULES_CHANNEL_ID = 'rules-channel';
process.env.DEV_INTRO_CHANNEL_ID = 'intro-channel';
process.env.COMMUNITY_CHANNEL_ID = 'community-channel';
process.env.SUPPORT_CHANNEL_ID = 'support-channel';

const { buildWelcomeButtons, premiumWelcomeEmbed } = await import('../src/managers/welcomeManager.js');
const { toBalancedRows, premiumWelcomeDMEmbed } = await import('../src/managers/dmManager.js');
const { isDuplicateActiveJoin } = await import('../src/database/memberStore.js');

function fakeGuild() {
  return {
    id: 'guild-phase4',
    name: 'Forge Community',
    memberCount: 42,
    iconURL: () => null,
  };
}

function fakeMember() {
  return {
    id: 'member-phase4',
    displayName: 'Alex',
    user: {
      username: 'alex',
      globalName: 'Alex',
      createdTimestamp: Date.now() - 86_400_000,
      displayAvatarURL: () => 'https://cdn.example/avatar.png',
    },
    guild: fakeGuild(),
    joinedTimestamp: Date.now(),
    pending: false,
  };
}

test('welcome guidance uses configured channels and omits unavailable destinations', () => {
  const row = buildWelcomeButtons(fakeGuild(), {
    buttons: { rules: '📖', intro: '👋', community: '💬', website: '🌐' },
  }, {});
  const buttons = row.toJSON().components;
  assert.deepEqual(buttons.map((button) => button.label), ['Rules', 'Introduce Yourself', 'Community', 'Support']);
  assert.ok(buttons.every((button) => button.url.includes('guild-phase4')));
  assert.ok(!buttons.some((button) => button.url.endsWith('/welcome-channel')));
});

test('welcome embeds remain concise and use real member/server information', () => {
  const member = fakeMember();
  const publicEmbed = premiumWelcomeEmbed(member, {
    accent: 0xffaa00,
    color: 0xffaa00,
    name: 'Forge',
    divider: '---',
    emojis: { wave: '👋', spark: '✨', star: '⭐', book: '📖', chat: '💬', game: '🎮', shield: '🛡️', heart: '❤️' },
  }, null).toJSON();
  assert.match(publicEmbed.title, /Alex/);
  assert.match(publicEmbed.author.name, /^Forge Community/);
  assert.ok(publicEmbed.description.length < 1500);
  const dmEmbed = premiumWelcomeDMEmbed(member).toJSON();
  assert.equal(dmEmbed.author.name, 'Forge Community');
});

test('DM button rows stay touch-friendly and balanced', () => {
  const buttons = Array.from({ length: 5 }, (_, index) => new ButtonBuilder().setLabel(`Button ${index}`));
  const rows = toBalancedRows(buttons).map((row) => row.toJSON());
  assert.deepEqual(rows.map((row) => row.components.length), [3, 2]);
});

test('restart-safe active join duplicate helper is present and safe for unknown members', async () => {
  assert.equal(typeof isDuplicateActiveJoin, 'function');
  assert.equal(await isDuplicateActiveJoin('missing-guild', 'missing-user', Date.now()), false);
  assert.equal(await isDuplicateActiveJoin('missing-guild', 'missing-user', null), false);
});
