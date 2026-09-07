import { estimateCostUsd, MODEL_PRICING_VERSION } from "../../src/model-pricing";
import type { TraceEntry } from "../../src/traces";
import type { Account, ExposedModel, ModelAlias, ModuleView, ProxyApiKey } from "../src/types";

const HOUR = 3_600_000;
const workloads = [
  { model: "gpt-5.3-codex", account: 0, application: "Codex", project: "Orbit dashboard" },
  { model: "gpt-5.4", account: 1, application: "Claude Code", project: "Atlas API" },
  { model: "gpt-5.4-mini", account: 0, application: "Documentation bot", project: "Developer docs" },
  { model: "mistral-small-latest", account: 2, application: "Support assistant", project: "Support portal" },
  { model: "qwen3-coder:30b", account: 3, application: "Local code review", project: "Orbit dashboard" },
];

/** Fictional fixtures only. The seed is fixed; timestamps follow the demo startup. */
export function createDemoFixtures(now = Date.now()) {
  let seed = 42;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const accounts: Account[] = [
    { id: "demo-openai-studio", provider: "openai", email: "studio@example.com", enabled: true, priority: 10, location: "cloud" },
    { id: "demo-openai-lab", provider: "openai", email: "research@example.com", enabled: true, priority: 5, location: "cloud" },
    { id: "demo-mistral", provider: "mistral", email: "support@example.com", enabled: true, location: "cloud" },
    {
      id: "demo-local", provider: "openai-compatible", email: "Local workstation", enabled: true, location: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      localRuntime: { source: "multivibe-local-discovery", adapter: "ollama", endpoint: "http://127.0.0.1:11434", confirmedModelIds: ["qwen3-coder:30b"], authentication: "none" },
      capacityProfile: { maxConcurrent: 2, decodeTokensPerSecond: 82, contextWindow: 131072 },
    },
  ].map((account, index) => ({
    ...account,
    usage: index < 2 ? {
      fetchedAt: now,
      primary: { usedPercent: [24, 41][index], resetAt: now + (index + 1) * HOUR },
      secondary: { usedPercent: [32, 58][index], resetAt: now + (index + 2) * 24 * HOUR },
    } : { fetchedAt: now, quotaStatus: "unsupported", quotaMessage: index === 3 ? "Local runtime — no subscription quota." : "API billing — quota windows are not exposed." },
    state: { lastSelectedAt: now - (index + 1) * 60_000, lastUsageRefreshAt: now },
  })) as Account[];

  const aliases: ModelAlias[] = [
    {
      schemaVersion: 2, id: "coding", enabled: true,
      description: "Route coding tasks to the primary model with a fast fallback.",
      defaults: { priority: "interactive", executionMode: "sync" },
      rules: [{ id: "primary", candidates: [{ model: "gpt-5.3-codex", provider: "openai" }, { model: "gpt-5.4-mini", provider: "openai" }], onNoCapacity: "queue" }],
    },
    {
      schemaVersion: 2, id: "local-first", enabled: true,
      description: "Prefer the workstation; use cloud capacity when it is busy.",
      rules: [
        { id: "local", candidates: [{ model: "qwen3-coder:30b", provider: "openai-compatible", location: "local" }], onNoCapacity: "next-rule" },
        { id: "cloud-fallback", candidates: [{ model: "gpt-5.4-mini", provider: "openai", location: "cloud" }], cloudBudget: { amountUsd: 5, period: "day" }, onNoCapacity: "queue" },
      ],
    },
    {
      schemaVersion: 2, id: "background", enabled: true,
      description: "Defer documentation and support jobs to available capacity.",
      defaults: { priority: "batch", executionMode: "defer" },
      rules: [{ id: "batch", candidates: [{ model: "mistral-small-latest", provider: "mistral" }], onNoCapacity: "queue" }],
    },
  ];
  const models: ExposedModel[] = [
    ...workloads.map(({ model, account }) => ({ id: model, owned_by: accounts[account].provider, metadata: { provider: accounts[account].provider } })),
    ...aliases.map((alias) => ({ id: alias.id, owned_by: "multivibe", metadata: { is_alias: true, alias_targets: alias.rules.flatMap((rule) => rule.candidates.map((candidate) => candidate.model)) } })),
  ];
  const apiKeys: ProxyApiKey[] = workloads.map((workload, index) => ({
    id: `demo-key-${index}`, application: workload.application, keyPreview: `demo-only-••••${1000 + index}`,
    source: "dashboard", createdAt: now - (index + 3) * 24 * HOUR,
  }));
  const modules: ModuleView[] = [{
    id: "security", origin: "bundled:security", commit: "demo-fixture", enabled: true, source: "bundled", loaded: true,
    healthy: true, removable: false, settings: {},
    manifest: { name: "Security", version: "1.0.0", description: "Reversible, session-scoped pseudonymization before prompt content leaves MultiVibe.", hooks: ["beforeRequest", "afterResponse"], categories: ["Security"], author: "MultiVibe" },
  }];

  const traces: TraceEntry[] = [];
  for (let hour = 14 * 24 - 1; hour >= 0; hour--) {
    const count = 8 + Math.floor(random() * 25);
    for (let index = 0; index < count; index++) {
      const workload = workloads[Math.floor(random() * workloads.length)];
      const account = accounts[workload.account];
      const at = now - hour * HOUR - Math.floor(random() * HOUR) - 60_000;
      const isError = random() < 0.012;
      const tokensInput = isError ? 0 : 1200 + Math.floor(random() * 6200);
      const tokensInputCached = Math.floor(tokensInput * (0.35 + random() * 0.45));
      const tokensOutput = isError ? 0 : 180 + Math.floor(random() * 1500);
      const ttftMs = 180 + Math.floor(random() * 900) + workload.account * 95;
      const latencyMs = isError ? 1200 : ttftMs + Math.round(tokensOutput / (55 + random() * 70) * 1000);
      const costUsd = account.location === "local" || isError ? 0 : estimateCostUsd(workload.model, tokensInput, tokensOutput, tokensInputCached);
      const id = `demo-request-${hour}-${index}`;
      const trace: TraceEntry = {
        id, clientRequestId: id, at, route: workload.account === 2 ? "/v1/chat/completions" : "/v1/responses",
        application: workload.application, projectId: workload.project.toLowerCase().replaceAll(" ", "-"), projectName: workload.project,
        accountId: account.id, accountEmail: account.email, provider: account.provider,
        model: workload.model, requestedModel: workload.model, resolvedModel: workload.model,
        status: isError ? 429 : 200, isError, stream: true, latencyMs, ttftMs: isError ? undefined : ttftMs,
        tokensInput, tokensInputCached, tokensOutput, tokensTotal: tokensInput + tokensOutput,
        costUsd, pricingVersion: MODEL_PRICING_VERSION, usageStatus: isError ? "missing" : "measured", costStatus: costUsd === undefined ? "unpriced" : "estimated",
        providerAttempts: 1, lifecycleState: "completed", startedAt: at - latencyMs, completedAt: at,
        error: isError ? "Demo: provider quota temporarily exceeded." : undefined,
        accountSelection: { reason: workload.account === 3 ? "policy-preferred" : "quota-headroom", provider: account.provider!, candidateCount: 4, eligibleCount: 4, nearLimitCount: 0, rotated: index % 5 === 0, selectedHeadroomPercent: 59 + Math.floor(random() * 30) },
        requestBody: { model: workload.model, input: "Review this fictional example and suggest a clearer implementation.", stream: true },
      };
      traces.push(
        { ...trace, traceKind: "client-request" },
        { ...trace, id: `${id}-attempt-1`, traceKind: "upstream-attempt", upstreamAttempt: 1 },
      );
    }
  }
  traces.sort((left, right) => right.at - left.at || left.id.localeCompare(right.id));
  return { now, accounts, models, aliases, apiKeys, modules, traces };
}

export type DemoFixtures = ReturnType<typeof createDemoFixtures>;
