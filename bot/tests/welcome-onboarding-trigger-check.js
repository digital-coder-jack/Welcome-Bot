import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repo = path.resolve(new URL('..', import.meta.url).pathname, '..');
const dataDir = path.join(repo, 'bot', 'src', 'database', 'data');
const settingsFile = path.join(dataDir, 'settings.json');
let originalSettings = null;
let settingsExisted = false;

try {
  try {
    originalSettings = await readFile(settingsFile);
    settingsExisted = true;
    throw new Error('Refusing to run against existing runtime settings');
  } catch (error) {
    if (error.message === 'Refusing to run against existing runtime settings') throw error;
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(settingsFile, JSON.stringify({
    'guild-welcome': {
      welcome: {
        publicEnabled: true,
        animatedEnabled: false,
        randomGif: false,
      },
    },
  }, null, 2));

  process.env.WELCOME_CHANNEL_ID = 'welcome-channel';
  const { sendPublicWelcome } = await import('../src/managers/welcomeManager.js');
  const sentPayloads = [];
  const channel = {
    isTextBased: () => true,
    async send(payload) {
      sentPayloads.push(payload);
      return { edit: async () => {} };
    },
  };
  const member = {
    id: 'user-welcome',
    displayName: 'Welcome User',
    joinedTimestamp: Date.now(),
    toString: () => '<@user-welcome>',
    user: {
      username: 'welcome-user',
      createdTimestamp: Date.now() - 86_400_000,
      displayAvatarURL: () => 'https://cdn.example.test/avatar.png',
    },
    guild: {
      id: 'guild-welcome',
      name: 'Welcome Guild',
      memberCount: 42,
      iconURL: () => null,
      channels: { fetch: async () => channel },
      stickers: { cache: new Map() },
    },
  };

  await sendPublicWelcome(member);
  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].embeds.length, 1);
  assert.equal(sentPayloads[0].components.length, 2);
  assert.equal(sentPayloads[0].components[1].toJSON().components[0].custom_id, 'onboarding:user-welcome:interests');
  assert.equal(sentPayloads[0].components[1].toJSON().components[0].max_values, 12);

  console.log('PUBLIC_WELCOME_SENDS_ONBOARDING_MENU=PASS');
  console.log('PUBLIC_WELCOME_EMBED_PRESERVED=PASS');
  console.log('PUBLIC_WELCOME_EXISTING_BUTTON_ROW_PRESERVED=PASS');
} finally {
  if (settingsExisted) {
    await writeFile(settingsFile, originalSettings);
  } else {
    await rm(settingsFile, { force: true });
  }
  try {
    const entries = await readdir(dataDir);
    if (entries.length === 0) await rm(dataDir, { recursive: true, force: true });
  } catch {}
}
