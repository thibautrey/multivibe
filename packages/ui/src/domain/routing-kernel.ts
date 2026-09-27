// Pure routing policy and scheduler extracted from MultiVibe Core. No transport, credentials or storage.
export type ProviderId =
  | "ai-sdk"
  | "openai"
  | "openai-compatible"
  | "opencode"
  | "mistral"
  | "zai"
  | "github-copilot"
  | "xai";
export type UpstreamMode = "responses" | "chat/completions";
export type CompatibilityMode =
  | "auto"
  | "responses"
  | "chat-completions-bridge";

export const PRIORITY_CLASSES = [
  "critical",
  "interactive",
  "standard",
  "batch",
] as const;
export type PriorityClass = (typeof PRIORITY_CLASSES)[number];
export type ExecutionMode = "sync" | "auto" | "defer";
export type ExecutionLocation = "local" | "personal-cluster" | "cloud";
export type PrivacyMode = "standard" | "confidential_verified";
export type CapacityState = "ready" | "degraded" | "queue_only" | "unavailable";

export type CapacityProfile = {
  maxConcurrent?: number | undefined;
  prefillTokensPerSecond?: number | undefined;
  decodeTokensPerSecond?: number | undefined;
  contextWindow?: number | undefined;
  healthUrl?: string | undefined;
  metricsUrl?: string | undefined;
};

export type TimeWindow = {
  days?: number[] | undefined;
  start: string;
  end: string;
  timezone?: string | undefined;
};

export type RoutingRuleMatch = {
  applications?: string[] | undefined;
  priorities?: PriorityClass[] | undefined;
  efforts?: string[] | undefined;
  modalities?: Array<"text" | "image" | "audio" | "video"> | undefined;
  requiresTools?: boolean | undefined;
  executionModes?: ExecutionMode[] | undefined;
  minInputTokens?: number | undefined;
  maxInputTokens?: number | undefined;
  timeWindows?: TimeWindow[] | undefined;
};

export type RoutingRuleConstraints = {
  allowedLocations?: ExecutionLocation[] | undefined;
  requiredPrivacy?: PrivacyMode | undefined;
  maxPredictedWaitMs?: number | undefined;
  minContextWindow?: number | undefined;
  minQuality?: number | undefined;
};

export type RoutingObjectives = {
  latency: number;
  cost: number;
  quality: number;
  locality: number;
};

export type RoutingCandidateConfig = {
  model: string;
  provider?: ProviderId | undefined;
  accountIds?: string[] | undefined;
  location?: ExecutionLocation | undefined;
  quality?: number | undefined;
  inputCostPerMillionUsd?: number | undefined;
  outputCostPerMillionUsd?: number | undefined;
  capacityProfile?: CapacityProfile | undefined;
};

export type RoutingRule = {
  id: string;
  enabled?: boolean | undefined;
  match?: RoutingRuleMatch | undefined;
  constraints?: RoutingRuleConstraints | undefined;
  objectives?: RoutingObjectives | undefined;
  candidates: RoutingCandidateConfig[];
  onNoCapacity?: "next-rule" | "queue" | "reject" | undefined;
  cloudBudget?: {
    amountUsd: number;
    period: "hour" | "day" | "month";
  };
};

export type ModelAlias = {
  schemaVersion: 2;
  id: string;
  rules: RoutingRule[];
  enabled: boolean;
  description?: string | undefined;
  defaults?: {
    priority?: PriorityClass | undefined;
    executionMode?: ExecutionMode | undefined;
  };
};


export const PRIORITY_WEIGHTS: Record<PriorityClass, number> = {
  critical: 16,
  interactive: 8,
  standard: 4,
  batch: 1,
};

const DEFAULT_OBJECTIVES: Record<PriorityClass, RoutingObjectives> = {
  critical: { latency: 100, cost: 0, quality: 0, locality: 0 },
  interactive: { latency: 20, cost: 0, quality: 10, locality: 70 },
  standard: { latency: 25, cost: 20, quality: 30, locality: 25 },
  batch: { latency: 5, cost: 35, quality: 20, locality: 40 },
};

export type RoutingRequest = {
  application: string;
  priority: PriorityClass;
  executionMode: ExecutionMode;
  optedIn: boolean;
  privacyMode?: PrivacyMode | undefined;
  maxWaitMs: number;
  deadlineAt?: number | undefined;
  idempotencyKey?: string | undefined;
  webhookId?: string | undefined;
  effort?: string | undefined;
  modalities: Array<"text" | "image" | "audio" | "video">;
  requiresTools: boolean;
  estimatedInputTokens: number;
  now: number;
};

