import {
  SdkInputError,
  SdkProviderError,
  unknownUsage,
  type SdkAssistantPart,
  type SdkCallOptions,
  type SdkFinishReason,
  type SdkGenerateResult,
  type SdkModel,
  type SdkPrompt,
  type SdkStreamPart,
  type SdkToolDefinition,
  type SdkUsage,
} from "../model.js";
import { parseToolInput, sseData, throwResponseError } from "../transport-utils.js";

export type AnthropicConfig = {
  modelId: string;
  apiKey: string;
  baseURL?: string;
  fetch?: typeof fetch;
};

const ANTHROPIC_VERSION = "2023-06-01";

const ANTHROPIC_STOP_REASONS = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool-calls",
  refusal: "content-filter",
  pause_turn: "other",
} as const;

function mapFinishReason(reason: string | null | undefined): SdkFinishReason {
  if (reason == null) return { unified: "other" };
  const unified: SdkFinishReason["unified"] = ANTHROPIC_STOP_REASONS[reason as keyof typeof ANTHROPIC_STOP_REASONS] ?? "other";
  return { unified, raw: reason };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === "string" ? part.text : "").join("");
  return "";
}

export function convertAnthropicUsage(usage: Record<string, any> | null | undefined, rawUsage?: Record<string, unknown>): SdkUsage {
  if (usage == null || typeof usage !== "object") return unknownUsage();
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const reasoningTokens = usage.output_tokens_details?.thinking_tokens ?? undefined;
  let inputTokens: number = usage.input_tokens ?? 0;
  let outputTokens: number = usage.output_tokens ?? 0;
  const servedByFallback = Array.isArray(usage.iterations) && usage.iterations.some((iteration: any) => iteration?.type === "fallback_message");
  if (Array.isArray(usage.iterations) && usage.iterations.length > 0 && !servedByFallback) {
    const executorIterations = usage.iterations.filter((iteration: any) => iteration?.type === "compaction" || iteration?.type === "message");
    if (executorIterations.length > 0) {
      inputTokens = executorIterations.reduce((sum: number, iteration: any) => sum + Number(iteration.input_tokens ?? 0), 0);
      outputTokens = executorIterations.reduce((sum: number, iteration: any) => sum + Number(iteration.output_tokens ?? 0), 0);
    }
  }
  return {
    inputTokens: {
      total: inputTokens + cacheCreationTokens + cacheReadTokens,
      noCache: inputTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheCreationTokens,
    },
    outputTokens: {
      total: outputTokens,
      text: reasoningTokens == null ? undefined : outputTokens - reasoningTokens,
      reasoning: reasoningTokens,
    },
    raw: rawUsage ?? usage,
  };
}

function imagePartToAnthropic(part: Extract<SdkPrompt[number], { role: "user" }>["content"][number]): Record<string, unknown> {
  if (part.type === "text") return { type: "text", text: part.text };
  if (!part.mediaType.toLowerCase().startsWith("image/")) throw new SdkInputError("This provider accepts text and image content only");
  if (part.data.type === "url") return { type: "image", source: { type: "url", url: part.data.url.toString() } };
  return { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data.data } };
}

function toAnthropicMessages(prompt: SdkPrompt): { messages: any[]; system?: string } {
  const messages: any[] = [];
  const system: string[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      system.push(message.content);
    } else if (message.role === "user") {
      messages.push({ role: "user", content: message.content.map(imagePartToAnthropic) });
    } else if (message.role === "assistant") {
      const content: any[] = [];
      for (const part of message.content) {
        if (part.type === "text" && part.text) content.push({ type: "text", text: part.text });
        else if (part.type === "tool-call") content.push({ type: "tool_use", id: part.toolCallId, name: part.toolName, input: part.input ?? {} });
        // Reasoning without a provider signature cannot be replayed; Anthropic
        // rejects unsigned thinking blocks, so it is intentionally dropped.
      }
      if (content.length) messages.push({ role: "assistant", content });
    } else {
      messages.push({
        role: "user",
        content: message.content.map((result) => ({
          type: "tool_result",
          tool_use_id: result.toolCallId,
          content: result.output.value,
        })),
      });
    }
  }
  return { messages, ...(system.length ? { system: system.join("\n\n") } : {}) };
}

