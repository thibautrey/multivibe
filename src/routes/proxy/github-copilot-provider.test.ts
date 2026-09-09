import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { createProxyRouter, discoverModels } from "./index.js";
import { toCodexModelShape } from "./models-response.js";
import type { Account } from "../../types.js";

function post(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

for (const scenario of ["chat", "responses", "stream", "refresh", "reject-twice"] as const) {
  test(`Copilot proxy: ${scenario}`, async t => {
    let account: Account = { id: `copilot-${scenario}`, provider: "github-copilot", accessToken: "inference-secret",
      refreshToken: "github-secret", expiresAt: Date.now() + 3600_000, enabled: true, usage: { fetchedAt: Date.now() } };
    const store = {
      getCachedAccounts: () => [account], listAccounts: async () => [account],
      getCachedModelAliases: () => [], getCachedSettings: () => ({}),
      markAccountModified: (_id: string, next: Account) => { account = next; },
      upsertAccount: async (next: Account) => { account = next; return next; },
      patchAccount: async (_id: string, patch: Partial<Account>) => { account = { ...account, ...patch }; return account; },
    };
    const requests: Array<{ url: string; headers: Headers; body: any }> = [];
    let exchanges = 0;
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url === "https://api.github.com/copilot_internal/v2/token") {
        exchanges++;
        assert.equal(headers.get("authorization"), "token github-secret");
        return Response.json({ token: `renewed-${exchanges}`, expires_at: Math.floor(Date.now() / 1000) + 3600 });
      }
      assert.ok(url.startsWith("https://api.githubcopilot.com/"), url);
      assert.equal(init?.redirect, "manual");
      assert.equal(headers.get("copilot-integration-id"), "vscode-chat");
      assert.equal(headers.get("authorization")?.includes("github-secret"), false);
      if (url.endsWith("/models")) return Response.json({ data: [
        { id: "copilot-test-model", supported_endpoints: [scenario === "responses" ? "/responses" : "/chat/completions"],
          capabilities: { type: "chat", limits: { max_context_window_tokens: 128000 }, supports: { tool_calls: true } } },
        { id: "policy-disabled-model", policy: { state: "disabled" } },
      ] });
      const body = JSON.parse(String(init?.body));
      requests.push({ url, headers, body });
      if (scenario === "reject-twice" || (scenario === "refresh" && requests.length === 1)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (scenario === "responses") return Response.json({ id: "resp_copilot", object: "response", status: "completed", model: body.model,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "from copilot" }] }],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } });
      if (scenario === "stream") return new Response([
        { id: "chat_copilot", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "from copilot" }, finish_reason: null }] },
        { id: "chat_copilot", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      return Response.json({ id: "chat_copilot", object: "chat.completion", model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "from copilot" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
    };
    const models = await discoverModels(store as any, "https://chatgpt.example", "https://mistral.example", "https://zai.example");
    const copilot = models.find(m => m.id === "copilot-test-model")!;
    assert.equal(copilot.metadata.provider, "github-copilot");
    assert.equal(copilot.metadata.context_window, 128000);
    assert.equal(toCodexModelShape(copilot)?.slug, "copilot-test-model");
    assert.equal(models.some(m => m.id === "policy-disabled-model"), false);
    const app = express();
    app.use(express.json());
    app.use("/v1", createProxyRouter({ store: store as any,
      traceManager: { recordTrace: () => undefined, beginTrace: async () => "trace", completeTrace: async () => undefined } as any,
      openaiBaseUrl: "https://chatgpt.example", mistralBaseUrl: "https://mistral.example", mistralUpstreamPath: "/v1/responses", mistralCompactUpstreamPath: "/v1/responses/compact",
      zaiBaseUrl: "https://zai.example", zaiUpstreamPath: "/v1/chat/completions", zaiCompactUpstreamPath: "/v1/chat/completions", oauthConfig: {} as any,
    }));
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const port = (server.address() as { port: number }).port;
    const result = await post(port, "/v1/responses", { model: "copilot-test-model", input: "hello", stream: scenario === "stream" });
    if (scenario === "reject-twice") {
      assert.equal(result.status, 503);
      assert.equal(requests.length, 2);
      assert.equal(exchanges, 1);
      assert.equal(account.state?.needsTokenRefresh, true);
      return;
    }
    assert.equal(result.status, 200, result.body);
    assert.ok(result.body.includes("from copilot"), result.body);
    assert.equal(requests.at(-1)?.url, `https://api.githubcopilot.com/${scenario === "responses" ? "responses" : "chat/completions"}`);
    assert.equal(requests.at(-1)?.headers.get("x-initiator"), "user");
    if (scenario === "responses") assert.ok(Array.isArray(requests[0].body.input));
    else assert.equal(requests[0].body.messages.at(-1).content, "hello");
    if (scenario === "stream") assert.ok(result.body.includes("response.completed"), result.body);
    if (scenario === "refresh") {
      assert.equal(requests.length, 2);
      assert.equal(exchanges, 1);
      assert.equal(requests[1].headers.get("authorization"), "Bearer renewed-1");
    }
    // Also exercise a Chat Completions client against either upstream protocol.
    if (scenario === "chat" || scenario === "responses") {
      const chat = await post(port, "/v1/chat/completions", { model: "copilot-test-model", messages: [{ role: "user", content: "hello" }], stream: false });
      assert.equal(chat.status, 200, chat.body);
      assert.equal(JSON.parse(chat.body).choices[0].message.content, "from copilot");
    }
  });
}
