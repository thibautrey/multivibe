import { createHash } from 'node:crypto';
import type { ProviderAgentControl } from './provider-agent-supervisor.js';
import { HostLocalPreparationDriver, type ResolvedPreparationPlan } from './local-preparation-driver.js';
import { parseOpenModels } from './open-model-catalog.js';
import { estimatePreparationMemory, PREPARATION_MEMORY_VERSION } from './local-preparation-memory.js';
const hub = 'https://huggingface.co';
const safeId = /^[\w.-]+\/[\w.-]+$/;
/** Metadata-only, bounded preflight. Never follows model-card URLs or reads weights. */
export function createLocalPreparationResolver(host: ProviderAgentControl, fetcher: typeof fetch = fetch) {
  async function json(url: string): Promise<any> {
    const response = await fetcher(url, {redirect:'error', signal:AbortSignal.timeout(15000)});
    if (!response.ok || !response.body) { await response.body?.cancel(); throw Error('compatibility_not_established'); }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let count = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; count += part.value.length;
      if (count > 2*1024**2) throw Error('compatibility_not_established'); chunks.push(part.value); }
    } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return async (modelId: string): Promise<ResolvedPreparationPlan> => {
    if (!safeId.test(modelId)) throw Error('model_identity_mismatch');
    if (!host.enabled || !host.getLocalPreparationResources) throw Error('local_preparation_unavailable');
    const policy = await host.getCapacityPolicy();
    if (policy.paused || !policy.automatic_downloads) throw Error('host_permission_required');
    const [capability, status, manifest, resources] = await Promise.all([host.getCapability(),host.getManagedOllamaStatus(),host.getManifest(),host.getLocalPreparationResources()]);
    if (resources.policy_revision !== policy.revision) throw Error('new_preflight_required');
    if (!capability.supported || !['metal','cuda'].includes(capability.accelerator ?? '') || status.runtime.version !== '0.33.2' ||
      (status.runtime.execution_runtime && status.runtime.execution_runtime !== 'ollama')) throw Error('compatibility_not_established');
    let runtimeDownload: ResolvedPreparationPlan['quote']['runtimeDownload'];
    if (!status.runtime.runtime_installed) {
      if (!host.getLocalPreparationRuntimeQuote) throw Error('runtime_download_quote_required');
      runtimeDownload = await host.getLocalPreparationRuntimeQuote();
      // These archive formats have a pre-extraction aggregate size bound.
      if (!['darwin-arm64','windows-amd64'].includes(runtimeDownload.platform) ||
        runtimeDownload.version !== status.runtime.version || !/^[a-f0-9]{64}$/.test(runtimeDownload.sha256) ||
        !Number.isSafeInteger(runtimeDownload.bytes) || runtimeDownload.bytes < 1 || runtimeDownload.bytes > 4*1024**3) throw Error('runtime_download_quote_required');
      if (!Number.isSafeInteger(resources.free_runtime_storage_bytes) || Number(resources.free_runtime_storage_bytes) < 0) throw Error('resources_unknown');
    }
    const runtimeDiskBytes = runtimeDownload ? runtimeDownload.bytes + 4*1024**3 : 0;
    // Requiring the whole reservation on both volumes is conservative even when
    // model storage and runtime storage share a filesystem.
    const availableDiskBytes = runtimeDownload ? Math.min(resources.free_storage_bytes!, resources.free_runtime_storage_bytes!) : resources.free_storage_bytes!;
    const measured = [resources.free_storage_bytes, resources.occupied_storage_bytes, resources.free_host_memory_bytes, resources.free_accelerator_memory_bytes, capability.accelerator_memory_bytes];
    if (!manifest.device_key_id || resources.storage_error || measured.some(n => !Number.isSafeInteger(n) || Number(n)<0)) throw Error('resources_unknown');
    if (!Number.isFinite(Date.parse(resources.observed_at)) || Math.abs(Date.now()-Date.parse(resources.observed_at)) > 60000) throw Error('resources_unknown');
    const raw = await json(`${hub}/api/models/${modelId}?blobs=true`);
    const canonical = parseOpenModels([raw])[0];
    if (!canonical || canonical.id !== modelId || !canonical.revision) throw Error('compatibility_not_established');
    if (canonical.gated) throw Error('model_access_required');
    if (canonical.relation === 'quantized') throw Error('compatibility_not_established');
    const config = await json(`${hub}/${modelId}/raw/${canonical.revision}/config.json`);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('compatibility_not_established');
    const listing = await json(`${hub}/api/models?filter=${encodeURIComponent(`base_model:quantized:${modelId}`)}&sort=downloads&direction=-1&limit=8&full=true`);
    if (!Array.isArray(listing)) throw Error('compatibility_not_established');
    const candidates = listing.slice(0,8).filter(row => typeof row?.id === 'string' && safeId.test(row.id));
    const memoryLimit = Math.min(resources.free_accelerator_memory_bytes!, capability.accelerator_memory_bytes!*policy.policy.gpu_vram_percent/100, resources.free_host_memory_bytes!);
    let failure = 'compatibility_not_established';
    for (const candidate of candidates) {
      const detail = await json(`${hub}/api/models/${candidate.id}?blobs=true`);
      const variant = parseOpenModels([detail])[0];
      if (!variant || variant.id !== candidate.id || variant.gated || variant.parent !== modelId || variant.relation !== 'quantized' || !variant.revision) continue;
      const architecture = detail.gguf?.architecture;
      if (typeof architecture !== 'string') continue;
      const files = variant.files.filter(file => /(?:^|[._-])Q4_K_M\.gguf$/i.test(file.name) && !/-\d{5}-of-\d{5}/.test(file.name) && file.sha256 && file.bytes && file.bytes>0);
      if (files.length !== 1) continue;
      const file = files[0]; const contextTokens = 2048;
      const memory = estimatePreparationMemory(config,architecture,file.bytes!,contextTokens);
      if (memory === null) continue;
      if (memory > memoryLimit) { failure = 'insufficient_memory'; continue; }
      const requiredDiskBytes = file.bytes!*2 + runtimeDiskBytes; // source + Ollama blob, no hardlink assumption
      if (!Number.isSafeInteger(requiredDiskBytes) || requiredDiskBytes > availableDiskBytes-policy.policy.reserve_free_disk_bytes ||
          requiredDiskBytes+resources.occupied_storage_bytes! > policy.policy.max_disk_bytes) { failure = 'insufficient_disk'; continue; }
      if (file.bytes! + (runtimeDownload?.bytes ?? 0) > policy.policy.max_download_bytes_per_day) { failure = 'download_budget_exceeded'; continue; }
      const plan: ResolvedPreparationPlan = {artifact:{model_id:variant.id,revision:variant.revision,filename:file.name,bytes:file.bytes!,sha256:file.sha256!}, contextTokens, policy,
        memoryEvidence: { estimator: PREPARATION_MEMORY_VERSION, configDigest: createHash('sha256').update(JSON.stringify(config)).digest('hex'), requiredBytes: memory },
        quote:{hostId:manifest.device_key_id,hostName:capability.hardware_model || 'This Host',modelId,variant:file.name,runtime:'ollama',runtimeVersion:status.runtime.version,policyRevision:policy.revision,
          artifactDigest:`sha256:${file.sha256}`,runtimeDownload,downloadBytes:file.bytes! + (runtimeDownload?.bytes ?? 0),requiredDiskBytes,availableDiskBytes,reserveDiskBytes:policy.policy.reserve_free_disk_bytes,
          compatibility:'estimated-fit',configurationKey:''}};
      plan.quote.configurationKey = HostLocalPreparationDriver.configurationKey(plan);
      return plan;
    }
    throw Error(failure);
  };
}
