import express from "express";
import { ModelBenchmarkError } from "../../model-benchmarks.js";
import type { CachedModelBenchmarkClient } from "../../model-benchmark-cache.js";

function failure(res: express.Response, error: unknown) {
  const code = error instanceof ModelBenchmarkError ? error.code : "upstream_unavailable";
  const status = { invalid_request: 400, not_configured: 503, not_found: 404, rate_limited: 429, forbidden: 403, upstream_unavailable: 502 }[code];
  return res.status(status).json({ error: code });
}

export function modelBenchmarkRoutes(client: CachedModelBenchmarkClient) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader("cache-control", "private, max-age=300"); next(); });
  router.get("/sources", (_req, res) => res.json(client.sources()));
  router.get("/cache", async (_req, res) => res.json(await client.cacheInventory()));
  router.get("/cached-models", async (req, res) => {
    const source = String(req.query.source ?? "all");
    if (!["all", "hugging-face", "artificial-analysis"].includes(source)) return res.status(400).json({ error: "invalid_request" });
    res.json(await client.cachedModels(source as "all" | "hugging-face" | "artificial-analysis"));
  });
  router.get("/models", async (req, res) => {
    try { res.json(await client.model(String(req.query.model ?? ""), { refresh: req.query.refresh === "true" })); } catch (error) { failure(res, error); }
  });
  router.get("/leaderboards", async (req, res) => {
    try { res.json(await client.leaderboard(String(req.query.dataset ?? ""), Number(req.query.limit ?? 100), { refresh: req.query.refresh === "true" })); } catch (error) { failure(res, error); }
  });
  router.get("/artificial-analysis/models", async (req, res) => {
    try { res.json(await client.artificialAnalysisModels(Number(req.query.page ?? 1), String(req.query.access ?? "free") as "free" | "full", { refresh: req.query.refresh === "true" })); } catch (error) { failure(res, error); }
  });
  router.get("/artificial-analysis/models/:slug", async (req, res) => {
    try { res.json(await client.artificialAnalysisModel(req.params.slug, String(req.query.prompt_type ?? "long"), { refresh: req.query.refresh === "true" })); } catch (error) { failure(res, error); }
  });
  return router;
}
