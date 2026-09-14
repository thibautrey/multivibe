import assert from "node:assert/strict";
import test from "node:test";
import {
  createTeamApiKeyValidator,
  ProviderCredentialValidationError,
} from "./team-api-key-validation.js";

const API_KEY = "provider-secret-never-returned-123456";

test("slow provider validation aborts within the ingress budget without exposing the key", async (t) => {
  const budgets: number[] = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    budgets.push(milliseconds);
    return AbortSignal.abort(new DOMException("Timed out", "TimeoutError"));
  });
  const validator = createTeamApiKeyValidator(async (_url, init) => {
    init?.signal?.throwIfAborted();
    throw new Error("Expected an aborted request");
  });
  await assert.rejects(validator.listModels({ provider: "openai", apiKey: API_KEY }), errorCode("unavailable"));
  await assert.rejects(validator.testInference({ provider: "openai", apiKey: API_KEY, model: "model-a" }),
    errorCode("unavailable"));
  assert.ok(budgets.every(value => value > 0));
  assert.ok(budgets.reduce((sum, value) => sum + value, 0) <= 35_000);
});

function errorCode(code: ProviderCredentialValidationError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof ProviderCredentialValidationError && error.code === code
    && !error.message.includes(API_KEY);
}

test("direct provider validation returns a deduplicated bounded model catalog", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const validator = createTeamApiKeyValidator(async (url, init) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return Response.json({ data: [{ id: "mistral-small-latest" }, { id: "mistral-large-latest" },
      { id: "mistral-small-latest" }, { id: "invalid model" }, { id: `model-${API_KEY}` }] });
  });
  assert.deepEqual(await validator.listModels({ provider: "mistral", apiKey: API_KEY }),
    ["mistral-large-latest", "mistral-small-latest"]);
  assert.equal(calls[0]?.url, "https://api.mistral.ai/v1/models");
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), `Bearer ${API_KEY}`);
  assert.equal(calls[0]?.init?.redirect, "error");
});

test("direct provider validation maps rejected keys and malformed catalogs without leaking keys", async () => {
  const rejected = createTeamApiKeyValidator(async () => new Response("denied", { status: 401 }));
  await assert.rejects(rejected.listModels({ provider: "mistral", apiKey: API_KEY }),
    errorCode("unauthorized"));

  const malformed = createTeamApiKeyValidator(async () => Response.json({ models: [] }));
  await assert.rejects(malformed.listModels({ provider: "mistral", apiKey: API_KEY }),
    errorCode("invalid_response"));

  const oversized = createTeamApiKeyValidator(async () => new Response(JSON.stringify({
    data: [{ id: "valid-model" }], padding: "x".repeat(2 * 1024 * 1024),
  }), { headers: { "content-type": "application/json" } }));
  await assert.rejects(oversized.listModels({ provider: "mistral", apiKey: API_KEY }),
    errorCode("invalid_response"));
});

test("direct provider inference validates OpenAI-compatible and Anthropic output", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  const validator = createTeamApiKeyValidator(async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return String(url).includes("anthropic")
      ? Response.json({ content: [{ type: "text", text: "OK" }] })
      : Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }] });
  });
  await validator.testInference({ provider: "mistral", apiKey: API_KEY, model: "mistral-small-latest" });
  await validator.testInference({ provider: "anthropic", apiKey: API_KEY, model: "claude-test" });
  assert.equal(requests[0]?.url, "https://api.mistral.ai/v1/chat/completions");
  assert.equal(requests[0]?.body.max_tokens, 8);
  assert.equal(requests[0]?.body.stream, false);
  assert.equal(requests[1]?.url, "https://api.anthropic.com/v1/messages");
  assert.equal(requests[1]?.headers.get("x-api-key"), API_KEY);
  assert.equal(requests[1]?.headers.get("anthropic-version"), "2023-06-01");
});


for (const provider of ['__proto__', 'constructor', 'github-copilot', 'unknown']) {
  test(`unsupported API provider ${provider} never reaches transport`, async () => {
    let calls = 0;
    const validator = createTeamApiKeyValidator(async () => { calls++; throw Error(API_KEY); });
    await assert.rejects(validator.listModels({provider, apiKey: API_KEY}), errorCode('unsupported'));
    assert.equal(calls, 0);
  });
}
test('key header injection is rejected before transport and upstream errors are sanitized', async () => {
  let calls = 0;
  const validator = createTeamApiKeyValidator(async () => {calls++; throw Error(API_KEY);});
  await assert.rejects(validator.listModels({provider:'openai',apiKey:'key\ninvalid'}), errorCode('unauthorized'));
  assert.equal(calls, 0);
  await assert.rejects(validator.listModels({provider:'openai',apiKey:API_KEY}), errorCode('unavailable'));
});
test('empty inference output is not a successful validation',async()=>{
  const validator=createTeamApiKeyValidator(async()=>Response.json({choices:[]}));
  await assert.rejects(validator.testInference({provider:'openai',apiKey:API_KEY,model:'model-a'}),errorCode('inference_failed'));
});
