import type { ModuleVirtualModel } from "./module-sdk.js";

/** Bundled module that exposes the parent/worker coding virtual models. */
export const CODING_ECONOMY_PLUGIN = "multivibe.coding-economy";

/** Client-facing parent model: the strong model that owns the task. */
export const CODING_PARENT_MODEL = "multivibe/coding-parent";
/** Client-facing worker model: the cheaper model that executes bounded work. */
export const CODING_WORKER_MODEL = "multivibe/coding-worker";

export type CodingAgentRole = "parent" | "worker";

/**
 * Identifies the managed routing aliases owned by this module. Only aliases
 * carrying this exact description are ever created, updated, or removed by
 * MultiVibe; a user-authored alias with a colliding id is reported as a
 * conflict and left untouched.
 */
export const CODING_ECONOMY_ALIAS_DESCRIPTION =
  "Managed by the MultiVibe cost-optimized coding module";

export const CODING_ECONOMY_VIRTUAL_MODELS: readonly ModuleVirtualModel[] = [
  {
    id: CODING_PARENT_MODEL,
    targetSetting: "parentModel",
    role: "parent",
    description:
      "Strong model that owns planning, delegation, and final verification for cost-optimized coding.",
  },
  {
    id: CODING_WORKER_MODEL,
    targetSetting: "workerModel",
    role: "worker",
    description:
      "Cheaper model used for bounded implementation work delegated by the parent.",
  },
];

/** Roles declared by this module, keyed by client-facing model id. */
export const CODING_ECONOMY_ROLES: Readonly<Record<string, CodingAgentRole>> = Object.freeze(
  Object.fromEntries(
    CODING_ECONOMY_VIRTUAL_MODELS.flatMap((model) =>
      model.role ? [[model.id, model.role] as const] : [],
    ),
  ),
);

/** Declared virtual model ids, regardless of whether the module is enabled. */
export const CODING_ECONOMY_VIRTUAL_MODEL_IDS: readonly string[] = CODING_ECONOMY_VIRTUAL_MODELS.map(
  (model) => model.id,
);

/** Resolves the agent role a client asked for, based on the requested model id. */
export function codingRoleForRequestedModel(model: unknown): CodingAgentRole | undefined {
  return typeof model === "string" ? CODING_ECONOMY_ROLES[model.trim()] : undefined;
}

/** True when the requested model id names one of this module's virtual models. */
export function isCodingEconomyVirtualModel(model: unknown): boolean {
  return codingRoleForRequestedModel(model) !== undefined;
}