export type ResourceSnapshot = {
  accountId: string;
  model: string;
  provider: ProviderId;
  location: ExecutionLocation;
  privacyMode?: PrivacyMode | undefined;
  enabled: boolean;
  inFlight: number;
  maxConcurrent: number;
  freeSlots: number;
  predictedWaitMs: number;
  averageLatencyMs: number;
  prefillTokensPerSecond?: number | undefined;
  decodeTokensPerSecond?: number | undefined;
  contextWindow?: number | undefined;
  confidence: "declared" | "observed" | "stale";
  lastObservedAt?: number | undefined;
};

export type ScoredRoutingCandidate = {
  config: RoutingCandidateConfig;
  resource: ResourceSnapshot;
  score: number;
  estimatedCostUsd?: number | undefined;
  rejectedReasons: string[];
};

export type PolicyDecision = {
  alias?: ModelAlias | undefined;
  rule?: RoutingRule | undefined;
  candidates: ScoredRoutingCandidate[];
  eligible: ScoredRoutingCandidate[];
  onNoCapacity: "next-rule" | "queue" | "reject";
};

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value.trim() : undefined;
}

function defaultExecution(priority: PriorityClass): ExecutionMode {
  if (priority === "batch") return "defer";
  if (priority === "standard") return "auto";
  return "sync";
}

function defaultWait(priority: PriorityClass): number {
  if (priority === "interactive") return 2_000;
  if (priority === "standard") return 30_000;
  return 0;
}

export function parseRoutingHeaders(
  headers: Record<string, string | string[] | undefined>,
  application = "default",
  now = Date.now(),
): RoutingRequest {
  const rawPriority = headerValue(headers, "x-multivibe-priority");
  const priority = PRIORITY_CLASSES.includes(rawPriority as PriorityClass)
    ? (rawPriority as PriorityClass)
    : "standard";
  const rawExecution = headerValue(headers, "x-multivibe-execution");
  const rawPrivacy = headerValue(headers, "x-multivibe-privacy");
  const optedIn = [
    rawPriority,
    rawExecution,
    headerValue(headers, "x-multivibe-max-wait-ms"),
    headerValue(headers, "x-multivibe-deadline"),
    headerValue(headers, "x-multivibe-idempotency-key"),
    headerValue(headers, "x-multivibe-webhook"),
    rawPrivacy,
  ].some(Boolean);
  const executionMode: ExecutionMode =
    rawExecution === "sync" || rawExecution === "auto" || rawExecution === "defer"
      ? rawExecution
      : rawPrivacy === "confidential_verified"
        ? "sync"
      : optedIn
        ? defaultExecution(priority)
        : "sync";
  const rawWait = Number(headerValue(headers, "x-multivibe-max-wait-ms"));
  const maxWaitMs = Number.isFinite(rawWait)
    ? Math.max(0, Math.min(rawWait, 24 * 60 * 60_000))
    : defaultWait(priority);
  const rawDeadline = headerValue(headers, "x-multivibe-deadline");
  const parsedDeadline = rawDeadline ? Date.parse(rawDeadline) : Number.NaN;

  return {
    application,
    priority,
    executionMode,
    optedIn,
    privacyMode: rawPrivacy === "confidential_verified"
      ? "confidential_verified"
      : "standard",
    maxWaitMs,
    deadlineAt: Number.isFinite(parsedDeadline) ? parsedDeadline : undefined,
    idempotencyKey: headerValue(headers, "x-multivibe-idempotency-key"),
    webhookId: headerValue(headers, "x-multivibe-webhook"),
    modalities: ["text"],
    requiresTools: false,
    estimatedInputTokens: 0,
    now,
  };
}

