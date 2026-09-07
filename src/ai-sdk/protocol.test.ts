import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { sdkCallOptions, chatStream, chatResult } from "./protocol.js";
import { sdkAccountModels, sdkModelId, sdkProviderCatalog } from "./catalog.js";
import { validateSdkAccount } from "./providers.js";
import type { Account } from "../types.js";

const usage: LanguageModelV4Usage = {inputTokens: {total: 12, noCache: 8, cacheRead: 4, cacheWrite: 0}, outputTokens: {total: 3, text: 2, reasoning: 1}};

test("translates tool history, images, structured output and generation controls", () => {
  const signal = new AbortController().signal;
  const options = sdkCallOptions({ messages: [
    {role: "developer", content: "Be concise"},
    {role: "user", content: [{type: "text", text: "Describe"}, {type: "image_url", image_url: {url: "data:image/png;base64,aGVsbG8="}}]},
    {role: "assistant", content: null, tool_calls: [{id: "call_1", type: "function", function: {name: "lookup", arguments: '{"q":"test"}'}}]},
    {role: "tool", tool_call_id: "call_1", content: "found"},
  ], tools: [{type: "function", function: {name: "lookup", parameters: {type: "object"}}}], tool_choice: {type: "function", function: {name: "lookup"}},
    max_completion_tokens: 20, reasoning_effort: "low", response_format: {type: "json_schema", json_schema: {name: "answer", schema: {type: "object"}}},
  }, signal);
  assert.equal(options.prompt[0].role, "system");
  assert.deepEqual((options.prompt[2].content as any[])[0].input, {q: "test"});
  assert.equal((options.prompt[3].content as any[])[0].toolName, "lookup");
  assert.deepEqual(options.toolChoice, {type: "tool", toolName: "lookup"});
  assert.equal(options.maxOutputTokens, 20);
  assert.equal(options.responseFormat?.type, "json");
  assert.equal(options.abortSignal, signal);
  assert.equal(options.reasoning, "low");
  for (const body of [{messages: []}, {messages: [{role: "user", content: "test"}], n: 2}, {messages: [{role: "tool", tool_call_id: "missing", content: "x"}]}]) {
    assert.throws(() => sdkCallOptions(body, signal));
  }
});

test("streams text and function arguments incrementally without repeating completed tool calls", async () => {
  const parts: LanguageModelV4StreamPart[] = [
    {type: "text-delta", id: "text", delta: "Hello"},
    {type: "tool-input-start", id: "call", toolName: "lookup"},
    {type: "tool-input-delta", id: "call", delta: '{"q":'},
    {type: "tool-input-delta", id: "call", delta: '"test"}'},
    {type: "tool-call", toolCallId: "call", toolName: "lookup", input: '{"q":"test"}'},
    {type: "finish", usage, finishReason: {unified: "tool-calls", raw: "tool_use"}},
  ];
  const stream = new ReadableStream<LanguageModelV4StreamPart>({start(controller) {parts.forEach((part) => controller.enqueue(part)); controller.close();}});
  const frames: string[] = [];
  for await (const frame of chatStream("anthropic/test", stream, true)) frames.push(frame);
  assert.equal(frames.at(-1), "data: [DONE]\n\n");
  const chunks = frames.slice(0,-1).map((frame) => JSON.parse(frame.slice(6)));
  assert.equal(chunks[1].choices[0].delta.content, "Hello");
  const calls = chunks.flatMap((part) => part.choices[0]?.delta.tool_calls ?? []);
  assert.equal(calls.map((call) => call.function.arguments).join(""), '{"q":"test"}');
  assert.equal(calls.filter((call) => call.id).length, 1);
  assert.equal(chunks.at(-1).usage.prompt_tokens_details.cached_tokens, 4);
  assert.equal(chunks.at(-2).choices[0].finish_reason, "tool_calls");
});

test("does not fabricate completion for truncated provider streams", async () => {
  const stream = new ReadableStream<LanguageModelV4StreamPart>({start(controller) {controller.close();}});
  await assert.rejects(async () => {for await (const _frame of chatStream("google/test", stream, false)) {}}, /before a finish/);
});

test("maps buffered results and keeps provider namespaces distinct", () => {
  const result = chatResult("google/test", {content: [{type: "text", text: "Hello"}], usage, finishReason: {unified: "stop", raw: "STOP"}, warnings: []});
  assert.equal(result.choices[0].message.content, "Hello");
  assert.equal(result.usage.total_tokens, 15);
  const account: Account = {id: "one", provider: "ai-sdk", sdkProvider: "openrouter", accessToken: "key", enabled: true, sdkModels: ["anthropic/custom-model"]};
  assert.equal(sdkAccountModels(account)[0].id, "openrouter/anthropic/custom-model");
  assert.equal(sdkModelId(account, "openrouter/anthropic/custom-model"), "anthropic/custom-model");
  assert.throws(() => sdkModelId(account, "anthropic/custom-model"));
  assert.throws(() => sdkModelId(account, "openrouter/unknown"));
  assert.equal(sdkProviderCatalog().providers.length, 8);
  assert.throws(() => validateSdkAccount({...account, sdkProvider: "uninstalled-package"}));
  assert.throws(() => validateSdkAccount({...account, baseUrl: "https://untrusted.test"}));
});
