import {
  CODING_ECONOMY_PLUGIN,
  CODING_ECONOMY_VIRTUAL_MODELS,
  codingRoleForRequestedModel,
} from "./coding-economy-model.js";
import type { ModuleHook, ModuleManifest, MultivibeModule } from "./module-sdk.js";

const modelSetting = (title: string, description: string) => ({
  type: "string",
  title,
  description,
  format: "multivibe-model",
});

export const codingEconomyManifest: ModuleManifest = {
  id: CODING_ECONOMY_PLUGIN,
  name: "Cost-optimized coding",
  version: "1.0.0",
  apiVersion: 1,
  description:
    "Publish a strong parent model and a cheaper worker model so a harness can delegate bounded implementation work and the parent can verify it. Records role-attributed cost evidence per task; it never rewrites messages, tool definitions, or cache keys.",
  repository: "https://github.com/thibautrey/multivibe",
  entrypoint: "coding-economy.js",
  hooks: ["request.completed"],
  priority: 150,
  timeoutMs: 5_000,
  failurePolicy: "open",
  categories: ["Routing"],
  tags: ["cost", "coding", "delegation", "cache"],
  defaultSettings: {
    parentModel: "",
    workerModel: "",
    workerReasoningEffort: "",
    taskTtlMinutes: 720,
    delegationMarginPercent: 20,
  },
  settingsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      parentModel: modelSetting(
        "Parent (strong) model",
        "Model behind multivibe/coding-parent. It keeps ownership of the task and verifies the worker's actual changes.",
      ),
      workerModel: modelSetting(
        "Worker (cheaper) model",
        "Model behind multivibe/coding-worker. It must support tools and should be materially cheaper than the parent.",
      ),
      workerReasoningEffort: {
        type: "string",
        title: "Worker reasoning effort",
        description:
          "Optional reasoning effort published for the worker model. Empty leaves the harness default untouched.",
      },
      taskTtlMinutes: {
        type: "integer",
        title: "Task correlation window (minutes)",
        description:
          "How long parent and worker activity may be grouped into one task when the harness does not send an explicit task id.",
        minimum: 1,
        maximum: 10_080,
      },
      delegationMarginPercent: {
        type: "integer",
        title: "Minimum predicted saving (%)",
        description:
          "Reporting threshold only. Delegations below this margin are flagged as uneconomic; MultiVibe never blocks or rewrites a request.",
        minimum: 0,
        maximum: 100,
      },
    },
  },
  virtualModels: CODING_ECONOMY_VIRTUAL_MODELS,
};

type CompletionTelemetry = {
  traceId?: string;
  traceKind?: string;
  model?: string;
  requestedModel?: string;
  status?: number;
  usageStatus?: string;
  costUsd?: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensInputCached?: number;
  tokensInputCacheWrite?: number;
};

/**
 * Records role-attributed usage for traffic that named one of this module's
 * virtual models. `request.completed` is read-only telemetry: this hook
 * observes; it never changes a delivered response or a routed model.
 */
export function createCodingEconomy(): MultivibeModule {
  const completed: ModuleHook = async (value, context) => {
    if (!context.storage || context.internal) return { action: "continue" };
    const telemetry = value as CompletionTelemetry;
    if (telemetry.traceKind !== "upstream-attempt") return { action: "continue" };
    const role = codingRoleForRequestedModel(telemetry.requestedModel);
    if (!role) return { action: "continue" };
    const measured =
      telemetry.usageStatus === "measured" &&
      typeof telemetry.tokensInput === "number" &&
      typeof telemetry.tokensOutput === "number";
    const priced = measured && typeof telemetry.costUsd === "number";
    try {
      await context.storage.recordEvent({
        id: `coding:${telemetry.traceId ?? context.requestId}`,
        type: "coding.usage",
        data: {
          role,
          requestedModel: telemetry.requestedModel,
          resolvedModel: telemetry.model,
          status: telemetry.status,
          usageStatus: telemetry.usageStatus ?? "unknown",
          comparison:
            "Measured token counts at the resolved model's published rates. Not an invoice or trajectory comparison.",
        },
        metrics: {
          measured: Number(measured),
          priced: Number(priced),
          unknown: Number(!priced),
          ...(priced ? { costUsd: telemetry.costUsd! } : {}),
          ...(measured
            ? {
                inputTokens: telemetry.tokensInput!,
                cachedInputTokens: telemetry.tokensInputCached ?? 0,
                cacheWriteTokens: telemetry.tokensInputCacheWrite ?? 0,
                outputTokens: telemetry.tokensOutput!,
              }
            : {}),
          worker: Number(role === "worker"),
          parent: Number(role === "parent"),
        },
      });
    } catch {
      context.log.warn("Could not persist coding economy usage");
    }
    return { action: "continue" };
  };

  return { "request.completed": completed };
}
