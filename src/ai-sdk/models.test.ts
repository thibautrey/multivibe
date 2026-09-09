import assert from "node:assert/strict";
import test from "node:test";
import { createSdkModel } from "./models.js";
import { sdkCallOptions, chatResult } from "./protocol.js";
import type { Account } from "../types.js";

for (const provider of ["anthropic", "google", "groq", "mammouth"]) test(`uses the real ${provider} SDK request and response codec`, async () => {
  const account: Account = {id: "account", provider: "ai-sdk", sdkProvider: provider, accessToken: "account-key", enabled: true};
  let requests = 0;
  const mockFetch: typeof fetch = async (input, init) => {
    requests++;
    const url = String(input), headers = new Headers(init?.headers), body = JSON.parse(String(init?.body));
    if (provider === "anthropic") {
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      assert.equal(headers.get("x-api-key"), "account-key");
      assert.equal(body.messages[0].content[0].text, "Hello");
      return Response.json({id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{type: "text", text: "Hi"}], stop_reason: "end_turn", stop_sequence: null, usage: {input_tokens: 5, output_tokens: 2}});
    }
    if (provider === "google") {
      assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/.+:generateContent$/);
      assert.equal(headers.get("x-goog-api-key"), "account-key");
      assert.equal(body.contents[0].parts[0].text, "Hello");
      return Response.json({candidates: [{content: {role: "model", parts: [{text: "Hi"}]}, finishReason: "STOP"}], usageMetadata: {promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7}});
    }
    assert.equal(url, provider === "mammouth" ? "https://api.mammouth.ai/v1/chat/completions" : "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(body.model, "test");
    assert.equal(headers.get("authorization"), "Bearer account-key");
    assert.equal(body.messages[0].content, "Hello");
    return Response.json({id: "chat_test", object: "chat.completion", created: 1, model: "test", choices: [{index: 0, message: {role: "assistant", content: "Hi"}, finish_reason: "stop"}], usage: {prompt_tokens: 5, completion_tokens: 2, total_tokens: 7}});
  };
  const model = createSdkModel(account, provider === "anthropic" ? "claude-sonnet-4-6" : "test", mockFetch);
  const result = chatResult(`${provider}/test`, await model.doGenerate(sdkCallOptions({messages: [{role: "user", content: "Hello"}], max_tokens: 50}, new AbortController().signal)));
  assert.equal(requests, 1);
  assert.equal(result.choices[0].message.content, "Hi");
  assert.ok(result.usage);
  assert.equal(result.usage.total_tokens, 7);
});

test("Mammouth streams through the compatible SDK with the upstream model ID", async () => {
  const account: Account = { id: "mammouth", provider: "ai-sdk", sdkProvider: "mammouth", accessToken: "key", enabled: true };
  const model = createSdkModel(account, "mammouth-recommended", async (input, init) => {
    assert.equal(String(input), "https://api.mammouth.ai/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "mammouth-recommended");
    assert.equal(body.stream, true);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer key");
    return new Response([
      { id: "test", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
      { id: "test", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const { stream } = await model.doStream(sdkCallOptions({ messages: [{ role: "user", content: "Hi" }] }, new AbortController().signal));
  const parts = [];
  for await (const part of stream) parts.push(part);
  assert.ok(parts.some((part) => part.type === "text-delta" && part.delta === "Hello"));
  assert.ok(parts.some((part) => part.type === "finish" && part.finishReason.unified === "stop"));
  assert.ok(!parts.some((part) => part.type === "error"));
});
