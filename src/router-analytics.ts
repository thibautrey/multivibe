import { estimateCostUsd, MODEL_PRICING_VERSION } from "./model-pricing.js";
import type { ModuleContext, ModuleHookResult } from "./module-sdk.js";

export async function recordRouterDecision(body: any, result: ModuleHookResult, context: ModuleContext, reason: string) {
  if (!context.storage || context.internal || typeof body?.model !== "string") return;
  const selected = result.action === "replace" ? (result.value as any)?.model : body.model;
  const decision = { requestedModel: body.model, selectedModel: selected, reason,
    mode: context.conversation?.mode ?? "unknown", phase: context.conversation?.phase ?? "unknown" };
  await context.storage.set(`decision:${context.requestId}`, decision, 86_400);
  await context.storage.recordEvent({ id: `decision:${context.requestId}`, type: "routing.decision", data: decision,
    metrics: { routed: Number(selected !== body.model), sticky: Number(reason === "sticky"), retained: Number(selected === body.model) } });
}

export async function recordRouterUsage(value: any, context: ModuleContext) {
  if (!context.storage || value?.traceKind !== "upstream-attempt") return;
  const decision = await context.storage.get(`decision:${context.requestId}`) as { requestedModel: string } | null;
  if (!decision) return;
  const measured = value.usageStatus === "measured" && typeof value.tokensInput === "number" && typeof value.tokensOutput === "number";
  const actual = measured ? estimateCostUsd(value.model, value.tokensInput, value.tokensOutput, value.tokensInputCached ?? 0, value.tokensInputCacheWrite ?? 0) : undefined;
  const baseline = measured ? estimateCostUsd(decision.requestedModel, value.tokensInput, value.tokensOutput, value.tokensInputCached ?? 0, value.tokensInputCacheWrite ?? 0) : undefined;
  const comparable = actual !== undefined && baseline !== undefined && value.status < 400;
  await context.storage.recordEvent({ id: `usage:${value.traceId}`, type: "routing.usage",
    data: { requestedModel: decision.requestedModel, actualModel: value.model, status: value.status, pricingVersion: MODEL_PRICING_VERSION,
      comparison: "Same observed token counts and cache usage at the requested model's published rates" },
    metrics: {
      measured: Number(measured), comparable: Number(comparable), unknown: Number(!comparable),
      ...(actual === undefined ? {} : { actualCostUsd: actual, ...(value.status >= 400 ? { failedAttemptCostUsd: actual } : {}) }),
      ...(comparable ? { baselineCostUsd: baseline!, grossSavingsUsd: baseline! - actual! } : {}),
      ...(measured ? { inputTokens: value.tokensInput, cachedInputTokens: value.tokensInputCached ?? 0, outputTokens: value.tokensOutput } : {}),
    } });
}
