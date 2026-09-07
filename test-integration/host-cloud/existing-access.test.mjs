import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonRequest, main } from './existing-access.mjs';

test('generic gateway credentials cannot implicitly configure Cloud', async () => {
  let called = false;
  await assert.rejects(main(['configure'], { API_KEY: 'gateway-only', MULTIVIBE_API_KEY: 'gateway-only' }, async () => {
    called = true;
  }), /MULTIVIBE_CLOUD_TEST_API_KEY is required; no lab state changed/);
  assert.equal(called, false);
});

test('Cloud redirects are rejected and transport diagnostics do not disclose keys', async () => {
  const key = 'test-key-must-not-be-logged';
  await assert.rejects(jsonRequest(async (_url, options) => {
    assert.equal(options.redirect, 'error');
    throw new Error(`Transport failure ${key}`);
  }, 'https://api.multivibe.cloud/v1/models', key), error => {
    assert.ok(!error.message.includes(key));
    assert.match(error.message, /details withheld/);
    return true;
  });
});

test('HTTP authentication failures never echo a reflected upstream body', async () => {
  const key = 'reflected-test-credential';
  await assert.rejects(jsonRequest(async () => new Response(JSON.stringify({ error: key }), { status: 401 }),
    'https://api.multivibe.cloud/v1/models', key), { message: 'Request rejected (HTTP 401)' });
});

test('inference idempotency is forwarded and invalid JSON produces a bounded error', async () => {
  await assert.rejects(jsonRequest(async (_url, options) => {
    assert.equal(options.headers['idempotency-key'], 'test-inference-id');
    return new Response('private upstream diagnostics');
  }, 'http://127.0.0.1:18455/v1/responses', 'test-local-key', {
    method: 'POST', body: { input: 'Reply OK' }, idempotencyKey: 'test-inference-id',
  }), { message: 'Response was not JSON' });
});
