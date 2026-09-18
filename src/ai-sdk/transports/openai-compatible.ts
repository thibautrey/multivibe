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
  type SdkUsage,
} from "../model.js";
import { parseToolInput, sseData, throwResponseError } from "../transport-utils.js";

export type OpenAICompatibleConfig = {
  provider: string;
  modelId: string;
  baseURL: string;
  apiKey: string;
  authScheme?: "Bearer" | "Key";
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  includeUsage?: boolean;
};

function mapFinishReason(reason: string | null | undefined): SdkFinishReason {
  if (reason == null) return { unified: "other" };
  const unified = ({
    stop: "stop",
    length: "length",
    content_filter: "content-filter",
    tool_calls: "tool-calls",
    function_call: "tool-calls",
  } as const)[reason as "stop" | "length" | "content_filter" | "tool_calls" | "function_call"] ?? "other";
  return { unified, raw: reason };
}

function convertUsage(usage: any): SdkUsage {
  if (usage == null || typeof usage !== "object") return unknownUsage();
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    inputTokens: {
      total: promptTokens,
      noCache: promptTokens - cacheReadTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: completionTokens,
      text: Math.max(0, completionTokens - reasoningTokens),
      reasoning: reasoningTokens,
    },
    raw: usage,
  };
}

function filePartToChat(part: Extract<SdkPrompt[number], { role: "user" }>["content"][number]): Record<string, unknown> {
  if (part.type === "text") return { type: "text", text: part.text };
  const mediaType = part.mediaType.split("/")[0].toLowerCase();
  if (mediaType !== "image") throw new SdkInputError("This provider accepts text and image content only");
  const url = part.data.type === "url"
    ? part.data.url.toString()
    : `data:${part.mediaType};base64,${part.data.data}`;
  return { type: "image_url", image_url: { url } };
}

function toChatMessages(prompt: SdkPrompt): any[] {
  const messages: any[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      messages.push({ role: "system", content: message.content });
    } else if (message.role === "user") {
      const parts = message.content;
      messages.push(parts.length === 1 && parts[0].type === "text"
        ? { role: "user", content: parts[0].text }
        : { role: "user", content: parts.map(filePartToChat) });
    } else if (message.role === "assistant") {
      let text = "";
      let reasoning = "";
      const toolCalls: any[] = [];
      for (const part of message.content) {
        if (part.type === "text") text += part.text;
        else if (part.type === "reasoning") reasoning += part.text;
        else if (part.type === "tool-call") toolCalls.push({
          id: part.toolCallId,
          type: "function",
          function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) },
        });
      }
      messages.push({
        role: "assistant",
        content: toolCalls.length > 0 ? text || null : text,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      for (const result of message.content) {
        messages.push({ role: "tool", tool_call_id: result.toolCallId, content: result.output.value });
      }
    }
  }
  return messages;
}

function requestBody(config: OpenAICompatibleConfig, options: SdkCallOptions, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.modelId,
    messages: toChatMessages(options.prompt),
  };
  if (stream) {
    body.stream = true;
    if (config.includeUsage !== false) body.stream_options = { include_usage: true };
  }
  if (options.maxOutputTokens !== undefined) body.max_tokens = options.maxOutputTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.topP !== undefined) body.top_p = options.topP;
  if (options.frequencyPenalty !== undefined) body.frequency_penalty = options.frequencyPenalty;
  if (options.presencePenalty !== undefined) body.presence_penalty = options.presencePenalty;
  if (options.seed !== undefined) body.seed = options.seed;
  if (options.stopSequences !== undefined) body.stop = options.stopSequences;
  if (options.reasoning !== undefined && options.reasoning !== "provider-default") body.reasoning_effort = options.reasoning;
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        parameters: tool.inputSchema,
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    }));
  }
  if (options.toolChoice !== undefined) {
    body.tool_choice = options.toolChoice.type === "tool"
      ? { type: "function", function: { name: options.toolChoice.toolName } }
      : options.toolChoice.type;
  }
  if (options.responseFormat !== undefined && options.responseFormat.type !== "text") {
    body.response_format = { type: "json_object" };
  }
  return body;
}

type ToolStreamState = { id?: string; name?: string; arguments: string; started: boolean; ended: boolean };

