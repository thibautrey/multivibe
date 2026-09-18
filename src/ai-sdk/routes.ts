import {googleUsageEligible} from "./google-usage.js";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import type { SdkModel } from "./model.js";
import type { Account } from "../types.js";
import { sdkAccountModels, sdkModelId } from "./catalog.js";
import { LiveModelCatalog } from "./live-model-catalog.js";
import type { LiveModelCatalogSource } from "./live-model-catalog.js";
import type { ModelsDevCatalog } from "./models-dev-catalog.js";
import { createSdkModel } from "./models.js";
import { SdkInputError, sdkCallOptions, chatResult, chatStream } from "./protocol.js";

function providerErrorMessage(error: unknown, status: number): string {
  if (!error || typeof error !== "object") return `Provider request failed (${status})`;
  const value = error as Record<string, unknown>;
  const candidates: unknown[] = [value.data, value.responseBody];
  for (const candidate of candidates) {
    let parsed = candidate;
    if (typeof candidate === "string") {
      try { parsed = JSON.parse(candidate); } catch { parsed = candidate; }
    }
    if (typeof parsed === "string" && parsed.trim()) return parsed.trim().slice(0, 500);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : undefined;
      const message = nested?.message ?? record.message;
      if (typeof message === "string" && message.trim()) return message.trim().slice(0, 500);
    }
  }
  return `Provider request failed (${status})`;
}

const CONTEXT_LENGTH_SIGNATURES = [
  // vLLM and OpenAI-compatible runtimes (Together, Fireworks, DeepInfra).
  "maximum context length",
  "reduce the length of the messages",
  // OpenAI.
  "context_length_exceeded",
  // Anthropic.
  "prompt is too long",
  // Ollama and llama.cpp local runtimes.
  "available context size",
  // Gateways and other providers.
  "context length exceeded",
  "context window exceeded",
  "too many tokens",
  "input is too long",
  "exceeds the maximum context",
];

const CONTENT_FILTER_SIGNATURES = [
  "content filter",
  "content_filter",
  "content policy",
  "content management policy",
  "responsible ai",
  "data_inspection_failed",
];

// A request that exceeded the model's context window is recoverable: agent
// clients compact or trim the conversation when they see this signal, so it
// must stay detectable instead of collapsing into a generic provider_error.
function isContextLengthError(status: number, message: string): boolean {
  // Only the statuses a runtime uses for an oversized request. A 429 is a rate
  // limit even when the body happens to mention context, and auth or not-found
  // errors must never be relabeled as an overflow.
  if (status !== 400 && status !== 413 && status !== 422) return false;
  const text = message.toLowerCase();
  return (
    CONTEXT_LENGTH_SIGNATURES.some((signature) => text.includes(signature)) ||
    (text.includes("input token count") && text.includes("exceed"))
  );
}

// Thinking-mode providers reject a turn whose assistant message lost the
// reasoning they produced. Only the client owns that history, so the failure is
// surfaced with a dedicated code instead of a provider-specific string.
function isReasoningContentRequiredError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    (text.includes("reasoning_content") && text.includes("passed back")) ||
    text.includes("reasoning_content is required") ||
    text.includes("missing reasoning_content") ||
    (text.includes("reasoning") && text.includes("thinking mode") && /required|missing/.test(text))
  );
}

function isContentFilterError(message: string): boolean {
  const text = message.toLowerCase();
  return CONTENT_FILTER_SIGNATURES.some((signature) => text.includes(signature)) || text.includes("flagged");
}

function isInsufficientQuotaError(status: number, message: string): boolean {
  const text = message.toLowerCase();
  return (
    status === 402 ||
    text.includes("insufficient_quota") ||
    text.includes("insufficient balance") ||
    text.includes("insufficient credit") ||
    text.includes("insufficient fund") ||
    text.includes("exceeded your current quota") ||
    (text.includes("quota") && /exceed|insufficient|reached|no available/.test(text))
  );
}

function isRateLimitError(status: number, message: string): boolean {
  if (status === 429) return true;
  const text = message.toLowerCase();
  return text.includes("rate limit") || text.includes("rate_limit_exceeded") || text.includes("too many requests");
}

function isModelNotFoundError(status: number, message: string): boolean {
  if (status !== 404) return false;
  const text = message.toLowerCase();
  return text.includes("model") || text.includes("does not exist");
}

