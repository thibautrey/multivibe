import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createSdkAdapterRouter } from "./routes.js";
import type { Account } from "../types.js";

async function server(run: (url: string, account: Account, calls: () => number) => Promise<void>, fail = false) {
  const account: Account = {id: "account", provider: "ai-sdk", sdkProvider: "anthropic", sdkModels: ["test"], accessToken: "provider-secret", enabled: true};
  let calls = 0;
  const app = express(); app.use(express.json());
  app.use("/internal/ai-sdk", createSdkAdapterRouter({store: {listAccounts: async () => [account]}, internalToken: "internal-secret", createModel: () => ({
    doGenerate: async () => { calls++; return {content: [{type: "text", text: "Hi"}], finishReason: {unified: "stop"}, usage: {inputTokens: {total: 1}, outputTokens: {total: 2}}, warnings: []}; },
    doStream: async () => {calls++; if (fail) throw Object.assign(new Error("private provider error"), {statusCode: 429}); return {stream: new ReadableStream({start(controller) {
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
  }, true);
});

test("SDK adapter returns a complete incremental chat stream", async () => {
  await server(async (url) => {
    const response = await fetch(`${url}/chat/completions`, {method: "POST", headers: auth, body: JSON.stringify({model: "anthropic/test", messages: [{role: "user", content: "Hi"}], stream: true, stream_options: {include_usage: true}})});
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = await response.text(); assert.match(body, /"content":"Hi"/); assert.match(body, /"total_tokens":3/); assert.ok(body.endsWith("data: [DONE]\n\n"));
  });
});