export function validateSmartAlias(alias: ModelAlias): string[] {
  const errors: string[] = [];
  if (alias.schemaVersion !== 2) errors.push("schemaVersion must be 2");
  if (!alias.id.trim()) errors.push("id required");
  if (!alias.rules.length) errors.push("at least one routing rule is required");
  if (
    alias.defaults?.priority &&
    !PRIORITY_CLASSES.includes(alias.defaults.priority)
  ) errors.push("invalid default priority");
  if (
    alias.defaults?.executionMode &&
    !["sync", "auto", "defer"].includes(alias.defaults.executionMode)
  ) errors.push("invalid default execution mode");
  const ids = new Set<string>();
  for (const rule of alias.rules) {
    if (!rule.id.trim()) errors.push("routing rule id required");
    if (ids.has(rule.id)) errors.push(`duplicate routing rule id: ${rule.id}`);
    ids.add(rule.id);
    if (!rule.candidates.length) errors.push(`rule ${rule.id} requires candidates`);
    if (
      rule.onNoCapacity &&
      !["next-rule", "queue", "reject"].includes(rule.onNoCapacity)
    ) errors.push(`rule ${rule.id} has an invalid no-capacity behavior`);
    if (rule.match?.priorities?.some((value) => !PRIORITY_CLASSES.includes(value))) {
      errors.push(`rule ${rule.id} has an invalid priority`);
    }
    if (
      rule.match?.executionModes?.some(
        (value) => !["sync", "auto", "defer"].includes(value),
      )
    ) errors.push(`rule ${rule.id} has an invalid execution mode`);
    if (
      rule.match?.modalities?.some(
        (value) => !["text", "image", "audio", "video"].includes(value),
      )
    ) errors.push(`rule ${rule.id} has an invalid modality`);
    for (const window of rule.match?.timeWindows ?? []) {
      if (parseClock(window.start) === undefined || parseClock(window.end) === undefined) {
        errors.push(`rule ${rule.id} has an invalid time window`);
      }
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: window.timezone ?? "Europe/Paris" });
      } catch {
        errors.push(`rule ${rule.id} has an invalid timezone`);
      }
    }
    for (const candidate of rule.candidates) {
      if (!candidate.model?.trim()) errors.push(`rule ${rule.id} has an empty model`);
      if (candidate.quality !== undefined && (candidate.quality < 0 || candidate.quality > 100)) {
        errors.push(`rule ${rule.id} quality must be between 0 and 100`);
      }
      if (candidate.location && candidate.location !== "local" && candidate.location !== "personal-cluster" && candidate.location !== "cloud") {
        errors.push(`rule ${rule.id} has an invalid candidate location`);
      }
      for (const value of [
        candidate.inputCostPerMillionUsd,
        candidate.outputCostPerMillionUsd,
      ]) {
        if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
          errors.push(`rule ${rule.id} candidate costs must be non-negative`);
        }
      }
      if (candidate.capacityProfile) {
        for (const [name, value] of Object.entries(candidate.capacityProfile)) {
          if (
            !name.endsWith("Url") &&
            value !== undefined &&
            (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
          ) errors.push(`rule ${rule.id} has an invalid candidate capacity profile`);
        }
      }
    }
    if (rule.objectives) {
      const values = [
        rule.objectives.latency,
        rule.objectives.cost,
        rule.objectives.quality,
        rule.objectives.locality,
      ];
      if (values.some((value) => !Number.isFinite(value) || value < 0)) {
        errors.push(`rule ${rule.id} objective weights must be non-negative`);
      }
      if (values.every((value) => value === 0)) {
        errors.push(`rule ${rule.id} requires at least one objective weight`);
      }
    }
    if (
      rule.constraints?.allowedLocations?.some(
        (location) => location !== "local" && location !== "personal-cluster" && location !== "cloud",
      )
    ) errors.push(`rule ${rule.id} has an invalid allowed location`);
    if (
      rule.constraints?.requiredPrivacy
      && !["standard", "confidential_verified"].includes(rule.constraints.requiredPrivacy)
    ) errors.push(`rule ${rule.id} has an invalid privacy requirement`);
    if (
      rule.cloudBudget &&
      (!Number.isFinite(rule.cloudBudget.amountUsd) ||
        rule.cloudBudget.amountUsd <= 0 ||
        !["hour", "day", "month"].includes(rule.cloudBudget.period))
    ) errors.push(`rule ${rule.id} has an invalid cloud budget`);
  }
  return errors;
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    day: weekdays.indexOf(get("weekday")),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function parseClock(value: string): number | undefined {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return hour * 60 + minute;
}

