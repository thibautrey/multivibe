import { sdkProviderCatalog } from "../../src/ai-sdk/catalog";
import { buildTraceStats } from "../../src/traces";
import { aggregateProjectUsage } from "../../src/project-usage";
import { createDemoFixtures } from "./fixtures";

export const DEMO_READ_ONLY = "Demo instance is read-only. Provider connections, configuration changes, exports, and inference are unavailable.";

export function createDemoApi(now = Date.now()) {
  const fixtures = createDemoFixtures(now);
  const json = (body: unknown, status = 200) => ({ status, body });
  return (method: string, input: string) => {
    const url = new URL(input, "http://demo.invalid");
    const path = url.pathname;
    // These POSTs normally run automatically. In the demo they only return fixtures.
    if (method === "POST" && path === "/admin/local-runtimes/discover") return json({ accounts: [] });
    if (method === "POST" && path === "/admin/usage/refresh-stale") return json({ accounts: fixtures.accounts });
    if (method !== "GET" && method !== "HEAD") return json({ error: DEMO_READ_ONLY }, 403);
    const reads: Record<string, unknown> = {
      "/admin/session": { authenticated: true },
      "/admin/provider-catalog": sdkProviderCatalog(),
      "/admin/accounts": { accounts: fixtures.accounts },
      "/admin/provider-agent/local-worker": { localWorker: null },
      "/admin/cloud": { status: "disconnected", topupUrl: "https://app.multivibe.cloud/billing" },
      "/admin/config": { hostApplication: false, usageCacheTtlMs: 86400000, oauthRedirectUri: "http://localhost:4173/auth/callback" },
      "/v1/models": { object: "list", data: fixtures.models },
      "/admin/model-aliases": { modelAliases: fixtures.aliases },
      "/admin/settings": { settings: { anonymousUsageSharingEnabled: false, defaultPassthroughAccountId: fixtures.accounts[0].id } },
      "/admin/proxy-api-keys": { proxyApiKeys: fixtures.apiKeys },
      "/admin/application-policies": { applicationPolicies: fixtures.apiKeys.map((key) => ({ application: key.application, fairnessWeight: key.application === "Documentation bot" ? 1 : 3, webhooks: [] })) },
      "/admin/modules": { modules: fixtures.modules, marketplace: fixtures.modules.map((module) => ({ ...module, submittedAt: new Date(now).toISOString() })) },
      "/admin/host-harnesses": { hostApplication: false, harnesses: [] },
      "/admin/quota-reset-forecast": { forecast: { score: 18, state: "low", horizonHours: 24 } },
      "/health": { status: "ok", demo: true },
    };
    if (Object.hasOwn(reads, path)) return json(reads[path]);
    if (path === "/admin/traces/export.zip") return json({ error: DEMO_READ_ONLY }, 403);
    if (path.startsWith("/admin/traces/")) {
      const trace = fixtures.traces.find((trace) => trace.id === decodeURIComponent(path.slice("/admin/traces/".length)));
      return trace ? json({ trace: { ...trace, hasRequestBody: true } }) : json({ error: "Unknown demo trace" }, 404);
    }
    if (["/admin/traces", "/admin/stats/traces", "/admin/stats/usage"].includes(path)) {
      const since = Number(url.searchParams.get("sinceMs") ?? "0");
      const until = Number(url.searchParams.get("untilMs") ?? now);
      const selected = fixtures.traces.filter((trace) => trace.at >= since && trace.at <= until);
      if (path === "/admin/stats/traces") return json({ stats: buildTraceStats(selected) });
      if (path === "/admin/stats/usage") return json({ byProject: aggregateProjectUsage(selected.filter((trace) => trace.traceKind === "client-request")) });
      const positiveInt = (value: string | null, fallback: number) => value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
      const pageSize = Math.min(100, positiveInt(url.searchParams.get("pageSize"), 100));
      const totalPages = Math.max(1, Math.ceil(selected.length / pageSize));
      const page = Math.min(totalPages, positiveInt(url.searchParams.get("page"), 1));
      return json({
        traces: selected.slice((page - 1) * pageSize, page * pageSize).map(({ requestBody, ...trace }) => ({ ...trace, hasRequestBody: Boolean(requestBody) })),
        pagination: { page, pageSize, total: selected.length, totalPages, hasPrev: page > 1, hasNext: page < totalPages },
      });
    }
    return json({ error: "This endpoint is not available in the demo instance." }, 404);
  };
}
