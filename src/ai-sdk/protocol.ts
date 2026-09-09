import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4Prompt, LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";

export class SdkInputError extends Error {}
const invalid = (message: string): never => { throw new SdkInputError(message); };
const requiredString = (value: unknown, label: string): string => typeof value === "string" && value.length > 0 ? value : invalid(`${label} required`);

export function sdkCallOptions(body: any, signal: AbortSignal): LanguageModelV4CallOptions {
  if (!Array.isArray(body?.messages) || !body.messages.length) invalid("messages must be a nonempty array");
  if (body.n !== undefined && body.n !== 1) invalid("Only n=1 is supported for these providers");
  for (const key of ["audio", "modalities", "logprobs", "top_logprobs", "functions", "function_call"]) {
    if (body[key] !== undefined) invalid(`${key} is not supported by this adapter`);
  }
  const toolNames = new Map<string, string>();
  const prompt: LanguageModelV4Prompt = [];
  for (const message of body.messages) {
    if (!message || typeof message !== "object") invalid("Invalid message");
    if (message.role === "system" || message.role === "developer") {
      if (typeof message.content !== "string") invalid("System messages must contain text");
      prompt.push({ role: "system", content: message.content });
    } else if (message.role === "tool") {
      const id = requiredString(message.tool_call_id, "tool_call_id");
      const toolName = toolNames.get(id) ?? message.name;
      if (!toolName) invalid("Tool result has no matching tool call");
      if (typeof message.content !== "string") invalid("Tool results must contain text");
      prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName, output: { type: "text", value: message.content } }] });
    } else if (message.role === "user") {
      const content: Extract<LanguageModelV4Prompt[number], {role: "user"}>["content"] = [];
      const parts = typeof message.content === "string" ? [{type: "text", text: message.content}] : message.content;
      if (!Array.isArray(parts)) invalid("User messages must contain text or image parts");
      for (const part of parts) {
        if (part?.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
        else if (part?.type === "image_url") {
          const value = requiredString(part.image_url?.url, "image_url.url");
          const data = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/.exec(value);
          if (data) content.push({ type: "file", mediaType: data[1], data: { type: "data", data: data[2] } });
          else {
            let url: URL;
            try { url = new URL(value); } catch { invalid("Invalid image URL"); }
            if (!['https:', 'http:'].includes(url!.protocol)) invalid("Images require an HTTP URL or base64 image data");
            content.push({ type: "file", mediaType: "image", data: { type: "url", url: url! } });
          }
        } else invalid("Unsupported user content part");
      }
      prompt.push({ role: "user", content });
    } else if (message.role === "assistant") {
      const content: Extract<LanguageModelV4Prompt[number], {role: "assistant"}>["content"] = [];
      if (typeof message.content === "string" && message.content) content.push({ type: "text", text: message.content });
      else if (message.content != null && message.content !== "") invalid("Assistant messages must contain text");
      if (typeof message.reasoning_content === "string") content.push({ type: "reasoning", text: message.reasoning_content, providerOptions: message.provider_options });
      if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) invalid("tool_calls must be an array");
      for (const call of message.tool_calls ?? []) {
        if (call?.type !== "function") invalid("Only function tools are supported");
        const id = requiredString(call.id, "tool call ID");
        const name = requiredString(call.function?.name, "tool name");
        let input: unknown;
        try { input = JSON.parse(call.function.arguments); } catch { invalid("Tool arguments must be valid JSON"); }
        toolNames.set(id, name);
        content.push({ type: "tool-call", toolCallId: id, toolName: name, input });
      }
      prompt.push({ role: "assistant", content });
    } else invalid("Unsupported message role");
  }
  const options: LanguageModelV4CallOptions = { prompt, abortSignal: signal };
  for (const [source, target] of Object.entries({ temperature: "temperature", top_p: "topP", frequency_penalty: "frequencyPenalty", presence_penalty: "presencePenalty", seed: "seed" }) ) {
    if (body[source] !== undefined) {
      if (typeof body[source] !== "number" || !Number.isFinite(body[source])) invalid(`${source} must be finite`);
      (options as any)[target] = body[source];
    }
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens !== undefined) {
    if (!Number.isInteger(maxTokens) || maxTokens < 1) invalid("max_tokens must be a positive integer");
    options.maxOutputTokens = maxTokens;
  }
  if (body.stop !== undefined) {
    const stop = typeof body.stop === "string" ? [body.stop] : body.stop;
    if (!Array.isArray(stop) || stop.some((item) => typeof item !== "string")) invalid("stop must contain strings");
    options.stopSequences = stop;
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) invalid("tools must be an array");
    options.tools = body.tools.map((tool: any) => {
      if (tool?.type !== "function" || !tool.function?.parameters || typeof tool.function.parameters !== "object") invalid("Expected a function tool with a JSON parameter schema");
      return { type: "function", name: requiredString(tool.function.name, "tool name"), description: tool.function.description,
        inputSchema: tool.function.parameters, strict: tool.function.strict };
    });
  }
  if (body.tool_choice !== undefined) {
    if (["auto", "none", "required"].includes(body.tool_choice)) options.toolChoice = { type: body.tool_choice };
    else if (body.tool_choice?.type === "function") options.toolChoice = { type: "tool", toolName: requiredString(body.tool_choice.function?.name, "tool name") };
    else invalid("Invalid tool_choice");
  }
  if (body.response_format !== undefined) {
    const format = body.response_format;
    if (format?.type === "text") options.responseFormat = { type: "text" };
    else if (format?.type === "json_object") options.responseFormat = { type: "json" };
    else if (format?.type === "json_schema" && format.json_schema?.schema) options.responseFormat = { type: "json", ...format.json_schema };
    else invalid("Unsupported response_format");
  }
  if (body.reasoning_effort !== undefined) {
    if (!["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"].includes(body.reasoning_effort)) invalid("Unsupported reasoning effort");
    options.reasoning = body.reasoning_effort;
  }
  if (body.provider_options !== undefined) {
    if (!body.provider_options || typeof body.provider_options !== "object" || Array.isArray(body.provider_options)) invalid("provider_options must be an object");
    options.providerOptions = body.provider_options;
  }
  return options;
}