function toAnthropicTools(tools: SdkToolDefinition[] | undefined): unknown {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    input_schema: tool.inputSchema,
  }));
}

function toAnthropicToolChoice(choice: SdkCallOptions["toolChoice"]): unknown {
  if (choice === undefined || choice.type === "none") return undefined;
  if (choice.type === "auto") return { type: "auto" };
  if (choice.type === "required") return { type: "any" };
  return { type: "tool", name: choice.toolName };
}

type AnthropicThinking = { type: "enabled"; budget_tokens: number } | { type: "disabled" };

function thinkingFor(reasoning: string | undefined): { thinking?: AnthropicThinking; budget: number } {
  if (reasoning === undefined || reasoning === "provider-default") return { budget: 0 };
  if (reasoning === "none") return { thinking: { type: "disabled" }, budget: 0 };
  const budget = ({ minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768 } as Record<string, number>)[reasoning];
  if (budget === undefined) return { budget: 0 };
  return { thinking: { type: "enabled", budget_tokens: budget }, budget };
}

function requestBody(config: AnthropicConfig, options: SdkCallOptions): Record<string, unknown> {
  const { messages, system } = toAnthropicMessages(options.prompt);
  const { thinking, budget } = thinkingFor(options.reasoning);
  const baseTokens = options.maxOutputTokens ?? 4096;
  const body: Record<string, unknown> = {
    model: config.modelId,
    max_tokens: baseTokens + budget,
    messages,
  };
  if (system !== undefined) body.system = system;
  if (temperatureAllowed(thinking)) {
    if (options.temperature !== undefined) body.temperature = options.temperature;
  }
  if (options.topP !== undefined) body.top_p = options.topP;
  if (options.topK !== undefined) body.top_k = options.topK;
  if (options.stopSequences !== undefined) body.stop_sequences = options.stopSequences;
  if (thinking !== undefined) body.thinking = thinking;
  const tools = toAnthropicTools(options.tools);
  if (tools !== undefined) body.tools = tools;
  const toolChoice = toAnthropicToolChoice(options.toolChoice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  if (options.responseFormat?.type === "json" && options.responseFormat.schema !== undefined) {
    body.output_config = { format: { type: "json_schema", schema: options.responseFormat.schema } };
  }
  return body;
}

/** Extended thinking fixes the sampling temperature at 1. */
function temperatureAllowed(thinking: AnthropicThinking | undefined): boolean {
  return thinking === undefined || thinking.type === "disabled";
}

export function createAnthropicModel(config: AnthropicConfig): SdkModel {
  const fetchImpl = config.fetch ?? fetch;
  const baseURL = (config.baseURL ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
  const headers = {
    "content-type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };

  const doGenerate = async (options: SdkCallOptions): Promise<SdkGenerateResult> => {
    const response = await fetchImpl(`${baseURL}/messages`, {
      method: "POST",
      redirect: "error",
      signal: options.abortSignal,
      headers,
      body: JSON.stringify(requestBody(config, options)),
    });
    if (!response.ok) await throwResponseError(response);
    const payload: any = await response.json();
    const content: SdkAssistantPart[] = [];
    for (const block of Array.isArray(payload?.content) ? payload.content : []) {
      if (block?.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
      else if (block?.type === "thinking" && typeof block.thinking === "string") content.push({ type: "reasoning", text: block.thinking, providerOptions: { anthropic: { signature: block.signature } } });
      else if (block?.type === "tool_use" && typeof block.name === "string") content.push({ type: "tool-call", toolCallId: String(block.id ?? ""), toolName: block.name, input: block.input ?? {} });
    }
    return {
      content,
      finishReason: mapFinishReason(payload?.stop_reason),
      usage: convertAnthropicUsage(payload?.usage),
      warnings: [],
      response: {
        id: typeof payload?.id === "string" ? payload.id : undefined,
        modelId: typeof payload?.model === "string" ? payload.model : undefined,
      },
    };
  };

  const doStream = async (options: SdkCallOptions): Promise<{ stream: ReadableStream<SdkStreamPart> }> => {
    const response = await fetchImpl(`${baseURL}/messages`, {
      method: "POST",
      redirect: "error",
      signal: options.abortSignal,
      headers,
      body: JSON.stringify({ ...requestBody(config, options), stream: true }),
    });
    if (!response.ok) await throwResponseError(response);
    if (!response.body) throw new SdkProviderError("Provider returned an empty stream", { statusCode: response.status });

    let rawUsage: Record<string, any> = {};
    let finishReason: SdkFinishReason | undefined;
    let started = false;
    let textStarted = false;
    let reasoningStarted = false;
    let finished = false;
    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();
    const stream = new ReadableStream<SdkStreamPart>({
      async start(controller) {
        const emit = (part: SdkStreamPart) => controller.enqueue(part);
        const endText = () => { if (textStarted) { textStarted = false; emit({ type: "text-end", id: "txt-0" }); } };
        const endReasoning = () => { if (reasoningStarted) { reasoningStarted = false; emit({ type: "reasoning-end", id: "reasoning-0" }); } };
        try {
          for await (const payload of sseData<Record<string, any>>(response.body!)) {
            if (payload === "[DONE]") break;
            if (payload?.type === "error") {
              throw new SdkProviderError(
                typeof payload.error?.message === "string" ? payload.error.message : "Provider stream failed",
                { statusCode: 502, data: payload.error },
              );
            }
            if (!started) {
              started = true;
              emit({ type: "stream-start", warnings: [] });
            }
            if (payload?.type === "message_start") {
              rawUsage = { ...(payload.message?.usage ?? {}) };
              emit({
                type: "response-metadata",
                id: typeof payload.message?.id === "string" ? payload.message.id : undefined,
                modelId: typeof payload.message?.model === "string" ? payload.message.model : undefined,
              });
            } else if (payload?.type === "content_block_start") {
              const block = payload.content_block ?? {};
              blocks.set(Number(payload.index ?? 0), {
                type: String(block.type ?? ""),
                id: typeof block.id === "string" ? block.id : undefined,
                name: typeof block.name === "string" ? block.name : undefined,
                json: "",
              });
              if (block.type === "tool_use" && typeof block.name === "string") {
                endText();
                endReasoning();
                emit({ type: "tool-input-start", id: String(block.id ?? `call_${payload.index}`), toolName: block.name });
              }
            } else if (payload?.type === "content_block_delta") {
              const delta = payload.delta ?? {};
              if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
                if (!textStarted) { textStarted = true; emit({ type: "text-start", id: "txt-0" }); }
                emit({ type: "text-delta", id: "txt-0", delta: delta.text });
              } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
                if (!reasoningStarted) { reasoningStarted = true; emit({ type: "reasoning-start", id: "reasoning-0" }); }
                emit({ type: "reasoning-delta", id: "reasoning-0", delta: delta.thinking });
              } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                const state = blocks.get(Number(payload.index ?? 0));
                if (state?.id) {
                  state.json += delta.partial_json;
                  emit({ type: "tool-input-delta", id: state.id, delta: delta.partial_json });
                }
              }
            } else if (payload?.type === "content_block_stop") {
              const state = blocks.get(Number(payload.index ?? 0));
              if (state?.type === "text") endText();
              else if (state?.type === "thinking") endReasoning();
              else if (state?.type === "tool_use" && state.id) {
                emit({ type: "tool-input-end", id: state.id });
                emit({ type: "tool-call", toolCallId: state.id, toolName: state.name ?? "unknown", input: parseToolInput(state.json) });
              }
            } else if (payload?.type === "message_delta") {
              if (payload.delta?.stop_reason != null) finishReason = mapFinishReason(payload.delta.stop_reason);
              if (payload.usage != null) rawUsage = { ...rawUsage, ...payload.usage };
            } else if (payload?.type === "message_stop") {
              finished = true;
              endText();
              endReasoning();
              emit({ type: "finish", usage: convertAnthropicUsage(rawUsage, rawUsage), finishReason: finishReason ?? { unified: "error", raw: "stream-ended" } });
              break;
            }
          }
          if (!finished) {
            endText();
            endReasoning();
            emit({ type: "finish", usage: convertAnthropicUsage(rawUsage, rawUsage), finishReason: finishReason ?? { unified: "error", raw: "stream-ended" } });
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        return response.body?.cancel().catch(() => undefined) ?? undefined;
      },
    });
    return { stream };
  };

  return { specificationVersion: "v4", provider: "anthropic", modelId: config.modelId, supportedUrls: {}, doGenerate, doStream };
}
