import assert from "node:assert/strict";
import test from "node:test";
import type { Account } from "../types.js";
import { cloudPlatformEndpoint } from "./cloud-platforms.js";
import { createSdkModel } from "./models.js";
import { sdkAccountBaseUrl, validateSdkAccount } from "./providers.js";
import { sdkCallOptions } from "./protocol.js";

const account = (sdkProvider: string, extra: Partial<Account> = {}): Account => ({
  id: sdkProvider,
  provider: "ai-sdk",
  sdkProvider,
  accessToken: "test-key",
  enabled: true,
  ...extra,
});

test("cloud platform endpoints accept only reviewed service URL shapes", () => {
  assert.equal(cloudPlatformEndpoint("bedrock", "https://bedrock-runtime.eu-west-3.amazonaws.com/openai/v1/"),
    "https://bedrock-runtime.eu-west-3.amazonaws.com/openai/v1");
  assert.equal(cloudPlatformEndpoint("bedrock", "https://bedrock-mantle.us-east-1.api.aws/v1"),
    "https://bedrock-mantle.us-east-1.api.aws/v1");
  assert.equal(cloudPlatformEndpoint("azure-foundry", "https://team-one.openai.azure.com/openai/v1/"),
    "https://team-one.openai.azure.com/openai/v1");
  assert.equal(cloudPlatformEndpoint("azure-foundry", "https://team-one.services.ai.azure.com/openai/v1"),
    "https://team-one.services.ai.azure.com/openai/v1");
  assert.equal(cloudPlatformEndpoint("cloudflare", "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1"),
    "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1");
});

test("cloud endpoint overrides reject credential leaks, URL smuggling, and lookalike hosts", () => {
  const malicious: Array<[string, string]> = [
    ["azure-foundry", "https://openai.azure.com.evil.example/openai/v1"],
    ["azure-foundry", "https://user:secret@team.openai.azure.com/openai/v1"],
    ["azure-foundry", "https://team.openai.azure.com:444/openai/v1"],
    ["azure-foundry", "https://team.openai.azure.com/openai/v1?next=https://evil.example"],
    ["bedrock", "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/../secrets"],
    ["bedrock", "http://bedrock-runtime.us-east-1.amazonaws.com/openai/v1"],
    ["cloudflare", "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdeg/ai/v1"],
    ["cloudflare", "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1#fragment"],
  ];
  for (const [provider, endpoint] of malicious) assert.throws(() => cloudPlatformEndpoint(provider, endpoint));
  assert.throws(() => sdkAccountBaseUrl(account("vertex-express", { baseUrl: "https://evil.example/v1" })));
});

test("Azure requires an endpoint and at least one deployed model name", () => {
  assert.throws(() => validateSdkAccount(account("azure-foundry")), /Endpoint required/);
  const baseUrl = "https://team.openai.azure.com/openai/v1";
  assert.throws(() => validateSdkAccount(account("azure-foundry", { baseUrl })), /deployed model name/);
  assert.doesNotThrow(() => validateSdkAccount(account("azure-foundry", { baseUrl, sdkModels: ["my-gpt-deployment"] })));
});

test("Cloudflare accepts its documented @cf model IDs", () => {
  assert.doesNotThrow(() => validateSdkAccount(account("cloudflare", {
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1",
    sdkModels: ["@cf/meta/llama-3.1-8b-instruct"],
  })));
  assert.throws(() => validateSdkAccount(account("cloudflare", {
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1",
    sdkModels: ["@bad model"],
  })), /Models must be/);
});

const compatiblePlatforms = [
  ["bedrock", "openai.gpt-oss-120b", "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1"],
  ["azure-foundry", "my-deployment", "https://team.openai.azure.com/openai/v1"],
  ["cloudflare", "@cf/meta/llama-3.1-8b-instruct", "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1"],
] as const;

for (const [provider, modelId, baseUrl] of compatiblePlatforms) test(`${provider} performs an authenticated compatible request`, async () => {
  const configured = account(provider, provider === "bedrock" ? {} : { baseUrl, sdkModels: [modelId] });
  const model = createSdkModel(configured, modelId, async (input, init) => {
    assert.equal(String(input), `${baseUrl}/chat/completions`);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, modelId);
    assert.equal(body.messages[0].content, "Hello");
    return Response.json({ id: "reply", object: "chat.completion", created: 1, model: modelId,
      choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  });
  const result = await model.doGenerate(sdkCallOptions({ messages: [{ role: "user", content: "Hello" }] }, new AbortController().signal));
  assert.equal(result.content.find((part) => part.type === "text")?.text, "Hi");
  assert.equal(result.usage.inputTokens.total, 2);
  assert.equal(result.usage.outputTokens.total, 1);
});

test("Vertex Express performs a Google request with its API key", async () => {
  const model = createSdkModel(account("vertex-express"), "gemini-2.5-flash", async (input, init) => {
    assert.equal(String(input), "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent");
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "test-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.contents[0].parts[0].text, "Hello");
    return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } });
  });
  const result = await model.doGenerate(sdkCallOptions({ messages: [{ role: "user", content: "Hello" }] }, new AbortController().signal));
  assert.equal(result.content.find((part) => part.type === "text")?.text, "Hi");
  assert.equal(result.usage.inputTokens.total, 2);
  assert.equal(result.usage.outputTokens.total, 1);
});
