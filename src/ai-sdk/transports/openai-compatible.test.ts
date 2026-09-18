import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAICompatibleModel } from "./openai-compatible.js";
import type { SdkStreamPart } from "../model.js";

test("compatible generate translates messages, controls and provider usage", async () => {
  let request: { url: string; headers: Headers; body: any } | undefined;
  const model = createOpenAICompatibleModel({
    provider: "deepseek",
    modelId: "deepseek-chat",
    baseURL: "https://api.deepseek.com",
    apiKey: "secret",
    fetch: async (input, init) => {
      request = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return Response.json({
        id: "chat_1", object: "chat.completion", created: 1_700_000_000, model: "deepseek-chat",
        choices: [{ index: 0, finish_reason: "tool_calls", message: {
          role: "assistant", content: "Checking",
          reasoning_content: "I should look",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
        } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } },
      });
    },
  });
  const result = await model.doGenerate({
    prompt: [
      { role: "system", content: "Be nice" },
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "earlier thought" }], },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_0", toolName: "lookup", input: { q: "old" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_0", toolName: "lookup", output: { type: "text", value: "old result" } }] },
    ],
    tools: [{ type: "function", name: "lookup", description: "Look up", inputSchema: { type: "object" }, strict: true }],
    toolChoice: { type: "tool", toolName: "lookup" },
    responseFormat: { type: "json" },
    reasoning: "low",
    maxOutputTokens: 64,
    temperature: 0.2,
  });
  assert.ok(request);
  assert.equal(request.url, "https://api.deepseek.com/chat/completions");
  assert.equal(request.headers.get("authorization"), "Bearer secret");
  assert.equal(request.body.model, "deepseek-chat");
  assert.equal(request.body.max_tokens, 64);
  assert.equal(request.body.temperature, 0.2);
  assert.equal(request.body.reasoning_effort, "low");
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  assert.equal(request.body.tool_choice.function.name, "lookup");
  assert.equal(request.body.tools[0].function.strict, true);
  assert.equal(request.body.messages[0].content, "Be nice");
  assert.equal(request.body.messages[1].content, "Hi");
  assert.equal(request.body.messages[2].reasoning_content, "earlier thought");
  assert.equal(request.body.messages[3].tool_calls[0].function.arguments, '{"q":"old"}');
  assert.equal(request.body.messages[4].role, "tool");
  assert.equal(request.body.messages[4].tool_call_id, "call_0");
  assert.deepEqual(result.content.map((part) => part.type), ["text", "reasoning", "tool-call"]);
  assert.deepEqual((result.content[2] as any).input, { q: "x" });
  assert.equal(result.finishReason.unified, "tool-calls");
  assert.equal(result.usage.inputTokens.total, 10);
  assert.equal(result.usage.inputTokens.cacheRead, 3);
  assert.equal(result.usage.outputTokens.reasoning, 2);
  assert.equal(result.usage.outputTokens.text, 2);
});

test("compatible generate surfaces provider failures with the upstream envelope", async () => {
  const model = createOpenAICompatibleModel({
    provider: "groq", modelId: "test", baseURL: "https://api.groq.com/openai/v1", apiKey: "secret",
    fetch: async () => Response.json({ error: { message: "Rate limit reached", type: "rate_limit_error" } }, { status: 429 }),
  });
  await assert.rejects(
    () => model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] }),
    (error: any) => error.statusCode === 429 && error.message === "Rate limit reached" && /rate_limit_error/.test(error.responseBody),
  );
});

test("compatible stream forwards reasoning, text and incrementally assembled tool calls", async () => {
  let body: any;
  const chunks = [
    { id: "chat_1", object: "chat.completion.chunk", created: 1, model: "deepseek-chat", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "let me " }, finish_reason: null }] },
    { id: "chat_1", object: "chat.completion.chunk", created: 1, model: "deepseek-chat", choices: [{ index: 0, delta: { reasoning_content: "think" }, finish_reason: null }] },
    { id: "chat_1", object: "chat.completion.chunk", created: 1, model: "deepseek-chat", choices: [{ index: 0, delta: { content: "Calling " }, finish_reason: null }] },
    { id: "chat_1", object: "chat.completion.chunk", created: 1, model: "deepseek-chat", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "lookup", arguments: "" } }] }, finish_reason: null }] },
    { id: "chat_1", object: "chat.completion.chunk", created: 1, model: "deepseek-chat", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] }, finish_reason: null }] },
    { id: "chat_1", object: "chat.completion.chunk", created: 1, model: "deepseek-chat", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: null }] },
    { id: "chat_1", object: "chat.completion.chunk", created: 1, model: "deepseek-chat", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { id: "chat_1", object: "chat.completion.chunk", created: 1, model: "deepseek-chat", choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, completion_tokens_details: { reasoning_tokens: 1 } } },
  ];
  const model = createOpenAICompatibleModel({
    provider: "deepseek", modelId: "deepseek-chat", baseURL: "https://api.deepseek.com", apiKey: "secret",
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  const { stream } = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] });
  const parts: SdkStreamPart[] = [];
  for await (const part of stream) parts.push(part);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  const reasoning = parts.filter((part) => part.type === "reasoning-delta").map((part: any) => part.delta).join("");
  assert.equal(reasoning, "let me think");
  const text = parts.filter((part) => part.type === "text-delta").map((part: any) => part.delta).join("");
  assert.equal(text, "Calling ");
  const toolStart = parts.find((part: any) => part.type === "tool-input-start") as any;
  assert.equal(toolStart.id, "call_9");
  assert.equal(toolStart.toolName, "lookup");
  const args = parts.filter((part) => part.type === "tool-input-delta").map((part: any) => part.delta).join("");
  assert.equal(args, '{"q":"x"}');
  const toolCall = parts.find((part: any) => part.type === "tool-call") as any;
  assert.deepEqual(toolCall.input, { q: "x" });
  const finish = parts.find((part) => part.type === "finish") as any;
  assert.equal(finish.finishReason.unified, "tool-calls");
  assert.equal(finish.usage.inputTokens.total, 7);
  assert.equal(finish.usage.outputTokens.reasoning, 1);
});

test("compatible stream buffers tool arguments that arrive before the tool name", async () => {
  const chunks = [
    { object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"early"}' } }] }, finish_reason: null }] },
    { object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_early", function: { name: "lookup" } }] }, finish_reason: "tool_calls" }] },
  ];
  const model = createOpenAICompatibleModel({
    provider: "test", modelId: "test", baseURL: "https://example.test/v1", apiKey: "k",
    fetch: async () => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"),
  });
  const { stream } = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] });
  const parts: any[] = [];
  for await (const part of stream) parts.push(part);
  assert.ok(parts.findIndex((part) => part.type === "tool-input-start") < parts.findIndex((part) => part.type === "tool-input-delta"));
  const toolCall = parts.find((part) => part.type === "tool-call");
  assert.deepEqual(toolCall.input, { q: "early" });
});

test("compatible stream maps an error payload to a provider error", async () => {
  const model = createOpenAICompatibleModel({
    provider: "test", modelId: "test", baseURL: "https://example.test/v1", apiKey: "k",
    fetch: async () => new Response(`data: ${JSON.stringify({ error: { message: "context length exceeded" } })}\n\n`),
  });
  const { stream } = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] });
  await assert.rejects(async () => { for await (const _part of stream) { /* consume */ } }, /context length exceeded/);
});
