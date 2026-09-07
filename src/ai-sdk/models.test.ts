import assert from "node:assert/strict";
import test from "node:test";
import { createSdkModel } from "./models.js";
import { sdkCallOptions, chatResult } from "./protocol.js";
import type { Account } from "../types.js";

for (const provider of ["anthropic", "google", "groq"]) test(`uses the real ${provider} SDK request and response codec`, async () => {
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
      assert.match(url, /^https:\/\/generativelanguage.googleapis.com\/v1beta\/models\/.+:generateContent$/);
      assert.equal(headers.get("x-goog-api-key"), "account-key");
      assert.equal(body.contents[0].parts[0].text, "Hello");
      return Response.json({candidates: [{content: {role: "model", parts: [{text: "Hi"}]}, finishReason: "STOP"}], usageMetadata: {promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7}});
    }
    assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(headers.get("authorization"), "Bearer account-key");
    assert.equal(body.messages[0].content, "Hello");
    return Response.json({id: "chat_test", object: "chat.completion", created: 1, model: "test", choices: [{index: 0, message: {role: "assistant", content: "Hi"}, finish_reason: "stop"}], usage: {prompt_tokens: 5, completion_tokens: 2, total_tokens: 7}});
  };
  const model = createSdkModel(account, provider === "anthropic" ? "claude-sonnet-4-6" : "test", mockFetch);
  const result = chatResult(`${provider}/test`, await model.doGenerate(sdkCallOptions({messages: [{role: "user", content: "Hello"}], max_tokens: 50}, new AbortController().signal)));
  assert.equal(requests, 1);
  assert.equal(result.choices[0].message.content, "Hi");
  assert.equal(result.usage.total_tokens, 7);
});
