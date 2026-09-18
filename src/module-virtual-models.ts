import type { RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import type { ModuleManager } from "./module-manager.js";
import type { ModuleServices } from "./module-sdk.js";
import type { ExposedModel } from "./model-catalog-types.js";
import { getSessionId } from "./responses/payloads.js";
import { extractCodexSessionId } from "./codex-projects.js";
import { inspectModuleConversation } from "./module-conversation.js";
import { AUTOMATIC_ROUTER_MODEL, AUTOMATIC_ROUTER_PLUGIN } from "./automatic-router-model.js";
import { resolveVirtualModels } from "./virtual-model-registry.js";

function activeRouter(manager?: ModuleManager) {
  return manager?.list?.().find((entry) => entry.id === AUTOMATIC_ROUTER_PLUGIN && entry.enabled && entry.loaded && entry.healthy && !entry.restartRequired);
}

/**
 * Merge after cached discovery: plugin enable/disable must be visible immediately.
 * Virtual models declared by bundled modules are appended from the same registry
 * that reconciles their managed routing aliases.
 */
export function withVirtualModels(models: ExposedModel[], manager?: ModuleManager): ExposedModel[] {
  const declared = new Set(
    resolveVirtualModels(manager).map((descriptor) => descriptor.id),
  );
  const physical = models.filter((model) => model.id !== AUTOMATIC_ROUTER_MODEL && !declared.has(model.id));
  const registry = resolveVirtualModels(manager, new Set(physical.map((model) => model.id)));
  const virtual: ExposedModel[] = registry
    .filter((descriptor) => descriptor.status === "ready" && descriptor.target)
    .map((descriptor) => {
      const target = physical.find((model) => model.id === descriptor.target);
      return {
        id: descriptor.id,
        object: "model" as const,
        created: 0,
        owned_by: "multivibe",
        metadata: {
          provider: "openai-compatible" as const,
          is_virtual: true,
          plugin_id: descriptor.moduleId,
          catalog_source: "plugin",
          context_window: target?.metadata.context_window ?? null,
          max_output_tokens: null,
          supports_tools: target?.metadata.supports_tools ?? false,
          supported_tool_types: target?.metadata.supported_tool_types ?? [],
          supports_reasoning: false,
          input_modalities: ["text"],
          alias_targets: [descriptor.target!],
        },
        codexModelInfo: {
          slug: descriptor.id,
          display_name: descriptor.id,
          description: descriptor.description ?? "Provided by MultiVibe Host.",
          visibility: "list",
          supported_in_api: true,
          base_instructions: "",
          supported_reasoning_levels: [],
          shell_type: "shell_command",
          priority: 100,
          support_verbosity: false,
          truncation_policy: { mode: "tokens", limit: target?.metadata.context_window ?? 10000 },
          experimental_supported_tools: [],
        },
      };
    });
  return [...virtual, ...withRouterEntry(physical, manager)];
}

function withRouterEntry(physical: ExposedModel[], manager?: ModuleManager): ExposedModel[] {
  const plugin = activeRouter(manager);
  if (!plugin) return physical;
  const targets = [plugin.settings.economyModel, plugin.settings.balancedModel, plugin.settings.advancedModel].map((id) => physical.find((model) => model.id === id));
  const supportsTools = targets.every((model) => model?.metadata.supports_tools);
  const windows = targets.map((model) => model?.metadata.context_window);
  const contextWindow = windows.every((value): value is number => typeof value === "number") ? Math.min(...windows) : null;
  return [...physical, {
    id: AUTOMATIC_ROUTER_MODEL, object: "model", created: 0, owned_by: "multivibe",
    metadata: { provider: "openai-compatible", is_virtual: true, plugin_id: AUTOMATIC_ROUTER_PLUGIN,
      catalog_source: "plugin", context_window: contextWindow, max_output_tokens: null,
      supports_tools: supportsTools, supported_tool_types: supportsTools ? ["function"] : [], supports_reasoning: false,
      input_modalities: ["text"] },
    codexModelInfo: { slug: AUTOMATIC_ROUTER_MODEL, display_name: "MultiVibe Auto Router",
      description: "Automatically select a configured model based on task difficulty.", visibility: "list", supported_in_api: true,
      base_instructions: "", supported_reasoning_levels: [], shell_type: "shell_command", priority: 100,
      support_verbosity: false, truncation_policy: { mode: "tokens", limit: contextWindow ?? 10000 }, experimental_supported_tools: [] },
  }];
}

/** Runs before admission/idempotent execution reaches a provider. */
export function createVirtualModelMiddleware(manager?: ModuleManager, services?: (application?: string) => ModuleServices): RequestHandler {
  return async (req, res, next) => {
    if (req.method !== "POST" || req.body?.model !== AUTOMATIC_ROUTER_MODEL || res.locals.multivibeRequestModulesHandled) return next();
    const fail = (status: number, code: string, message: string) => res.status(status).json({ error: { type: "invalid_request_error", code, message } });
    if (!activeRouter(manager)) return fail(404, "model_not_found", "multivibe/autorouter is unavailable: enable the Automatic model router plugin.");
    if (!/\/(chat\/completions|responses)$/.test(req.path)) return fail(400, "unsupported_router_endpoint", "multivibe/autorouter supports HTTP Chat Completions and Responses, including SSE.");
    if (req.header("x-multivibe-privacy") === "confidential_verified") return fail(400, "unsupported_router_privacy", "Use an explicit model for verified confidential inference.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort); res.once("close", abort);
    const application = typeof res.locals.proxyApplication === "string" ? res.locals.proxyApplication : undefined;
    const requestId = res.locals.multivibeRequestTraceContext?.clientRequestId ?? res.locals.multivibeClientRequestId ?? randomUUID();
    res.locals.multivibeClientRequestId = requestId;
    try {
      const sessionId = getSessionId(req) ?? extractCodexSessionId(req.headers);
      const result = await manager!.runHook("request.received", req.body, { requestId, sessionId, application,
        conversation: inspectModuleConversation(req.body, req.headers, sessionId), route: req.path,
        internal: Boolean(res.locals.multivibeModuleInternal), services: res.locals.multivibeModuleInternal ? undefined : services?.(application),
        transport: req.body.stream ? "sse" : "http", signal: controller.signal });
      if (result.response) {
        for (const [name, value] of Object.entries(result.response.headers ?? {})) res.setHeader(name, value);
        return res.status(result.response.status).send(result.response.body);
      }
      if (!result.value || typeof result.value.model !== "string" || result.value.model === AUTOMATIC_ROUTER_MODEL) return fail(503, "router_unavailable", "Automatic routing did not resolve a configured model.");
      req.body = result.value;
      delete req.payloadContextInspection;
      res.locals.multivibeRequestModulesHandled = true;
      return next();
    } catch {
      return fail(503, "router_unavailable", "Automatic routing is temporarily unavailable.");
    } finally { req.off("aborted", abort); res.off("close", abort); }
  };
}
