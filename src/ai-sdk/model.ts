/**
 * Internal provider-model contract.
 *
 * This is the narrow surface the adapter routes need: one prompt shape, one
 * generate result, one incremental stream part union. Transports are plain
 * fetch implementations, so provider-specific payloads never pass through a
 * third-party abstraction that can silently drop fields.
 */

export type SdkUsage = {
  inputTokens: { total?: number; noCache?: number; cacheRead?: number; cacheWrite?: number };
  outputTokens: { total?: number; text?: number; reasoning?: number };
  raw?: Record<string, unknown>;
};

export type SdkFinishReason = {
  unified: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "other";
  raw?: string;
};

export type SdkTextPart = { type: "text"; text: string };
export type SdkReasoningPart = { type: "reasoning"; text: string; providerOptions?: Record<string, unknown> };
export type SdkToolCallPart = { type: "tool-call"; toolCallId: string; toolName: string; input: unknown };
export type SdkToolResultPart = { type: "tool-result"; toolCallId: string; toolName: string; output: { type: "text"; value: string } };
export type SdkAssistantPart = SdkTextPart | SdkReasoningPart | SdkToolCallPart;

export type SdkFilePart = {
  type: "file";
  mediaType: string;
  data: { type: "data"; data: string } | { type: "url"; url: URL };
};

export type SdkMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: Array<SdkTextPart | SdkFilePart> }
  | { role: "assistant"; content: SdkAssistantPart[] }
  | { role: "tool"; content: SdkToolResultPart[] };

export type SdkPrompt = SdkMessage[];

export type SdkToolDefinition = {
  type: "function";
  name: string;
  description?: string;
  inputSchema: unknown;
  strict?: boolean;
};

export type SdkToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "required" }
  | { type: "tool"; toolName: string };

export type SdkResponseFormat =
  | { type: "text" }
  | { type: "json"; name?: string; description?: string; schema?: unknown };

export type SdkCallOptions = {
  prompt: SdkPrompt;
  abortSignal?: AbortSignal;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  tools?: SdkToolDefinition[];
  toolChoice?: SdkToolChoice;
  responseFormat?: SdkResponseFormat;
  reasoning?: string;
  providerOptions?: Record<string, unknown>;
};

export type SdkGenerateResult = {
  content: SdkAssistantPart[];
  finishReason: SdkFinishReason;
  usage: SdkUsage;
  warnings: unknown[];
  response?: { id?: string; modelId?: string; timestamp?: Date };
  providerMetadata?: Record<string, unknown>;
};

export type SdkStreamPart =
  | { type: "stream-start"; warnings: unknown[] }
  | { type: "response-metadata"; id?: string; modelId?: string; timestamp?: Date }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | { type: "tool-input-start"; id: string; toolName: string }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-input-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "finish"; usage: SdkUsage; finishReason: SdkFinishReason }
  | { type: "error"; error: unknown };

/** Invalid client input; mapped to HTTP 400 by the adapter routes. */
export class SdkInputError extends Error {}

export type SdkModel = {
  readonly provider?: string;
  readonly modelId?: string;
  specificationVersion?: "v4";
  supportedUrls?: Record<string, unknown>;
  doGenerate(options: SdkCallOptions): Promise<SdkGenerateResult>;
  doStream(options: SdkCallOptions): Promise<{ stream: ReadableStream<SdkStreamPart> }>;
};

export function unknownUsage(): SdkUsage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
}

/** Provider transport failure that keeps the upstream envelope observable. */
export class SdkProviderError extends Error {
  readonly statusCode: number;
  readonly responseBody?: string;
  readonly data?: unknown;
  constructor(message: string, options: { statusCode: number; responseBody?: string; data?: unknown; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SdkProviderError";
    this.statusCode = options.statusCode;
    this.responseBody = options.responseBody;
    this.data = options.data;
  }
}

export type SdkFetch = typeof fetch;

export function resolveFetch(fetchImpl?: SdkFetch): SdkFetch {
  return fetchImpl ?? fetch;
}