/** Public conversion must not turn unknown billing measurements into zero. */
export function chatUsage(usage: LanguageModelV4Usage) {
  const input = usage.inputTokens.total, output = usage.outputTokens.total;
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (!valid(input) || !valid(output) || !Number.isSafeInteger(input + output)) return null;
  const cached = usage.inputTokens.cacheRead, written = usage.inputTokens.cacheWrite;
  const reasoning = usage.outputTokens.reasoning;
  for (const [value, maximum] of [[cached,input],[written,input],[reasoning,output]] as const) {
    if (value !== undefined && (!valid(value) || value > maximum)) return null;
  }
  if (cached !== undefined && written !== undefined && cached + written > input) return null;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output,
    ...(cached !== undefined ? {prompt_tokens_details: {cached_tokens: cached}} : {}),
    ...(reasoning !== undefined ? {completion_tokens_details: {reasoning_tokens: reasoning}} : {}),
    // Preserve this separately priced native dimension. Managed billing can
    // leave it uncertain until a corresponding adapter and rate are supported.
    ...(written !== undefined ? {cache_creation_input_tokens: written} : {}),
  };
}
const finishReason = (reason: string) => ({ "tool-calls": "tool_calls", "content-filter": "content_filter", other: "stop" }[reason] ?? reason);
export function chatResult(model: string, result: LanguageModelV4GenerateResult, validateUsage?: (usage: LanguageModelV4Usage) => boolean) {
  if (result.finishReason.unified === "error") throw new Error("Provider generation failed");
  const tools = result.content.filter((part) => part.type === "tool-call");
  const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  const reasoning = result.content.filter((part) => part.type === "reasoning").map((part) => part.text).join("");
  return { id: result.response?.id ?? `chatcmpl-${randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now()/1000), model,
    choices: [{ index: 0, message: { role: "assistant", content: text || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(tools.length ? { tool_calls: tools.map((tool) => ({ id: tool.toolCallId, type: "function", function: { name: tool.toolName, arguments: tool.input } })) } : {}),
    }, finish_reason: finishReason(result.finishReason.unified) }], usage: validateUsage && !validateUsage(result.usage) ? null : chatUsage(result.usage),
    ...(result.providerMetadata ? { provider_metadata: result.providerMetadata } : {}),
  };
}

/** Incremental translation; no buffering of the generated answer or execution of tools. */
export async function* chatStream(model: string, stream: ReadableStream<LanguageModelV4StreamPart>, includeUsage: boolean, validateUsage?: (usage: LanguageModelV4Usage) => boolean): AsyncGenerator<string> {
  const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now()/1000);
  const chunk = (delta: any, finish: string | null = null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{index: 0, delta, finish_reason: finish}] })}\n\n`;
  const tools = new Map<string, number>();
  let finished = false;
  yield chunk({role: "assistant", content: ""});
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value: part, done } = await reader.read();
      if (done) break;
      if (part.type === "text-delta") yield chunk({content: part.delta});
      else if (part.type === "reasoning-delta") yield chunk({reasoning_content: part.delta});
      else if (part.type === "tool-input-start") {
        const index = tools.size; tools.set(part.id, index);
        yield chunk({tool_calls: [{index, id: part.id, type: "function", function: {name: part.toolName, arguments: ""}}]});
      } else if (part.type === "tool-input-delta") {
        const index = tools.get(part.id);
        if (index === undefined) throw new Error("Provider sent tool input without a tool start");
        yield chunk({tool_calls: [{index, function: {arguments: part.delta}}]});
      } else if (part.type === "tool-call" && !tools.has(part.toolCallId)) {
        const index = tools.size; tools.set(part.toolCallId, index);
        yield chunk({tool_calls: [{index, id: part.toolCallId, type: "function", function: {name: part.toolName, arguments: part.input}}]});
      } else if (part.type === "error") throw part.error;
      else if (part.type === "finish") {
        if (part.finishReason.unified === "error") throw new Error("Provider stream failed");
        finished = true;
        yield chunk({}, finishReason(part.finishReason.unified));
        if (includeUsage) yield `data: ${JSON.stringify({id, object: "chat.completion.chunk", created, model, choices: [], usage: validateUsage && !validateUsage(part.usage) ? null : chatUsage(part.usage)})}\n\n`;
      }
    }
    if (!finished) throw new Error("Provider stream ended before a finish event");
    yield "data: [DONE]\n\n";
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
