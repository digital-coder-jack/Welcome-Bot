import assert from 'node:assert/strict';

process.env.ONBOARDING_INTEREST_ROLE_IDS = 'Cyber Security=interest-1,Student=interest-2';
process.env.ONBOARDING_EXPERIENCE_ROLE_IDS = 'Expert=experience-1';
process.env.ONBOARDING_WORK_ROLE_IDS = 'Startup / Business=work-1,Prefer not to say=work-2';
process.env.ONBOARDING_GENDER_ROLE_IDS = 'Female=gender-1,Prefer not to say=gender-2';

const { nativeOnboardingFromMember, syncNativeOnboardingFromMember } =
  await import('../src/database/nativeOnboardingSync.js');
const { getProfile } = await import('../src/database/profileStore.js');

const member = {
  guild: { id: 'native-test-guild' },
  id: 'native-test-user',
  roles: {
    cache: new Map([
      ['interest-1', { id: 'interest-1' }],
      ['interest-2', { id: 'interest-2' }],
      ['experience-1', { id: 'experience-1' }],
      ['work-1', { id: 'work-1' }],
      ['gender-1', { id: 'gender-1' }],
    ]),
  },
};

const selections = nativeOnboardingFromMember(member);
assert.deepEqual(selections, {
  interests: ['Cyber Security', 'Student'],
  experience: 'Expert',
  workStatus: 'Startup / Business',
  gender: 'Female',
});

const result = await syncNativeOnboardingFromMember(member);
assert.equal(result.detected, true);
const profile = await getProfile(member.guild.id, member.id);
assert.deepEqual(profile.onboarding.interests, ['Cyber Security', 'Student']);
assert.equal(profile.onboarding.experience, 'Expert');
assert.equal(profile.onboarding.workStatus, 'Startup / Business');
assert.equal(profile.onboarding.gender, 'Female');

console.log('PASS native onboarding role mapping and same-profile persistence');
