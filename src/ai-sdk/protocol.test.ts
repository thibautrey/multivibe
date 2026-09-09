import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { sdkCallOptions, chatStream, chatResult } from "./protocol.js";
import { sdkAccountModels, sdkModelId, sdkProviderCatalog } from "./catalog.js";
import { SDK_PROVIDERS, validateSdkAccount } from "./providers.js";
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
  assert.ok(result.usage);
  assert.equal(result.usage.total_tokens, 15);
  const account: Account = {id: "one", provider: "ai-sdk", sdkProvider: "openrouter", accessToken: "key", enabled: true, sdkModels: ["anthropic/custom-model"]};
  assert.equal(sdkAccountModels(account)[0].id, "openrouter/anthropic/custom-model");
  assert.equal(sdkModelId(account, "openrouter/anthropic/custom-model"), "anthropic/custom-model");
  assert.throws(() => sdkModelId(account, "anthropic/custom-model"));
  assert.throws(() => sdkModelId(account, "openrouter/unknown"));
  assert.deepEqual(sdkProviderCatalog().providers.map(({ id }) => id), SDK_PROVIDERS.map(({ id }) => id));
  assert.throws(() => validateSdkAccount({...account, sdkProvider: "uninstalled-package"}));
  for (const id of ["../other", "a/b", "a?b", "", "a".repeat(129)]) {
    assert.throws(() => validateSdkAccount({...account, id}), /Invalid provider account ID/);
  }
  assert.doesNotThrow(() => validateSdkAccount({...account, id: "sdk-account_123"}));
  assert.throws(() => validateSdkAccount({...account, baseUrl: "https://untrusted.test"}));
});

test("JSON and streaming preserve missing usage and positive cache writes",async()=>{
 for(const measured of [
  {...usage,inputTokens:{...usage.inputTokens,total:undefined}},
  {...usage,outputTokens:{...usage.outputTokens,total:undefined}},
  {...usage,inputTokens:{...usage.inputTokens,cacheRead:13}},
  {...usage,outputTokens:{...usage.outputTokens,reasoning:-1}},
 ]){
  const result=chatResult("anthropic/test",{content:[],usage:measured,finishReason:{unified:"stop",raw:"stop"},warnings:[]});
  assert.equal(result.usage,null);
  const stream=new ReadableStream<LanguageModelV4StreamPart>({start(controller){controller.enqueue({type:"finish",usage:measured,finishReason:{unified:"stop",raw:"stop"}});controller.close();}});
  const frames=[];for await(const frame of chatStream("anthropic/test",stream,true))frames.push(frame);
  assert.equal(JSON.parse(frames.at(-2)!.slice(6)).usage,null);
 }
 const measured={...usage,inputTokens:{total:12,noCache:undefined,cacheRead:undefined,cacheWrite:5},outputTokens:{total:3,text:undefined,reasoning:undefined}};
 const result=chatResult("anthropic/test",{content:[],usage:measured,finishReason:{unified:"stop",raw:"stop"},warnings:[]});
 assert.deepEqual(result.usage,{prompt_tokens:12,completion_tokens:3,total_tokens:15,cache_creation_input_tokens:5});
});

test("Mammouth exposes documented models, provenance and custom model selection", () => {
  const account: Account = { id: "mammouth", provider: "ai-sdk", sdkProvider: "mammouth", accessToken: "key", enabled: true };
  assert.doesNotThrow(() => validateSdkAccount(account));
  const catalog = sdkProviderCatalog().providers.find((provider) => provider.id === "mammouth")!;
  assert.equal(catalog.name, "Mammouth AI");
  assert.equal(catalog.source, "https://info.mammouth.ai/docs/api-quick-start/");
  const models = sdkAccountModels(account);
  assert.ok(models.some((model) => model.id === "mammouth/mammouth-recommended"));
  assert.ok(models.some((model) => model.id === "mammouth/claude-sonnet-4-6"));
  assert.equal(models[0].catalog_source, catalog.source);
  assert.equal(models[0].supports_tools, undefined);
  assert.equal(new Set(models.map((model) => model.id)).size, models.length);
  account.sdkModels = ["custom-model"];
  assert.deepEqual(sdkAccountModels(account).map((model) => model.id), ["mammouth/custom-model"]);
  assert.equal(sdkModelId(account, "mammouth/custom-model"), "custom-model");
  assert.throws(() => sdkModelId(account, "mammouth/gpt-5.5"));
  assert.throws(() => sdkModelId(account, "openrouter/custom-model"));
});
