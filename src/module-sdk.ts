export const MULTIVIBE_MODULE_API_VERSION = 1 as const;

export const MODULE_HOOKS = [
  "request.received",
  "request.beforeUpstream",
  "response.received",
  "stream.open",
  "response.beforeClient",
  "request.error",
  "request.completed",
] as const;

export type ModuleHookName = (typeof MODULE_HOOKS)[number];
export type ModuleFailurePolicy = "open" | "closed";

/**
 * A client-facing model contributed by a bundled module. Modules never resolve
 * these names themselves; the host maps each declaration onto a managed,
 * exactly-reversible routing alias so the name resolves before provider
 * selection while requests keep their messages and cache keys untouched.
 */
export type ModuleVirtualModel = {
  /** Client-facing model id, for example `multivibe/coding-worker`. */
  id: string;
  /** Settings key whose value holds the concrete target model id. */
  targetSetting: string;
  /** Role attributed to usage recorded for this model. */
  role?: "parent" | "worker";
  /** Human-readable purpose, surfaced in the model catalog. */
  description?: string;
  /** Managed alias marker. Defaults to the coding-economy marker for compatibility. */
  aliasDescription?: string;
};

export const MODULE_ANALYTICS_UNITS = ["count", "tokens", "ms", "ratio", "usd"] as const;
export type ModuleAnalyticsUnit = (typeof MODULE_ANALYTICS_UNITS)[number];

export const MODULE_ANALYTICS_AGGREGATIONS = ["sum", "count", "average"] as const;
export type ModuleAnalyticsAggregation = (typeof MODULE_ANALYTICS_AGGREGATIONS)[number];

/**
 * A dashboard metric contributed by a module. The host reads trace telemetry
 * and computes the value over the dashboard's time range; modules never run
 * code during analytics queries and cannot see other modules' data.
 */
export type ModuleAnalyticsMetric = {
  /** Stable id, namespaced by the module id in analytics responses. */
  id: string;
  label: string;
  description?: string;
  unit?: ModuleAnalyticsUnit;
  /** Dot path to a numeric trace field, e.g. `compression.tokensSaved`. */
  path?: string;
  /** Nested partial match selecting the traces that contribute to this metric. */
  when?: Record<string, unknown>;
  aggregation: ModuleAnalyticsAggregation;
};

export type ModuleManifest = {
  id: string;
  name: string;
  version: string;
  apiVersion: 1;
  description: string;
  entrypoint: string;
  hooks: ModuleHookName[];
  priority?: number;
  timeoutMs?: number;
  failurePolicy?: ModuleFailurePolicy;
  repository: string;
  categories?: string[];
  tags?: string[];
  author?: string;
  homepage?: string;
  settingsSchema?: Record<string, unknown>;
  defaultSettings?: Record<string, unknown>;
  /** Built-in modules can opt into being enabled on first discovery. */
  defaultEnabled?: boolean;
  /** Virtual models this bundled module contributes to the instance catalog. */
  virtualModels?: readonly ModuleVirtualModel[];
  /** Dashboard analytics metrics contributed by this module. */
  analytics?: readonly ModuleAnalyticsMetric[];
};

export type ModuleConversation = {
  phase: "start" | "continuation";
  mode: "one-off" | "multi-turn" | "unknown";
  hasTools: boolean;
  stateful: boolean;
  sessionId?: string;
  messageCount: number;
};

export type ModuleModel = {
  id: string;
  metadata: { supports_tools: boolean; context_window: number | null; [key: string]: unknown };
};

export type ModuleServices = {
  listModels(): Promise<ModuleModel[]>;
  completeWithUsage?(input: { model: string; messages: { role: "system" | "user"; content: string }[]; max_tokens: number }, signal: AbortSignal): Promise<ModuleCompletion>;
  /** Runs a bounded non-streaming completion with routing recursion suppressed. */
  complete(input: { model: string; messages: { role: "system" | "user"; content: string }[]; max_tokens: number }, signal: AbortSignal): Promise<string>;
};

export type ModuleStorageEvent = {
  id: string;
  type: string;
  data?: unknown;
  metrics?: Record<string, number>;
};

export type ModuleStorage = {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string, limit?: number): Promise<string[]>;
  recordEvent(event: ModuleStorageEvent): Promise<void>;
  readEvents(type?: string, limit?: number): Promise<Array<ModuleStorageEvent & { at: number }>>;
};

export type ModuleCompletion = {
  text: string;
  model: string;
  costUsd?: number;
};

export type ModuleContext = {
  requestId: string;
  storage?: ModuleStorage;
  conversation?: ModuleConversation;
  internal?: boolean;
  services?: ModuleServices;
  sessionId?: string;
  application?: string;
  route: string;
  transport: "http" | "sse" | "websocket";
  provider?: string;
  model?: string;
  signal: AbortSignal;
  settings: Readonly<Record<string, unknown>>;
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
};

export type ModuleResponse = {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
};

export type ModuleHookResult<T = unknown> =
  | { action: "continue" }
  | { action: "replace"; value: T }
  | { action: "respond"; response: ModuleResponse };

export type ModuleHook<T = unknown> = (
  value: Readonly<T>,
  context: ModuleContext,
) => ModuleHookResult<T> | Promise<ModuleHookResult<T>>;

export type MultivibeModule = Partial<Record<ModuleHookName, ModuleHook>>;
