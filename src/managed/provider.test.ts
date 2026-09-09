import test from "node:test";
import assert from "node:assert/strict";
import { createManagedProviderAccount } from "./provider.js";
test("discovery and execution use the same fixed provider corridor with one credential resolution per request", async () => {
  const calls: string[] = [];
  let reads = 0;
  const account = createManagedProviderAccount({ providerId: "mistral", credentialRef: "account-1", models: new Set(["model"]),
    readCredential: async () => { reads++; return "fixture-key"; },
    fetchViaEgress: (async (url, init) => {
      calls.push(String(url));
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
      assert.equal(init?.redirect, "error");
      return Response.json({ data: [{ id: "model" }, { id: "model" }] });
    }) as typeof fetch,
  });
  assert.deepEqual(await account.discoverModels(AbortSignal.timeout(1000)), ["model"]);
  await account.chatCompletions(Buffer.from("{}"), AbortSignal.timeout(1000), {token:"unused-direct-connector-fixture",originalBody:Buffer.from("{}")});
  assert.deepEqual(calls, ["https://api.mistral.ai/v1/models", "https://api.mistral.ai/v1/chat/completions"]);
  assert.equal(reads, 2);
});
test("upstream errors do not trigger retries or expose response bodies", async () => {
  let calls = 0;
  const account = createManagedProviderAccount({ providerId: "mistral", credentialRef: "account-1", models: new Set(),
    readCredential: async () => "fixture-key", fetchViaEgress: (async () => { calls++; return new Response("secret diagnostic", { status: 401 }); }) as typeof fetch });
  await assert.rejects(account.discoverModels(AbortSignal.timeout(1000)), /^Error: provider_discovery_unavailable$/);
  assert.equal(calls, 1);
});
