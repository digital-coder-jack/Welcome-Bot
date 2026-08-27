import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(new URL('..', import.meta.url).pathname, '..');
const dataDir = path.join(repo, 'bot', 'src', 'database', 'data');
const dataFile = path.join(dataDir, 'member-profiles.json');
const backupDir = await mkdtemp(path.join(os.tmpdir(), 'welcome-bot-onboarding-'));
const backupFile = path.join(backupDir, 'member-profiles.json');
let original = null;
let existed = false;

try {
  try {
    original = await readFile(dataFile);
    existed = true;
    await writeFile(backupFile, original);
    throw new Error('Refusing to run against an existing runtime profile store');
  } catch (error) {
    if (error.message === 'Refusing to run against an existing runtime profile store') throw error;
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(dataFile, JSON.stringify({
    'guild-1:user-1': {
      guildId: 'guild-1',
      userId: 'user-1',
      identity: { username: 'legacy-user' },
      activity: { messageCount: 4 },
      rolesOutsideOnboarding: ['admin-role', 'staff-role'],
    },
  }, null, 2));

  process.env.ONBOARDING_INTEREST_ROLE_IDS =
    'Cyber Security=interest-cyber,AI Enthusiast=interest-ai,Programmer=interest-programmer';
  process.env.ONBOARDING_AGE_ROLE_IDS = 'Under 13=age-under-13,18+=age-18';
  process.env.ONBOARDING_EXPERIENCE_ROLE_IDS = 'Beginner=exp-beginner,Expert=exp-expert';

  const manager = await import('../src/managers/onboardingManager.js');
  const profileStore = await import('../src/database/profileStore.js');
  const onboardingCommand = await import('../src/commands/onboarding.js');
  assert.equal(onboardingCommand.data.name, 'onboarding');
  assert.equal(onboardingCommand.data.toJSON().dm_permission, false);

  const interestsMenu = manager.buildInterestsMenu('user-1').toJSON().components[0];
  assert.equal(interestsMenu.custom_id, 'onboarding:user-1:interests');
  assert.equal(interestsMenu.min_values, 0);
  assert.equal(interestsMenu.max_values, 12);
  assert.equal(interestsMenu.options.length, 12);
  assert.deepEqual(interestsMenu.options.map((option) => option.label), [
    'Cyber Security', 'AI Enthusiast', 'Web Developer', 'Programmer',
    'Vibe Coder', 'ML Enthusiast', 'Game Developer', 'App Developer',
    'UI/UX Designer', 'DevOps', 'Student', 'Other',
  ]);
  assert.deepEqual(interestsMenu.options.map((option) => option.emoji.name), [
    '🛡️', '🤖', '🌐', '💻', '⚡', '🧠', '🎮', '📱', '🎨', '🔧', '📚', '🔥',
  ]);

  const ageMenu = manager.buildAgeMenu('user-1').toJSON().components[0];
  assert.equal(ageMenu.custom_id, 'onboarding:user-1:age');
  assert.equal(ageMenu.min_values, 1);
  assert.equal(ageMenu.max_values, 1);
  assert.deepEqual(ageMenu.options.map((option) => option.label), ['Under 13', '13–15', '16–17', '18+', 'Prefer not to say']);

  const experienceMenu = manager.buildExperienceMenu('user-1').toJSON().components[0];
  assert.equal(experienceMenu.custom_id, 'onboarding:user-1:experience');
  assert.equal(experienceMenu.min_values, 1);
  assert.equal(experienceMenu.max_values, 1);
  assert.deepEqual(experienceMenu.options.map((option) => option.label), ['Beginner', 'Intermediate', 'Advanced', 'Expert']);
  assert.deepEqual(experienceMenu.options.map((option) => option.emoji.name), ['🌱', '⚙️', '🔥', '👑']);

  assert.equal(manager.validateStepValues('interests', ['Cyber Security', 'AI Enthusiast']).valid, true);
  assert.equal(manager.validateStepValues('interests', []).valid, true);
  assert.equal(manager.validateStepValues('interests', ['Not Allowed']).valid, false);
  assert.equal(manager.validateStepValues('age', ['18+']).valid, true);
  assert.equal(manager.validateStepValues('age', ['18+', '16–17']).valid, false);
  assert.equal(manager.validateStepValues('experience', ['Expert']).valid, true);

  const roleCalls = [];
  const fakeMember = {
    id: 'user-1',
    roles: {
      cache: new Map([
        ['guild-1', { id: 'guild-1', name: '@everyone' }],
        ['interest-cyber', { id: 'interest-cyber', name: 'Cyber Security' }],
        ['age-under-13', { id: 'age-under-13', name: 'Under 13' }],
        ['admin-role', { id: 'admin-role', name: 'Administrator' }],
        ['staff-role', { id: 'staff-role', name: 'Staff' }],
      ]),
      async add(role) { roleCalls.push({ action: 'add', roleId: role.id }); },
      async remove(role) { roleCalls.push({ action: 'remove', roleId: role.id }); },
    },
    guild: {
      id: 'guild-1',
      members: {
        async fetch() { return fakeMember; },
      },
      roles: {
        async fetch(roleId) {
          const roles = {
            'interest-cyber': { id: 'interest-cyber', name: 'Cyber Security' },
            'interest-ai': { id: 'interest-ai', name: 'AI Enthusiast' },
            'interest-programmer': { id: 'interest-programmer', name: 'Programmer' },
            'age-under-13': { id: 'age-under-13', name: 'Under 13' },
            'age-18': { id: 'age-18', name: '18+' },
            'exp-beginner': { id: 'exp-beginner', name: 'Beginner' },
            'exp-expert': { id: 'exp-expert', name: 'Expert' },
          };
          return roles[roleId] ?? null;
        },
      },
    },
  };

  const interestDiff = manager.managedRoleChanges(
    'interests',
    { interests: ['Cyber Security'], ageGroup: 'Under 13', experience: null },
    { interests: ['AI Enthusiast'], ageGroup: 'Under 13', experience: null },
  );
  assert.deepEqual(interestDiff.add, ['interest-ai']);
  assert.deepEqual(interestDiff.remove, ['interest-cyber']);

  const ageDiff = manager.managedRoleChanges(
    'age',
    { interests: ['Cyber Security'], ageGroup: 'Under 13', experience: 'Beginner' },
    { interests: ['Cyber Security'], ageGroup: '18+', experience: 'Beginner' },
  );
  assert.deepEqual(ageDiff.add, ['age-18']);
  assert.deepEqual(ageDiff.remove, ['age-under-13']);
  assert(!ageDiff.remove.includes('admin-role'));
  assert(!ageDiff.remove.includes('staff-role'));

  const experienceDiff = manager.managedRoleChanges(
    'experience',
    { interests: ['Cyber Security'], ageGroup: '18+', experience: 'Beginner' },
    { interests: ['Cyber Security'], ageGroup: '18+', experience: 'Expert' },
  );
  assert.deepEqual(experienceDiff.add, ['exp-expert']);
  assert.deepEqual(experienceDiff.remove, ['exp-beginner']);

  const before = await profileStore.getProfile('guild-1', 'user-1');
  assert.deepEqual(before.onboarding, { interests: [], ageGroup: null, experience: null });
  assert.equal(before.identity.username, 'legacy-user');
  assert.equal(before.activity.messageCount, 4);

  const first = await profileStore.updateOnboardingData('guild-1', 'user-1', {
    interests: ['Cyber Security', 'AI Enthusiast'],
    ageGroup: '18+',
    experience: 'Expert',
  });
  assert.deepEqual(first.onboarding, {
    interests: ['Cyber Security', 'AI Enthusiast'],
    ageGroup: '18+',
    experience: 'Expert',
  });
  assert.equal(first.identity.username, 'legacy-user');
  assert.equal(first.activity.messageCount, 4);

  const second = await profileStore.updateOnboardingData('guild-1', 'user-1', { ageGroup: '16–17' });
  assert.deepEqual(second.onboarding, {
    interests: ['Cyber Security', 'AI Enthusiast'],
    ageGroup: '16–17',
    experience: 'Expert',
  });

  const other = await profileStore.updateOnboardingData('guild-2', 'user-2', {
    interests: ['Programmer'],
    ageGroup: 'Prefer not to say',
    experience: 'Beginner',
  });
  assert.equal(other.guildId, 'guild-2');
  assert.equal(other.userId, 'user-2');

  await profileStore.updateOnboardingData('guild-1', 'user-1', { ageGroup: 'Under 13' });
  const { default: interactionEvent } = await import('../src/events/interactionCreate.js');
  const makeRoutedInteraction = (step, values) => ({
    customId: `onboarding:user-1:${step}`,
    values,
    user: { id: 'user-1' },
    guild: fakeMember.guild,
    replied: false,
    deferred: false,
    isButton: () => false,
    isStringSelectMenu: () => true,
    isChatInputCommand: () => false,
    async deferUpdate() { this.deferred = true; },
    async editReply(payload) { this.editPayload = payload; },
    async reply(payload) { this.replied = true; this.replyPayload = payload; },
    async followUp(payload) { this.followUpPayload = payload; },
  });

  const interestsInteraction = makeRoutedInteraction('interests', ['Programmer']);
  await interactionEvent.execute(interestsInteraction, { commands: new Map() });
  assert.deepEqual(roleCalls, [
    { action: 'remove', roleId: 'interest-cyber' },
    { action: 'add', roleId: 'interest-programmer' },
  ]);
  assert.equal(interestsInteraction.editPayload.components[0].components[0].data.custom_id, 'onboarding:user-1:age');

  roleCalls.length = 0;
  const ageInteraction = makeRoutedInteraction('age', ['18+']);
  await interactionEvent.execute(ageInteraction, { commands: new Map() });
  assert.deepEqual(roleCalls, [
    { action: 'remove', roleId: 'age-under-13' },
    { action: 'add', roleId: 'age-18' },
  ]);
  assert.equal(ageInteraction.editPayload.components[0].components[0].data.custom_id, 'onboarding:user-1:experience');

  roleCalls.length = 0;
  const experienceInteraction = makeRoutedInteraction('experience', ['Expert']);
  await interactionEvent.execute(experienceInteraction, { commands: new Map() });
  assert.deepEqual(roleCalls, [{ action: 'add', roleId: 'exp-expert' }]);
  assert.deepEqual(experienceInteraction.editPayload.components, []);

  const routedProfile = await profileStore.getProfile('guild-1', 'user-1');
  assert.deepEqual(routedProfile.onboarding, {
    interests: ['Programmer'],
    ageGroup: '18+',
    experience: 'Expert',
  });

  await new Promise((resolve) => setTimeout(resolve, 400));
  const persisted = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.deepEqual(Object.keys(persisted).sort(), ['guild-1:user-1', 'guild-2:user-2']);
  assert.equal(persisted['guild-1:user-1'].identity.username, 'legacy-user');
  assert.deepEqual(persisted['guild-1:user-1'].onboarding, {
    interests: ['Programmer'],
    ageGroup: '18+',
    experience: 'Expert',
  });
  assert.deepEqual(persisted['guild-2:user-2'].onboarding, other.onboarding);

  console.log('ONBOARDING_COMMAND_DEFINITION=PASS');
  console.log('ONBOARDING_MENU_DEFINITIONS=PASS');
  console.log('ONBOARDING_VALIDATION=PASS');
  console.log('ONBOARDING_ROLE_DIFF_SAFETY=PASS');
  console.log('ONBOARDING_PROFILE_PERSISTENCE=PASS');
  console.log('ONBOARDING_INTERACTION_ROUTING=PASS');
  console.log('ONBOARDING_MULTI_USER_ISOLATION=PASS');
} finally {
  if (existed) {
    await writeFile(dataFile, await readFile(backupFile));
  } else {
    await rm(dataFile, { force: true });
  }
  try {
    const entries = await (await import('node:fs/promises')).readdir(dataDir);
    if (entries.length === 0) await rm(dataDir, { recursive: true, force: true });
  } catch {}
  await rm(backupDir, { recursive: true, force: true });
}