export function isWithinTimeWindow(window: TimeWindow, at: number): boolean {
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  if (start === undefined || end === undefined) return false;
  const parts = zonedParts(new Date(at), window.timezone || "Europe/Paris");
  if (window.days?.length && !window.days.includes(parts.day)) return false;
  return start <= end
    ? parts.minutes >= start && parts.minutes < end
    : parts.minutes >= start || parts.minutes < end;
}

function matchesList<T>(configured: T[] | undefined, actual: T): boolean {
  return !configured?.length || configured.includes(actual);
}

export function routingRuleMatches(match: RoutingRuleMatch | undefined, request: RoutingRequest): boolean {
  if (!match) return true;
  if (!matchesList(match.applications, request.application)) return false;
  if (!matchesList(match.priorities, request.priority)) return false;
  if (match.efforts?.length && (!request.effort || !match.efforts.includes(request.effort))) return false;
  if (!matchesList(match.executionModes, request.executionMode)) return false;
  if (match.requiresTools !== undefined && match.requiresTools !== request.requiresTools) return false;
  if (match.modalities?.length && !request.modalities.some((modality) => match.modalities!.includes(modality))) {
    return false;
  }
  if (match.minInputTokens !== undefined && request.estimatedInputTokens < match.minInputTokens) return false;
  if (match.maxInputTokens !== undefined && request.estimatedInputTokens > match.maxInputTokens) return false;
  if (match.timeWindows?.length && !match.timeWindows.some((window) => isWithinTimeWindow(window, request.now))) {
    return false;
  }
  return true;
}

function estimateCandidateCost(
  config: RoutingCandidateConfig,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  if (config.inputCostPerMillionUsd === undefined || config.outputCostPerMillionUsd === undefined) {
    return undefined;
  }
  return (
    (inputTokens / 1_000_000) * config.inputCostPerMillionUsd +
    (outputTokens / 1_000_000) * config.outputCostPerMillionUsd
  );
}

function score(
  config: RoutingCandidateConfig,
  resource: ResourceSnapshot,
  objectives: RoutingObjectives,
  estimatedCostUsd: number | undefined,
): number {
  const total = Object.values(objectives).reduce((sum, value) => sum + value, 0) || 1;
  const latency = Number.isFinite(resource.predictedWaitMs) && Number.isFinite(resource.averageLatencyMs)
    ? 1 / (1 + (resource.predictedWaitMs + resource.averageLatencyMs) / 1_000)
    : 0.5;
  const cost = estimatedCostUsd === undefined ? 0.5 : 1 / (1 + estimatedCostUsd * 10);
  const quality = Math.max(0, Math.min(1, (config.quality ?? 50) / 100));
  const locality = resource.location === "local" ? 1 : resource.location === "personal-cluster" ? 0.5 : 0;
  return (
    latency * objectives.latency +
    cost * objectives.cost +
    quality * objectives.quality +
    locality * objectives.locality
  ) / total;
}

