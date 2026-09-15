import express from "express";
import { ModelBenchmarkError, type ModelBenchmarkClient } from "../../model-benchmarks.js";

function failure(res: express.Response, error: unknown) {
  const code = error instanceof ModelBenchmarkError ? error.code : "upstream_unavailable";
  const status = { invalid_request: 400, not_configured: 503, not_found: 404, rate_limited: 429, forbidden: 403, upstream_unavailable: 502 }[code];
  return res.status(status).json({ error: code });
}

export function modelBenchmarkRoutes(client: ModelBenchmarkClient) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader("cache-control", "private, max-age=300"); next(); });
  router.get("/sources", (_req, res) => res.json(client.sources()));
  router.get("/models", async (req, res) => {
    try { res.json(await client.model(String(req.query.model ?? ""))); } catch (error) { failure(res, error); }
  });
  router.get("/leaderboards", async (req, res) => {
    try { res.json(await client.leaderboard(String(req.query.dataset ?? ""), Number(req.query.limit ?? 100))); } catch (error) { failure(res, error); }
  });
  router.get("/artificial-analysis/models", async (req, res) => {
    try { res.json(await client.artificialAnalysisModels(Number(req.query.page ?? 1), String(req.query.access ?? "free") as "free" | "full")); } catch (error) { failure(res, error); }
  });
  router.get("/artificial-analysis/models/:slug", async (req, res) => {
    try { res.json(await client.artificialAnalysisModel(req.params.slug, String(req.query.prompt_type ?? "long"))); } catch (error) { failure(res, error); }
  });
  return router;
}
