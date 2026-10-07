import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanion } from '../src/companion.mjs';

const code = value => error => error.code === value;
const model = { id: 'coding/model', name: 'Coding model', contextWindow: 8192, maxTokens: 2048 };

export function fixture() {
  let record;
  let revision = 0;
  let mutateFailure = null;
  let unsetFailure = false;
  let finishFailure = false;
  const secrets = new Map();
  const user = { providers: { unrelated: { baseURL: 'https://existing.example', apiKeyEnv: 'EXISTING_KEY' } } };
  const base = { providers: {} };
  const events = [];
  const profileSchema = { dict: { apiKeyEnv: {}, baseURL: {}, models: {} } };
  const snapshot = () => ({ ns: 'custom-pi-entry', revision, schema: { dict: { providers: { inner: profileSchema } } },
    user: structuredClone(user), base: structuredClone(base), value: { providers: Object.fromEntries(Object.entries({ ...base.providers, ...user.providers }).map(([id, profile]) => [id, { ...profile, defaultContextWindow: 262144 }])) } });
  const ctx = {
    credentials: {
      readRecord: async () => structuredClone(record),
      modifyRecord: async (_key, action) => {
        const next = action(structuredClone(record));
        if (finishFailure && next.payload.connection && !next.payload.pending) { finishFailure = false; throw new Error('simulated commit failure'); }
        record = structuredClone(next);
      },
      describe: async ref => ({ configured: secrets.has(ref), writable: true }),
      resolve: async ref => secrets.has(ref) ? { value: secrets.get(ref), source: 'store' } : undefined,
      set: async (ref, key) => { events.push('set-key'); secrets.set(ref, key); },
      unset: async ref => { events.push('unset-key'); if (unsetFailure) throw new Error('simulated delete failure'); secrets.delete(ref); },
    },
    settings: {
      describe: () => [snapshot()],
      mutate: async (ns, ops, expected) => {
        assert.equal(ns, 'custom-pi-entry');
        if (expected !== revision) { const error = new Error('settings conflict'); error.name = 'SettingsConflictError'; throw error; }
        if (mutateFailure) { const error = mutateFailure; mutateFailure = null; throw error; }
        events.push(ops[0].op === 'set' ? 'set-provider' : 'unset-provider');
        for (const op of ops) { if (op.op === 'set') user.providers[op.path[1]] = structuredClone(op.value); else delete user.providers[op.path[1]]; }
        revision++;
      },
    },
    llm: {
      listConfigurableProviders: () => [{ provider: 'openai', settingsNs: 'custom-pi-entry', settingsPath: ['providers', 'openai'] }],
      listProviders: () => Object.keys({ ...base.providers, ...user.providers }).map(id => ({ id, name: id })),
    },
  };
  let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json({ data: [model] }); };
  const companion = createCompanion(ctx, { fetchImpl, clock: () => 123 });
  const input = { revision: 0, providerId: 'multivibe', settingsNs: 'custom-pi-entry', baseURL: 'http://127.0.0.1:1455/v1', apiKey: 'mv_fake_key', protocol: 'openai-completions', selectedIds: [model.id] };
  return { ctx, companion, input, user, base, events, secrets, calls: () => calls,
    state: () => structuredClone(record), failMutation: error => { mutateFailure = error; }, failCredentialRemoval: value => { unsetFailure = value; }, failFinish: () => { finishFailure = true; } };
}

