import { EventEmitter } from "node:events";
import type {
  Account,
  CapacityProfile,
  ExecutionLocation,
  ExecutionMode,
  LegacyModelAlias,
  ModelAlias,
  PriorityClass,
  ProviderId,
  PrivacyMode,
  RoutingCandidateConfig,
  RoutingObjectives,
  RoutingRule,
  RoutingRuleMatch,
  TimeWindow,
} from "./types.js";
import { PRIORITY_CLASSES } from "./types.js";

import { validateSmartAlias, type ResourceSnapshot } from './workspace-routing-kernel.js';
export { PRIORITY_WEIGHTS, parseRoutingHeaders, validateSmartAlias, isWithinTimeWindow, routingRuleMatches, evaluateAliasPolicy, estimateInputTokens } from './workspace-routing-kernel.js';
export type { RoutingRequest, ResourceSnapshot, ScoredRoutingCandidate, PolicyDecision } from './workspace-routing-kernel.js';

export function inferAccountLocation(account: Pick<Account, "provider" | "baseUrl">): ExecutionLocation {
  if (account.provider !== "openai-compatible") return "cloud";
  if (!account.baseUrl) return "cloud";
  try {
    const host = new URL(account.baseUrl).hostname.toLowerCase();
    if (host === "localhost" || host === "::1" || host.startsWith("127.")) return "local";
    if (host.startsWith("10.") || host.startsWith("192.168.")) return "local";
    const match = host.match(/^172\.(\d+)\./);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return "local";
  } catch {
    return "cloud";
  }
  return "cloud";
}

function candidateList(models: string[]): RoutingCandidateConfig[] {
  return Array.from(new Set(models.filter(Boolean))).map((model) => ({ model }));
}

export function migrateModelAlias(raw: ModelAlias | LegacyModelAlias | any): ModelAlias {
  if (raw?.schemaVersion === 2 && Array.isArray(raw.rules)) {
    return {
      schemaVersion: 2,
      id: String(raw.id ?? ""),
      enabled: raw.enabled !== false,
      description: typeof raw.description === "string" ? raw.description : undefined,
      defaults: raw.defaults,
      rules: raw.rules.map((rule: RoutingRule, index: number) => ({
        ...rule,
        id: String(rule?.id || `rule-${index + 1}`),
        candidates: Array.isArray(rule?.candidates) ? rule.candidates : [],
      })),
    };
  }

  const targets = Array.isArray(raw?.targets)
    ? raw.targets.filter((target: unknown): target is string => typeof target === "string")
    : [];
  const byEffort = new Map<string, string[]>();
  const unqualified: string[] = [];
  for (const target of targets) {
    const match = target.match(/^(minimal|low|medium|high|xhigh):(.+)$/);
    if (!match) {
      unqualified.push(target);
      continue;
    }
    const list = byEffort.get(match[1]) ?? [];
    list.push(match[2]);
    byEffort.set(match[1], list);
  }
  const rules: RoutingRule[] = Array.from(byEffort.entries()).map(
    ([effort, models]) => ({
      id: `effort-${effort}`,
      match: { efforts: [effort] },
      candidates: candidateList(models),
      onNoCapacity: "next-rule",
    }),
  );
  const fallbackModels = unqualified.length
    ? unqualified
    : targets.map((target: string) => target.replace(/^(minimal|low|medium|high|xhigh):/, ""));
  if (fallbackModels.length) {
    rules.push({
      id: "default",
      candidates: candidateList(fallbackModels),
      onNoCapacity: "reject",
    });
  }
  return {
    schemaVersion: 2,
    id: String(raw?.id ?? ""),
    rules,
    enabled: raw?.enabled !== false,
    description: typeof raw?.description === "string" ? raw.description : undefined,
  };
}

export function aliasCandidateModels(alias: ModelAlias, effort?: string): string[] {
  const normalized = Array.isArray(alias.rules)
    ? alias
    : migrateModelAlias(alias as unknown as LegacyModelAlias);
  const matching = normalized.rules.filter((rule) => {
    if (rule.enabled === false) return false;
    const efforts = rule.match?.efforts;
    return !efforts?.length || Boolean(effort && efforts.includes(effort));
  });
  const effortSpecific = effort
    ? matching.filter((rule) => rule.match?.efforts?.includes(effort))
    : [];
  const selected = effortSpecific.length
    ? [...effortSpecific, ...matching.filter((rule) => !rule.match?.efforts?.length)]
    : matching.filter((rule) => !rule.match?.efforts?.length);
  const rules = selected.length ? selected : matching;
  return Array.from(
    new Set(rules.flatMap((rule) => rule.candidates.map((candidate) => candidate.model))),
  );
}

export function allAliasCandidateModels(alias: ModelAlias): string[] {
  const normalized = Array.isArray(alias.rules)
    ? alias
    : migrateModelAlias(alias as unknown as LegacyModelAlias);
  return Array.from(
    new Set(
      normalized.rules
        .filter((rule) => rule.enabled !== false)
        .flatMap((rule) => rule.candidates.map((candidate) => candidate.model)),
    ),
  );
}

