import assert from "node:assert/strict";
import test from "node:test";
import { codingEconomyManifest, createCodingEconomy } from "./coding-economy.js";
import { CODING_ECONOMY_VIRTUAL_MODELS, CODING_PARENT_MODEL, CODING_WORKER_MODEL, codingRoleForRequestedModel, isCodingEconomyVirtualModel } from "./coding-economy-model.js";
import type { ModuleContext, ModuleStorageEvent } from "./module-sdk.js";

function setup() {
  const events: ModuleStorageEvent[] = [];
  const context = {
    requestId: "req-1",
    route: "/responses",
    transport: "http",
    signal: new AbortController().signal,
    settings: {},
    internal: false,
    log: { info() {}, warn() {}, error() {} },
    storage: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
      recordEvent: async (event: ModuleStorageEvent) => { events.push(event); },
      readEvents: async () => [],
    },
  } as unknown as ModuleContext;
  return { context, events, hook: createCodingEconomy()["request.completed"]! };
}

test("declares the parent and worker virtual models from settings keys", () => {
  assert.deepEqual(CODING_ECONOMY_VIRTUAL_MODELS.map((model) => model.id), [CODING_PARENT_MODEL, CODING_WORKER_MODEL]);
  assert.equal(codingRoleForRequestedModel(CODING_WORKER_MODEL), "worker");
  assert.equal(codingRoleForRequestedModel(CODING_PARENT_MODEL), "parent");
  assert.equal(isCodingEconomyVirtualModel("gpt-5.2-codex"), false);
  const properties = (codingEconomyManifest.settingsSchema as { properties: Record<string, { format?: string }> }).properties;
  assert.equal(properties.parentModel.format, "multivibe-model");
  assert.equal(properties.workerModel.format, "multivibe-model");
  assert.equal(codingEconomyManifest.defaultSettings?.parentModel, "");
  assert.deepEqual(codingEconomyManifest.hooks, ["request.completed"]);
});

test("records role-attributed usage for measured coding turns", async () => {
  const { context, events, hook } = setup();
  await hook({
    traceId: "t1", traceKind: "upstream-attempt", requestedModel: CODING_WORKER_MODEL, model: "gpt-5.1-codex-mini",
    status: 200, usageStatus: "measured", costUsd: 0.0004, tokensInput: 1_000, tokensInputCached: 400, tokensOutput: 50,
  }, context);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "coding:t1");
  assert.equal(events[0].type, "coding.usage");
  assert.equal(events[0].metrics?.worker, 1);
  assert.equal(events[0].metrics?.costUsd, 0.0004);
  assert.equal(events[0].metrics?.cachedInputTokens, 400);
});

test("ignores unrelated traffic, nested requests, and unpriced turns are marked unknown", async () => {
  const { context, events, hook } = setup();
  await hook({ traceId: "t2", traceKind: "upstream-attempt", requestedModel: "gpt-5.2-codex", model: "gpt-5.2-codex", status: 200, usageStatus: "measured", costUsd: 1 }, context);
  await hook({ traceId: "t3", traceKind: "client-request", requestedModel: CODING_PARENT_MODEL, status: 200 }, context);
  context.internal = true;
  await hook({ traceId: "t4", traceKind: "upstream-attempt", requestedModel: CODING_PARENT_MODEL, status: 200, usageStatus: "measured", costUsd: 1 }, context);
  assert.equal(events.length, 0);

  context.internal = false;
  await hook({ traceId: "t5", traceKind: "upstream-attempt", requestedModel: CODING_PARENT_MODEL, model: "gpt-5.2-codex", status: 200, usageStatus: "measured" }, context);
  assert.equal(events.length, 1);
  assert.equal(events[0].metrics?.unknown, 1);
  assert.equal(events[0].metrics?.priced, 0);
});