test('connect discovers a real namespace, preserves unrelated providers and hides secrets', async () => {
  const f = fixture();
  const before = structuredClone(f.user.providers.unrelated);
  const result = await f.companion.connect(f.input);
  assert.equal(result.connected, true);
  assert.equal(result.revision, 2);
  assert.equal(f.state().payload.connection.settingsNs, 'custom-pi-entry');
  assert.deepEqual(f.user.providers.unrelated, before);
  assert.equal(JSON.stringify(result).includes('mv_fake_key'), false);
  assert.equal(JSON.stringify(result).includes('MULTIVIBE_DSH_'), false);
  assert.equal(JSON.stringify(f.state()).includes('mv_fake_key'), false);
  assert.deepEqual(f.events, ['set-key', 'set-provider']);
  assert.equal(f.calls(), 1);
});
test('existing, inherited and adapter-owned provider IDs are never overwritten', async () => {
  for (const place of ['user', 'base']) {
    const f = fixture();
    f[place].providers.multivibe = { displayName: 'Existing' };
    await assert.rejects(f.companion.connect(f.input), code('PROVIDER_EXISTS'));
    assert.equal(f.secrets.size, 0);
    assert.equal(f.state(), undefined);
  }
});
test('stale revision and duplicate concurrent clicks cannot overwrite a connection', async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.companion.connect(f.input), f.companion.connect(f.input)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results[1].reason.code, 'CONFLICT');
  assert.equal(f.secrets.size, 1);
});
test('settings rejection restores its newly created credential', async () => {
  const f = fixture();
  f.failMutation(new Error('schema error mv_fake_key'));
  await assert.rejects(f.companion.connect(f.input), code('CONNECT_FAILED'));
  assert.equal(f.secrets.size, 0);
  assert.equal(f.user.providers.multivibe, undefined);
  assert.equal(f.state().payload.pending, null);
  assert.equal(JSON.stringify(await f.companion.status()).includes('mv_fake_key'), false);
});
test('state finalization failure removes only the matching newly managed provider', async () => {
  const f = fixture();
  f.failFinish();
  await assert.rejects(f.companion.connect(f.input), code('CONNECT_FAILED'));
  assert.equal(f.user.providers.multivibe, undefined);
  assert.ok(f.user.providers.unrelated);
  assert.equal(f.secrets.size, 0);
});
test('failed compensation retains a journal and explicit recovery resolves it', async () => {
  const f = fixture();
  f.failFinish(); f.failCredentialRemoval(true);
  await assert.rejects(f.companion.connect(f.input), code('RECOVERY_REQUIRED'));
  const status = await f.companion.status();
  assert.equal(status.pending, true);
  assert.equal(status.connected, false);
  await assert.rejects(f.companion.connect({ ...f.input, revision: status.revision }), code('RECOVERY_REQUIRED'));
  f.failCredentialRemoval(false);
  const result = await f.companion.recover({ revision: status.revision });
  assert.equal(result.pending, false);
  assert.equal(f.secrets.size, 0);
});
test('disconnect refuses externally modified managed providers and keeps their secret', async () => {
  const f = fixture();
  const status = await f.companion.connect(f.input);
  f.user.providers.multivibe.displayName = 'Edited elsewhere';
  assert.equal((await f.companion.status()).connected, false);
  await assert.rejects(f.companion.disconnect({ removeCredential: true, revision: status.revision }), code('PROVIDER_MODIFIED'));
  assert.equal(f.secrets.size, 1);
  assert.equal(f.user.providers.multivibe.displayName, 'Edited elsewhere');
});
test('disconnect removes configuration before the unused credential', async () => {
  const f = fixture();
  const status = await f.companion.connect(f.input);
  const disconnected = await f.companion.disconnect({ removeCredential: true, revision: status.revision });
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.connection, null);
  assert.equal(f.secrets.size, 0);
  assert.ok(f.user.providers.unrelated);
  assert.deepEqual(f.events, ['set-key', 'set-provider', 'unset-provider', 'unset-key']);
});
test('a credential reused by another configuration is never revoked blindly', async () => {
  const f = fixture();
  const status = await f.companion.connect(f.input);
  f.user.providers.unrelated.apiKeyEnv = f.state().payload.connection.credentialRef;
  await assert.rejects(f.companion.disconnect({ removeCredential: true, revision: status.revision }), code('RECOVERY_REQUIRED'));
  assert.equal(f.secrets.size, 1);
  const pending = await f.companion.status();
  delete f.user.providers.unrelated.apiKeyEnv;
  await f.companion.recover({ revision: pending.revision });
  assert.equal(f.secrets.size, 0);
});
test('catalog resolves rotated credentials on every request, never from a cached secret', async () => {
  const f = fixture();
  await f.companion.connect(f.input);
  const ref = f.state().payload.connection.credentialRef;
  f.secrets.delete(ref);
  await assert.rejects(f.companion.catalog(), code('MISSING_CREDENTIAL'));
  assert.equal(f.calls(), 1);
});
test('disconnect retains credentials by default because inactive profiles are not observable', async () => {
  const f = fixture();
  const connected = await f.companion.connect(f.input);
  const ref = f.user.providers.multivibe.apiKeyEnv;
  const disconnected = await f.companion.disconnect({ revision: connected.revision });
  assert.equal(disconnected.connection, null);
  assert.deepEqual(disconnected.retainedCredentialRefs, [ref]);
  assert.equal(f.secrets.has(ref), true);
  assert.ok(f.user.providers.unrelated);
});

test('disconnect cleans up a manually removed provider without touching other providers', async () => {
  const f = fixture();
  const status = await f.companion.connect(f.input);
  delete f.user.providers.multivibe;
  assert.equal((await f.companion.status()).connected, false);
  const result = await f.companion.disconnect({ removeCredential: true, revision: status.revision });
  assert.equal(result.connection, null);
  assert.equal(f.secrets.size, 0);
  assert.ok(f.user.providers.unrelated);
});

test('model limits and missing capabilities reject before credential persistence', async () => {
  const f = fixture();
  await assert.rejects(f.companion.connect({ ...f.input, selectedIds: ['withdrawn'] }), code('UNKNOWN_MODEL'));
  assert.equal(f.secrets.size, 0);
  assert.equal(f.state(), undefined);
});