export function capacityTokenUsage(usage: any): {
  inputTokens?: number;
  outputTokens?: number;
} {
  const finiteNonNegative = (value: unknown): number | undefined => {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim()
          ? Number(value)
          : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  return {
    inputTokens:
      finiteNonNegative(usage?.input_tokens) ??
      finiteNonNegative(usage?.prompt_tokens),
    outputTokens:
      finiteNonNegative(usage?.output_tokens) ??
      finiteNonNegative(usage?.completion_tokens),
  };
}

function ewma(current: number | undefined, next: number, alpha = 0.25): number {
  return current === undefined ? next : current * (1 - alpha) + next * alpha;
}

export class CapacityTracker extends EventEmitter {
  private observations = new Map<string, Observation>();
  private accountHealth = new Map<string, { healthy: boolean; observedAt: number }>();
  private accountMetrics = new Map<string, CapacityProfile>();
  private revision = 1;

  private key(accountId: string, model: string) {
    return `${accountId}::${model.toLowerCase()}`;
  }

  getVersion() {
    return this.revision;
  }

  setAccountHealth(accountId: string, healthy: boolean) {
    const previous = this.accountHealth.get(accountId);
    this.accountHealth.set(accountId, { healthy, observedAt: Date.now() });
    if (!previous || previous.healthy !== healthy) {
      this.bump("capacity.changed", { accountId, healthy });
    }
  }

  clearAccountHealth(accountId: string) {
    if (this.accountHealth.delete(accountId)) {
      this.bump("capacity.changed", { accountId, healthCleared: true });
    }
  }

  setAccountMetrics(accountId: string, profile: CapacityProfile) {
    const next = { ...profile };
    const previous = this.accountMetrics.get(accountId);
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
    this.accountMetrics.set(accountId, next);
    this.bump("capacity.changed", { accountId, metrics: true });
  }

  clearAccountMetrics(accountId: string) {
    if (this.accountMetrics.delete(accountId)) {
      this.bump("capacity.changed", { accountId, metricsCleared: true });
    }
  }

  acquire(accountId: string, model: string): CapacityLease {
    const key = this.key(accountId, model);
    const observation = this.observations.get(key) ?? { inFlight: 0, samples: 0 };
    observation.inFlight += 1;
    this.observations.set(key, observation);
    this.bump("capacity.changed", { accountId, model });
    const startedAt = Date.now();
    let released = false;
    return {
      accountId,
      model,
      startedAt,
      release: (result) => {
        if (released) return;
        released = true;
        const current = this.observations.get(key) ?? observation;
        current.inFlight = Math.max(0, current.inFlight - 1);
        const latencyMs = result?.latencyMs ?? Date.now() - startedAt;
        current.latencyMs = ewma(current.latencyMs, latencyMs);
        if (result?.inputTokens && latencyMs > 0) {
          current.prefillTokensPerSecond = ewma(
            current.prefillTokensPerSecond,
            result.inputTokens / (latencyMs / 1_000),
          );
        }
        if (result?.outputTokens && latencyMs > 0) {
          current.decodeTokensPerSecond = ewma(
            current.decodeTokensPerSecond,
            result.outputTokens / (latencyMs / 1_000),
          );
        }
        current.samples += 1;
        current.lastObservedAt = Date.now();
        this.observations.set(key, current);
        this.bump("capacity.changed", { accountId, model });
      },
    };
  }

  snapshots(
    accounts: Account[],
    models: Array<{ accountId: string; model: string; provider: ProviderId; enabled?: boolean }>,
    overrides = new Map<string, CapacityProfile>(),
  ): ResourceSnapshot[] {
    const accountMap = new Map(accounts.map((account) => [account.id, account]));
    return models.flatMap((entry) => {
      const account = accountMap.get(entry.accountId);
      if (!account) return [];
      const key = this.key(entry.accountId, entry.model);
      const observed = this.observations.get(key) ?? { inFlight: 0, samples: 0 };
      const profile = {
        ...account.capacityProfile,
        ...this.accountMetrics.get(account.id),
        ...overrides.get(key),
      };
      const location = account.location ?? inferAccountLocation(account);
      const maxConcurrent = Math.max(
        1,
        Math.floor(profile.maxConcurrent ?? (location === "cloud" ? 8 : 1)),
      );
      const averageLatencyMs = observed.latencyMs ?? 10_000;
      const freeSlots = Math.max(0, maxConcurrent - observed.inFlight);
      const queuedWaves = Math.max(0, observed.inFlight - maxConcurrent + 1);
      const age = observed.lastObservedAt ? Date.now() - observed.lastObservedAt : Number.POSITIVE_INFINITY;
      return [{
        accountId: account.id,
        model: entry.model,
        provider: entry.provider,
        location,
        privacyMode: account.privacyMode ?? "standard",
        enabled:
          account.enabled &&
          entry.enabled !== false &&
          (this.accountHealth.get(account.id)?.healthy ?? true),
        inFlight: observed.inFlight,
        maxConcurrent,
        freeSlots,
        predictedWaitMs: freeSlots > 0 ? 0 : queuedWaves * averageLatencyMs,
        averageLatencyMs,
        prefillTokensPerSecond: observed.prefillTokensPerSecond ?? profile.prefillTokensPerSecond,
        decodeTokensPerSecond: observed.decodeTokensPerSecond ?? profile.decodeTokensPerSecond,
        contextWindow: profile.contextWindow,
        confidence: observed.samples >= 5 && age <= 30 * 60_000
          ? "observed"
          : observed.samples > 0 && age > 30 * 60_000
            ? "stale"
            : "declared",
        lastObservedAt: observed.lastObservedAt,
      }];
    });
  }

  private bump(type: string, data: unknown) {
    this.revision += 1;
    this.emit(type, { id: this.revision, type, at: Date.now(), data });
  }
}
