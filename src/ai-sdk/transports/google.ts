import {
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
import { sseData, throwResponseError } from "../transport-utils.js";

export type GoogleConfig = {
  modelId: string;
  apiKey: string;
  baseURL?: string;
  fetch?: typeof fetch;
};

const GOOGLE_FINISH_REASONS = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content-filter",
  RECITATION: "content-filter",
  BLOCKLIST: "content-filter",
  PROHIBITED_CONTENT: "content-filter",
  SPII: "content-filter",
  IMAGE_SAFETY: "content-filter",
  MALFORMED_FUNCTION_CALL: "error",
  UNEXPECTED_TOOL_CALL: "error",
} as const;

function mapFinishReason(reason: string | null | undefined): SdkFinishReason {
  if (reason == null) return { unified: "other" };
  const unified: SdkFinishReason["unified"] = GOOGLE_FINISH_REASONS[reason as keyof typeof GOOGLE_FINISH_REASONS] ?? "other";
  return { unified, raw: reason };
}

function convertUsage(usageMetadata: any): SdkUsage {
  if (usageMetadata == null || typeof usageMetadata !== "object") return unknownUsage();
  const promptTokens = usageMetadata.promptTokenCount ?? 0;
  const candidatesTokens = usageMetadata.candidatesTokenCount ?? 0;
  const cachedContentTokens = usageMetadata.cachedContentTokenCount ?? 0;
  const thoughtsTokens = usageMetadata.thoughtsTokenCount ?? 0;
  return {
    inputTokens: {
      total: promptTokens,
      noCache: promptTokens - cachedContentTokens,
      cacheRead: cachedContentTokens,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: candidatesTokens + thoughtsTokens,
      text: candidatesTokens,
      reasoning: thoughtsTokens,
    },
    raw: usageMetadata,
  };
}

function filePartToGoogle(part: Extract<SdkPrompt[number], { role: "user" }>["content"][number]): Record<string, unknown> {
  if (part.type === "text") return { text: part.text };
  if (part.data.type === "url") return { fileData: { mimeType: part.mediaType, fileUri: part.data.url.toString() } };
  return { inlineData: { mimeType: part.mediaType, data: part.data.data } };
}

function toGoogleContents(prompt: SdkPrompt): { contents: any[]; systemInstruction?: unknown } {
  const contents: any[] = [];
  let systemInstruction: unknown;
  for (const message of prompt) {
    if (message.role === "system") {
      systemInstruction = { parts: [{ text: message.content }] };
    } else if (message.role === "user") {
      contents.push({ role: "user", parts: message.content.map(filePartToGoogle) });
    } else if (message.role === "assistant") {
      const parts: any[] = [];
      for (const part of message.content) {
        if (part.type === "text" && part.text) parts.push({ text: part.text });
        else if (part.type === "tool-call") parts.push({ functionCall: { name: part.toolName, args: part.input ?? {} } });
      }
      if (parts.length) contents.push({ role: "model", parts });
    } else {
      contents.push({
        role: "user",
        parts: message.content.map((result) => ({
          functionResponse: {
            name: result.toolName,
            response: { name: result.toolName, content: result.output.value },
          },
        })),
      });
    }
  }
  return { contents, ...(systemInstruction !== undefined ? { systemInstruction } : {}) };
}

function toGoogleTools(tools: SdkToolDefinition[] | undefined): unknown {
  if (!tools?.length) return undefined;
  return [{ functionDeclarations: tools.map((tool) => ({
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    parameters: tool.inputSchema,
  })) }];
}

function toGoogleToolConfig(options: SdkCallOptions): unknown {
  if (options.toolChoice === undefined) return undefined;
  if (options.toolChoice.type === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (options.toolChoice.type === "required") return { functionCallingConfig: { mode: "ANY" } };
  if (options.toolChoice.type === "tool") {
    return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [options.toolChoice.toolName] } };
  }
  return undefined;
}

