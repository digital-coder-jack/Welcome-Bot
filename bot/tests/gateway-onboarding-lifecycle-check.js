import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repo = path.resolve(new URL('..', import.meta.url).pathname, '..');
const dataDir = path.join(repo, 'bot', 'src', 'database', 'data');
const profilesFile = path.join(dataDir, 'member-profiles.json');
const settingsFile = path.join(dataDir, 'settings.json');
let originalProfiles = null;
let originalSettings = null;
let profilesExisted = false;
let settingsExisted = false;

try {
  for (const [file, label] of [[profilesFile, 'profiles'], [settingsFile, 'settings']]) {
    try {
      const original = await readFile(file);
      if (label === 'profiles') {
        originalProfiles = original;
        profilesExisted = true;
      } else {
        originalSettings = original;
        settingsExisted = true;
      }
      throw new Error(`Refusing to run against existing runtime ${label}`);
    } catch (error) {
      if (error.message.startsWith('Refusing')) throw error;
      if (error.code !== 'ENOENT') throw error;
    }
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(profilesFile, '{}');
  await writeFile(settingsFile, JSON.stringify({
    'guild-flow': {
      welcome: { publicEnabled: true, dmEnabled: true, animatedEnabled: false, randomGif: false },
    },
  }, null, 2));

  process.env.GATEWAY_CHANNEL_ID = 'gateway-channel';
  process.env.WELCOME_CHANNEL_ID = 'chill-zone-channel';
  process.env.ONBOARDING_INTEREST_ROLE_IDS = 'AI Enthusiast=interest-role';
  process.env.ONBOARDING_AGE_ROLE_IDS = '18-=age-role';
  process.env.ONBOARDING_EXPERIENCE_ROLE_IDS = 'Beginner=experience-role';

  const { startPostScreeningOnboarding, completePostScreeningOnboarding } = await import('../src/managers/introductionManager.js');
  const { handleOnboardingInteraction } = await import('../src/managers/onboardingManager.js');
  const { getProfile } = await import('../src/database/profileStore.js');

  const channels = [];
  const roles = new Map();
  const member = {
    id: 'flow-user',
    displayName: 'Flow User',
    joinedTimestamp: Date.now(),
    toString: () => '<@flow-user>',
    user: {
      id: 'flow-user',
      username: 'flow-user',
      globalName: 'Flow User',
      tag: 'flow-user#0001',
      bot: false,
      createdTimestamp: Date.now() - 86_400_000,
      displayAvatarURL: () => 'https://cdn.example.test/avatar.png',
    },
    async send(payload) {
      channels.push({ name: 'dm', payload });
      return { id: 'dm-message' };
    },
    roles: {
      cache: roles,
      async add(role) { roles.set(role.id, role); },
      async remove(role) { roles.delete(role.id); },
      highest: { id: 'guild-flow', name: '@everyone' },
    },
    guild: {
      id: 'guild-flow',
      name: 'Flow Guild',
      memberCount: 4,
      iconURL: () => null,
      channels: {
        async fetch(id) {
          return {
            isTextBased: () => true,
            async send(payload) {
              channels.push({ name: id, payload });
              return { id: `${id}-message` };
            },
          };
        },
      },
      roles: {
        async fetch(id) { return { id, name: id }; },
      },
      members: { async fetch() { return member; } },
    },
  };

  const started = await startPostScreeningOnboarding(member);
  assert.equal(started.started, true);
  assert.equal(channels[0].name, 'gateway-channel');
  assert.equal(channels[0].payload.components[0].toJSON().components[0].custom_id, 'onboarding:flow-user:interests');

  async function interaction(step, values) {
    const edits = [];
    await handleOnboardingInteraction({
      customId: `onboarding:flow-user:${step}`,
      user: { id: 'flow-user' },
      guild: member.guild,
      values,
      replied: false,
      deferred: false,
      async deferUpdate() {},
      async editReply(payload) { edits.push(payload); },
      async reply() {},
      async followUp() {},
    });
    return edits.at(-1);
  }

  await interaction('interests', ['AI Enthusiast']);
  await interaction('age', ['18-']);
  const finalReply = await interaction('experience', ['Beginner']);
  assert.deepEqual(finalReply.components, []);

  const profile = await getProfile('guild-flow', 'flow-user');
  assert.deepEqual(profile.onboarding, {
    interests: ['AI Enthusiast'],
    ageGroup: '18-',
    experience: 'Beginner',
  });
  assert.deepEqual([...roles.keys()], ['interest-role', 'age-role', 'experience-role']);
  assert.equal(channels.at(-3).name, 'dm');
  assert.equal(channels.at(-2).name, 'gateway-channel');
  assert.equal(channels.at(-1).name, 'chill-zone-channel');

  console.log('GATEWAY_ONBOARDING_FIRST=PASS');
  console.log('THREE_STEP_PROFILE_COMPLETION=PASS');
  console.log('DM_GATEWAY_CHILL_ZONE_ORDER=PASS');
} finally {
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (profilesExisted) await writeFile(profilesFile, originalProfiles);
  else await rm(profilesFile, { force: true });
  if (settingsExisted) await writeFile(settingsFile, originalSettings);
  else await rm(settingsFile, { force: true });
  try {
    if ((await readdir(dataDir)).length === 0) await rm(dataDir, { recursive: true, force: true });
  } catch {}
}
