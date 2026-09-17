import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { discoverProviderModelCatalog } from "../provider-model-catalog.js";
import type { ProviderModelCatalogFormat } from "../provider-model-catalog.js";
import { sdkAccountBaseUrl, sdkProvider } from "./providers.js";
import type { SdkProviderDiscoveryAuth } from "./provider-definition.js";
import type { Account } from "../types.js";

/** Live provider model discovery for SDK provider accounts.
 *
 * When the reviewed adapter declares a `/models` endpoint, the account's model
 * list comes from the provider itself, so a model the provider adds or renames
 * appears without waiting for a new models.dev snapshot to ship. The reviewed
 * snapshot still supplies display metadata for known ids and remains the
 * fallback whenever discovery is unavailable, rejected, or too slow.
 *
 * Every provider account has one cached entry with a stale-while-revalidate
 * window and a bounded failure backoff, so the number of upstream calls does
 * not grow with the number of callers. The last successful list is persisted on
 * disk so a restart does not lose the discovered ids.
 */

function envMilliseconds(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

export const SDK_LIVE_MODEL_CATALOG_TTL_MS = envMilliseconds(
  process.env.SDK_LIVE_MODEL_CATALOG_TTL_MS,
  10 * 60_000,
  30_000,
);
export const SDK_LIVE_MODEL_CATALOG_TIMEOUT_MS = envMilliseconds(
  process.env.SDK_LIVE_MODEL_CATALOG_TIMEOUT_MS,
  5_000,
  500,
);
/** Cold-start budget before a caller is served the reviewed snapshot instead. */
export const SDK_LIVE_MODEL_CATALOG_BLOCKING_BUDGET_MS = envMilliseconds(
  process.env.SDK_LIVE_MODEL_CATALOG_BLOCKING_BUDGET_MS,
  2_000,
  0,
);
export const SDK_LIVE_MODEL_CATALOG_MAX_MODELS = 5_000;
export const SDK_LIVE_MODEL_CATALOG_RETRY_BASE_MS = 60_000;
const SDK_LIVE_MODEL_CATALOG_CACHE_VERSION = 1;
const SDK_LIVE_MODEL_CATALOG_CACHE_MAX_BYTES = 4 * 1024 * 1024;

/** The non-chat runtimes the catalog projection already excludes from clients. */
const NON_CHAT_MODEL_TOKENS = new Set([
  "tts", "asr", "whisper", "kokoro", "embed", "embedding", "rerank", "reranker",
]);

export type LiveModelCatalogSnapshot = {
  /** Provider-local model ids (no provider prefix), sorted. */
  ids: readonly string[];
  source: string;
  fetchedAt: string;
  /** True when this snapshot was served while a refresh was already due. */
  stale: boolean;
  error?: string;
};

export type LiveModelCatalogSource = {
  snapshot(account: Account): Promise<LiveModelCatalogSnapshot | undefined>;
  /** Optional forced revalidation used by explicit admin refreshes. */
  refresh?(account: Account): Promise<LiveModelCatalogSnapshot | undefined>;
};

type LiveModelCatalogOptions = {
  fetch?: typeof fetch;
  ttlMs?: number;
  timeoutMs?: number;
  blockingBudgetMs?: number;
  now?: () => number;
  /** Persisted last-successful snapshots; discovery still wins when it runs. */
  cachePath?: string;
};

type LiveModelCatalogEntry = {
  signature: string;
  ids?: readonly string[];
  fetchedAt: number;
  nextRefreshAt: number;
  lastAttemptAt: number;
  lastError?: string;
  consecutiveFailures: number;
  inFlight?: Promise<void>;
};

type LiveModelCatalogTarget = {
  provider: NonNullable<ReturnType<typeof sdkProvider>>;
  baseUrl: string;
  path: string;
  url: string;
  format: ProviderModelCatalogFormat;
  auth: SdkProviderDiscoveryAuth;
  headers: Record<string, string>;
};

export function isNonChatProviderModelId(id: string): boolean {
  return id
    .toLowerCase()
    .split(/[-_/]/)
    .some((part) => NON_CHAT_MODEL_TOKENS.has(part));
}

function catalogSignature(account: Account, target: LiveModelCatalogTarget): string {
  return createHash("sha256")
    .update([
      account.sdkProvider ?? "",
      target.baseUrl,
      target.path,
      target.format,
      target.auth,
      account.accessToken ?? "",
    ].join("\u0000"))
    .digest("hex");
}

function discoveryAuth(provider: { modelsAuth?: SdkProviderDiscoveryAuth; authScheme?: "Bearer" | "Key" }): SdkProviderDiscoveryAuth {
  if (provider.modelsAuth) return provider.modelsAuth;
  return provider.authScheme === "Key" ? "key" : "bearer";
}

function discoveryHeaders(account: Account, target: LiveModelCatalogTarget): Record<string, string> {
  const token = account.accessToken ?? "";
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(target.provider.headers ?? {}),
    ...(target.provider.modelsHeaders ?? {}),
  };
  if (target.auth === "bearer") headers.authorization = `Bearer ${token}`;
  else if (target.auth === "key") headers.authorization = `Key ${token}`;
  else if (target.auth === "google") headers["x-goog-api-key"] = token;
  return headers;
}