/** Anthropic-independent, OpenAI-shaped error `type` for a bare status. */
function errorTypeForStatus(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The provider's own structured error object, when the transport exposes one. */
function providerErrorSource(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as Record<string, unknown>;
  for (const candidate of [value.data, value.responseBody]) {
    let parsed = candidate;
    if (typeof candidate === "string") {
      try { parsed = JSON.parse(candidate); } catch { continue; }
    }
    if (!parsed || typeof parsed !== "object") continue;
    const nested = (parsed as Record<string, unknown>).error;
    if (nested && typeof nested === "object") return nested as Record<string, unknown>;
    return parsed as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Normalize an adapter provider failure into the documented client contract.
 *
 * Every field the provider supplied is preserved; `message`, `type`, `param`
 * and `code` are then guaranteed to be present, and the classes that need a
 * stable machine-readable code (exhausted context, thinking-mode reasoning,
 * content filtering, quota, rate limits) are relabeled so a client can branch on
 * `code` instead of pattern-matching free text.
 */
export function normalizeProviderError(error: unknown, status: number): Record<string, unknown> {
  const message = providerErrorMessage(error, status);
  const envelope: Record<string, unknown> = { ...(providerErrorSource(error) ?? {}) };
  if (!nonEmptyString(envelope.message)) envelope.message = message;
  const text = String(envelope.message);

  let type: string | undefined;
  let code: string | undefined;
  if (isContextLengthError(status, text)) {
    type = "invalid_request_error";
    code = "context_length_exceeded";
  } else if (isReasoningContentRequiredError(text)) {
    type = "invalid_request_error";
    code = "reasoning_content_required";
  } else if (isContentFilterError(text)) {
    code = "content_filter";
  } else if (isInsufficientQuotaError(status, text)) {
    type = "rate_limit_error";
    code = "insufficient_quota";
  } else if (isRateLimitError(status, text)) {
    type = "rate_limit_error";
    if (!nonEmptyString(envelope.code)) code = "rate_limit_exceeded";
  } else if (isModelNotFoundError(status, text)) {
    code = "model_not_found";
  }
  if (!type && !nonEmptyString(envelope.type)) type = errorTypeForStatus(status);
  if (!code && !nonEmptyString(envelope.code)) code = status >= 500 ? "server_error" : "upstream_error";
  if (type) envelope.type = type;
  if (code) envelope.code = code;
  if (!("param" in envelope)) envelope.param = null;
  return envelope;
}

export function createSdkAdapterRouter(options: {
  store: { listAccounts(): Promise<Account[]> };
  internalToken: string;
  createModel?: (account: Account, model: string) => SdkModel;
  liveModelCatalog?: LiveModelCatalogSource;
  modelsDevCatalog?: ModelsDevCatalog;
}) {
  const router = express.Router();
  router.use((req, res, next) => {
    const token = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const received = Buffer.from(token), expected = Buffer.from(options.internalToken);
    if (!expected.length || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      res.status(401).json({ error: { message: "Unauthorized adapter request", type: "authentication_error" } }); return;
    }
    next();
  });
  router.use("/:accountId", async (req, res, next) => {
    try {
      const account = (await options.store.listAccounts()).find((account) => account.id === req.params.accountId);
      if (!account?.enabled || account.provider !== "ai-sdk") { res.status(404).json({ error: { message: "Provider account unavailable" } }); return; }
      res.locals.sdkAccount = account;
      next();
    } catch { res.status(500).json({ error: { message: "Could not load provider account" } }); }
  });
  const liveModelCatalog = options.liveModelCatalog ?? new LiveModelCatalog();
  router.get("/:accountId/v1/models", async (_req, res) => {
    const account = res.locals.sdkAccount as Account;
    let live;
    try {
      live = await liveModelCatalog.snapshot(account);
    } catch {
      // Discovery never blocks the catalog: a failed refresh falls back to the
      // reviewed snapshot instead of failing the listing.
      live = undefined;
    }
    try {
      await options.modelsDevCatalog?.ensure();
    } catch {
      // Runtime metadata is optional; the bundled snapshot stays authoritative.
    }
    res.json({object: "list", data: sdkAccountModels(account, live, options.modelsDevCatalog)});
  });
  router.post("/:accountId/v1/chat/completions", async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once("close", abort);
    req.once("aborted", abort);
    const timeout = setTimeout(abort, 180_000);
    try {
      const account = res.locals.sdkAccount as Account;
      if (typeof req.body?.model !== "string") throw new SdkInputError("model required");
      let modelId: string;
      try { modelId = sdkModelId(account, req.body.model); } catch {
        res.status(404).json({error: {message: "Model is not enabled for this provider account", type: "model_not_found"}}); return;
      }
      const params = sdkCallOptions(req.body, controller.signal);
      const model = (options.createModel ?? createSdkModel)(account, modelId);
      const validateUsage = account.sdkProvider === "google" ? googleUsageEligible : undefined;
      if (!req.body.stream) {
        res.json(chatResult(req.body.model, await model.doGenerate(params), validateUsage)); return;
      }
      // doStream awaits the upstream HTTP response. Authentication and quota
      // failures reach the routing layer before we commit streaming headers.
      const result = await model.doStream(params);
      res.status(200).set({"content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no"});
      // This route is MultiVibe's internal Edge adapter, not the provider's
      // public API. Usage is required for analytics even when the original
      // client did not opt into OpenAI stream_options; Edge owns what it
      // exposes downstream after protocol conversion.
      for await (const frame of chatStream(req.body.model, result.stream, true, validateUsage)) {
        if (controller.signal.aborted) break;
        if (!res.write(frame)) await new Promise<void>((resolve) => {
          const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
          res.once("drain", done); res.once("close", done);
        });
      }
      res.end();
    } catch (error: any) {
      if (res.destroyed) return;
      const status = error instanceof SdkInputError ? 400 : Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : controller.signal.aborted ? 504 : 502;
      const body = error instanceof SdkInputError
        ? {error: {message: error.message, type: "invalid_request_error", param: null, code: "invalid_request_error"}}
        : {error: normalizeProviderError(error, status)};
      if (res.headersSent) res.end(`data: ${JSON.stringify(body)}\n\n`);
      else res.status(status).json(body);
    } finally {
      clearTimeout(timeout); res.off("close", abort); req.off("aborted", abort);
    }
  });
  return router;
}
