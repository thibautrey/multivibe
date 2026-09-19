import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { StoreSettings } from "./types.js";
import { solveAnonymousUsageProof } from "./anonymous-usage-proof.js";
import {
  COMMUNITY_LATENCY_UPPER_BOUNDS,
  COMMUNITY_REPORT_MODEL_LIMIT,
  COMMUNITY_REPORT_SCHEMA_VERSION,
  COMMUNITY_REPORT_SYNTHETIC_LIMIT,
  COMMUNITY_SPEED_UPPER_BOUNDS,
  COMMUNITY_CONTEXT_BUCKETS,
  buildCommunityReportModels,
  readSyntheticBenchmarkResults,
  type CommunityReportModelEntry,
  type CommunityReportSyntheticEntry,
  type CommunityReportTrace,
} from "./community-report.js";
import type { CommunityHostDescriptor } from "./community-host-profile.js";

/**
 * Opt-in community report sharing (schema v2). The worker is off unless the
 * operator explicitly enabled community benchmark sharing, sends at most one
 * report per installation per completed UTC day, reuses the anonymous
 * telemetry admission proof, and never includes an installation identifier.
 */

const DAY_MS = 86_400_000;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_ALLOWLIST_BYTES = 8 * 1024 * 1024;
const SENT_DIGEST_MEMORY = 200;

export class CommunityReportHttpError extends Error {
  constructor(readonly stage: "allowlist" | "admission" | "ingestion", readonly status: number) {
    super(`community report ${stage} is unavailable`);
    this.name = "CommunityReportHttpError";
  }
}

export type CommunityReportPayload = Readonly<{
  schemaVersion: typeof COMMUNITY_REPORT_SCHEMA_VERSION;
  eventId: string;
  periodStart: string;
  periodEnd: string;
  host: CommunityHostDescriptor;
  models: readonly CommunityReportModelEntry[];
  syntheticBenchmarks: readonly CommunityReportSyntheticEntry[];
}>;

type CommunityReportState = {
  schemaVersion: 1;
  pending?: CommunityReportPayload;
  lastCompletedPeriodEnd?: string;
  sentSyntheticDigests?: string[];
};

export type CommunityReportRunOutcome = "sent" | "empty" | "skipped" | "disabled" | "failed";

export type CommunityReportSharingWorkerOptions = Readonly<{
  settingsStore: { getSettings(): Promise<StoreSettings> };
  traceSource: { collectCommunityReportTraces(sinceMs: number, untilMs: number, limit?: number): Promise<CommunityReportTrace[]> };
  /** Resolves the bounded machine descriptor, or undefined when unsupported. */
  hostProvider: () => Promise<CommunityHostDescriptor | undefined>;
  /** Reads the provider-agent synthetic benchmark store document, if any. */
  benchmarkStore: { read(): Promise<unknown> };
  statePath: string;
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
  clock?: () => Date;
  random?: () => number;
  requestTimeoutMs?: number;
  onWarning?: (event: string, detail: Readonly<Record<string, unknown>>) => void;
}>;

export type CommunityReportSharingController = {
  start(): Promise<void>;
  stop(): void;
  runOnce(): Promise<CommunityReportRunOutcome>;
  applySettings(settings: StoreSettings): Promise<void>;
};

function utcDayStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