function requestBody(config: GoogleConfig, options: SdkCallOptions): Record<string, unknown> {
  const { contents, systemInstruction } = toGoogleContents(options.prompt);
  const generationConfig: Record<string, unknown> = {};
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (options.topP !== undefined) generationConfig.topP = options.topP;
  if (options.topK !== undefined) generationConfig.topK = options.topK;
  if (options.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = options.maxOutputTokens;
  if (options.stopSequences !== undefined) generationConfig.stopSequences = options.stopSequences;
  if (options.seed !== undefined) generationConfig.seed = options.seed;
  if (options.responseFormat?.type === "json") {
    generationConfig.responseMimeType = "application/json";
    if (options.responseFormat.schema !== undefined) generationConfig.responseJsonSchema = options.responseFormat.schema;
  }
  const thinkingBudget = ({ none: 0, minimal: 512, low: 1024, medium: 8192, high: 24576, xhigh: 32768 } as Record<string, number>)[options.reasoning ?? ""];
  if (thinkingBudget !== undefined) generationConfig.thinkingConfig = { thinkingBudget };
  return {
    contents,
    ...(systemInstruction !== undefined ? { systemInstruction } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    ...(toGoogleTools(options.tools) ? { tools: toGoogleTools(options.tools) } : {}),
    ...(toGoogleToolConfig(options) ? { toolConfig: toGoogleToolConfig(options) } : {}),
  };
}

function partsToContent(parts: any): SdkAssistantPart[] {
  const content: SdkAssistantPart[] = [];
  let index = 0;
  for (const part of Array.isArray(parts) ? parts : []) {
    if (typeof part?.text === "string" && part.text) {
      content.push(part.thought === true ? { type: "reasoning", text: part.text } : { type: "text", text: part.text });
    } else if (part?.functionCall) {
      const name = part.functionCall.name;
      if (typeof name !== "string" || !name) continue;
      const callId = typeof part.functionCall.id === "string" && part.functionCall.id ? part.functionCall.id : `call_${index}`;
      content.push({ type: "tool-call", toolCallId: callId, toolName: name, input: part.functionCall.args ?? {} });
    }
    index++;
  }
  return content;
}

export function createGoogleModel(config: GoogleConfig): SdkModel {
  const fetchImpl = config.fetch ?? fetch;
  const baseURL = (config.baseURL ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const headers = { "content-type": "application/json", "x-goog-api-key": config.apiKey };
  const modelPath = `${baseURL}/models/${encodeURIComponent(config.modelId)}`;

  const doGenerate = async (options: SdkCallOptions): Promise<SdkGenerateResult> => {
    const response = await fetchImpl(`${modelPath}:generateContent`, {
      method: "POST",
      redirect: "error",
      signal: options.abortSignal,
      headers,
      body: JSON.stringify(requestBody(config, options)),
    });
    if (!response.ok) await throwResponseError(response);
    const payload: any = await response.json();
    const candidate = payload?.candidates?.[0] ?? {};
    return {
      content: partsToContent(candidate.content?.parts),
      finishReason: mapFinishReason(candidate.finishReason),
      usage: convertUsage(payload?.usageMetadata),
      warnings: [],
      response: {
        id: typeof payload?.responseId === "string" ? payload.responseId : undefined,
        modelId: typeof payload?.modelVersion === "string" ? payload.modelVersion : undefined,
      },
    };
  };

  const doStream = async (options: SdkCallOptions): Promise<{ stream: ReadableStream<SdkStreamPart> }> => {
    const response = await fetchImpl(`${modelPath}:streamGenerateContent?alt=sse`, {
      method: "POST",
      redirect: "error",
      signal: options.abortSignal,
      headers,
      body: JSON.stringify(requestBody(config, options)),
    });
    if (!response.ok) await throwResponseError(response);
    if (!response.body) throw new SdkProviderError("Provider returned an empty stream", { statusCode: response.status });

    let usage: SdkUsage = unknownUsage();
    let finishReason: SdkFinishReason | undefined;
    let textStarted = false;
    let reasoningStarted = false;
    let started = false;
    const stream = new ReadableStream<SdkStreamPart>({
      async start(controller) {
        const emit = (part: SdkStreamPart) => controller.enqueue(part);
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
              emit({ type: "response-metadata", modelId: config.modelId });
            }
            if (payload?.usageMetadata != null) usage = convertUsage(payload.usageMetadata);
            const candidate = payload?.candidates?.[0];
            if (!candidate) continue;
            if (candidate.finishReason != null) finishReason = mapFinishReason(candidate.finishReason);
            for (const part of Array.isArray(candidate.content?.parts) ? candidate.content.parts : []) {
              if (typeof part?.text === "string" && part.text) {
                if (part.thought === true) {
                  if (!reasoningStarted) { reasoningStarted = true; emit({ type: "reasoning-start", id: "reasoning-0" }); }
                  emit({ type: "reasoning-delta", id: "reasoning-0", delta: part.text });
                } else {
                  if (!textStarted) { textStarted = true; emit({ type: "text-start", id: "txt-0" }); }
                  emit({ type: "text-delta", id: "txt-0", delta: part.text });
                }
              } else if (part?.functionCall) {
                const name = part.functionCall.name;
                if (typeof name !== "string" || !name) continue;
                if (textStarted) { textStarted = false; emit({ type: "text-end", id: "txt-0" }); }
                if (reasoningStarted) { reasoningStarted = false; emit({ type: "reasoning-end", id: "reasoning-0" }); }
                const callId = typeof part.functionCall.id === "string" && part.functionCall.id ? part.functionCall.id : `call_${name}`;
                const args = JSON.stringify(part.functionCall.args ?? {});
                emit({ type: "tool-input-start", id: callId, toolName: name });
                emit({ type: "tool-input-delta", id: callId, delta: args });
                emit({ type: "tool-input-end", id: callId });
                emit({ type: "tool-call", toolCallId: callId, toolName: name, input: part.functionCall.args ?? {} });
              }
            }
          }
          if (textStarted) emit({ type: "text-end", id: "txt-0" });
          if (reasoningStarted) emit({ type: "reasoning-end", id: "reasoning-0" });
          emit({ type: "finish", usage, finishReason: finishReason ?? { unified: "error", raw: "stream-ended" } });
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

  return { specificationVersion: "v4", provider: "google", modelId: config.modelId, supportedUrls: {}, doGenerate, doStream };
}
