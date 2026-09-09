import assert from "node:assert/strict";
import test from "node:test";
import type { Account } from "../../src/types.js";
import { SDK_PROVIDERS } from "../../src/ai-sdk/providers.js";
import { sdkAccountModels, sdkProviderCatalog } from "../../src/ai-sdk/catalog.js";
import { SDK_PROVIDER_NAMES, EXPANDED_PROVIDER_ACCESS } from "../src/lib/expandedProviderMetadata.js";
import { ACCESS as inference } from "../../src/ai-sdk/expansion-inference/index.js";
import { ACCESS as subscriptions } from "../../src/ai-sdk/expansion-subscriptions/index.js";
import { ACCESS as gateways } from "../../src/ai-sdk/expansion-gateways/index.js";
import { CLOUD_PLATFORM_ACCESS } from "../../src/ai-sdk/cloud-platforms.js";
const account = (sdkProvider: string): Account => ({ id: `test-${sdkProvider}`, provider: "ai-sdk", sdkProvider, accessToken: "test-key", enabled: true });

test("expanded providers have unique registration, catalogs and synchronized browser metadata", () => {
  assert.equal(new Set(SDK_PROVIDERS.map(p => p.id)).size, SDK_PROVIDERS.length);
  assert.deepEqual(EXPANDED_PROVIDER_ACCESS, { ...inference, ...subscriptions, ...gateways, ...CLOUD_PLATFORM_ACCESS });
  assert.deepEqual(SDK_PROVIDER_NAMES, Object.fromEntries(SDK_PROVIDERS.map(p => [p.id, p.name])));
  const catalog = sdkProviderCatalog();
  for (const id of Object.keys(EXPANDED_PROVIDER_ACCESS)) {
    const provider = catalog.providers.find(p => p.id === id);
    assert.ok(provider, id);
    assert.match(provider.source, /^https:\/\//);
    assert.ok(provider.models.length || provider.requiresModelSelection, id);
    for (const model of sdkAccountModels(account(id))) {
      assert.ok(model.id.startsWith(`${id}/`));
      assert.ok(model.input_modalities?.includes("text"));
    }
  }
});
