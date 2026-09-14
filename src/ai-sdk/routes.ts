import {googleUsageEligible} from "./google-usage.js";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Account } from "../types.js";
import { sdkAccountModels, sdkModelId } from "./catalog.js";
import { LiveModelCatalog } from "./live-model-catalog.js";
import type { LiveModelCatalogSource } from "./live-model-catalog.js";
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

export function createSdkAdapterRouter(options: {
  store: { listAccounts(): Promise<Account[]> };
  internalToken: string;
  createModel?: (account: Account, model: string) => LanguageModelV4;
  liveModelCatalog?: LiveModelCatalogSource;
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
    res.json({object: "list", data: sdkAccountModels(account, live)});
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
      for await (const frame of chatStream(req.body.model, result.stream, req.body.stream_options?.include_usage === true, validateUsage)) {
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
      const body = {error: {message: error instanceof SdkInputError ? error.message : providerErrorMessage(error, status), type: status === 429 ? "rate_limit_error" : "provider_error"}};
      if (res.headersSent) res.end(`data: ${JSON.stringify(body)}\n\n`);
      else res.status(status).json(body);
    } finally {
      clearTimeout(timeout); res.off("close", abort); req.off("aborted", abort);
    }
  });
  return router;
}
