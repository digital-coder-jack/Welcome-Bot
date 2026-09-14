import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manager = await import('../src/managers/verificationManager.js');
assert.equal(manager.VERIFY_PREFIX, 'forge-verify');

const button = manager.verifyButton({ guild: { id: 'guild-1' }, id: 'user-1' });
const buttonJson = button.toJSON().components[0];
assert.equal(buttonJson.custom_id, 'forge-verify:guild-1:user-1');
assert.equal(buttonJson.label, 'Verify');

const source = await readFile(new URL('../src/managers/verificationManager.js', import.meta.url), 'utf8');
assert.match(source, /profile\.server\.introSubmitted/);
assert.match(source, /profile\.server\.onboardingCompleted/);
assert.match(source, /notifyGuardianVerification/);

const client = await readFile(new URL('../src/services/telegramClient.js', import.meta.url), 'utf8');
assert.match(client, /guardian-verification/);

const messageHandler = await readFile(new URL('../src/events/messageCreate.js', import.meta.url), 'utf8');
assert.match(messageHandler, /length < 10/);

const backend = await readFile(new URL('../../backend/app/services/telegram_service.py', import.meta.url), 'utf8');
assert.match(backend, /\[FORGE_GUARDIAN\]/);
assert.doesNotMatch(source, /FORGE_ASSIST/);

console.log('VERIFICATION_BUTTON_OWNERSHIP=PASS');
console.log('INTRO_AND_ONBOARDING_GATING=PASS');
console.log('GUARDIAN_ASSIST_ISOLATION_CONTRACT=PASS');