function retryDelayMs(ttlMs: number, consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 4);
  return Math.min(ttlMs, SDK_LIVE_MODEL_CATALOG_RETRY_BASE_MS * 2 ** exponent);
}

export class LiveModelCatalog implements LiveModelCatalogSource {
  private readonly entries = new Map<string, LiveModelCatalogEntry>();
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly blockingBudgetMs: number;
  private readonly now: () => number;
  private readonly cachePath?: string;
  private loaded = false;
  private loadPromise?: Promise<void>;

  constructor(options: LiveModelCatalogOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.ttlMs = options.ttlMs ?? SDK_LIVE_MODEL_CATALOG_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? SDK_LIVE_MODEL_CATALOG_TIMEOUT_MS;
    this.blockingBudgetMs = options.blockingBudgetMs ?? SDK_LIVE_MODEL_CATALOG_BLOCKING_BUDGET_MS;
    this.now = options.now ?? Date.now;
    this.cachePath = options.cachePath;
  }

  /** Reviewed `/models` endpoint for an account, or undefined when the adapter
   * declares none or the account cannot be called at all. */
  private target(account: Account): LiveModelCatalogTarget | undefined {
    if (account.provider !== "ai-sdk" || !account.accessToken) return undefined;
    const provider = sdkProvider(account.sdkProvider);
    if (!provider?.modelsPath) return undefined;
    let baseUrl: string;
    try {
      baseUrl = sdkAccountBaseUrl(account).replace(/\/+$/, "");
    } catch {
      return undefined;
    }
    const url = new URL(`${baseUrl}${provider.modelsPath}`);
    if (url.protocol !== "https:") return undefined;
    return {
      provider,
      baseUrl,
      path: provider.modelsPath,
      url: url.toString(),
      format: provider.modelsFormat ?? (provider.adapter === "anthropic" ? "anthropic" : "openai"),
      auth: discoveryAuth(provider),
      headers: provider.modelsHeaders ?? {},
    };
  }

  /** Cached provider models, or undefined when the reviewed snapshot should be
   * used instead. Never throws and never blocks past the cold-start budget. */
  async snapshot(account: Account): Promise<LiveModelCatalogSnapshot | undefined> {
    await this.ensureLoaded();
    const target = this.target(account);
    if (!target) return undefined;
    const entry = this.entry(account, target);
    const now = this.now();
    // nextRefreshAt is zero for a new entry, the TTL deadline after a success,
    // and the backoff deadline after a failure, so an unavailable provider is
    // not retried on every caller.
    if (now >= entry.nextRefreshAt) this.startRefresh(account, entry, target, now);
    if (entry.ids) return this.view(entry, target, now >= entry.nextRefreshAt);
    const refresh = entry.inFlight;
    if (refresh && this.blockingBudgetMs > 0) {
      await Promise.race([refresh, new Promise<void>((resolve) => void setTimeout(resolve, this.blockingBudgetMs).unref?.())]);
    }
    if (!entry.ids) return undefined;
    return this.view(entry, target, this.now() >= entry.nextRefreshAt);
  }

  /** Force a revalidation and return the refreshed snapshot when available. */
  async refresh(account: Account): Promise<LiveModelCatalogSnapshot | undefined> {
    await this.ensureLoaded();
    const target = this.target(account);
    if (!target) return undefined;
    const entry = this.entry(account, target);
    entry.nextRefreshAt = 0;
    this.startRefresh(account, entry, target, this.now());
    if (entry.inFlight) await entry.inFlight;
    return entry.ids ? this.view(entry, target, false) : undefined;
  }

  /** Last observed state for diagnostics and tests. */
  state(accountId: string) {
    const entry = this.entries.get(accountId);
    if (!entry) return undefined;
    return {
      ids: entry.ids,
      fetchedAt: entry.fetchedAt,
      lastError: entry.lastError,
      consecutiveFailures: entry.consecutiveFailures,
      nextRefreshAt: entry.nextRefreshAt,
    };
  }

  private entry(account: Account, target: LiveModelCatalogTarget): LiveModelCatalogEntry {
    const signature = catalogSignature(account, target);
    const existing = this.entries.get(account.id);
    if (existing?.signature === signature) return existing;
    const entry: LiveModelCatalogEntry = { signature, fetchedAt: 0, nextRefreshAt: 0, lastAttemptAt: 0, consecutiveFailures: 0 };
    this.entries.set(account.id, entry);
    return entry;
  }

