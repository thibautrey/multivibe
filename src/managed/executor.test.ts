import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { ManagedExecutor } from "./executor.js";
import { signExecutionGrant, executionBodyDigest, type ExecutionGrant } from "./authorization.js";
import { providerTokenUsage } from "./usage.js";
import type { ExecutionReceipt } from "./journal.js";
const keys = generateKeyPairSync("ed25519");
function harness(reply: () => Promise<Response>, operation: ExecutionGrant["operation"] = "responses") {
  const receipts: ExecutionReceipt[] = [];
  let calls = 0;
  let claimed = false;
  const body = Buffer.from(JSON.stringify({ model: "public/model", input: "hello", max_output_tokens: 8 }));
  const grant: ExecutionGrant = { version: 1, audience: "multivibe-core-managed", attemptId: "a1", reservationId: "r1",
    routeVersionId: "v1", providerId: "mistral", credentialRef: "account-1", model: "public/model", upstreamModel: "upstream",
    operation, stream: false, bodySha256: executionBodyDigest(body), maximumOutputTokens: 8, issuedAt: 1000, expiresAt: 61000 };
  const executor = new ManagedExecutor({ verificationKey: keys.publicKey, maximumRequestBytes: 10000,
    maximumResponseBytes: 10000, executionTimeoutMs: 1000, clock: () => 1001,
    journal: { async claim() { if (claimed) throw Error("duplicate"); claimed = true; }, async finish(receipt) { receipts.push(receipt); } },
    accounts: [{ providerId: "mistral", credentialRef: "account-1", models: new Set(["upstream"]), async chatCompletions(bytes) {
      assert.equal(claimed, true);
      const payload = JSON.parse(Buffer.from(bytes).toString());
      assert.equal(payload.model, "upstream");
      assert.equal(payload.max_tokens, 8);
      calls++;
      return reply();
    } }],
  });
  return { executor, body, token: signExecutionGrant(grant, keys.privateKey, 1000), receipts, calls: () => calls };
}
test("managed execution reuses Responses conversion while preserving independent billing usage", async () => {
  const h = harness(async () => Response.json({ model: "upstream", choices: [{ message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, prompt_tokens_details: { cached_tokens: 1 } } }));
  const result = await h.executor.execute(h.token, h.body);
  assert.equal((await result.response.json()).object, "response");
  assert.deepEqual((await result.receipt).usage, { inputTokens: "4", outputTokens: "2", totalTokens: "6", cachedInputTokens: "1" });
  assert.equal(h.receipts.length, 1);
  await assert.rejects(h.executor.execute(h.token, h.body), /duplicate/);
  assert.equal(h.calls(), 1);
});
test("ambiguous provider failure never retries and durably records uncertainty", async () => {
  const h = harness(async () => { throw Error("secret-provider-error"); });
  const result = await h.executor.execute(h.token, h.body);
  assert.equal(h.calls(), 1);
  assert.equal((await result.receipt).state, "uncertain");
  assert.equal((await result.receipt).usage, null);
  assert.equal(h.receipts.length, 1);
  assert.doesNotMatch(await result.response.text(), /secret-provider-error/);
});
test("compatibility conversion cannot manufacture billable usage", async () => {
  const h = harness(async () => Response.json({ choices: [{ message: { content: "Hi" } }], usage: { prompt_tokens: 3 } }));
  const result = await h.executor.execute(h.token, h.body);
  assert.equal((await result.receipt).usage, null);
  assert.equal((await result.receipt).state, "uncertain");
});
test("usage rejects partial and inconsistent quantities without persisting arbitrary provider fields", () => {
  assert.equal(providerTokenUsage({ usage: { input_tokens: 2 } }), null);
  assert.equal(providerTokenUsage({ usage: { input_tokens: 2, output_tokens: 1, total_tokens: 4 } }), null);
  assert.equal(providerTokenUsage({ usage: { input_tokens: 2, output_tokens: -1 } }), null);
  assert.deepEqual(providerTokenUsage({ usage: { input_tokens: 0, output_tokens: 0, secret: "never copy" } }), { inputTokens: "0", outputTokens: "0" });
});
test("stream cancellation does not discard provider usage or the durable receipt", async () => {
  let finish: ExecutionReceipt | undefined;
  const body = Buffer.from(JSON.stringify({ model: "public/model", input: "hello", stream: true, max_output_tokens: 8 }));
  const grant: ExecutionGrant = { version: 1, audience: "multivibe-core-managed", attemptId: "stream-1", reservationId: "r1",
    routeVersionId: "v1", providerId: "mistral", credentialRef: "account-1", model: "public/model", upstreamModel: "upstream",
    operation: "responses", stream: true, bodySha256: executionBodyDigest(body), maximumOutputTokens: 8, issuedAt: 1000, expiresAt: 61000 };
  const executor = new ManagedExecutor({ verificationKey: keys.publicKey, maximumRequestBytes: 10000,
    maximumResponseBytes: 10000, executionTimeoutMs: 1000, clock: () => 1001,
    journal: { async claim() {}, async finish(receipt) { finish = receipt; } },
    accounts: [{ providerId: "mistral", credentialRef: "account-1", models: new Set(["upstream"]), async chatCompletions() {
      return new Response(new ReadableStream({ async start(controller) {
        controller.enqueue(Buffer.from('data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"hello"}}]}\n\n'));
        await new Promise(resolve => setTimeout(resolve, 10));
        controller.enqueue(Buffer.from('data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n\n'));
        controller.close();
      } }), { headers: { "content-type": "text/event-stream" } });
    } }],
  });
  const result = await executor.execute(signExecutionGrant(grant, keys.privateKey, 1000), body);
  await result.response.body!.cancel();
  const receipt = await result.receipt;
  assert.equal(receipt.state, "completed");
  assert.deepEqual(receipt.usage, { inputTokens: "4", outputTokens: "2" });
  assert.deepEqual(finish, receipt);
});