export function evaluateAliasPolicy(
  alias: ModelAlias | undefined,
  request: RoutingRequest,
  resources: ResourceSnapshot[],
  outputTokens = 8_192,
): PolicyDecision {
  if (!alias) return { candidates: [], eligible: [], onNoCapacity: "reject" };
  for (const rule of alias.rules) {
    if (rule.enabled === false || !routingRuleMatches(rule.match, request)) continue;
    const objectives = rule.objectives ?? DEFAULT_OBJECTIVES[request.priority];
    const candidates: ScoredRoutingCandidate[] = [];
    for (const config of rule.candidates) {
      const matching = resources.filter((resource) => {
        if (resource.model.toLowerCase() !== config.model.toLowerCase()) return false;
        if (config.provider && config.provider !== resource.provider) return false;
        if (config.accountIds?.length && !config.accountIds.includes(resource.accountId)) return false;
        return true;
      });
      for (const resource of matching) {
        const rejectedReasons: string[] = [];
        const location = resource.location;
        const constraints = rule.constraints;
        if (!resource.enabled) rejectedReasons.push("resource_unavailable");
        if (config.location && config.location !== resource.location) {
          rejectedReasons.push("candidate_location_mismatch");
        }
        if (
          request.priority === "batch" &&
          !constraints?.allowedLocations?.length &&
          !config.location &&
          resource.location !== "local"
        ) {
          rejectedReasons.push("batch_defaults_to_local");
        }
        if (constraints?.allowedLocations?.length && !constraints.allowedLocations.includes(location)) {
          rejectedReasons.push("location_not_allowed");
        }
        const requiredPrivacy = request.privacyMode === "confidential_verified"
          ? "confidential_verified"
          : constraints?.requiredPrivacy;
        if (requiredPrivacy && (resource.privacyMode ?? "standard") !== requiredPrivacy) {
          rejectedReasons.push("privacy_mode_not_allowed");
        }
        if (constraints?.maxPredictedWaitMs !== undefined && (!Number.isFinite(resource.predictedWaitMs) || resource.predictedWaitMs > constraints.maxPredictedWaitMs)) {
          rejectedReasons.push("predicted_wait_exceeded");
        }
        if (constraints?.minContextWindow !== undefined && (resource.contextWindow ?? 0) < constraints.minContextWindow) {
          rejectedReasons.push("context_too_small");
        }
        if (constraints?.minQuality !== undefined && (config.quality ?? 0) < constraints.minQuality) {
          rejectedReasons.push("quality_too_low");
        }
        if (resource.freeSlots !== undefined && resource.freeSlots <= 0) rejectedReasons.push("capacity_saturated");
        const estimatedCostUsd = estimateCandidateCost(
          config,
          request.estimatedInputTokens,
          outputTokens,
        );
        candidates.push({
          config,
          resource: { ...resource, location },
          score: score(config, { ...resource, location }, objectives, estimatedCostUsd),
          estimatedCostUsd,
          rejectedReasons,
        });
      }
    }
    candidates.sort((left, right) => right.score - left.score);
    const eligible = candidates.filter((candidate) => !candidate.rejectedReasons.length);
    if (eligible.length || rule.onNoCapacity !== "next-rule") {
      return {
        alias,
        rule,
        candidates,
        eligible,
        onNoCapacity: rule.onNoCapacity ?? "reject",
      };
    }
  }
  return { alias, candidates: [], eligible: [], onNoCapacity: "reject" };
}

export function estimateInputTokens(payload: unknown): number {
  try {
    return Math.max(1, Math.ceil(JSON.stringify(payload).length / 4));
  } catch {
    return 1;
  }
}

export type SchedulingCandidate = { id: string; application: string; priority: PriorityClass };

/** Smooth weighted round-robin across priorities, then applications. */
export class WeightedFairScheduler {
  private priorityScores = new Map<PriorityClass, number>();
  private applicationScores = new Map<string, number>();

  choose(candidates: SchedulingCandidate[], applicationWeight: (application: string) => number): string | undefined {
    if (!candidates.length) return undefined;
    const priorities = PRIORITY_CLASSES.filter((priority) =>
      candidates.some((candidate) => candidate.priority === priority),
    );
    let selectedPriority = priorities[0]!;
    let selectedPriorityScore = Number.NEGATIVE_INFINITY;
    const priorityTotal = priorities.reduce((sum, priority) => sum + PRIORITY_WEIGHTS[priority], 0);
    for (const priority of priorities) {
      const next = (this.priorityScores.get(priority) ?? 0) + PRIORITY_WEIGHTS[priority];
      this.priorityScores.set(priority, next);
      if (next > selectedPriorityScore) {
        selectedPriority = priority;
        selectedPriorityScore = next;
      }
    }
    this.priorityScores.set(
      selectedPriority,
      (this.priorityScores.get(selectedPriority) ?? 0) - priorityTotal,
    );

    const matching = candidates.filter((candidate) => candidate.priority === selectedPriority);
    const applications = Array.from(new Set(matching.map((candidate) => candidate.application)));
    let selectedApplication = applications[0]!;
    let selectedApplicationScore = Number.NEGATIVE_INFINITY;
    const appTotal = applications.reduce(
      (sum, application) => sum + Math.max(0.1, applicationWeight(application)),
      0,
    );
    for (const application of applications) {
      const key = `${selectedPriority}:${application}`;
      const next =
        (this.applicationScores.get(key) ?? 0) +
        Math.max(0.1, applicationWeight(application));
      this.applicationScores.set(key, next);
      if (next > selectedApplicationScore) {
        selectedApplication = application;
        selectedApplicationScore = next;
      }
    }
    const selectedKey = `${selectedPriority}:${selectedApplication}`;
    this.applicationScores.set(
      selectedKey,
      (this.applicationScores.get(selectedKey) ?? 0) - appTotal,
    );
    return matching.find((candidate) => candidate.application === selectedApplication)?.id;
  }
}