/** Local check that mirrors the Cloud contract before any data leaves the machine. */
export function assertCommunityReportPayload(value: unknown): CommunityReportPayload {
  if (!isObject(value)) throw new Error("community report payload is invalid");
  const allowed = ["schemaVersion", "eventId", "periodStart", "periodEnd", "host", "models", "syntheticBenchmarks"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || Object.keys(value).length !== allowed.length) {
    throw new Error("community report payload fields are invalid");
  }
  if (value.schemaVersion !== COMMUNITY_REPORT_SCHEMA_VERSION) throw new Error("community report schema version is invalid");
  if (typeof value.eventId !== "string" || !UUID_V4.test(value.eventId)) throw new Error("community report event id is invalid");
  const periodStart = Date.parse(String(value.periodStart));
  const periodEnd = Date.parse(String(value.periodEnd));
  if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd) || periodEnd - periodStart !== DAY_MS) {
    throw new Error("community report window is invalid");
  }
  const host = value.host;
  if (!isObject(host)
    || typeof host.acceleratorName !== "string" || host.acceleratorName.length < 1 || host.acceleratorName.length > 80
    || typeof host.os !== "string" || typeof host.architecture !== "string"
    || typeof host.acceleratorKind !== "string"
    || typeof host.machineModel !== "string" || host.machineModel.length > 48
    || typeof host.acceleratorMemoryBytes !== "number" || typeof host.hostMemoryBytes !== "number") {
    throw new Error("community report host descriptor is invalid");
  }
  const models = value.models;
  if (!Array.isArray(models) || models.length > COMMUNITY_REPORT_MODEL_LIMIT) throw new Error("community report models are invalid");
  for (const entry of models as unknown[]) {
    if (!isObject(entry) || typeof entry.modelId !== "string" || (entry.scope !== "local" && entry.scope !== "personal-cluster")) {
      throw new Error("community report model entry is invalid");
    }
    const known = ["modelId", "scope", "requests", "succeeded", "failed", "inputTokens", "outputTokens",
      "cachedInputTokens", "reasoningTokens", "timeToFirstToken", "latency", "outputTokensPerSecond",
      "contextHistogram", "contextTimeToFirstToken"];
    if (Object.keys(entry).length !== known.length || Object.keys(entry).some((key) => !known.includes(key))) {
      throw new Error("community report model entry fields are invalid");
    }
    if (entry.succeeded as number + (entry.failed as number) !== entry.requests) {
      throw new Error("community report requests do not reconcile");
    }
    for (const [key, expected] of [["timeToFirstToken", COMMUNITY_LATENCY_UPPER_BOUNDS.length + 1], ["latency", COMMUNITY_LATENCY_UPPER_BOUNDS.length + 1], ["outputTokensPerSecond", COMMUNITY_SPEED_UPPER_BOUNDS.length + 1]] as const) {
      const metric = entry[key];
      if (!isObject(metric) || !Array.isArray(metric.histogram) || metric.histogram.length !== expected) {
        throw new Error("community report metric is invalid");
      }
      if ((metric.histogram as number[]).reduce((sum, count) => sum + count, 0) !== metric.samples) {
        throw new Error("community report metric samples do not reconcile");
      }
    }
    if (!Array.isArray(entry.contextHistogram) || entry.contextHistogram.length !== COMMUNITY_CONTEXT_BUCKETS.length) {
      throw new Error("community report context histogram is invalid");
    }
    if ((entry.contextHistogram as number[]).reduce((sum, count) => sum + count, 0) !== entry.requests) {
      throw new Error("community report context counts do not reconcile");
    }
    if (!Array.isArray(entry.contextTimeToFirstToken)) throw new Error("community report context latency is invalid");
  }
  const synthetic = value.syntheticBenchmarks;
  if (!Array.isArray(synthetic) || synthetic.length > COMMUNITY_REPORT_SYNTHETIC_LIMIT) {
    throw new Error("community report synthetic benchmarks are invalid");
  }
  for (const entry of synthetic as unknown[]) {
    if (!isObject(entry) || typeof entry.resultDigest !== "string" || !DIGEST.test(entry.resultDigest)
      || typeof entry.modelId !== "string" || typeof entry.runtimeFamily !== "string"
      || typeof entry.completedAt !== "string" || !Number.isFinite(Date.parse(entry.completedAt))
      || typeof entry.samples !== "number" || entry.samples < 1 || entry.samples > 50
      || typeof entry.ttftP50Ms !== "number" || typeof entry.ttftP95Ms !== "number" || entry.ttftP95Ms < entry.ttftP50Ms) {
      throw new Error("community report synthetic benchmark entry is invalid");
    }
  }
  if (!models.length && !synthetic.length) throw new Error("community report payload is empty");
  return value as CommunityReportPayload;
}

