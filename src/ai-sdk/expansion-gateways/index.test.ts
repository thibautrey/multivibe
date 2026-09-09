import assert from "node:assert/strict";
import test from "node:test";
import { createSdkModel } from "../models.js";
import { ACCESS, CATALOGS, PROVIDERS, QUOTA_FETCHERS, createFalModel, createReplicateModel } from "./index.js";

test("expansion gateway metadata is complete and fixed to reviewed HTTPS endpoints", () => {
  assert.deepEqual(PROVIDERS.map(({ id }) => id), ["orcarouter", "martian", "crofai", "inceptron", "neuralwatt", "baseten", "replicate", "fal"]);
  for (const provider of PROVIDERS) {
    assert.equal(new URL(provider.baseURL).protocol, "https:");
    assert.ok(CATALOGS[provider.id]);
    assert.ok(ACCESS[provider.id]?.source.startsWith("https://"));
  }
  assert.deepEqual(Object.keys(QUOTA_FETCHERS), []);
  assert.equal(CATALOGS.replicate.models[0].id, "meta/meta-llama-3-70b-instruct");
});

test("Replicate adapter creates and polls only the reviewed text prediction contract", async () => {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  const model = createReplicateModel("secret", "meta/meta-llama-3-70b-instruct", async (input, init) => {
    const call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    assert.equal(new Headers(init?.headers).get("authorization"), "Token secret");
    if (calls.length === 1) return Response.json({ id: "pred_1", status: "starting" });
    return Response.json({ id: "pred_1", status: "succeeded", output: ["Hello", " world"] });
  }, 0);
  const result = await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }], maxOutputTokens: 32, temperature: 0.2, topK: 9, providerOptions: {} });
  assert.equal(calls[0].url, "https://api.replicate.com/v1/models/meta/meta-llama-3-70b-instruct/predictions");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual({ max_tokens: calls[0].body.input.max_tokens, temperature: calls[0].body.input.temperature, top_k: calls[0].body.input.top_k }, { max_tokens: 32, temperature: 0.2, top_k: 9 });
  assert.equal(calls[1].url, "https://api.replicate.com/v1/predictions/pred_1");
  assert.ok(result.content.some((part) => part.type === "text" && part.text === "Hello world"));
});

test("Replicate cancels an unfinished prediction at its fixed host when polling is aborted", async () => {
  const controller = new AbortController();
  const urls: string[] = [];
  const model = createReplicateModel("secret", "meta/meta-llama-3-70b-instruct", async (input, init) => {
    urls.push(String(input));
    if (urls.length === 1) return Response.json({ id: "pred_cancel", status: "processing" });
    if (urls.length === 2) {
      controller.abort(new Error("client disconnected"));
      throw controller.signal.reason;
    }
    assert.equal(init?.method, "POST");
    return Response.json({ id: "pred_cancel", status: "canceled" });
  }, 0);
  await assert.rejects(async () => model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }], abortSignal: controller.signal }), /client disconnected/);
  assert.deepEqual(urls, [
    "https://api.replicate.com/v1/models/meta/meta-llama-3-70b-instruct/predictions",
    "https://api.replicate.com/v1/predictions/pred_cancel",
    "https://api.replicate.com/v1/predictions/pred_cancel/cancel",
  ]);
});

test("Replicate exposes failed terminal status and still cancels defensively", async () => {
  const urls: string[] = [];
  const model = createReplicateModel("secret", "meta/meta-llama-3-70b-instruct", async (input) => {
    urls.push(String(input));
    if (urls.length === 1) return Response.json({ id: "pred_failed", status: "failed", error: "capacity exhausted" });
    return Response.json({ id: "pred_failed", status: "canceled" });
  }, 0);
  await assert.rejects(async () => model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] }), /capacity exhausted/);
  assert.equal(urls[1], "https://api.replicate.com/v1/predictions/pred_failed/cancel");
});

test("Replicate streaming buffers a completed prediction into normal text parts", async () => {
  const model = createReplicateModel("secret", "meta/meta-llama-3-70b-instruct", async () => Response.json({ id: "pred_stream", status: "succeeded", output: ["one", " two"] }), 0);
  const result = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Count" }] }] });
  const parts = [];
  for await (const part of result.stream) parts.push(part);
  assert.ok(parts.some((part) => part.type === "text-delta" && part.delta === "one two"));
  assert.ok(parts.some((part) => part.type === "finish" && part.finishReason.unified === "stop"));
});

test("Replicate rejects unsupported media before creating a prediction", async () => {
  let calls = 0;
  const model = createReplicateModel("secret", "meta/meta-llama-3-70b-instruct", async () => { calls++; return Response.json({}); });
  await assert.rejects(async () => model.doGenerate({ prompt: [{ role: "user", content: [{ type: "file", data: "YWJj", mediaType: "image/png" } as any] }] }), /text-only/);
  assert.equal(calls, 0);
});

test("fal adapter sends OpenAI chat protocol with documented Key authorization", async () => {
  let calls = 0;
  const model = createFalModel("secret", "google/gemini-2.5-flash", async (input, init) => {
    calls++;
    assert.equal(String(input), "https://fal.run/openrouter/router/openai/v1/chat/completions");
    assert.equal(new Headers(init?.headers).get("authorization"), "Key secret");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "google/gemini-2.5-flash");
    assert.equal(body.messages[0].content, "Hello");
    return Response.json({
      id: "reply", object: "chat.completion", created: 1, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
  });
  const result = await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] });
  assert.equal(calls, 1);
  assert.ok(result.content.some((part) => part.type === "text" && part.text === "Hi"));
  assert.equal(result.usage.inputTokens.total, 2);
  assert.equal(result.usage.outputTokens.total, 1);
});

test("central SDK factory preserves fal Key authorization", async () => {
  const model = createSdkModel({ id: "fal", provider: "ai-sdk", sdkProvider: "fal", accessToken: "secret", enabled: true }, "google/gemini-2.5-flash", async (input, init) => {
    assert.equal(String(input), "https://fal.run/openrouter/router/openai/v1/chat/completions");
    assert.equal(new Headers(init?.headers).get("authorization"), "Key secret");
    return Response.json({ id: "reply", object: "chat.completion", created: 1, model: "google/gemini-2.5-flash", choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  const result = await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] });
  assert.ok(result.content.some((part) => part.type === "text" && part.text === "Hi"));
});
