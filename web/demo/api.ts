import { configuredInvoiceProviders } from "../../src/provider-invoices";
import { sdkProviderCatalog } from "../../src/ai-sdk/catalog";
import { buildTraceStats } from "../../src/traces";
import { aggregateProjectUsage } from "../../src/project-usage";
import { aggregateSessionUsage, sessionTurnsFor } from "../../src/session-usage";
import { createDemoFixtures } from "./fixtures";

export const DEMO_READ_ONLY = "Demo instance is read-only. Provider connections, configuration changes, exports, and inference are unavailable.";

export function createDemoApi(now = Date.now(), workspace: "personal" | "owner" | "admin" | "member" | "billing" = "personal", hostApplication = false) {
  const fixtures = createDemoFixtures(now);
  const json = (body: unknown, status = 200) => ({ status, body });
  return (method: string, input: string) => {
    const url = new URL(input, "http://demo.invalid");
    const path = url.pathname;
    // These POSTs normally run automatically. In the demo they only return fixtures.
    if (method === "POST" && path === "/admin/local-runtimes/discover") return json({ accounts: [] });
    if (method === "POST" && path === "/admin/usage/refresh-stale") return json({ accounts: fixtures.accounts });
    if (method !== "GET" && method !== "HEAD") return json({ error: DEMO_READ_ONLY }, 403);
    if (path === "/admin/invoices" && workspace === "member") return json({ error: "Billing access is unavailable for this workspace." }, 403);
    const accountModels = path.match(/^\/admin\/accounts\/([^/]+)\/models$/);
    if (accountModels) {
      const account = fixtures.accounts.find((entry: { id?: string }) => entry.id === decodeURIComponent(accountModels[1]));
      if (!account || account.provider !== "ai-sdk") return json({ error: "Provider account unavailable" }, 404);
      const provider = sdkProviderCatalog().providers.find((entry) => entry.id === account.sdkProvider);
      const selection: string[] = account.sdkModels ?? [];
      return json({
        object: "list",
        provider: account.sdkProvider ?? null,
        selection,
        discovered: false,
        live: null,
        catalog: null,
        data: (selection.length ? selection : (provider?.models ?? []).map((model) => model.id)).map((id: string) => ({
          id: `${account.sdkProvider}/${id}`,
          name: id,
          input_modalities: ["text"],
          output_modalities: ["text"],
        })),
      });
    }
    const reads: Record<string, unknown> = {
      "/admin/team/workspace": {state: workspace === "personal" ? "personal" : "team", role: workspace === "personal" ? null : workspace},
      "/admin/session": { authenticated: true },
      "/admin/provider-catalog": sdkProviderCatalog(),
      "/admin/accounts": { accounts: fixtures.accounts },
      "/admin/invoices": { providers: workspace === "member" ? [] : configuredInvoiceProviders(fixtures.accounts), cloudUnavailable: false },
      "/admin/provider-agent/local-worker": { localWorker: null },
      "/admin/cloud/models": { models: [{ id: "hf:demo/cloud-model", name: "Demo Cloud model", aliases: [], availability: "unknown", network: false }] },
      "/admin/cloud": { status: "disconnected", topupUrl: "https://app.multivibe.cloud/billing" },
      "/admin/config": { hostApplication, usageCacheTtlMs: 86400000, oauthRedirectUri: "http://localhost:4173/auth/callback" },
      "/v1/models": { object: "list", data: fixtures.models },
      "/admin/model-aliases": { modelAliases: fixtures.aliases },
      "/admin/settings": { settings: { anonymousUsageSharingEnabled: false, defaultPassthroughAccountId: fixtures.accounts[0].id } },
      "/admin/proxy-api-keys": { proxyApiKeys: fixtures.apiKeys },
      "/admin/application-policies": { applicationPolicies: fixtures.apiKeys.map((key) => ({ application: key.application, fairnessWeight: key.application === "Documentation bot" ? 1 : 3, webhooks: [] })) },
      "/admin/modules": { modules: fixtures.modules, marketplace: fixtures.modules.map((module) => ({ ...module, submittedAt: new Date(now).toISOString() })) },
      "/admin/host-harnesses": { hostApplication, harnesses: hostApplication ? [
        { id: "openai-codex", name: "Codex", category: "cli", detected: true, detectedBy: ["command:codex"], configured: true, managed: true, drifted: false, canInstall: true, repairable: false, canUninstall: true, projectTracking: "not-installed" },
        { id: "claude-code", name: "Claude Code", category: "cli", detected: true, detectedBy: ["command:claude"], configured: false, managed: false, drifted: false, canInstall: true, repairable: false, canUninstall: false },
        { id: "opencode", name: "OpenCode", category: "cli", detected: true, detectedBy: ["command:opencode"], configured: true, managed: true, drifted: true, canInstall: true, repairable: true, canUninstall: true },
      ] : [] },
      "/admin/quota-reset-forecast": { forecast: { score: 18, state: "low", horizonHours: 24 } },
      "/health": { status: "ok", demo: true },
    };
    if (hostApplication && path === "/admin/host-update") return json({
      schema_version: "multivibe-host-updater-state-v1", mode: "notify", channel: "stable", current_version: "0.2.0-demo", status: "current",
      last_checked_at: new Date(now).toISOString(), next_check_at: new Date(now + 3600000).toISOString(), available_version: null,
      available_critical: false, rollout_eligible: false, downloaded: false, download_requested: false, install_requested: false,
      last_installed_at: null, last_error_code: null, last_error: null, container_managed: false,
    });
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
    if (path === "/admin/stats/sessions" || path.startsWith("/admin/stats/sessions/")) {
      const since = Number(url.searchParams.get("sinceMs") ?? "0");
      const until = Number(url.searchParams.get("untilMs") ?? now);
      const selected = fixtures.traces.filter((trace) => trace.at >= since && trace.at <= until);
      if (path === "/admin/stats/sessions") {
        const { summary, sessions } = aggregateSessionUsage(selected);
        return json({
          ok: true,
          coverage: { totalAttempts: summary.totalAttempts, identifiedAttempts: summary.attempts, ratio: summary.coverage },
          summary,
          total: sessions.length,
          sessions: sessions.slice(0, 100),
        });
      }
      const suffix = path.slice("/admin/stats/sessions/".length);
      const key = decodeURIComponent(suffix.endsWith("/turns") ? suffix.slice(0, -"/turns".length) : suffix);
      const turns = sessionTurnsFor(selected, key);
      return turns.length ? json({ ok: true, sessionKey: key, turns }) : json({ error: "not found" }, 404);
    }
    return json({ error: "This endpoint is not available in the demo instance." }, 404);
  };
}
