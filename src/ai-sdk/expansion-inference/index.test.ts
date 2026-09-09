import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ACCESS, CATALOGS, PROVIDERS, QUOTA_FETCHERS } from "./index.js";

test("expansion inference metadata is complete and uses fixed HTTPS endpoints", () => {
  assert.equal(PROVIDERS.length, 10);
  assert.equal(new Set(PROVIDERS.map(({ id }) => id)).size, 10);
  for (const provider of PROVIDERS) {
    assert.equal(provider.adapter, "compatible");
    assert.match(provider.baseURL, /^https:\/\//);
    assert.ok(CATALOGS[provider.id]?.models.length, `${provider.id} needs a reviewed model`);
    assert.match(CATALOGS[provider.id].source, /^https:\/\//);
    assert.match(ACCESS[provider.id].source, /^https:\/\//);
  }
  assert.deepEqual(QUOTA_FETCHERS, {});
});

for (const provider of PROVIDERS) test(`${provider.name} uses compatible chat transport`, async () => {
  const catalogModel = CATALOGS[provider.id].models[0];
  let requests = 0;
  const sdk = createOpenAICompatible({
    name: provider.id,
    apiKey: "test-key",
    baseURL: provider.baseURL,
    fetch: async (input, init) => {
      requests++;
      assert.equal(String(input), `${provider.baseURL}/chat/completions`);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, catalogModel.id);
      assert.equal(body.messages[0].content, "Hello");
      return Response.json({ id: "reply", object: "chat.completion", created: 1, model: catalogModel.id,
        choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    },
  });
  const result = await sdk.languageModel(catalogModel.id).doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  });
  assert.equal(requests, 1);
  assert.equal(result.content.find((part) => part.type === "text")?.text, "Hi");
  assert.equal(result.usage.inputTokens.total, 1);
});
