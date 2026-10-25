import { createHash } from "node:crypto";

export const HARNESS_FEATURES = [
  "sessions", "history", "fork", "queue", "steer", "interrupt", "streaming", "modes", "plans",
  "instructions", "context", "compaction", "memory", "skills", "commands", "tools", "mcp", "plugins",
  "interactions", "attachments", "images", "audio", "video", "artifacts", "terminals", "workspace", "git",
  "checkpoints", "models", "settings", "usage", "agents", "automations", "hooks", "remote", "diagnostics",
] as const;
export type HarnessFeature = typeof HARNESS_FEATURES[number];
export type HarnessCapability = {
  support: "native" | "multivibe" | "unsupported" | "unknown";
  available: boolean;
  reason?: string;
  constraints?: Record<string, unknown>;
};
export type HarnessDescriptor = {
  id: string; name: string; protocol: "acp" | "pi-rpc" | "codex" | "claude-sdk" | "opencode" | "librechat" | "openwebui";
  version?: string; detected: boolean; configured: boolean; available: boolean; reason?: string;
  authentication: "unknown" | "required" | "ready";
  capabilities: Record<HarnessFeature, HarnessCapability>;
};
export type HarnessTarget = {
  id: string; name: string; kind: "local" | "ssh" | "container";
  sshHost?: string; bridgePath?: string; container?: string;
};
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "attachment"; attachmentId: string }
  | { type: "resource"; uri: string; text?: string; mimeType?: string }
  | { type: "structured"; value: unknown };
export type HarnessAttachment = {
  id: string; name: string; mimeType: string; size: number; sha256: string;
};
export type HarnessSession = {
  id: string; harnessId: string; targetId: string; workspace: string; nativeSessionId?: string;
  harnessVersion?: string; protocolVersion?: string;
  title: string; model?: string; authMode: "native" | "multivibe";
  state: "idle" | "starting" | "running" | "waiting_user" | "compacting" | "interrupted" | "uncertain" | "failed";
  queuePaused: boolean; revision: number; activeTurnId?: string;
  archived: boolean; pinned: boolean; createdAt: number; updatedAt: number;
  capabilities: Record<HarnessFeature, HarnessCapability>;
  configuration?: Record<string, unknown>;
};
export type PendingInteraction = {
  id: string; sessionId: string; kind: "permission" | "question" | "authentication";
  title: string; detail: unknown; status: "pending" | "answered" | "expired" | "cancelled";
  createdAt: number; expiresAt: number;
};
export type HarnessCommand = {
  id: string;
  type: "prompt" | "steer" | "interrupt" | "resume_queue" | "pause_queue" | "queue_edit" | "queue_remove"
    | "queue_reorder" | "compact" | "respond" | "inspect" | "configure" | "fork" | "native";
  turnId?: string; parts?: MessagePart[]; value?: Record<string, unknown>;
  displayText?: string;
};
export type HarnessCommandReceipt = {
  id: string; sessionId: string; command: HarnessCommand;
  state: "queued" | "dispatching" | "accepted" | "completed" | "failed" | "cancelled" | "uncertain";
  createdAt: number; ordinal: number; result?: unknown; error?: string;
  cancelRequested?: boolean; cancelAcknowledged?: boolean;
};
export type HarnessEvent = {
  seq: number; sessionId: string; type: string; turnId?: string; itemId?: string;
  payload: unknown; createdAt: number;
};
export type AdapterEvent = { type: string; payload: unknown; itemId?: string };
export type AdapterContext = {
  modelDiscovery?: boolean;
  session: HarnessSession; root: string; executable: string; target: HarnessTarget;
  emit: (event: AdapterEvent) => void;
  nativeSession: (id: string) => void;
  capabilities: (values: Partial<Record<HarnessFeature, HarnessCapability>>) => void;
  attachment: (id: string) => { info: HarnessAttachment; path: string; data: Buffer };
  ask: (kind: PendingInteraction["kind"], title: string, detail: unknown) => Promise<Record<string, unknown>>;
  openWebUIConnection?: {endpoint:string;apiKey:string;agentId:string};
  libreChatConnection?: {endpoint:string;apiKey:string;agentId:string};
  modelConnection?: {baseUrl:string;apiKey:string};
};
export interface HarnessAdapter {
  restartAfterInterrupt?: boolean;
  start(): Promise<void>;
  prompt(parts: MessagePart[], steer?: boolean): Promise<void>;
  interrupt(): Promise<void>;
  compact(instructions?: string): Promise<unknown>;
  inspect(subject: string): Promise<unknown>;
  configure(values: Record<string, unknown>): Promise<unknown>;
  native(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export class HarnessRuntimeError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "HarnessRuntimeError"; }
}
export function fail(message: string, status = 400): never { throw new HarnessRuntimeError(message, status); }
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/u.test(value)) fail("Invalid identifier");
  return value;
}
export function requiredText(value: unknown, max = 32_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) fail("Invalid text");
  return value;
}
export function messageParts(value: unknown): MessagePart[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) fail("A message needs 1–32 content parts");
  let total = 0;
  const parts = value.map((v): MessagePart => {
    if (v?.type === "text") { const text = requiredText(v.text); total += text.length; return { type: "text", text }; }
    if (v?.type === "attachment") return { type: "attachment", attachmentId: identifier(v.attachmentId) };
    if (v?.type === "resource") {
      const uri = requiredText(v.uri, 4096);
      if (v.text !== undefined && typeof v.text !== "string") fail("Invalid resource content");
      const text = v.text as string | undefined; total += text?.length ?? 0;
      return { type: "resource", uri, ...(text !== undefined ? { text } : {}), ...(typeof v.mimeType === "string" ? { mimeType: v.mimeType.slice(0,128) } : {}) };
    }
    fail("Unsupported input part");
  });
  if (total > 128_000) fail("Message content exceeds its limit", 413);
  return parts;
}
export function capabilities(): Record<HarnessFeature, HarnessCapability> {
  return Object.fromEntries(HARNESS_FEATURES.map(key => [key, { support: "unknown", available: false, reason: "Not advertised by this harness/version" }])) as Record<HarnessFeature, HarnessCapability>;
}
export const supported = (support: "native" | "multivibe" = "native", constraints?: Record<string, unknown>): HarnessCapability => ({ support, available: true, ...(constraints ? { constraints } : {}) });
export const unsupported = (reason: string): HarnessCapability => ({ support: "unsupported", available: false, reason });

// Diagnostics and protocol metadata must never persist provider credentials.
export function redact(value: unknown, depth = 0): any {
  if (depth > 16) return "[depth limit]";
  if (typeof value === "string") {const redacted=value.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 [private]").replace(/\bsk-[a-zA-Z0-9_-]{16,}/gu,"[private]");return redacted.length>128_000?redacted.slice(0,128_000)+" [truncated]":redacted;}
  if (Array.isArray(value)) return [...value.slice(0,256).map(v => redact(v, depth + 1)),...(value.length>256?[{truncated:true,total:value.length}]:[])];
  if (value && typeof value === "object") {const entries=Object.entries(value);return Object.fromEntries([...entries.slice(0,256).map(([k,v]) => {const schema=v && typeof v==="object" && ["string","number","integer","boolean","object","array"].includes(String((v as any).type));return [k, !schema && /^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|password|secret|credentials?|cookies?|set-cookie|env|headers|authUrl|authorizationUrl|loginUrl|verification_uri_complete)$/iu.test(k) ? "[private]" : redact(v, depth + 1)];}),...(entries.length>256?[["_multivibeTruncatedKeys",entries.length-256]]:[])]);}
  return value;
}
export function fingerprint(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
