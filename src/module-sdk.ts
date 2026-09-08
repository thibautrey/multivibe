export const MULTIVIBE_MODULE_API_VERSION = 1 as const;

export const MODULE_HOOKS = [
  "request.received",
  "request.beforeUpstream",
  "response.received",
  "stream.open",
  "response.beforeClient",
  "request.error",
] as const;

export type ModuleHookName = (typeof MODULE_HOOKS)[number];
export type ModuleFailurePolicy = "open" | "closed";

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
  /** Runs a bounded non-streaming completion with routing recursion suppressed. */
  complete(input: { model: string; messages: { role: "system" | "user"; content: string }[]; max_tokens: number }, signal: AbortSignal): Promise<string>;
};

export type ModuleContext = {
  requestId: string;
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
