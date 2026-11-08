import { CODING_ECONOMY_ALIAS_DESCRIPTION } from "./coding-economy-model.js";
import type { ModuleManager } from "./module-manager.js";
import type { ModuleVirtualModel } from "./module-sdk.js";
import { validateSmartAlias } from "./smart-routing.js";
import type { AccountStore } from "./store.js";
import type { ModelAlias } from "./types.js";

export type VirtualModelStatus = "ready" | "unconfigured" | "conflict" | "unavailable";

export type VirtualModelDescriptor = {
  /** Client-facing model id published by the declaring module. */
  id: string;
  moduleId: string;
  moduleName?: string;
  role?: "parent" | "worker";
  description?: string;
  /** Managed alias marker used to create and later reconcile the alias. */
  aliasDescription?: string;
  /** Concrete model the id resolves to, when configured. */
  target?: string;
  status: VirtualModelStatus;
  reason?: string;
};

type Declaration = {
  moduleId: string;
  moduleName?: string;
  enabled: boolean;
  declaration: ModuleVirtualModel;
  settings: Record<string, unknown>;
};

function declarations(manager?: ModuleManager): Declaration[] {
  if (!manager) return [];
  const found: Declaration[] = [];
  for (const view of manager.list()) {
    if (view.execution !== "host-builtin") continue;
    for (const declaration of view.manifest?.virtualModels ?? []) {
      if (typeof declaration?.id !== "string" || !declaration.id.trim()) continue;
      if (typeof declaration.targetSetting !== "string" || !declaration.targetSetting.trim()) continue;
      found.push({
        moduleId: view.id,
        moduleName: view.manifest?.name,
        enabled: Boolean(view.enabled) && view.loaded && view.healthy,
        declaration,
        settings: (view.settings ?? {}) as Record<string, unknown>,
      });
    }
  }
  return found;
}

function targetFor(entry: Declaration): string | undefined {
  const raw = entry.settings[entry.declaration.targetSetting];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/**
 * Resolves every declared virtual model to a concrete target. A declared id is
 * never resolved by an alias to another virtual model, and a target that is not
 * present in the instance catalog is reported as unavailable rather than being
 * published as a name that cannot serve.
 */
export function resolveVirtualModels(
  manager?: ModuleManager,
  knownModelIds?: ReadonlySet<string>,
): VirtualModelDescriptor[] {
  const entries = declarations(manager);
  const declaredIds = new Set(entries.map((entry) => entry.declaration.id));
  const aliasOwners = new Map<string, string>();
  return entries.map((entry) => {
    const base = {
      id: entry.declaration.id,
      moduleId: entry.moduleId,
      moduleName: entry.moduleName,
      role: entry.declaration.role,
      description: entry.declaration.description,
      aliasDescription: entry.declaration.aliasDescription,
    };
    const target = targetFor(entry);
    if (!entry.enabled) return { ...base, target, status: "unconfigured" as const, reason: "Module is disabled" };
    if (!target) return { ...base, status: "unconfigured" as const, reason: "No target model is configured" };
    if (declaredIds.has(target)) {
      return { ...base, target, status: "unavailable" as const, reason: "A virtual model cannot target another virtual model" };
    }
    if (knownModelIds && !knownModelIds.has(target)) {
      return { ...base, target, status: "unavailable" as const, reason: "Target model is not in the instance catalog" };
    }
    const owner = aliasOwners.get(target);
    if (owner) {
      return { ...base, target, status: "conflict" as const, reason: `${owner} already publishes this target model; parent and worker must differ` };
    }
    aliasOwners.set(target, entry.declaration.id);
    return { ...base, target, status: "ready" as const };
  });
}

/** Serializes an alias id for use as a model id: no leading or trailing space. */
function aliasFor(id: string, target: string, description: string): ModelAlias {
  return {
    schemaVersion: 2,
    id,
    enabled: true,
    description,
    rules: [
      {
        id: "pinned-target",
        enabled: true,
        candidates: [{ model: target }],
      },
    ],
  };
}

function sameTarget(alias: ModelAlias, target: string, description: string): boolean {
  const candidates = alias.rules.flatMap((rule) => rule.candidates);
  return (
    alias.enabled === true &&
    alias.description === description &&
    alias.rules.length === 1 &&
    candidates.length === 1 &&
    candidates[0].model === target &&
    Object.keys(alias.defaults ?? {}).length === 0
  );
}

export type VirtualModelSyncResult = {
  descriptors: VirtualModelDescriptor[];
  created: string[];
  updated: string[];
  removed: string[];
  conflicts: Array<{ id: string; reason: string }>;
};

/**
 * Reconciles the store's managed routing aliases with the current module
 * declarations. Only aliases carrying the module's managed description are
 * written or deleted; a user-authored alias with a colliding id is reported as
 * a conflict and left untouched.
 */
export async function syncVirtualModelAliases(
  store: AccountStore,
  manager?: ModuleManager,
  knownModelIds?: ReadonlySet<string>,
): Promise<VirtualModelSyncResult> {
  const descriptors = resolveVirtualModels(manager, knownModelIds);
  const declaredIds = new Set(descriptors.map((descriptor) => descriptor.id));
  const existing = await store.listModelAliases();
  const byId = new Map(existing.map((alias) => [alias.id, alias]));
  const result: VirtualModelSyncResult = { descriptors, created: [], updated: [], removed: [], conflicts: [] };

  for (const descriptor of descriptors) {
    const current = byId.get(descriptor.id);
    const managedDescription = descriptor.aliasDescription ?? CODING_ECONOMY_ALIAS_DESCRIPTION;
    if (descriptor.status !== "ready" || !descriptor.target) {
      if (current?.description === managedDescription) {
        await store.deleteModelAlias(descriptor.id);
        result.removed.push(descriptor.id);
      } else if (current) {
        result.conflicts.push({ id: descriptor.id, reason: "An alias with this id is not managed by this module" });
      }
      continue;
    }
    if (!current) {
      const alias = aliasFor(descriptor.id, descriptor.target, managedDescription);
      if (validateSmartAlias(alias).length) {
        result.conflicts.push({ id: descriptor.id, reason: validateSmartAlias(alias)[0] });
        continue;
      }
      await store.upsertModelAlias(alias);
      result.created.push(descriptor.id);
      continue;
    }
    if (current.description !== managedDescription) {
      result.conflicts.push({ id: descriptor.id, reason: "An alias with this id already exists and is not managed by this module" });
      continue;
    }
    if (!sameTarget(current, descriptor.target, managedDescription)) {
      await store.upsertModelAlias(aliasFor(descriptor.id, descriptor.target, managedDescription));
      result.updated.push(descriptor.id);
    }
  }

  const managedDescriptions = new Set<string>([CODING_ECONOMY_ALIAS_DESCRIPTION]);
  for (const descriptor of descriptors) {
    if (descriptor.aliasDescription) managedDescriptions.add(descriptor.aliasDescription);
  }
  for (const alias of existing) {
    if (!managedDescriptions.has(alias.description ?? "")) continue;
    if (declaredIds.has(alias.id)) continue;
    await store.deleteModelAlias(alias.id);
    result.removed.push(alias.id);
  }
  return result;
}
