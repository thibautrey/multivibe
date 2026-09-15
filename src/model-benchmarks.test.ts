import assert from "node:assert/strict";
import { test } from "node:test";
import { createModelBenchmarkClient, ModelBenchmarkError, parseHuggingFaceModelResults } from "./model-benchmarks.js";

test("Hugging Face results preserve provenance instead of inventing a canonical score", () => {
  const observations = parseHuggingFaceModelResults("owner/model", { id: "owner/model", evalResults: [
    { verified: true, filename: ".eval_results/a.yaml", pullRequest: 12, data: { dataset: { id: "org/bench", task_id: "pass_at_1" }, value: 84.2, metric: "accuracy", date: "2026-09-01", source: { name: "Independent", url: "https://huggingface.co/datasets/org/bench" } } },
    { verified: false, data: { dataset: { id: "org/bench", task_id: "pass_at_8" }, value: 91, source: { name: "Model Card", url: "https://huggingface.co/owner/model" } } },
  ] });
  assert.equal(observations.length, 2);
  assert.deepEqual(observations.map(row => [row.taskId, row.score, row.sourceType, row.verified]), [
    ["pass_at_1", 84.2, "independent", true], ["pass_at_8", 91, "provider", false],
  ]);
});

test("client uses only fixed upstream origins and validates identifiers", async () => {
  const calls: Array<{ url: string; key: string | null }> = [];
  const client = createModelBenchmarkClient({ artificialAnalysisApiKey: "secret", fetcher: (async (input, init) => {
    calls.push({ url: String(input), key: new Headers(init?.headers).get("x-api-key") });
    if (String(input).includes("artificialanalysis")) return new Response(JSON.stringify({ tier: "free", intelligence_index_version: 4.3, pagination: { page: 1 }, data: [] }), { headers: { "x-ratelimit-remaining": "99" } });
    if (String(input).includes("leaderboard")) return new Response(JSON.stringify([{ rank: 1, model_id: "owner/model", value: 2, verified: true }]));
    return new Response(JSON.stringify({ id: "owner/model", evalResults: [] }));
  }) as typeof fetch });
  await client.model("owner/model"); await client.leaderboard("org/bench", 1); await client.artificialAnalysisModels();
  assert.deepEqual(calls, [
    { url: "https://huggingface.co/api/models/owner/model?expand=evalResults", key: null },
    { url: "https://huggingface.co/api/datasets/org/bench/leaderboard", key: null },
    { url: "https://artificialanalysis.ai/api/v2/language/models/free?page=1", key: "secret" },
  ]);
  await assert.rejects(client.model("../metadata"), (error: unknown) => error instanceof ModelBenchmarkError && error.code === "invalid_request");
  await assert.rejects(client.leaderboard("https://evil.example/x"), (error: unknown) => error instanceof ModelBenchmarkError && error.code === "invalid_request");
});

test("Artificial Analysis remains an explicit optional source", async () => {
  const client = createModelBenchmarkClient();
  assert.equal(client.sources().sources[1].configured, false);
  await assert.rejects(client.artificialAnalysisModels(), (error: unknown) => error instanceof ModelBenchmarkError && error.code === "not_configured");
});

test("upstream payloads and errors fail closed", async () => {
  const malformed = createModelBenchmarkClient({ fetcher: (async () => new Response("{}")) as typeof fetch });
  await assert.rejects(malformed.model("owner/model"), (error: unknown) => error instanceof ModelBenchmarkError && error.code === "upstream_unavailable");
  const limited = createModelBenchmarkClient({ fetcher: (async () => new Response("{}", { status: 429 })) as typeof fetch });
  await assert.rejects(limited.model("owner/model"), (error: unknown) => error instanceof ModelBenchmarkError && error.code === "rate_limited");
});