  private view(entry: LiveModelCatalogEntry, target: LiveModelCatalogTarget, stale: boolean): LiveModelCatalogSnapshot {
    return {
      ids: entry.ids ?? [],
      source: target.url,
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
      stale,
      ...(entry.lastError ? { error: entry.lastError } : {}),
    };
  }

  private startRefresh(
    account: Account,
    entry: LiveModelCatalogEntry,
    target: LiveModelCatalogTarget,
    now: number,
  ): void {
    if (entry.inFlight) return;
    const started = (async () => {
      entry.lastAttemptAt = now;
      try {
        const ids = await this.discover(account, target);
        entry.ids = ids;
        entry.fetchedAt = this.now();
        entry.lastError = undefined;
        entry.consecutiveFailures = 0;
        entry.nextRefreshAt = entry.fetchedAt + this.ttlMs;
        await this.persist();
      } catch (error) {
        entry.consecutiveFailures += 1;
        entry.lastError = error instanceof Error ? error.message.slice(0, 200) : "model discovery failed";
        entry.nextRefreshAt = this.now() + retryDelayMs(this.ttlMs, entry.consecutiveFailures);
      }
    })().finally(() => {
      if (entry.inFlight === started) entry.inFlight = undefined;
    });
    entry.inFlight = started;
  }

  private async discover(account: Account, target: LiveModelCatalogTarget): Promise<readonly string[]> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const ids = await discoverProviderModelCatalog({
      signal,
      format: target.format,
      request: (path) =>
        this.fetchImpl(`${target.baseUrl}${path}`, {
          method: "GET",
          redirect: "error",
          signal,
          headers: discoveryHeaders(account, target),
        }),
      maximumModels: SDK_LIVE_MODEL_CATALOG_MAX_MODELS,
      normalizeModel: (value) => {
        const raw = value && typeof value === "object"
          ? ((value as { id?: unknown }).id ?? (value as { name?: unknown }).name)
          : undefined;
        if (typeof raw !== "string") return undefined;
        const id = raw.startsWith("models/") ? raw.slice("models/".length) : raw;
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(id)) return undefined;
        return isNonChatProviderModelId(id) ? undefined : id;
      },
    });
    // A successful but empty list must not silently replace a working catalog.
    if (!ids.length) throw new Error("provider returned no models");
    return ids;
  }

  /** Load the persisted last-successful snapshots once, without failing callers. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) this.loadPromise = this.load();
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    this.loaded = true;
    if (!this.cachePath) return;
    let raw: string;
    try {
      const buffer = await readFile(this.cachePath);
      if (buffer.byteLength > SDK_LIVE_MODEL_CATALOG_CACHE_MAX_BYTES) return;
      raw = buffer.toString("utf8");
    } catch {
      return;
    }
    let parsed: {
      version?: unknown;
      accounts?: Record<string, { signature?: unknown; ids?: unknown; fetchedAt?: unknown }>;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || parsed.version !== SDK_LIVE_MODEL_CATALOG_CACHE_VERSION || !parsed.accounts || typeof parsed.accounts !== "object") return;
    for (const [accountId, value] of Object.entries(parsed.accounts)) {
      if (!value || typeof value.signature !== "string" || !Array.isArray(value.ids)) continue;
      const ids = value.ids
        .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 256)
        .slice(0, SDK_LIVE_MODEL_CATALOG_MAX_MODELS);
      if (!ids.length) continue;
      const fetchedAt = typeof value.fetchedAt === "number" && Number.isFinite(value.fetchedAt) ? value.fetchedAt : 0;
      this.entries.set(accountId, {
        signature: value.signature,
        ids,
        fetchedAt,
        // Persisted entries are revalidated in the background, not trusted forever.
        nextRefreshAt: 0,
        lastAttemptAt: 0,
        consecutiveFailures: 0,
      });
    }
  }

  private async persist(): Promise<void> {
    if (!this.cachePath) return;
    const accounts: Record<string, { signature: string; ids: readonly string[]; fetchedAt: number }> = {};
    for (const [accountId, entry] of this.entries) {
      if (!entry.ids?.length) continue;
      accounts[accountId] = { signature: entry.signature, ids: entry.ids, fetchedAt: entry.fetchedAt };
    }
    const payload = `${JSON.stringify({ version: SDK_LIVE_MODEL_CATALOG_CACHE_VERSION, accounts })}\n`;
    try {
      await mkdir(path.dirname(this.cachePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.cachePath}.${process.pid}.tmp`;
      await writeFile(temporary, payload, { mode: 0o600 });
      await rename(temporary, this.cachePath);
    } catch {
      // Persistence is best effort; discovery still works from memory.
    }
  }
}
