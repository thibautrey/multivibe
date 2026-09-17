import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { LanguageModelV4 } from "@ai-sdk/provider";
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
  } as unknown as LanguageModelV4)}));
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
