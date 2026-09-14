import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { LocalPreparationDriver, PreparationQuote } from './local-model-preparation.js';
import type { HostPreparationOperation } from './local-preparation-transport.js';
import type { ProviderAgentControl, ProviderCapacityPolicy } from './provider-agent-supervisor.js';

/** Private, evidence-backed preflight result. This is never accepted from HTTP input.
 * Runtime archive consent must be enforced by the installer, not inferred from the
 * model's byte count. Missing runtimes require their own exact archive quote.
 */
export type ResolvedPreparationPlan = {
  quote: PreparationQuote;
  artifact: HostPreparationOperation['artifact'];
  contextTokens: number;
  policy: ProviderCapacityPolicy;
  memoryEvidence?: { estimator: string; configDigest: string; requiredBytes: number };
};
type StoredPlan = ResolvedPreparationPlan & { importStarted?: boolean; runtimeModel?: string };
type Dependencies = {
  host: ProviderAgentControl;
  resolvePlan(modelId: string): Promise<ResolvedPreparationPlan>;
  verifyChat(model: string, signal: AbortSignal): Promise<void>;
};
const identity = /^multivibe-local-[a-f0-9]{32}:latest$/;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Concrete adapter from durable coordinator jobs to the existing Host manager.
 * Private plans and import identities survive server restart. An interrupted import
 * is deliberately not retried: it may have created a model before losing its reply.
 */
