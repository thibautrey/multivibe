import assert from "node:assert/strict";
import test from "node:test";
import type { ModuleManager } from "./module-manager.js";
import type { ModuleVirtualModel } from "./module-sdk.js";
import type { AccountStore } from "./store.js";
import type { ModelAlias } from "./types.js";
import { CODING_ECONOMY_ALIAS_DESCRIPTION, CODING_PARENT_MODEL, CODING_WORKER_MODEL } from "./coding-economy-model.js";
import { resolveVirtualModels, syncVirtualModelAliases } from "./virtual-model-registry.js";

const DECLARATIONS: readonly ModuleVirtualModel[] = [
  { id: CODING_PARENT_MODEL, targetSetting: "parentModel", role: "parent" },
  { id: CODING_WORKER_MODEL, targetSetting: "workerModel", role: "worker" },
];

function manager(overrides: { enabled?: boolean; settings?: Record<string, unknown>; declarations?: readonly ModuleVirtualModel[]; id?: string } = {}) {
  const view = {
    id: overrides.id ?? "multivibe.coding-economy",
    enabled: overrides.enabled ?? true,
    loaded: overrides.enabled ?? true,
    healthy: true,
    execution: "host-builtin" as const,
    settings: overrides.settings ?? { parentModel: "gpt-5.2-codex", workerModel: "gpt-5.1-codex-mini" },
    manifest: { id: "multivibe.coding-economy", name: "Cost-optimized coding", virtualModels: overrides.declarations ?? DECLARATIONS },
  };
  return { list: () => [view] } as unknown as ModuleManager;
}

function fakeStore(seed: ModelAlias[] = []) {
  const aliases = new Map(seed.map((alias) => [alias.id, alias]));
  const store = {
    listModelAliases: async () => [...aliases.values()].map((alias) => structuredClone(alias)),
    upsertModelAlias: async (alias: ModelAlias) => { aliases.set(alias.id, structuredClone(alias)); return alias; },
    deleteModelAlias: async (id: string) => aliases.delete(id),
  } as unknown as AccountStore;
  return { store, aliases };
}

test("resolves declared virtual models to concrete catalog targets", () => {
  const catalog = new Set(["gpt-5.2-codex", "gpt-5.1-codex-mini"]);
  const descriptors = resolveVirtualModels(manager(), catalog);
  assert.deepEqual(descriptors.map((descriptor) => [descriptor.id, descriptor.status, descriptor.target]), [
    [CODING_PARENT_MODEL, "ready", "gpt-5.2-codex"],
    [CODING_WORKER_MODEL, "ready", "gpt-5.1-codex-mini"],
  ]);
});

test("reports unconfigured, unavailable, and conflicting declarations instead of publishing them", () => {
  assert.equal(resolveVirtualModels(manager({ enabled: false }))[0].status, "unconfigured");
  assert.equal(resolveVirtualModels(manager({ settings: {} }))[0].status, "unconfigured");
  assert.equal(resolveVirtualModels(manager({ settings: { parentModel: "not-in-catalog" } }), new Set(["gpt-5.1-codex-mini"]))[0].status, "unavailable");
  // A virtual model must never resolve to another virtual model.
  assert.equal(resolveVirtualModels(manager({ settings: { parentModel: CODING_WORKER_MODEL } }))[0].status, "unavailable");
  // Two declarations cannot publish the same target.
  const duplicated = resolveVirtualModels(manager({ settings: { parentModel: "same-model", workerModel: "same-model" } }));
  assert.equal(duplicated[1].status, "conflict");
});

test("creates, updates, and removes only the aliases it owns", async () => {
  const foreign: ModelAlias = { schemaVersion: 2, id: CODING_PARENT_MODEL, enabled: true, description: "Hand-written by the operator", rules: [{ id: "mine", candidates: [{ model: "gpt-5" }] }] };
  const { store, aliases } = fakeStore([foreign]);
  const catalog = new Set(["gpt-5.2-codex", "gpt-5.1-codex-mini"]);

  const first = await syncVirtualModelAliases(store, manager(), catalog);
  assert.deepEqual(first.created, [CODING_WORKER_MODEL]);
  assert.equal(first.conflicts.length, 1);
  assert.equal(aliases.get(CODING_PARENT_MODEL)?.description, "Hand-written by the operator", "a foreign alias must be left untouched");

  const created = aliases.get(CODING_WORKER_MODEL)!;
  assert.equal(created.description, CODING_ECONOMY_ALIAS_DESCRIPTION);
  assert.deepEqual(created.rules[0].candidates.map((candidate) => candidate.model), ["gpt-5.1-codex-mini"]);

  const second = await syncVirtualModelAliases(store, manager({ settings: { parentModel: "gpt-5.2-codex", workerModel: "gpt-5" } }), new Set([...catalog, "gpt-5"]));
  assert.deepEqual(second.updated, [CODING_WORKER_MODEL]);
  assert.deepEqual(aliases.get(CODING_WORKER_MODEL)!.rules[0].candidates.map((candidate) => candidate.model), ["gpt-5"]);

  const disabled = await syncVirtualModelAliases(store, manager({ enabled: false }), catalog);
  assert.deepEqual(disabled.removed, [CODING_WORKER_MODEL]);
  assert.equal(aliases.has(CODING_WORKER_MODEL), false);
  assert.equal(aliases.has(CODING_PARENT_MODEL), true, "a foreign alias is never removed");
});