export function createOpenAICompatibleModel(config: OpenAICompatibleConfig): SdkModel {
  const fetchImpl = config.fetch ?? fetch;
  const url = `${config.baseURL.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(config.apiKey
      ? { authorization: config.authScheme === "Key" ? `Key ${config.apiKey}` : `Bearer ${config.apiKey}` }
      : {}),
    ...config.headers,
  };

  const doGenerate = async (options: SdkCallOptions): Promise<SdkGenerateResult> => {
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: options.abortSignal,
      headers,
      body: JSON.stringify(requestBody(config, options, false)),
    });
    if (!response.ok) await throwResponseError(response);
    const payload: any = await response.json();
    const choice = payload?.choices?.[0] ?? {};
    const message = choice.message ?? {};
    const content: SdkAssistantPart[] = [];
    if (typeof message.content === "string" && message.content.length > 0) content.push({ type: "text", text: message.content });
    else if (Array.isArray(message.content)) {
      for (const part of message.content) if (typeof part?.text === "string" && part.text) content.push({ type: "text", text: part.text });
    }
    const reasoning = message.reasoning_content ?? message.reasoning;
    if (typeof reasoning === "string" && reasoning.length > 0) content.push({ type: "reasoning", text: reasoning });
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call?.type !== "function" || typeof call.function?.name !== "string") continue;
        const callId = typeof call.id === "string" && call.id ? call.id : `call_${content.length}`;
        content.push({ type: "tool-call", toolCallId: callId, toolName: call.function.name, input: parseToolInput(String(call.function.arguments ?? "")) });
      }
    }
    return {
      content,
      finishReason: mapFinishReason(choice.finish_reason),
      usage: convertUsage(payload?.usage),
      warnings: [],
      response: {
        id: typeof payload?.id === "string" ? payload.id : undefined,
        modelId: typeof payload?.model === "string" ? payload.model : undefined,
        ...(typeof payload?.created === "number" ? { timestamp: new Date(payload.created * 1_000) } : {}),
      },
    };
  };

  const doStream = async (options: SdkCallOptions): Promise<{ stream: ReadableStream<SdkStreamPart> }> => {
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: options.abortSignal,
      headers,
      body: JSON.stringify(requestBody(config, options, true)),
    });
    if (!response.ok) await throwResponseError(response);
    if (!response.body) throw new SdkProviderError("Provider returned an empty stream", { statusCode: response.status });

    const tools = new Map<number, ToolStreamState>();
    let started = false;
    let textStarted = false;
    let reasoningStarted = false;
    let finished = false;
    let finishReason: SdkFinishReason | undefined;
    let usage: SdkUsage = unknownUsage();

    const stream = new ReadableStream<SdkStreamPart>({
      async start(controller) {
        const emit = (part: SdkStreamPart) => controller.enqueue(part);
        const endText = () => { if (textStarted) { textStarted = false; emit({ type: "text-end", id: "txt-0" }); } };
        const endReasoning = () => { if (reasoningStarted) { reasoningStarted = false; emit({ type: "reasoning-end", id: "reasoning-0" }); } };
        try {
          for await (const payload of sseData<Record<string, any>>(response.body!)) {
            if (payload === "[DONE]") break;
            if (payload?.error) {
              throw new SdkProviderError(
                typeof payload.error?.message === "string" ? payload.error.message : "Provider stream failed",
                { statusCode: 502, data: payload.error },
              );
            }
            if (!started) {
              started = true;
              emit({ type: "stream-start", warnings: [] });
              emit({
                type: "response-metadata",
                id: typeof payload?.id === "string" ? payload.id : undefined,
                modelId: typeof payload?.model === "string" ? payload.model : undefined,
                ...(typeof payload?.created === "number" ? { timestamp: new Date(payload.created * 1_000) } : {}),
              });
            }
            if (payload?.usage != null) usage = convertUsage(payload.usage);
            const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined;
            if (!choice) continue;
            if (choice.finish_reason != null) finishReason = mapFinishReason(choice.finish_reason);
            const delta = choice.delta;
            if (!delta) continue;
            const content = delta.content;
            if (typeof content === "string" && content.length > 0) {
              if (!textStarted) { textStarted = true; emit({ type: "text-start", id: "txt-0" }); }
              emit({ type: "text-delta", id: "txt-0", delta: content });
            }
            const reasoning = delta.reasoning_content ?? delta.reasoning;
            if (typeof reasoning === "string" && reasoning.length > 0) {
              if (!reasoningStarted) { reasoningStarted = true; emit({ type: "reasoning-start", id: "reasoning-0" }); }
              emit({ type: "reasoning-delta", id: "reasoning-0", delta: reasoning });
            }
            if (Array.isArray(delta.tool_calls)) {
              endText();
              endReasoning();
              for (const call of delta.tool_calls) {
                const index = Number.isInteger(call?.index) ? Number(call.index) : tools.size;
                const state = tools.get(index) ?? { arguments: "", started: false, ended: false };
                tools.set(index, state);
                if (typeof call?.id === "string" && call.id && !state.id) state.id = call.id;
                const name = call?.function?.name;
                if (typeof name === "string" && name && !state.name) state.name = name;
                const args = call?.function?.arguments;
                if (typeof args === "string" && args) state.arguments += args;
                if (!state.started && state.name) {
                  state.id ??= `call_${index}`;
                  state.started = true;
                  emit({ type: "tool-input-start", id: state.id, toolName: state.name });
                  if (state.arguments) emit({ type: "tool-input-delta", id: state.id, delta: state.arguments });
                } else if (state.started && typeof args === "string" && args) {
                  emit({ type: "tool-input-delta", id: state.id!, delta: args });
                }
              }
            }
          }
          if (!started) {
            emit({ type: "stream-start", warnings: [] });
            emit({ type: "response-metadata" });
          }
          endText();
          endReasoning();
          for (const [index, state] of tools) {
            state.id ??= `call_${index}`;
            if (!state.started) {
              state.started = true;
              emit({ type: "tool-input-start", id: state.id, toolName: state.name ?? "unknown" });
              if (state.arguments) emit({ type: "tool-input-delta", id: state.id, delta: state.arguments });
            }
            if (!state.ended) {
              state.ended = true;
              emit({ type: "tool-input-end", id: state.id });
            }
            emit({ type: "tool-call", toolCallId: state.id, toolName: state.name ?? "unknown", input: parseToolInput(state.arguments) });
          }
          if (!finished) {
            finished = true;
            emit({ type: "finish", usage, finishReason: finishReason ?? { unified: "error", raw: "stream-ended" } });
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

  return { specificationVersion: "v4", provider: config.provider, modelId: config.modelId, supportedUrls: {}, doGenerate, doStream };
}
