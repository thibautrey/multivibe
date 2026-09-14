import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostLocalPreparationDriver, type ResolvedPreparationPlan } from './local-preparation-driver.js';
import { LocalModelPreparation } from './local-model-preparation.js';
import type { ProviderAgentControl, ProviderCapacityPolicy } from './provider-agent-supervisor.js';

const alias = `multivibe-local-${'a'.repeat(32)}:latest`;
async function fixture(t: any) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-driver-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const policy: ProviderCapacityPolicy = { schema_version: 'provider-capacity-policy-state-v1', revision: 1,
    paused: false, automatic_downloads: true, allow_cloud_workloads: false,
    policy: { schema_version: 'provider-capacity-policy-v1', gpu_utilization_percent: 80, gpu_vram_percent: 75,
      max_disk_bytes: 1000, model_storage_path: '/approved/storage', max_download_bytes_per_day: 1000,
      minimum_model_residency_seconds: 21600, max_model_changes_per_day: 4, reserve_free_disk_bytes: 100 } };
  const resolved: ResolvedPreparationPlan = { quote: { hostId: 'machine', hostName: 'This Host', modelId: 'owner/model',
    variant: 'model.gguf', runtime: 'ollama', runtimeVersion: 'pinned', policyRevision: 1, artifactDigest: `sha256:${'b'.repeat(64)}`,
    downloadBytes: 100, requiredDiskBytes: 200, availableDiskBytes: 1000, reserveDiskBytes: 100,
    compatibility: 'estimated-fit', configurationKey: '' },
    artifact: { model_id: 'owner/model-GGUF', revision: 'a'.repeat(40), filename: 'model.gguf', sha256: 'b'.repeat(64), bytes: 100 },
    contextTokens: 2048, policy };
  resolved.quote.configurationKey = HostLocalPreparationDriver.configurationKey(resolved);
  const calls: string[] = [];
  const state = { installed: true, failImport: false, failChat: false };
  const host = { enabled: true, getCapacityPolicy: async () => structuredClone(policy),
    getManagedOllamaStatus: async () => ({ runtime: { runtime_installed: state.installed, version: 'pinned' } }),
    runLocalPreparationOperation: async (input: any, _signal: any, progress: any) => {
      calls.push(input.operation);
      assert.deepEqual(input.artifact, resolved.artifact);
      assert.equal(input.context_tokens, 2048);
      if (input.operation === 'install') { assert.deepEqual(input.runtime_quote, resolved.quote.runtimeDownload); state.installed = true; }
      if (input.operation === 'download') await progress(100, 100);
      if (input.operation === 'import') { if (state.failImport) throw Error('connection_lost'); return { runtimeModel: alias }; }
      if (input.operation === 'test') { assert.equal(input.runtime_model, alias); return { output: 'OK' }; }
      return {};
    } } as unknown as ProviderAgentControl;
  const dependencies = { host, resolvePlan: async () => structuredClone(resolved),
    verifyChat: async (model: string) => { assert.equal(model, alias); calls.push('chat'); if (state.failChat) throw Error('chat_route_not_ready'); } };
  const file = path.join(directory, 'plans.json');
  const driver = new HostLocalPreparationDriver(file, dependencies);
  const service = new LocalModelPreparation(path.join(directory, 'jobs.json'), driver);
  return { file, driver, service, dependencies, calls, policy, state, resolved };
}
test('concrete driver reaches ready through exact artifact operations and chat after consent', async t => {
  const { service, calls, file } = await fixture(t);
  const job = await service.quote('owner/model');
  assert.deepEqual(calls, []);
  await service.consent(job.id, job.consentDigest); await service.wait(job.id);
  assert.deepEqual(calls, ['start', 'download', 'import', 'test', 'chat']);
  assert.equal((await service.list())[0].chatModelId, alias);
  assert.equal((await service.list())[0].stage, 'ready');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});
test('persisted import identity is reused after restart, not imported twice', async t => {
  const { file, dependencies, driver, calls } = await fixture(t);
  const quote = await driver.preflight('owner/model');
  const signal = new AbortController().signal;
  await Promise.all([driver.prepare(quote, signal), driver.prepare(quote, signal)]);
  const restarted = new HostLocalPreparationDriver(file, dependencies);
  await restarted.prepare(await restarted.preflight('owner/model'), signal);
  assert.deepEqual(calls, ['import']);
  assert.equal((await restarted.test(quote, signal)).output, 'OK');
});
test('ambiguous import cannot silently launch a duplicate, even after restart', async t => {
  const { file, dependencies, driver, calls, state } = await fixture(t);
  const quote = await driver.preflight('owner/model'); state.failImport = true;
  const signal = new AbortController().signal;
  await assert.rejects(driver.prepare(quote, signal));
  state.failImport = false;
  const restarted = new HostLocalPreparationDriver(file, dependencies);
  await assert.rejects(restarted.prepare(quote, signal), /import_reconciliation_required/);
  assert.deepEqual(calls, ['import']);
});
test('missing runtime cannot spend unquoted archive bytes and policy changes stop before work', async t => {
  const { driver, state, calls, policy } = await fixture(t);
  state.installed = false;
  await assert.rejects(driver.preflight('owner/model'), /runtime_download_quote_required/);
  assert.deepEqual(calls, []);
  state.installed = true;
  const quote = await driver.preflight('owner/model');
  policy.paused = true;
  await assert.rejects(driver.install(quote, new AbortController().signal), /host_permission_required/);
  policy.paused = false; policy.policy.max_disk_bytes = 2000;
  await assert.rejects(driver.validate(quote), /new_preflight_required/);
  assert.deepEqual(calls, []);
});
test('wrong evidence, manipulated quote, failed chat and cancellation cannot become ready', async t => {
  const { driver, resolved, service, calls, state } = await fixture(t);
  const quote = await driver.preflight('owner/model');
  await assert.rejects(driver.validate({ ...quote, downloadBytes: 1000 }), /new_preflight_required/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(driver.download(quote, abort.signal, async () => {}));
  assert.deepEqual(calls, []);
  resolved.artifact.bytes = 200;
  await assert.rejects(driver.preflight('owner/model'), /invalid_preflight/);
  resolved.artifact.bytes = 100; state.failChat = true;
  const job = await service.quote('owner/model');
  await service.consent(job.id, job.consentDigest); await service.wait(job.id);
  assert.equal((await service.list())[0].stage, 'failed');
  assert.equal((await service.list())[0].chatModelId, undefined);
});

test('missing runtime installs only against separately consented archive and total volume', async t => {
 const f=await fixture(t);f.state.installed=false;
 f.resolved.quote.runtimeDownload={version:'pinned',platform:'darwin-arm64',sha256:'c'.repeat(64),bytes:50};
 f.resolved.quote.downloadBytes=150;
 f.resolved.quote.configurationKey=HostLocalPreparationDriver.configurationKey(f.resolved);
 const job=await f.service.quote('owner/model');assert.deepEqual(f.calls,[]);
 assert.equal(job.quote.downloadBytes,150);
 await f.service.consent(job.id,job.consentDigest);await f.service.wait(job.id);
 assert.deepEqual(f.calls,['install','start','download','import','test','chat']);
 assert.equal((await f.service.list())[0].stage,'ready');
});