function validateAllowlist(value: unknown): Readonly<{ models: Record<string, string>; generatedAt: string }> {
  if (!isObject(value) || value.schemaVersion !== 2 || !isObject(value.models)) {
    throw new Error("community report allowlist is invalid");
  }
  const entries = Object.entries(value.models);
  if (entries.length > 100_000) throw new Error("community report allowlist is too large");
  const models: Record<string, string> = {};
  for (const [alias, canonicalId] of entries) {
    if (!alias || alias.length > 512 || typeof canonicalId !== "string" || !canonicalId || canonicalId.length > 512) {
      throw new Error("community report allowlist contains an invalid model ID");
    }
    models[alias] = canonicalId;
  }
  return { models, generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : "" };
}

function validateState(value: unknown): CommunityReportState {
  if (!isObject(value) || value.schemaVersion !== 1) throw new Error("community report state is invalid");
  const allowed = ["schemaVersion", "pending", "lastCompletedPeriodEnd", "sentSyntheticDigests"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("community report state fields are invalid");
  const lastCompletedPeriodEnd = value.lastCompletedPeriodEnd;
  if (lastCompletedPeriodEnd !== undefined
    && (typeof lastCompletedPeriodEnd !== "string" || !Number.isFinite(Date.parse(lastCompletedPeriodEnd)))) {
    throw new Error("community report state has an invalid completed day");
  }
  const pending = value.pending === undefined ? undefined : assertCommunityReportPayload(value.pending);
  const digests = value.sentSyntheticDigests;
  if (digests !== undefined && (!Array.isArray(digests) || digests.length > SENT_DIGEST_MEMORY
    || (digests as unknown[]).some((entry) => typeof entry !== "string" || !DIGEST.test(entry)))) {
    throw new Error("community report state has invalid synthetic digests");
  }
  return {
    schemaVersion: 1,
    ...(pending === undefined ? {} : { pending }),
    ...(lastCompletedPeriodEnd === undefined ? {} : { lastCompletedPeriodEnd: lastCompletedPeriodEnd as string }),
    ...(digests === undefined ? {} : { sentSyntheticDigests: digests as string[] }),
  };
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > maximumBytes) {
    throw new Error("community report response exceeds its size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("community report response is empty");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > maximumBytes) throw new Error("community report response exceeds its size limit");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createCommunityReportSharingWorker(
  options: CommunityReportSharingWorkerOptions,
): CommunityReportSharingController {
  const fetchFn = options.fetchFn ?? fetch;
  const clock = options.clock ?? (() => new Date());
  const random = options.random ?? Math.random;
  const requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
  const apiBaseUrl = new URL(options.apiBaseUrl ?? "https://api.multivibe.cloud");
  const allowlistUrl = new URL("/telemetry/v2/allowlist", apiBaseUrl);
  const admissionUrl = new URL("/telemetry/v1/admission", apiBaseUrl);
  const reportUrl = new URL("/telemetry/v2/community-report", apiBaseUrl);
  const warn = options.onWarning ?? ((event, detail) => console.warn(event, detail));

  let cachedAllowlist: Record<string, string> | undefined;
  let cachedAllowlistEtag: string | undefined;
  let activeController: AbortController | undefined;
  let activeRun: Promise<CommunityReportRunOutcome> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let started = false;
  let stopped = false;
  let sharingEnabled = false;
  let settingsEpoch = 0;

  async function readState(): Promise<CommunityReportState> {
    try {
      const bytes = await fs.readFile(options.statePath);
      if (bytes.length > MAX_STATE_BYTES) throw new Error("community report state exceeds its size limit");
      return validateState(JSON.parse(bytes.toString("utf8")));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { schemaVersion: 1 };
      throw error;
    }
  }

  async function writeState(state: CommunityReportState): Promise<void> {
    await fs.mkdir(path.dirname(options.statePath), { recursive: true });
    const temporaryPath = `${options.statePath}.tmp-${randomUUID()}`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await fs.rename(temporaryPath, options.statePath);
      await fs.chmod(options.statePath, 0o600);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async function discardState(): Promise<void> {
    await fs.rm(options.statePath, { force: true }).catch(() => undefined);
  }

  async function request<T>(url: URL, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchFn(url, { ...init, redirect: "error", signal: controller.signal });
      return await consume(response);
    } finally {
      clearTimeout(timeout);
      if (activeController === controller) activeController = undefined;
    }
  }

  async function fetchAllowlist(): Promise<Record<string, string>> {
    return request(allowlistUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(cachedAllowlistEtag ? { "if-none-match": cachedAllowlistEtag } : {}),
      },
    }, async (response) => {
      if (response.status === 304 && cachedAllowlist) return cachedAllowlist;
      if (response.status !== 200) throw new CommunityReportHttpError("allowlist", response.status);
      const allowlist = validateAllowlist(await readBoundedJson(response, MAX_ALLOWLIST_BYTES));
      cachedAllowlist = allowlist.models;
      cachedAllowlistEtag = response.headers.get("etag") ?? undefined;
      return allowlist.models;
    });
  }

  async function sendPending(state: CommunityReportState, epoch: number): Promise<CommunityReportRunOutcome> {
    if (!state.pending) return "skipped";
    if (!sharingEnabled || settingsEpoch !== epoch) {
      await discardState();
      return "disabled";
    }
    const pending = assertCommunityReportPayload(state.pending);
    const admission = await request(admissionUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ eventId: pending.eventId }),
    }, async (response) => {
      if (response.status !== 200) throw new CommunityReportHttpError("admission", response.status);
      return readBoundedJson(response, 2_048);
    });
    const proof = await solveAnonymousUsageProof(
      admission, pending.eventId,
      () => !sharingEnabled || settingsEpoch !== epoch || stopped, clock(),
    );
    if (!sharingEnabled || settingsEpoch !== epoch || stopped) return sharingEnabled ? "skipped" : "disabled";
    await request(reportUrl, {
      method: "POST",
      headers: {
        accept: "application/json", "content-type": "application/json",
        "x-telemetry-ticket": proof.ticketId, "x-telemetry-proof": proof.nonce,
        "x-telemetry-challenge": proof.challenge, "x-telemetry-expires": proof.expiresAt,
      },
      body: JSON.stringify(pending),
    }, async (response) => {
      if (response.status !== 202) throw new CommunityReportHttpError("ingestion", response.status);
      return response.status;
    });
    if (!sharingEnabled || settingsEpoch !== epoch) {
      await discardState();
      return "disabled";
    }
    const sentDigests = [
      ...(state.sentSyntheticDigests ?? []),
      ...pending.syntheticBenchmarks.map((entry) => entry.resultDigest),
    ].slice(-SENT_DIGEST_MEMORY);
    await writeState({ schemaVersion: 1, lastCompletedPeriodEnd: pending.periodEnd, sentSyntheticDigests: sentDigests });
    return "sent";
  }

  async function runCycle(): Promise<CommunityReportRunOutcome> {
    if (stopped) return "skipped";
    const settings = await options.settingsStore.getSettings();
    sharingEnabled = settings.communityBenchmarksSharingEnabled === true;
    if (!sharingEnabled) {
      await discardState();
      return "disabled";
    }
    const epoch = settingsEpoch;
    const state = await readState();
    if (state.pending) return sendPending(state, epoch);

    const now = clock();
    const periodEnd = utcDayStart(now);
    const periodStart = new Date(periodEnd.getTime() - DAY_MS);
    const periodEndIso = periodEnd.toISOString();
    if (state.lastCompletedPeriodEnd === periodEndIso) return "skipped";
    const enabledAt = Date.parse(settings.communityBenchmarksSharingEnabledAt ?? "");
    if (!Number.isFinite(enabledAt)) throw new Error("community report activation time is unavailable");
    const eligibleStart = Math.max(periodStart.getTime(), enabledAt);
    if (eligibleStart >= periodEnd.getTime()) {
      await writeState({ schemaVersion: 1, lastCompletedPeriodEnd: periodEndIso, ...(state.sentSyntheticDigests ? { sentSyntheticDigests: state.sentSyntheticDigests } : {}) });
      return "empty";
    }

    const allowlist = await fetchAllowlist();
    if (!sharingEnabled || settingsEpoch !== epoch || stopped) return sharingEnabled ? "skipped" : "disabled";
    const host = await options.hostProvider();
    if (!host) {
      warn("community_report_host_unavailable", { platform: process.platform, architecture: process.arch });
      await writeState({ schemaVersion: 1, lastCompletedPeriodEnd: periodEndIso, ...(state.sentSyntheticDigests ? { sentSyntheticDigests: state.sentSyntheticDigests } : {}) });
      return "empty";
    }
    const traces = await options.traceSource.collectCommunityReportTraces(eligibleStart, periodEnd.getTime());
    if (!sharingEnabled || settingsEpoch !== epoch || stopped) return sharingEnabled ? "skipped" : "disabled";
    let benchmarkDocument: unknown;
    try {
      benchmarkDocument = await options.benchmarkStore.read();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        warn("community_report_benchmark_store_unavailable", {
          errorType: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    const models = buildCommunityReportModels(traces, allowlist);
    const syntheticBenchmarks = readSyntheticBenchmarkResults(
      benchmarkDocument, allowlist, new Set(state.sentSyntheticDigests ?? []),
    );
    if (!models.length && !syntheticBenchmarks.length) {
      await writeState({ schemaVersion: 1, lastCompletedPeriodEnd: periodEndIso, ...(state.sentSyntheticDigests ? { sentSyntheticDigests: state.sentSyntheticDigests } : {}) });
      return "empty";
    }
    const pending = assertCommunityReportPayload({
      schemaVersion: COMMUNITY_REPORT_SCHEMA_VERSION,
      eventId: randomUUID(),
      periodStart: periodStart.toISOString(),
      periodEnd: periodEndIso,
      host,
      models,
      syntheticBenchmarks,
    });
    const pendingState: CommunityReportState = {
      schemaVersion: 1,
      pending,
      ...(state.sentSyntheticDigests ? { sentSyntheticDigests: state.sentSyntheticDigests } : {}),
    };
    await writeState(pendingState);
    if (!sharingEnabled || settingsEpoch !== epoch || stopped) {
      if (settingsEpoch !== epoch || !sharingEnabled) await discardState();
      return sharingEnabled ? "skipped" : "disabled";
    }
    return sendPending(pendingState, epoch);
  }

  async function runOnce(): Promise<CommunityReportRunOutcome> {
    if (activeRun) return activeRun;
    activeRun = runCycle().catch(async (error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      warn("community_report_cycle_failed", {
        errorType: error instanceof Error ? error.name : "unknown",
        errorMessage: errorMessage.slice(0, 240),
        ...(error instanceof CommunityReportHttpError ? { stage: error.stage, status: error.status } : {}),
      });
      return sharingEnabled ? "failed" : "disabled";
    }).finally(() => {
      activeRun = undefined;
    });
    return activeRun;
  }

  function clearSchedule(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  function schedule(delayMs: number): void {
    if (!started || stopped || !sharingEnabled || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce().then((outcome) => {
        if (!started || stopped || !sharingEnabled) return;
        if (outcome === "failed") {
          schedule(15 * 60_000 + Math.floor(random() * 45 * 60_000));
          return;
        }
        const current = clock();
        const nextUtcDay = utcDayStart(new Date(current.getTime() + DAY_MS));
        schedule(Math.max(1_000, nextUtcDay.getTime() - current.getTime() + 5 * 60_000 + Math.floor(random() * 55 * 60_000)));
      });
    }, Math.max(0, delayMs));
    timer.unref?.();
  }

  async function applySettings(settings: StoreSettings): Promise<void> {
    const nextEnabled = settings.communityBenchmarksSharingEnabled === true;
    if (!nextEnabled) {
      if (sharingEnabled) settingsEpoch += 1;
      sharingEnabled = false;
      clearSchedule();
      activeController?.abort();
      await discardState();
      return;
    }
    const wasEnabled = sharingEnabled;
    sharingEnabled = true;
    if (!wasEnabled) settingsEpoch += 1;
    if (started && !stopped) schedule(5_000 + Math.floor(random() * 295_000));
  }

  async function start(): Promise<void> {
    if (started || stopped) return;
    started = true;
    try {
      await applySettings(await options.settingsStore.getSettings());
    } catch (error: unknown) {
      warn("community_report_startup_failed", { errorType: error instanceof Error ? error.name : "unknown" });
      schedule(15 * 60_000 + Math.floor(random() * 45 * 60_000));
    }
  }

  function stop(): void {
    stopped = true;
    clearSchedule();
    activeController?.abort();
  }

  return { start, stop, runOnce, applySettings };
}
