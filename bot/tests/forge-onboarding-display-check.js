import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(new URL('..', import.meta.url).pathname, '..');
const dataDir = path.join(repo, 'bot', 'src', 'database', 'data');
const profileFile = path.join(dataDir, 'member-profiles.json');
const backupDir = await mkdtemp(path.join(os.tmpdir(), 'welcome-bot-forge-display-'));
const backupFile = path.join(backupDir, 'member-profiles.json');
let original = null;
let existed = false;

const targetUser = {
  id: 'user-1',
  tag: 'forge-user#0001',
  displayAvatarURL: () => 'https://cdn.example.test/avatar.png',
};

function interactionFor(user) {
  return {
    guild: {
      id: 'guild-1',
      members: { fetch: async () => null },
    },
    user,
    options: {
      getUser: () => user,
      getSubcommand: () => 'member',
    },
    deferred: false,
    replied: false,
    async deferReply() { this.deferred = true; },
    async editReply(payload) { this.payload = payload; return payload; },
  };
}

function serverLinesFrom(interaction) {
  const embed = interaction.payload.embeds[0].toJSON();
  assert.equal(embed.title, `🗂️ Security Profile — ${interaction.user.tag}`);
  assert.deepEqual(embed.fields.map((field) => field.name), [
    '🪪 Identity', '📅 Account', '🏰 Server', '⚖️ Moderation', '🛡️ Security', '📊 Activity',
  ]);
  return embed.fields.find((field) => field.name === '🏰 Server').value.split('\n');
}

try {
  try {
    original = await readFile(profileFile);
    existed = true;
    await writeFile(backupFile, original);
    throw new Error('Refusing to run against an existing runtime profile store');
  } catch (error) {
    if (error.message === 'Refusing to run against an existing runtime profile store') throw error;
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(profileFile, JSON.stringify({
    'guild-1:user-1': {
      guildId: 'guild-1',
      userId: 'user-1',
      identity: { username: 'forge-user', displayName: 'Forge User' },
      server: {
        roles: [{ id: 'role-1', name: 'Member' }],
        highestRole: 'Member',
        inviteUsed: 'invite-code',
        inviter: 'inviter#0001',
        verificationStatus: 'Verified',
        forgeMemberStatus: 'Assigned',
        devIntroStatus: 'Sent',
        welcomeDmStatus: 'Delivered',
      },
      onboarding: {
        interests: ['Cyber Security', 'AI Enthusiast'],
        ageGroup: '18+',
        experience: 'Expert',
      },
    },
    'guild-1:user-legacy': {
      guildId: 'guild-1',
      userId: 'user-legacy',
      identity: { username: 'legacy-user' },
      server: { verificationStatus: 'Unverified' },
    },
  }, null, 2));

  const { execute } = await import('../src/commands/security.js');
  const { updateOnboardingData } = await import('../src/database/profileStore.js');

  const currentInteraction = interactionFor(targetUser);
  await execute(currentInteraction);
  const currentLines = serverLinesFrom(currentInteraction);
  assert.deepEqual(currentLines.slice(0, 8), [
    '**Highest Role:** Member',
    '**Roles:** Member',
    '**Invite Used:** invite-code',
    '**Inviter:** inviter#0001',
    '**Verification:** Verified',
    '**Forge Member:** Assigned',
    '**Dev Intro:** Sent',
    '**Welcome DM:** Delivered',
  ]);
  assert.deepEqual(currentLines.slice(8), [
    '**🎯 Interests:** Cyber Security, AI Enthusiast',
    '**🎂 Age Group:** 18+',
    '**📊 Experience:** Expert',
  ]);

  await updateOnboardingData('guild-1', 'user-1', {
    interests: ['Programmer'],
    ageGroup: '18-',
    experience: 'Advanced',
  });
  const latestInteraction = interactionFor(targetUser);
  await execute(latestInteraction);
  const latestLines = serverLinesFrom(latestInteraction);
  assert.deepEqual(latestLines.slice(8), [
    '**🎯 Interests:** Programmer',
    '**🎂 Age Group:** 18-',
    '**📊 Experience:** Advanced',
  ]);

  const legacyUser = {
    id: 'user-legacy',
    tag: 'legacy-user#0002',
    displayAvatarURL: () => 'https://cdn.example.test/legacy.png',
  };
  const legacyInteraction = interactionFor(legacyUser);
  await execute(legacyInteraction);
  const legacyLines = serverLinesFrom(legacyInteraction);
  assert.deepEqual(legacyLines.slice(8), [
    '**🎯 Interests:** Not selected',
    '**🎂 Age Group:** Not selected',
    '**📊 Experience:** Not selected',
  ]);

  await new Promise((resolve) => setTimeout(resolve, 400));
  const persisted = JSON.parse(await readFile(profileFile, 'utf8'));
  assert.deepEqual(persisted['guild-1:user-1'].onboarding, {
    interests: ['Programmer'],
    ageGroup: '18-',
    experience: 'Advanced',
  });
  assert.equal(persisted['guild-1:user-legacy'].identity.username, 'legacy-user');

  console.log('FORGE_EXISTING_FIELD_ORDER_AND_VALUES=PASS');
  console.log('FORGE_ONBOARDING_DISPLAY=PASS');
  console.log('FORGE_LATEST_PROFILE_REFRESH=PASS');
  console.log('FORGE_LEGACY_DEFAULTS=PASS');
} finally {
  if (existed) {
    await writeFile(profileFile, await readFile(backupFile));
  } else {
    await rm(profileFile, { force: true });
  }
  try {
    const entries = await (await import('node:fs/promises')).readdir(dataDir);
    if (entries.length === 0) await rm(dataDir, { recursive: true, force: true });
  } catch {}
  await rm(backupDir, { recursive: true, force: true });
}
