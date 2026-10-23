import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { SdkModel } from "./model.js";
import { createSdkAdapterRouter } from "./routes.js";
import type { LiveModelCatalogSource } from "./live-model-catalog.js";
import type { Account } from "../types.js";

async function server(run: (url: string, account: Account, calls: () => number) => Promise<void>, failure?: unknown, live?: LiveModelCatalogSource, sdkModels: string[] = ["test"]) {
  const account: Account = {id: "account", provider: "ai-sdk", sdkProvider: "anthropic", sdkModels, accessToken: "provider-secret", enabled: true};
  let calls = 0;
  const app = express(); app.use(express.json());
  app.use("/internal/ai-sdk", createSdkAdapterRouter({store: {listAccounts: async () => [account]}, internalToken: "internal-secret", liveModelCatalog: live, createModel: () => ({
    doGenerate: async () => { calls++; return {content: [{type: "text", text: "Hi"}], finishReason: {unified: "stop"}, usage: {inputTokens: {total: 1}, outputTokens: {total: 2}}, warnings: []}; },
    doStream: async () => {calls++; if (failure) throw failure; return {stream: new ReadableStream({start(controller) {
      controller.enqueue({type: "text-delta", id: "text", delta: "Hi"});
      controller.enqueue({type: "finish", usage: {inputTokens: {total: 1}, outputTokens: {total: 2}}, finishReason: {unified: "stop"}}); controller.close();
    }})};},
  } as unknown as SdkModel)}));
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  try {await run(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/internal/ai-sdk/account/v1`, account, () => calls);}
  finally {listener.closeAllConnections(); await new Promise<void>((resolve) => listener.close(() => resolve()));}
}
const auth = {authorization: "Bearer internal-secret", "content-type": "application/json"};

test("SDK adapter isolates accounts and never accepts public or upstream credentials", async () => {
  await server(async (url, account, calls) => {
    for (const token of ["", "Bearer proxy-key", "Bearer provider-secret"]) assert.equal((await fetch(`${url}/models`, {headers: {authorization: token}})).status, 401);
    const catalog = await (await fetch(`${url}/models`, {headers: auth})).json() as any;
    assert.equal(catalog.data[0].id, "anthropic/test");
    const wrongModel = await fetch(`${url}/chat/completions`, {method: "POST", headers: auth, body: JSON.stringify({model: "google/test", messages: [{role: "user", content: "Hi"}]})});
    assert.equal(wrongModel.status, 404); assert.equal(calls(), 0);
    const completion = await fetch(`${url}/chat/completions`, {method: "POST", headers: auth, body: JSON.stringify({model: "anthropic/test", messages: [{role: "user", content: "Hi"}]})});
    assert.equal(completion.status, 200); assert.equal((await completion.json() as any).choices[0].message.content, "Hi");
    account.enabled = false;
    assert.equal((await fetch(`${url}/models`, {headers: auth})).status, 404);
  });
});

test("SDK streaming errors preserve HTTP status before headers are committed", async () => {
  await server(async (url) => {
    const response = await fetch(`${url}/chat/completions`, {method: "POST", headers: auth, body: JSON.stringify({model: "anthropic/test", messages: [{role: "user", content: "Hi"}], stream: true})});
    assert.equal(response.status, 429);
    assert.equal((await response.text()).includes("private provider error"), false);
  }, Object.assign(new Error("private provider error"), {statusCode: 429}));
});


test("SDK adapter surfaces safe provider error messages", async () => {
  await server(async (url) => {
    const response = await fetch(`${url}/chat/completions`, {method: "POST", headers: auth, body: JSON.stringify({model: "anthropic/test", messages: [{role: "user", content: "Hi"}], stream: true})});
    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.error.message, "Invalid tool message sequence");
    assert.doesNotMatch(JSON.stringify(body), /provider-secret|authorization/i);
  }, Object.assign(new Error("request failed"), {
    statusCode: 400,
    responseBody: JSON.stringify({error: {message: "Invalid tool message sequence", type: "invalid_request_error"}}),
    responseHeaders: {authorization: "Bearer provider-secret"},
  }));
});

test("SDK adapter returns a complete incremental chat stream", async () => {
  await server(async (url) => {
    const response = await fetch(`${url}/chat/completions`, {method: "POST", headers: auth, body: JSON.stringify({model: "anthropic/test", messages: [{role: "user", content: "Hi"}], stream: true, stream_options: {include_usage: true}})});
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = await response.text(); assert.match(body, /"content":"Hi"/); assert.match(body, /"total_tokens":3/); assert.ok(body.endsWith("data: [DONE]\n\n"));
  });
});

test("SDK adapter always reports measured stream usage to the Edge", async () => {
  await server(async (url) => {
    const response = await fetch(`${url}/chat/completions`, {method: "POST", headers: auth, body: JSON.stringify({model: "anthropic/test", messages: [{role: "user", content: "Hi"}], stream: true})});
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /"content":"Hi"/);
    assert.match(body, /"prompt_tokens":1/);
    assert.match(body, /"completion_tokens":2/);
    assert.match(body, /"total_tokens":3/);
  });
});

test("SDK adapter lists models discovered from the provider and survives discovery failure", async () => {
  const live = {
    ids: ["from-provider"],
    source: "https://api.deepseek.com/models",
    fetchedAt: "2026-09-14T10:00:00.000Z",
    stale: false,
  };
  await server(async (url) => {
    const catalog = await (await fetch(`${url}/models`, {headers: auth})).json() as any;
    assert.deepEqual(catalog.data.map((model: any) => model.id), ["anthropic/from-provider"]);
    assert.equal(catalog.data[0].catalog_source, "https://api.deepseek.com/models");
    assert.equal(catalog.data[0].catalog_fetched_at, "2026-09-14T10:00:00.000Z");
  }, undefined, {snapshot: async () => live}, []);

  await server(async (url) => {
    const catalog = await (await fetch(`${url}/models`, {headers: auth})).json() as any;
    assert.deepEqual(catalog.data.map((model: any) => model.id), ["anthropic/test"]);
  }, undefined, {snapshot: async () => { throw new Error("provider discovery exploded"); }});
});

test("SDK adapter reports an exhausted context window with a stable code", async () => {
  const overflow = "This model's maximum context length is 1048576 tokens. However, you requested 1373993 tokens (1373993 in the messages, 0 in the completion). Please reduce the length of the messages or completion.";
  await server(async (url) => {
    const response = await fetch(`${url}/chat/completions`, {method: "POST", headers: auth, body: JSON.stringify({model: "anthropic/test", messages: [{role: "user", content: "Hi"}], stream: true})});
    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.error.code, "context_length_exceeded");
    assert.equal(body.error.type, "invalid_request_error");
    assert.equal(body.error.param, null);
    assert.equal(body.error.message, overflow);
    assert.doesNotMatch(JSON.stringify(body), /provider-secret|authorization/i);
  }, Object.assign(new Error("request failed"), {
    statusCode: 400,
    responseBody: JSON.stringify({error: {message: overflow, type: "invalid_request_error", code: null}}),
  }));
});

test("SDK adapter labels every provider failure with a documented code", async () => {
  const cases = [
    {name: "thinking-mode reasoning", status: 400, body: {error: {message: "The `reasoning_content` in the thinking mode must be passed back to the API.", type: "invalid_request_error"}}, code: "reasoning_content_required", type: "invalid_request_error"},
    {name: "context overflow", status: 400, body: {error: {message: "This model's maximum context length is 1048576 tokens."}}, code: "context_length_exceeded", type: "invalid_request_error"},
    {name: "content filter", status: 400, body: {error: {message: "The response was filtered due to the prompt triggering the content management policy.", code: "content_filter"}}, code: "content_filter", type: "invalid_request_error"},
    {name: "quota", status: 429, body: {error: {message: "You exceeded your current quota, please check your plan and billing details.", code: "insufficient_quota"}}, code: "insufficient_quota", type: "rate_limit_error"},
    {name: "rate limit", status: 429, body: {error: {message: "Rate limit reached for requests per min."}}, code: "rate_limit_exceeded", type: "rate_limit_error"},
    {name: "model not found", status: 404, body: {error: {message: "The model `gpt-nope` does not exist"}}, code: "model_not_found", type: "invalid_request_error"},
    {name: "authentication", status: 401, body: {error: {message: "Incorrect API key provided"}}, code: "upstream_error", type: "authentication_error"},
    {name: "upstream failure", status: 502, message: "socket hang up", code: "server_error", type: "api_error"},
  ];
  for (const entry of cases) {
    await server(async (url) => {
      const response = await fetch(`${url}/chat/completions`, {method: "POST", headers: auth, body: JSON.stringify({model: "anthropic/test", messages: [{role: "user", content: "Hi"}], stream: true})});
      assert.equal(response.status, entry.status, entry.name);
      const body = await response.json() as any;
      assert.equal(body.error.code, entry.code, entry.name);
      assert.equal(body.error.type, entry.type, entry.name);
      assert.equal(body.error.param, null, entry.name);
      assert.ok(typeof body.error.message === "string" && body.error.message.length > 0, entry.name);
    }, Object.assign(new Error(entry.message ?? "request failed"), entry.body === undefined ? {statusCode: entry.status} : {statusCode: entry.status, responseBody: JSON.stringify(entry.body)}));
  }
});

test("SDK adapter preserves provider error fields and labels its own input errors", async () => {
  await server(async (url) => {
    const response = await fetch(`${url}/chat/completions`, {method: "POST", headers: auth, body: JSON.stringify({model: "anthropic/test", messages: [{role: "user", content: "Hi"}], stream: true})});
    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.error.code, "invalid_tool_arguments");
    assert.equal(body.error.param, "tools[0]");
    assert.equal(body.error.provider_detail.trace, "abc");
  }, Object.assign(new Error("request failed"), {statusCode: 400, responseBody: JSON.stringify({error: {message: "Bad tool arguments", type: "invalid_request_error", code: "invalid_tool_arguments", param: "tools[0]", provider_detail: {trace: "abc"}}})}));

  await server(async (url) => {
    const response = await fetch(`${url}/chat/completions`, {method: "POST", headers: auth, body: JSON.stringify({model: "anthropic/test", messages: []})});
    assert.equal(response.status, 400);
    const body = await response.json() as any;
    assert.equal(body.error.type, "invalid_request_error");
    assert.equal(body.error.code, "invalid_request_error");
    assert.equal(body.error.param, null);
  });
});

test("image adapter preserves JSON and multipart results and enforces account grants", async () => {
  const account: Account = {id: "images", provider: "ai-sdk", sdkProvider: "openai", sdkModels: ["gpt-image-2"], accessToken: "image-provider-secret", enabled: true};
  const calls: {url: string; body: unknown}[] = [];
  let upstreamStatus = 200;
  const app = express(); app.use(express.json());
  app.use("/internal/ai-sdk", createSdkAdapterRouter({
    store: {listAccounts: async () => [account]}, internalToken: "internal-secret",
    fetch: async (input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer image-provider-secret");
      calls.push({url: String(input), body: init?.body});
      return new Response(upstreamStatus === 200 ? '{"created":123,"data":[{"b64_json":"aW1hZ2U="}],"usage":{"total_tokens":7}}' : '{"error":{"message":"Image rate limit","type":"rate_limit_error","code":"rate_limit_exceeded"}}', {status: upstreamStatus, headers: {"content-type": "application/json", "x-request-id": "image-request"}});
    },
  }));
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/internal/ai-sdk/images/v1`;
  const generate = (model: string, headers = auth) => fetch(`${url}/images/generations`, {method: "POST", headers, body: JSON.stringify({model, prompt: "A clean night sky", size: "1536x1024", quality: "high", n: 2})});
  try {
    assert.equal((await generate("openai/gpt-image-2", {authorization: "Bearer wrong", "content-type": "application/json"})).status, 401);
    assert.equal((await generate("openai/gpt-image-1")).status, 404);
    assert.equal(calls.length, 0);
    const result = await generate("openai/gpt-image-2");
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("x-request-id"), "image-request");
    assert.deepEqual(await result.json(), {created: 123, data: [{b64_json: "aW1hZ2U="}], usage: {total_tokens: 7}});
    assert.equal(calls[0].url, "https://api.openai.com/v1/images/generations");
    assert.deepEqual(JSON.parse(String(calls[0].body)), {model: "gpt-image-2", prompt: "A clean night sky", size: "1536x1024", quality: "high", n: 2});
    const form = new FormData();
    form.set("model", "an-alias"); form.set("prompt", "Change the sky"); form.set("n", "2");
    form.append("image[]", new Blob(["first image"], {type: "image/png"}), "first.png");
    form.append("image[]", new Blob(["second image"], {type: "image/jpeg"}), "second.jpg");
    form.set("mask", new Blob(["mask"], {type: "image/png"}), "mask.png");
    const edited = await fetch(`${url}/images/edits`, {method: "POST", headers: {authorization: "Bearer internal-secret", "x-multivibe-image-model": "openai/gpt-image-2"}, body: form});
    assert.equal(edited.status, 200); await edited.text();
    assert.equal(calls[1].url, "https://api.openai.com/v1/images/edits");
    const forwarded = calls[1].body as FormData;
    assert.equal(forwarded.get("model"), "gpt-image-2");
    assert.equal(forwarded.get("n"), "2");
    assert.deepEqual(await Promise.all(forwarded.getAll("image[]").map(part => (part as File).text())), ["first image", "second image"]);
    assert.equal((forwarded.get("mask") as File).name, "mask.png");
    upstreamStatus = 429;
    const error = await generate("openai/gpt-image-2");
    assert.equal(error.status, 429);
    assert.equal((await error.json()).error.code, "rate_limit_exceeded");
    account.sdkProvider = "anthropic";
    assert.equal((await generate("anthropic/gpt-image-2")).status, 400);
    account.enabled = false;
    assert.equal((await generate("openai/gpt-image-2")).status, 404);
  } finally {
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
  }
});
