import { AUTOMATIC_ROUTER_MODEL } from "../../automatic-router-model.js";
import { createVirtualModelMiddleware } from "../../module-virtual-models.js";
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { createProxyRouter } from "./index.js";

test("runs response modules for buffered native Responses streams", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "<SECRET>" }] }] } })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const account = { id: "a", provider: "openai-compatible", upstreamMode: "responses", baseUrl: "http://upstream", accessToken: "token", enabled: true };
  const store: any = {
    listAccounts: async () => [account], getCachedAccounts: () => [account], listModelAliases: async () => [],
    getCachedModelAliases: () => [], getCachedSettings: () => ({}), getRevision: () => 1,
    upsertAccount: async () => account, flushIfDirty: async () => undefined,
  };
  const traceManager: any = { recordTrace: () => undefined, beginTrace: async () => "t", completeTrace: async () => undefined };
  const hooks: string[] = [];
  const moduleManager: any = { runHook: async (hook: string, value: any) => { hooks.push(hook); return { value: hook === "response.beforeClient" ? JSON.parse(JSON.stringify(value).replaceAll("<SECRET>", "restored")) : value }; } };
  const app = express(); app.use(express.json()); app.use("/v1", createProxyRouter({ store, traceManager, moduleManager, openaiBaseUrl: "http://unused", mistralBaseUrl: "http://unused", mistralUpstreamPath: "/v1/responses", mistralCompactUpstreamPath: "/v1/responses/compact", zaiBaseUrl: "http://unused", zaiUpstreamPath: "/v1/chat/completions", zaiCompactUpstreamPath: "/v1/chat/completions", oauthConfig: {} as any }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as any).port;
  const body = await new Promise<string>((resolve, reject) => { const req = http.request({ host: "127.0.0.1", port, path: "/v1/responses", method: "POST", headers: { "content-type": "application/json" } }, (res) => { let text = ""; res.on("data", (chunk) => text += chunk); res.on("end", () => resolve(text)); }); req.on("error", reject); req.end(JSON.stringify({ model: "test-model", stream: false, input: "x" })); });
  assert.match(body, /restored/);
  assert.ok(hooks.includes("response.beforeClient"));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  globalThis.fetch = originalFetch;
});

test("request hooks receive conversation evidence and route the selected model upstream", async () => {
  const { createAutomaticRouter, automaticRouterManifest } = await import("../../automatic-router.js");
  const originalFetch = globalThis.fetch;
  const sentModels: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/v1/models")) return Response.json({ data: [{ id: "test-model" }, { id: "cheap" }] });
    sentModels.push(JSON.parse(String(init?.body)).model);
    return Response.json({ id: "chatcmpl-test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }] });
  };
  const account = { id: "router-account", provider: "openai-compatible", upstreamMode: "chat/completions", baseUrl: "http://upstream", accessToken: "token", enabled: true };
  const store: any = {
    listAccounts: async () => [account], getCachedAccounts: () => [account], listModelAliases: async () => [],
    getCachedModelAliases: () => [], getCachedSettings: () => ({}), getRevision: () => 987,
    upsertAccount: async () => account, flushIfDirty: async () => undefined,
  };
  const traceManager: any = { recordTrace: () => undefined, beginTrace: async () => "t", completeTrace: async () => undefined };
  const plugin = createAutomaticRouter();
  let classifierCalls = 0;
  let enabled = true;
  const moduleManager: any = { list: () => [{id: "multivibe.automatic-router", enabled, loaded: true, healthy: true, settings: {economyModel:"cheap",balancedModel:"cheap",advancedModel:"cheap"}}], runHook: async (hook: string, value: any, context: any) => {
    if (hook !== "request.received") return { value };
    assert.equal(context.sessionId, "agent-session");
    assert.equal(context.conversation.mode, "multi-turn");
    const result = await plugin["request.received"]!(value, { ...context,
      settings: { ...automaticRouterManifest.defaultSettings, classifierModel: "test-model", economyModel: "cheap", balancedModel: "cheap", advancedModel: "cheap" },
      log: { info() {}, warn() {}, error() {} },
    });
    return { value: result.action === "replace" ? result.value : value };
  } };
  const services = () => ({
    listModels: async () => ["test-model", "cheap"].map((id) => ({ id, metadata: { supports_tools: true, context_window: 100_000 } })),
    complete: async () => { classifierCalls++; return '{"difficulty":"easy"}'; },
  });
  const app = express(); app.use(express.json());
  app.use("/v1", createVirtualModelMiddleware(moduleManager, services));
  app.use("/v1", (req,res,next) => { if(req.method === "POST") assert.equal(req.body.model,"cheap","virtual model must resolve before admission"); next(); });
  app.use("/v1", createProxyRouter({
    store, traceManager, moduleManager, moduleServices: () => ({
      listModels: async () => ["test-model", "cheap"].map((id) => ({ id, metadata: { supports_tools: true, context_window: 100_000 } })),
      complete: async () => { classifierCalls++; return '{"difficulty":"easy"}'; },
    }),
    openaiBaseUrl: "http://unused", mistralBaseUrl: "http://unused", mistralUpstreamPath: "/v1/responses", mistralCompactUpstreamPath: "/v1/responses/compact",
    zaiBaseUrl: "http://unused", zaiUpstreamPath: "/v1/chat/completions", zaiCompactUpstreamPath: "/v1/chat/completions", oauthConfig: {} as any,
  }));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as any).port;
    for (const messages of [[{ role: "user", content: "hello" }], [{ role: "user", content: "hello" }, { role: "assistant", content: "answer" }, { role: "user", content: "continue" }]]) {
      const result = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", headers: {
          "content-type": "application/json", "session_id": "agent-session", "x-multivibe-conversation-mode": "multi-turn",
        } }, (res) => { let text = ""; res.on("data", (chunk) => text += chunk); res.on("end", () => resolve({ status: res.statusCode!, text })); });
        req.on("error", reject); req.end(JSON.stringify({ model: AUTOMATIC_ROUTER_MODEL, messages }));
      });
      assert.equal(result.status, 200, result.text);
      assert.match(result.text, /answer/);
    }
    const get = (url: string) => new Promise<{status:number; body:any}>((resolve,reject) => {
      http.get({host:"127.0.0.1",port,path:url}, res => {let text="";res.on("data",chunk=>text+=chunk);res.on("end",()=>resolve({status:res.statusCode!,body:JSON.parse(text)}));}).on("error",reject);
    });
    const catalog = await get("/v1/models");
    assert.ok(catalog.body.data.some((model:any)=>model.id===AUTOMATIC_ROUTER_MODEL));
    assert.ok(catalog.body.models.some((model:any)=>model.slug===AUTOMATIC_ROUTER_MODEL));
    assert.equal((await get("/v1/models/multivibe%2Fautorouter")).body.id,AUTOMATIC_ROUTER_MODEL);
    assert.equal((await get("/v1/models/multivibe/autorouter")).body.id,AUTOMATIC_ROUTER_MODEL);
    enabled=false;
    assert.ok(!(await get("/v1/models")).body.data.some((model:any)=>model.id===AUTOMATIC_ROUTER_MODEL));
    assert.equal((await get("/v1/models/multivibe%2Fautorouter")).status,404);
    assert.deepEqual(sentModels, ["cheap", "cheap"]);
    assert.equal(classifierCalls, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    globalThis.fetch = originalFetch;
  }
});