export class HostLocalPreparationDriver implements LocalPreparationDriver {
  private plans = new Map<string, StoredPlan>();
  private initialized?: Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private dependencies: Dependencies) {}
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation, operation);
    this.serial = next.catch(() => {});
    return next;
  }
  private async persist() {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, plans: [...this.plans.values()] }), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, this.file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  private initialize() {
    return this.initialized ??= this.exclusive(async () => {
      let document;
      try { document = JSON.parse(await fs.readFile(this.file, 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw Error('preparation_store_unavailable');
      }
      if (document.version !== 1 || !Array.isArray(document.plans)) throw Error('invalid_preparation_store');
      for (const plan of document.plans as StoredPlan[]) {
        this.checkPlan(plan);
        if (plan.runtimeModel && (!identity.test(plan.runtimeModel) || plan.importStarted !== true)) throw Error('invalid_preparation_store');
        if (this.plans.has(plan.quote.configurationKey)) throw Error('invalid_preparation_store');
        this.plans.set(plan.quote.configurationKey, plan);
      }
    });
  }
  private checkPlan(plan: ResolvedPreparationPlan) {
    const { quote, artifact, contextTokens, policy } = plan;
    if (!quote || !artifact || !policy || quote.compatibility !== 'estimated-fit' || quote.runtime !== 'ollama' ||
      !Number.isSafeInteger(contextTokens) || contextTokens < 512 || contextTokens > 131072 ||
      !/^[a-f0-9]{40}$/.test(artifact.revision) || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !artifact.model_id || !artifact.filename || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 ||
      quote.artifactDigest !== `sha256:${artifact.sha256}` || quote.variant !== artifact.filename ||
      quote.downloadBytes !== artifact.bytes + (quote.runtimeDownload?.bytes ?? 0) || quote.policyRevision !== policy.revision ||
      !quote.runtimeVersion || !quote.hostId || !quote.modelId ||
      !Number.isSafeInteger(quote.requiredDiskBytes) || quote.requiredDiskBytes < artifact.bytes ||
      !Number.isSafeInteger(quote.availableDiskBytes) || !Number.isSafeInteger(quote.reserveDiskBytes) ||
      quote.reserveDiskBytes < 0 || quote.requiredDiskBytes > quote.availableDiskBytes - quote.reserveDiskBytes) {
      throw Error('invalid_preflight');
    }
    const archive = quote.runtimeDownload;
    if (archive && (archive.version !== quote.runtimeVersion || !archive.platform || !/^[a-f0-9]{64}$/.test(archive.sha256) ||
      !Number.isSafeInteger(archive.bytes) || archive.bytes < 1 || archive.bytes > 4 * 1024 ** 3 ||
      quote.requiredDiskBytes < quote.downloadBytes)) throw Error('invalid_preflight');
    if (plan.memoryEvidence && (!plan.memoryEvidence.estimator || !/^[a-f0-9]{64}$/.test(plan.memoryEvidence.configDigest) ||
      !Number.isSafeInteger(plan.memoryEvidence.requiredBytes) || plan.memoryEvidence.requiredBytes < 1)) throw Error('invalid_preflight');
    const key = hash({ memoryEvidence: plan.memoryEvidence, host: quote.hostId, model: quote.modelId, artifact, contextTokens, runtime: quote.runtime, version: quote.runtimeVersion, policy, runtimeDownload: quote.runtimeDownload });
    if (quote.configurationKey !== key) throw Error('invalid_preflight');
  }
  static configurationKey(plan: Omit<ResolvedPreparationPlan, 'quote'> & { quote: Pick<PreparationQuote, 'hostId'|'modelId'|'runtime'|'runtimeVersion'|'runtimeDownload'> }) {
    return hash({ memoryEvidence: plan.memoryEvidence, host: plan.quote.hostId, model: plan.quote.modelId, artifact: plan.artifact, contextTokens: plan.contextTokens,
      runtime: plan.quote.runtime, version: plan.quote.runtimeVersion, policy: plan.policy, runtimeDownload: plan.quote.runtimeDownload });
  }
  async preflight(modelId: string): Promise<PreparationQuote> {
    await this.initialize();
    const plan = structuredClone(await this.dependencies.resolvePlan(modelId));
    this.checkPlan(plan);
    if (plan.quote.modelId !== modelId) throw Error('model_identity_mismatch');
    await this.checkHost(plan);
    return this.exclusive(async () => {
      const previous = this.plans.get(plan.quote.configurationKey);
      // Keep the original evidence/consent payload and any imported identity for
      // an unchanged configuration; a disk observation is not a new model import.
      if (previous) return structuredClone(previous.quote);
      this.plans.set(plan.quote.configurationKey, plan);
      try { await this.persist(); }
      catch (error) { this.plans.delete(plan.quote.configurationKey); throw error; }
      return structuredClone(plan.quote);
    });
  }
  private async plan(quote: PreparationQuote) {
    await this.initialize();
    const plan = this.plans.get(quote.configurationKey);
    if (!plan || !isDeepStrictEqual(plan.quote, quote)) throw Error('new_preflight_required');
    return plan;
  }
  private async checkHost(plan: StoredPlan) {
    const { host } = this.dependencies;
    if (!host.enabled || !host.runLocalPreparationOperation) throw Error('local_preparation_unavailable');
    const policy = await host.getCapacityPolicy();
    if (policy.paused || !policy.automatic_downloads) throw Error('host_permission_required');
    if (!isDeepStrictEqual(policy, plan.policy)) throw Error('new_preflight_required');
    const { runtime } = await host.getManagedOllamaStatus();
    if (runtime.version !== plan.quote.runtimeVersion) throw Error('new_preflight_required');
    // Do not call the unbounded archive installer against a model-only consent.
    if (!runtime.runtime_installed && !plan.quote.runtimeDownload) throw Error('runtime_download_quote_required');
  }
  private async checkResources(plan: StoredPlan) {
    // Only check before starting work: testing a loaded model consumes the very
    // memory reserved here, so post-inference free memory is not a fit test.
    if (!plan.memoryEvidence) return;
    const { host } = this.dependencies;
    if (!host.getLocalPreparationResources) throw Error('resources_unknown');
    const [resources, capability, manifest] = await Promise.all([
      host.getLocalPreparationResources(), host.getCapability(), host.getManifest()]);
    if (manifest.device_key_id !== plan.quote.hostId || resources.policy_revision !== plan.policy.revision) throw Error('new_preflight_required');
    const values = [resources.free_host_memory_bytes, resources.free_accelerator_memory_bytes,
      capability.accelerator_memory_bytes, resources.free_storage_bytes, resources.occupied_storage_bytes];
    if (resources.storage_error || values.some(value => !Number.isSafeInteger(value) || Number(value) < 0) ||
      !Number.isFinite(Date.parse(resources.observed_at)) || Math.abs(Date.now() - Date.parse(resources.observed_at)) > 60000) throw Error('resources_unknown');
    if (plan.quote.runtimeDownload) {
      if (!Number.isSafeInteger(resources.free_runtime_storage_bytes) || Number(resources.free_runtime_storage_bytes) < 0) throw Error('resources_unknown');
      if (plan.quote.requiredDiskBytes > resources.free_runtime_storage_bytes! - plan.policy.policy.reserve_free_disk_bytes) throw Error('insufficient_disk');
    }
    const limit = Math.min(resources.free_host_memory_bytes!, resources.free_accelerator_memory_bytes!,
      capability.accelerator_memory_bytes! * plan.policy.policy.gpu_vram_percent / 100);
    if (plan.memoryEvidence.requiredBytes > limit) throw Error('insufficient_memory');
    if (plan.quote.requiredDiskBytes > resources.free_storage_bytes! - plan.policy.policy.reserve_free_disk_bytes ||
      plan.quote.requiredDiskBytes + resources.occupied_storage_bytes! > plan.policy.policy.max_disk_bytes) throw Error('insufficient_disk');
  }
  async validate(quote: PreparationQuote) {
    const plan = await this.plan(quote);
    await this.checkHost(plan);
    await this.checkResources(plan);
  }
  private async run(quote: PreparationQuote, operation: HostPreparationOperation['operation'], signal: AbortSignal,
    progress: (completed: number, total: number) => Promise<void> = async () => {}) {
    const plan = await this.plan(quote);
    signal.throwIfAborted(); await this.checkHost(plan); signal.throwIfAborted();
    const result = await this.dependencies.host.runLocalPreparationOperation!({ operation,
      policy_revision: plan.policy.revision, artifact: plan.artifact, context_tokens: plan.contextTokens,
      ...(operation === 'install' ? { runtime_quote: plan.quote.runtimeDownload } : {}),
      ...(operation === 'test' ? { runtime_model: plan.runtimeModel } : {}),
    }, signal, progress);
    signal.throwIfAborted(); await this.checkHost(plan); signal.throwIfAborted();
    return result;
  }
  async install(quote: PreparationQuote, signal: AbortSignal) {
    const plan = await this.plan(quote);
    await this.checkHost(plan);
    await this.checkResources(plan);
    const { runtime } = await this.dependencies.host.getManagedOllamaStatus();
    if (!runtime.runtime_installed) {
      if (!quote.runtimeDownload) throw Error('runtime_download_quote_required');
      await this.run(quote, 'install', signal);
      const installed = await this.dependencies.host.getManagedOllamaStatus();
      if (!installed.runtime.runtime_installed) throw Error('local_preparation_failed');
    }
    // Start never falls back to installing an absent runtime.
    await this.run(quote, 'start', signal);
  }

  async download(quote: PreparationQuote, signal: AbortSignal, progress: (completed: number, total: number) => Promise<void>) {
    await this.run(quote, 'download', signal, progress);
  }
  async prepare(quote: PreparationQuote, signal: AbortSignal) {
    await this.initialize();
    await this.exclusive(async () => {
      const plan = await this.plan(quote);
      signal.throwIfAborted();
      if (plan.runtimeModel) return;
      if (plan.importStarted) throw Error('import_reconciliation_required');
      plan.importStarted = true;
      await this.persist();
      const result = await this.run(quote, 'import', signal);
      if (!result.runtimeModel || !identity.test(result.runtimeModel)) throw Error('invalid_preparation_result');
      plan.runtimeModel = result.runtimeModel;
      try { await this.persist(); }
      catch (error) { delete plan.runtimeModel; throw error; }
    });
  }
  async test(quote: PreparationQuote, signal: AbortSignal): Promise<{ local: true; output: string }> {
    if (!(await this.plan(quote)).runtimeModel) throw Error('local_test_failed');
    const result = await this.run(quote, 'test', signal);
    if (!result.output?.trim()) throw Error('local_test_failed');
    return { local: true, output: result.output };
  }
  async verifyChat(quote: PreparationQuote, signal: AbortSignal): Promise<{ local: true; modelId: string; configurationKey: string }> {
    const plan = await this.plan(quote);
    if (!plan.runtimeModel) throw Error('chat_route_not_ready');
    signal.throwIfAborted(); await this.checkHost(plan); signal.throwIfAborted();
    await this.dependencies.verifyChat(plan.runtimeModel, signal);
    signal.throwIfAborted(); await this.checkHost(plan); signal.throwIfAborted();
    return { local: true, modelId: plan.runtimeModel, configurationKey: quote.configurationKey };
  }
}
