import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTeamDeviceAuth } from './team-device-auth.js';

test('challenge projects public fields only and cancellation disables polling', async () => {
  let requests = 0;
  const session = await startTeamDeviceAuth('github-copilot', (async (_url, init) => {
    requests++;
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return Response.json({ device_code: 'private-device-secret', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
  }) as typeof fetch);
  assert.equal(JSON.stringify(session).includes('private-device-secret'), false);
  assert.equal(session.challenge.userCode, 'ABCD-1234');
  assert.deepEqual(await session.poll(), { status: 'pending', intervalSeconds: 5 });
  assert.equal(requests, 1);
  session.cancel();
  await assert.rejects(session.poll(), /no longer active/);
  assert.equal(requests, 1);
});

test('xAI reuses Core form flow and normalizes it for the isolated proxy', async () => {
  const session = await startTeamDeviceAuth('xai', (async (_url, init) => {
    assert.equal(typeof init?.body, 'string');
    assert.equal(init?.redirect, 'error');
    return Response.json({ device_code: 'private', user_code: 'CODE', verification_uri: 'https://accounts.x.ai/device', expires_in: 900 });
  }) as typeof fetch);
  assert.equal(session.challenge.provider, 'xai');
  session.cancel();
});

test('provider diagnostics are redacted and unsupported providers make no request', async () => {
  const transport = (async () => { throw new Error('access_token=private'); }) as typeof fetch;
  await assert.rejects(startTeamDeviceAuth('xai', transport), { message: 'Team device authorization could not be started' });
  await assert.rejects(startTeamDeviceAuth('openai' as 'xai', transport), /Unsupported/);
});
