import { TraceRangePicker } from "../TraceRangePicker";
import React, { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { TTFT_BUCKET_ORDER, TTFT_CONTEXT_LABELS, fmt, formatLatency, metricCount, formatTokenCount, formatTokenRate, maskEmail, maskId, pct, routeLabel, usd } from "../../lib/ui";
import type { TtftBucket } from "../../lib/ui";
import { activeLocale, useT } from "../../i18n";
import { HostHarnessCards } from "../../host/HostHarnessCarousel";
import {
  runtimeIdentityForAccount,
  runtimeIdentityForProvider,
} from "../../lib/runtimeCatalog";
import { ExtensionImpact } from "../ExtensionImpact";
import { Metric } from "../Metric";
import { TtftComparisonChart } from "../TtftComparisonChart";
import { WidgetGrid } from "../WidgetGrid";
import { TracingSessions } from "./TracingSessions";
import type { ActivityView, Account, ProjectUsageStats, ProxyApiKey, SessionTurn, SessionsResponse, StoreSettings, Trace, TracePagination, TraceRange, TraceStats } from "../../types";

type Props = {
  accounts: Account[];
  traceStats: TraceStats;
  traceStatsLoading: boolean;
  tokensTimeseries: Array<any>;
  modelChartData: Array<any>;
  modelCostChartData: Array<any>;
  tracePagination: TracePagination;
  gotoTracePage: (page: number) => Promise<void>;
  traceRange: TraceRange;
  setTraceRange: (range: TraceRange) => void;
  exportTracesZip: () => Promise<void>;
  traceExportInProgress: boolean;
  traces: Trace[];
  projectUsageStats: ProjectUsageStats;
  apiKeys: ProxyApiKey[];
  apiKeyFilter: string;
  setApiKeyFilter: (value: string) => void;
  sessionStats: SessionsResponse;
  sessionStatsLoading: boolean;
  expandedSessionKey: string | null;
  sessionTurns: SessionTurn[];
  sessionTurnsLoading: boolean;
  sessionTurnsTotal?: number;
  sessionTurnsOffset?: number;
  loadSessionTurnsPage?: (offset: number) => void;
  toggleSession: (sessionKey: string) => void;
  expandedTraceId: string | null;
  expandedTrace: Trace | null;
  expandedTraceLoading: boolean;
  toggleExpandedTrace: (id: string) => Promise<void>;
  sanitized: boolean;
  settings: StoreSettings;
  patchSettings: (body: Partial<StoreSettings>) => Promise<void>;
  activeView?: ActivityView;
  onActiveViewChange?: (view: ActivityView) => void;
};

function formatTtftDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value >= 10_000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}s`;
  return `${Math.round(value)}ms`;
}

export function TtftLatencyBoard({ traceStats }: { traceStats: TraceStats }) {
  const t = useT();
  const groups = traceStats.ttftByProviderModel;
  const activeBucket = groups.some((group) => group.inputTokenBucket === "1k-8k")
    ? "1k-8k"
    : TTFT_BUCKET_ORDER.find((bucket) => groups.some((group) => group.inputTokenBucket === bucket)) ?? "1k-8k";
  const [selectedBucket, setSelectedBucket] = useState<TtftBucket>(activeBucket);
  const selectedGroups = groups.filter((group) => group.inputTokenBucket === selectedBucket);
  const [chartView, setChartView] = useState<"range" | "line">("range");
  const chartRows = [...selectedGroups].sort((a, b) =>
    a.ttftP50Ms - b.ttftP50Ms || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  const scaleMax = Math.max(2_000, ...selectedGroups.map((group) => group.ttftP95Ms));
  const totalSamples = selectedGroups.reduce((sum, group) => sum + group.samples, 0);
  const fastest = selectedGroups.reduce((fastest, group) => Math.min(fastest, group.ttftP50Ms), Number.POSITIVE_INFINITY);
  const lowSamples = selectedGroups.filter((group) => group.confidence === "low").length;
  const bucketCounts = TTFT_BUCKET_ORDER.map((bucket) => ({
    bucket,
    label: TTFT_CONTEXT_LABELS[bucket],
    samples: groups.filter((group) => group.inputTokenBucket === bucket).reduce((sum, group) => sum + group.samples, 0),
  })).filter((entry) => entry.samples > 0);

  React.useEffect(() => {
    if (groups.length && !groups.some((group) => group.inputTokenBucket === selectedBucket)) {
      setSelectedBucket(activeBucket);
    }
  }, [activeBucket, groups, selectedBucket]);

  if (!groups.length) {
    return (
      <section className="panel ttft-board">
        <div className="section-split-header">
          <div>
            <h2>{t("Time to first token")}</h2>
          </div>
          <span className="badge">{t("No measurements")}</span>
        </div>
        <div className="ttft-empty">{t("No measured TTFT in this range yet.")}</div>
      </section>
    );
  }

  return (
    <section className="panel ttft-board">
      <div className="section-split-header">
        <div>
          <h2>{t("Time to first token")}</h2>
        </div>
        <div className="ttft-context-picker" role="tablist" aria-label={t("Input context range")}>
          {bucketCounts.map(({ bucket, label, samples }) => (
            <button
              key={bucket}
              type="button"
              role="tab"
              aria-selected={bucket === selectedBucket}
              className={`ttft-context-pill${bucket === selectedBucket ? " active" : ""}`}
              onClick={() => setSelectedBucket(bucket)}
            >
              <span>{label}</span>
              <small>{samples}</small>
            </button>
          ))}
        </div>
      </div>

      <div className="ttft-kpis" aria-label={t("Selected context summary")}>
        <div><small>{t("Models")}</small><strong>{new Set(selectedGroups.map((row) => `${row.provider}:${row.model}`)).size}</strong></div>
        <div><small>{t("Requests")}</small><strong>{totalSamples.toLocaleString(activeLocale())}</strong></div>
        <div><small>{t("Fastest p50")}</small><strong>{Number.isFinite(fastest) ? formatTtftDuration(fastest) : "—"}</strong></div>
        <div><small>{t("Scale")}</small><strong>0–{formatTtftDuration(scaleMax)}</strong></div>
        <div><small>{t("Low confidence")}</small><strong>{lowSamples}</strong></div>
      </div>

      <div className="ttft-chart-toolbar">
        <span className="muted">{chartView === "range" ? t("Range chart · Models ordered by p50") : t("Line chart · Models ordered by p50")}</span>
        <div className="ttft-view-switch" role="group" aria-label={t("TTFT chart view")}>
          <button type="button" className={`btn ghost icon-button${chartView === "range" ? " active" : ""}`}
            aria-label={t("Range chart")} title={t("Range chart")} aria-pressed={chartView === "range"} onClick={() => setChartView("range")}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M8 12h12M3 18h12M4 3v6M8 9v6M3 15v6M14 3v6M20 9v6M15 15v6" /></svg>
          </button>
          <button type="button" className={`btn ghost icon-button${chartView === "line" ? " active" : ""}`}
            aria-label={t("Line chart")} title={t("Line chart")} aria-pressed={chartView === "line"} onClick={() => setChartView("line")}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3v18h18M6 15l4-6 5 3 6-7" /></svg>
          </button>
        </div>
      </div>
      {chartRows.length ? (
        <TtftComparisonChart rows={chartRows} scaleMax={scaleMax} view={chartView} />
      ) : (
        <div className="ttft-empty">{t("No measured TTFT in {bucket} in this range yet.", { bucket: TTFT_CONTEXT_LABELS[selectedBucket] })}</div>
      )}

    </section>
  );
}

function TtftLatencyDetails({ traceStats }: { traceStats: TraceStats }) {
  const t = useT();
  return (
    <section className="panel ttft-details-panel">
      <details className="ttft-details">
        <summary>{t("Full TTFT metrics and rankings")}</summary>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>{t("Rank")}</th><th>{t("Provider")}</th><th>{t("Model")}</th><th>{t("Input bucket")}</th><th>{t("Samples")}</th><th>p50 TTFT</th><th>p95 TTFT</th><th>{t("Median input")}</th><th>{t("Cached input")}</th><th>{t("Confidence")}</th></tr>
            </thead>
            <tbody>
              {traceStats.ttftByProviderModel.map((group) => {
                const runtimeIdentity = runtimeIdentityForProvider(group.provider);
                return (
                  <tr key={`${group.provider}:${group.model}:${group.inputTokenBucket}`}>
                    <td>{group.rank ?? "—"}</td>
                    <td>
                      <span className="provider-badge">
                        <img className="provider-icon" src={runtimeIdentity.iconUrl} alt="" loading="lazy" />
                        {runtimeIdentity.label}
                      </span>
                    </td>
                    <td className="mono">{group.model}</td>
                    <td>{TTFT_CONTEXT_LABELS[group.inputTokenBucket as TtftBucket] ?? t("Unknown")}</td>
                    <td>{group.samples}</td>
                    <td>{formatTtftDuration(group.ttftP50Ms)}</td>
                    <td>{formatTtftDuration(group.ttftP95Ms)}</td>
                    <td>{group.medianInputTokens === undefined ? "—" : formatTokenCount(group.medianInputTokens)}</td>
                    <td>{group.cachedInputRatio === undefined ? "—" : pct(group.cachedInputRatio)}</td>
                    <td><span className={group.confidence === "low" ? "badge badge-warn" : "badge badge-live"}>{group.confidence === "low" ? t("Low") : t("Sufficient")}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

export function TracingTab(props: Props) {
  return <TracingTabContent {...props} />;
}

function TracingTabContent(props: Props) {
  const {
    accounts,
    traceStats,
    traceStatsLoading,
    tokensTimeseries,
    modelChartData,
    modelCostChartData,
    tracePagination,
    gotoTracePage,
    traceRange,
    setTraceRange,
    exportTracesZip,
    traceExportInProgress,
    traces,
    projectUsageStats,
    apiKeys,
    apiKeyFilter,
    setApiKeyFilter,
    sessionStats,
    sessionStatsLoading,
    expandedSessionKey,
    sessionTurns,
    sessionTurnsLoading,
    sessionTurnsTotal,
    sessionTurnsOffset,
    loadSessionTurnsPage,
    toggleSession,
    expandedTraceId,
    expandedTrace,
    expandedTraceLoading,
    toggleExpandedTrace,
    sanitized,
    settings,
    patchSettings,
  } = props;
  const t = useT();
  const accountRuntimeById = React.useMemo(
    () => new Map(accounts.map((account) => [account.id, runtimeIdentityForAccount(account)])),
    [accounts],
  );
  const [sharingBusy, setSharingBusy] = React.useState(false);
  const [sharingNotice, setSharingNotice] = React.useState<string | null>(null);

  const setAnonymousUsageSharing = async (enabled: boolean) => {
    setSharingBusy(true);
    setSharingNotice(null);
    try {
      await patchSettings({ anonymousUsageSharingEnabled: enabled });
      setSharingNotice(enabled ? t("Anonymous model demand sharing is enabled for future usage.") : t("Sharing stopped and unsent data was deleted."));
    } catch (error: any) {
      setSharingNotice(error?.message ?? String(error));
    } finally {
      setSharingBusy(false);
    }
  };

  const setCommunityBenchmarksSharing = async (enabled: boolean) => {
    setSharingBusy(true);
    setSharingNotice(null);
    try {
      await patchSettings({ communityBenchmarksSharingEnabled: enabled });
      setSharingNotice(enabled
        ? t("Community benchmarks sharing is enabled. The first report covers the next completed day.")
        : t("Community benchmarks sharing stopped and unsent data was deleted."));
    } catch (error: any) {
      setSharingNotice(error?.message ?? String(error));
    } finally {
      setSharingBusy(false);
    }
  };

  const formatTokenChartValue = (value: number | string | null | undefined) => formatTokenCount(value == null ? null : Number(value));

  const formatTooltipValue = (value: any) => formatTokenChartValue(value?.[0] ?? value);

  const formatPieTokenLabel = ({ value }: { value?: number }) => formatTokenChartValue(value);
  const chartColors = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
  ];
  const accountSelectionSummary = traceStats.accountSelection;
  const [localActiveView, setLocalActiveView] = React.useState<ActivityView>("overview");
  const activeView = props.activeView ?? localActiveView;
  const setActiveView = props.onActiveViewChange ?? setLocalActiveView;
  const requestCount = traceStats.totals.requests;
  const providerAttemptCount = traceStats.totals.upstreamAttempts;
  const errorCount = traceStats.totals.errors;
  const usageCoverage = providerAttemptCount > 0 ? traceStats.totals.requestsWithUsage / providerAttemptCount : 0;
  const pricingCoverage = providerAttemptCount > 0 ? traceStats.totals.requestsWithCost / providerAttemptCount : 0;
  const rangeLabel = typeof traceRange === "object"
    ? `${traceRange.startDate} – ${traceRange.endDate}`
    : traceRange === "24h"
    ? t("Last 24 hours")
    : traceRange === "7d"
      ? t("Last 7 days")
      : traceRange === "30d"
        ? t("Last 30 days")
        : t("All recorded time");
  const viewOptions = [
    { id: "overview" as const, label: t("Overview"), description: t("Health and routing") },
    { id: "performance" as const, label: t("Performance"), description: t("Latency and TTFT") },
    { id: "sessions" as const, label: t("Sessions"), description: t("Contexts and cache") },
    { id: "usage" as const, label: t("Usage & cost"), description: t("Tokens and projects") },
    { id: "requests" as const, label: t("Requests"), description: tracePagination.total === 1 ? t("1 trace") : t("{count} traces", { count: tracePagination.total ?? 0 }) },
  ];

  return (
    <>
      <section className="panel trace-workspace-header">
        <div className="trace-workspace-toolbar">
        <nav className="trace-view-tabs" role="tablist" aria-label={t("Tracing views")}>
          {viewOptions.map((view) => (
            <button
              key={view.id}
              type="button"
              role="tab"
              id={`trace-tab-${view.id}`}
              aria-selected={activeView === view.id}
              aria-controls={`trace-view-${view.id}`}
              className={`trace-view-tab${activeView === view.id ? " active" : ""}`}
              onClick={() => setActiveView(view.id)}
            >
              <strong>{view.label}</strong>
              <small>{view.description}</small>
            </button>
          ))}
        </nav>
        <div className="trace-workspace-controls">
          <div className="trace-range-controls">
            <label className="inline trace-key-filter" htmlFor="trace-api-key-filter">
              <span className="muted">{t("API key")}</span>
              <select
                id="trace-api-key-filter"
                value={apiKeyFilter}
                onChange={(event) => setApiKeyFilter(event.target.value)}
              >
                <option value="">{t("All keys")}</option>
                {apiKeys.map((key) => (
                  <option key={key.id} value={key.id}>
                    {key.application} · {key.keyPreview}
                    {key.source === "environment" ? " " + t("(env)") : ""}
                  </option>
                ))}
                {apiKeyFilter && !apiKeys.some((key) => key.id === apiKeyFilter) && (
                  <option value={apiKeyFilter}>{apiKeyFilter}</option>
                )}
              </select>
            </label>
            <TraceRangePicker range={traceRange} onChange={setTraceRange} />
            <button className="btn secondary trace-export-button" type="button" title={t("Export all recorded traces as a ZIP archive")} onClick={() => void exportTracesZip()} disabled={traceExportInProgress}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" /></svg>
              <span>{traceExportInProgress ? t("Exporting…") : t("Export all")}</span>
              <span className="trace-export-format">ZIP</span>
            </button>
          </div>
        </div>
        </div>
        <div className="trace-sharing-setting">
          <div className="trace-sharing-controls">
            <label className="inline" htmlFor="anonymous-usage-sharing-enabled">
              <input
                id="anonymous-usage-sharing-enabled"
                type="checkbox"
                checked={settings.anonymousUsageSharingEnabled !== false}
                disabled={sharingBusy}
                aria-describedby="trace-sharing-summary"
                onChange={(event) => void setAnonymousUsageSharing(event.target.checked)}
              />
              <span>{t("Share anonymous demand")}</span>
            </label>
            <label className="inline" htmlFor="community-benchmarks-sharing-enabled">
              <input
                id="community-benchmarks-sharing-enabled"
                type="checkbox"
                checked={settings.communityBenchmarksSharingEnabled === true}
                disabled={sharingBusy}
                aria-describedby="trace-sharing-summary"
                onChange={(event) => void setCommunityBenchmarksSharing(event.target.checked)}
              />
              <span>{t("Share community benchmarks")} <small className="muted">{t("(off by default)")}</small></span>
            </label>
          </div>
          <p id="trace-sharing-summary" className="muted">
            {t("Anonymous daily totals. No prompts or responses. Turning off deletes unsent data.")}
          </p>
          <details className="trace-sharing-details">
            <summary>{t("Privacy details")}</summary>
            <p id="anonymous-usage-sharing-description" className="muted">
              {t("MultiVibe shares only anonymous daily model usage totals—never your prompts, responses, or personal data.")}
            </p>
            <p id="community-benchmarks-description" className="muted">
              {t("Off by default. When enabled, MultiVibe reports one daily aggregate for this machine: the model IDs you ran locally, request and token counts, latency and time-to-first-token distributions, the context sizes you used, plus already-measured synthetic runtime benchmark results. It never includes prompts, responses, project or account names, host names, serial numbers or an installation identifier. Your machine is reduced to a public hardware profile before anything is stored, and results are published only in aggregate.")}
            </p>
          </details>
          <span className="muted trace-sharing-notice" role="status" aria-live="polite">{sharingNotice}</span>
        </div>
      </section>

      {activeView === "overview" && (
        <div id="trace-view-overview" role="tabpanel" aria-labelledby="trace-tab-overview" className="trace-view-content">
          <WidgetGrid storageKey="activity" label={t("Activity metrics")}>
            <Metric loading={traceStatsLoading} widgetId="client-requests" title={t("Client requests")} value={`${requestCount}`} detail={providerAttemptCount === 1 ? t("1 provider attempt · {range}", { range: rangeLabel }) : t("{count} provider attempts · {range}", { count: providerAttemptCount, range: rangeLabel })} />
            <Metric loading={traceStatsLoading} widgetId="client-error-rate" title={t("Client error rate")} value={pct(traceStats.totals.errorRate)} detail={errorCount === 1 ? t("1 final failure") : t("{count} final failures", { count: errorCount })} tone={traceStats.totals.errorRate > 0.05 ? "warning" : "default"} />
            <Metric loading={traceStatsLoading} widgetId="avg-latency" title={t("Avg latency")} value={formatLatency(traceStats.totals.latencyAvgMs)} detail={t("End-to-end response time")} />
            <Metric loading={traceStatsLoading} widgetId="total-cost" title={traceStats.totals.requestsWithCost < providerAttemptCount ? t("Recorded cost") : t("Total cost")} value={usd(traceStats.totals.costUsd)} detail={t("No-cache estimate: {estimate} · {priced}/{attempts} attempts priced · missing costs excluded", { estimate: usd(traceStats.totals.costUsdWithoutCache), priced: traceStats.totals.requestsWithCost, attempts: providerAttemptCount })} tone={traceStats.totals.unpricedRequests > 0 ? "warning" : "default"} />
          </WidgetGrid>

          <section className="grid trace-overview-grid">
            <section className="panel trace-quality-panel">
              <div className="section-split-header">
                <div>
                  <h2>{t("Data coverage")}</h2>
                </div>
                <span className={`badge ${requestCount > 0 && usageCoverage === 1 && pricingCoverage === 1 ? "badge-live" : "badge-warn"}`}>
                  {requestCount === 0 ? t("No data") : usageCoverage === 1 && pricingCoverage === 1 ? t("Complete") : t("Partial")}
                </span>
              </div>
              <div className="trace-coverage-list">
                <div className="trace-coverage-item">
                  <div><strong>{t("Token usage")}</strong><span>{t("{from} of {to} provider attempts", { from: traceStats.totals.requestsWithUsage, to: providerAttemptCount })}</span></div>
                  <strong>{pct(usageCoverage)}</strong>
                  <div className="trace-coverage-track"><span style={{ width: `${Math.min(100, usageCoverage * 100)}%` }} /></div>
                </div>
                <div className="trace-coverage-item">
                  <div><strong>{t("Cost pricing")}</strong><span>{t("{from} of {to} provider attempts", { from: traceStats.totals.requestsWithCost, to: providerAttemptCount })}</span></div>
                  <strong>{pct(pricingCoverage)}</strong>
                  <div className="trace-coverage-track"><span style={{ width: `${Math.min(100, pricingCoverage * 100)}%` }} /></div>
                </div>
              </div>
              <dl className="trace-compact-stats">
                <div><dt>{t("Input tokens")}</dt><dd>{formatTokenCount(traceStats.totals.tokensInput)}</dd></div>
                <div><dt>{t("Output tokens")}</dt><dd>{formatTokenCount(traceStats.totals.tokensOutput)}</dd></div>
                <div><dt>{t("Inference speed")}</dt><dd>{formatTokenRate(traceStats.totals.inferenceTokensPerSecond)}</dd></div>
                <div><dt>{t("Unpriced")}</dt><dd>{traceStats.totals.unpricedRequests}</dd></div>
              </dl>
            </section>

            <section className="panel trace-routing-panel">
              <div className="section-split-header">
                <div>
                  <h2>{t("Account routing")}</h2>
                  <p className="muted">{t("How the proxy selected and rotated accounts for this traffic.")}</p>
                </div>
                <span className="badge">{accountSelectionSummary.attempts === 1 ? t("1 attempt") : t("{count} attempts", { count: accountSelectionSummary.attempts })}</span>
              </div>
              <div className="trace-routing-summary">
                <div><span>{t("Account swaps")}</span><strong>{accountSelectionSummary.rotations}</strong><small>{t("Moved to another account")}</small></div>
                <div><span>{t("Sticky")}</span><strong>{accountSelectionSummary.reasonCounts.sticky}</strong><small>{t("Session affinity kept")}</small></div>
                <div><span>{t("Quota-led")}</span><strong>{accountSelectionSummary.reasonCounts["quota-headroom"]}</strong><small>{t("Selected by headroom")}</small></div>
                <div><span>{t("Avg headroom")}</span><strong>{typeof accountSelectionSummary.averageHeadroom === "number" ? `${Math.round(accountSelectionSummary.averageHeadroom)}%` : "—"}</strong><small>{t("Max near-limit: {count}", { count: accountSelectionSummary.maxNearLimit })}</small></div>
              </div>
              <div className="trace-routing-notes">
                <span>{t("Policy preferred")} <strong>{accountSelectionSummary.reasonCounts["policy-preferred"]}</strong></span>
                <span>{t("Quota headroom")} <strong>{accountSelectionSummary.reasonCounts["quota-headroom"]}</strong></span>
                <span>{t("Retried requests")} <strong>{metricCount(traceStats.totals.retriedRequests)}</strong></span>
                <span>{t("Recovered retries")} <strong>{metricCount(traceStats.totals.recoveredRequests)}</strong></span>
              </div>
            </section>
          </section>
          <ExtensionImpact modules={traceStats.moduleAnalytics} />
        </div>
      )}

      {activeView === "performance" && (
        <div id="trace-view-performance" role="tabpanel" aria-labelledby="trace-tab-performance" className="trace-view-content">
          <TtftLatencyBoard traceStats={traceStats} />
          <TtftLatencyDetails traceStats={traceStats} />

          <section className="grid cards2 trace-chart-grid">
            <section className="panel">
              <div className="section-split-header">
                <div><h2>{t("End-to-end latency")}</h2><p className="muted">{t("Median and tail response time by hour.")}</p></div>
                <span className="badge">p50 / p95</span>
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={tokensTimeseries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="label" minTickGap={24} />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line isAnimationActive={false} type="monotone" dataKey="latencyP50Ms" name="p50" stroke="var(--chart-3)" strokeWidth={2} dot={false} />
                    <Line isAnimationActive={false} type="monotone" dataKey="latencyP95Ms" name="p95" stroke="var(--danger)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="panel">
              <div className="section-split-header">
                <div><h2>{t("Inference speed")}</h2><p className="muted">{t("Output tokens divided by full request duration.")}</p></div>
                <span className="badge">{t("tokens / second")}</span>
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={tokensTimeseries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="label" minTickGap={24} />
                    <YAxis tickFormatter={formatTokenRate} />
                    <Tooltip formatter={(value: any) => formatTokenRate(Number(value) || 0)} />
                    <Legend />
                    <Line isAnimationActive={false} type="monotone" dataKey="inferenceTokensPerSecond" name={t("tokens/s")} stroke="var(--accent)" strokeWidth={2} dot={false} connectNulls={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="panel">
              <div className="section-split-header">
                <div><h2>{t("Error trend")}</h2><p className="muted">{t("Failures shown against total request volume.")}</p></div>
                <span className={`badge ${errorCount > 0 ? "badge-warn" : "badge-live"}`}>{errorCount === 1 ? t("1 error") : t("{count} errors", { count: errorCount })}</span>
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={tokensTimeseries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="label" minTickGap={24} />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line isAnimationActive={false} type="monotone" dataKey="errors" name={t("errors")} stroke="var(--danger)" strokeWidth={2} dot={false} />
                    <Line isAnimationActive={false} type="monotone" dataKey="requests" name={t("requests")} stroke="var(--chart-4)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="panel">
              <div className="section-split-header">
                <div><h2>{t("Token traffic")}</h2><p className="muted">{t("Input and generated volume by hour.")}</p></div>
                <span className="badge">{t("hourly")}</span>
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={tokensTimeseries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="label" minTickGap={24} />
                    <YAxis tickFormatter={formatTokenChartValue} />
                    <Tooltip formatter={formatTooltipValue} />
                    <Legend />
                    <Line isAnimationActive={false} type="monotone" dataKey="tokensInput" name={t("input")} stroke="var(--chart-1)" strokeWidth={2} dot={false} />
                    <Line isAnimationActive={false} type="monotone" dataKey="tokensOutput" name={t("output")} stroke="var(--chart-2)" strokeWidth={2} dot={false} />
                    <Line isAnimationActive={false} type="monotone" dataKey="tokensTotal" name={t("total")} stroke="var(--chart-3)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
          </section>
        </div>
      )}

      {activeView === "sessions" && (
        <div id="trace-view-sessions" role="tabpanel" aria-labelledby="trace-tab-sessions" className="trace-view-content">
          <TracingSessions
            sessionStats={sessionStats}
            sessionStatsLoading={sessionStatsLoading}
            expandedSessionKey={expandedSessionKey}
            sessionTurns={sessionTurns}
            sessionTurnsLoading={sessionTurnsLoading}
            sessionTurnsTotal={sessionTurnsTotal}
            sessionTurnsOffset={sessionTurnsOffset}
            loadSessionTurnsPage={loadSessionTurnsPage}
            toggleSession={toggleSession}
          />
        </div>
      )}

      {activeView === "usage" && (
        <div id="trace-view-usage" role="tabpanel" aria-labelledby="trace-tab-usage" className="trace-view-content">
          <WidgetGrid storageKey="activity-usage" label={t("Usage metrics")}>
            <Metric loading={traceStatsLoading} widgetId="input-tokens" title={t("Input tokens")} value={formatTokenCount(traceStats.totals.tokensInput)} detail={t("{measured}/{attempts} attempts measured", { measured: traceStats.totals.requestsWithUsage, attempts: providerAttemptCount })} tone={usageCoverage < 1 ? "warning" : "default"} />
            <Metric loading={traceStatsLoading} widgetId="output-tokens" title={t("Output tokens")} value={formatTokenCount(traceStats.totals.tokensOutput)} detail={t("Generated by providers")} />
            <Metric loading={traceStatsLoading} widgetId="total-cost" title={traceStats.totals.requestsWithCost < providerAttemptCount ? t("Recorded cost") : t("Total cost")} value={usd(traceStats.totals.costUsd)} detail={t("No-cache estimate: {estimate} · {priced}/{attempts} attempts priced · missing costs excluded", { estimate: usd(traceStats.totals.costUsdWithoutCache), priced: traceStats.totals.requestsWithCost, attempts: providerAttemptCount })} tone={pricingCoverage < 1 ? "warning" : "default"} />
            <Metric loading={traceStatsLoading} widgetId="inference-speed" title={t("Inference speed")} value={formatTokenRate(traceStats.totals.inferenceTokensPerSecond)} detail={traceStats.totals.inferenceRequests === 1 ? t("1 measurable request") : t("{count} measurable requests", { count: metricCount(traceStats.totals.inferenceRequests) })} />
          </WidgetGrid>

          <section className="grid cards2 trace-chart-grid">
            <section className="panel">
              <div className="section-split-header"><div><h2>{t("Cost over time")}</h2><p className="muted">{t("Hourly spend across all priced requests.")}</p></div><span className="badge">USD</span></div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={tokensTimeseries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="label" minTickGap={24} />
                    <YAxis />
                    <Tooltip formatter={(v: any) => usd(Number(v) || 0)} />
                    <Legend />
                    <Line isAnimationActive={false} type="monotone" dataKey="costUsd" name={t("cost usd")} stroke="var(--chart-3)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="panel">
              <div className="section-split-header"><div><h2>{t("Cost by model")}</h2><p className="muted">{t("Models ranked by estimated spend.")}</p></div><span className="badge">USD</span></div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={modelCostChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="label" interval={0} angle={-15} textAnchor="end" height={56} />
                    <YAxis />
                    <Tooltip formatter={(v: any) => usd(Number(v) || 0)} />
                    <Legend />
                    <Bar isAnimationActive={false} dataKey="costUsd" name={t("cost usd")} fill="var(--chart-3)" radius={[5, 5, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="panel">
              <div className="section-split-header"><div><h2>{t("Provider attempts by model")}</h2><p className="muted">{t("Which models handled the most upstream attempts.")}</p></div><span className="badge">{t("attempts")}</span></div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={modelChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="label" interval={0} angle={-15} textAnchor="end" height={56} />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar isAnimationActive={false} dataKey="count" name={t("attempts")} fill="var(--chart-1)" radius={[5, 5, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="panel">
              <div className="section-split-header"><div><h2>{t("Token share by model")}</h2><p className="muted">{t("How total token volume is distributed.")}</p></div><span className="badge">{t("tokens")}</span></div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie isAnimationActive={false} data={modelChartData} dataKey="tokensTotal" nameKey="label" outerRadius={90} label={formatPieTokenLabel}>
                      {modelChartData.map((entry, idx) => (
                        <Cell key={`${entry.label}-${idx}`} fill={chartColors[idx % chartColors.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value: any) => formatTokenChartValue(value)} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </section>
          </section>

          <HostHarnessCards />
          <section className="panel trace-apikey-panel">
            <div className="section-split-header">
              <div><h2>{t("Usage by API key")}</h2><p className="muted">{t("Consumption attributed to the key that authorized each request. Unattributed covers internal and keyless calls.")}</p></div>
              <span className="badge">{(projectUsageStats.byApiKey ?? []).length === 1 ? t("1 key") : t("{count} keys", { count: (projectUsageStats.byApiKey ?? []).length })}</span>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>{t("API key")}</th><th>{t("Attempts")}</th><th>{t("Attempt errors")}</th><th>{t("Input tokens")}</th><th>{t("Output tokens")}</th><th>{t("Total tokens")}</th><th>{t("Cost")}</th><th>{t("Avg latency")}</th><th>{t("p95 latency")}</th></tr>
                </thead>
                <tbody>
                  {(projectUsageStats.byApiKey ?? []).map((entry) => (
                    <tr key={entry.apiKeyId}>
                      <td>
                        <div className="mono">{entry.apiKeyId === "unattributed" ? t("Unattributed") : entry.application ?? entry.apiKeyId}</div>
                        <div className="muted mono">{entry.apiKeyId === "unattributed" ? t("internal or keyless") : entry.keyPreview ?? (sanitized ? maskId(entry.apiKeyId) : entry.apiKeyId)}</div>
                        <div className="muted">{t("{priced}/{requests} priced attempts", { priced: entry.requestsWithCost, requests: entry.requests })}</div>
                      </td>
                      <td>{entry.requests}</td><td>{entry.errors}</td><td>{formatTokenCount(entry.tokens.input)}</td><td>{formatTokenCount(entry.tokens.output)}</td><td>{formatTokenCount(entry.tokens.total)}</td><td>{usd(entry.costUsd)}</td><td>{formatLatency(entry.avgLatencyMs)}</td><td>{formatLatency(entry.latencyP95Ms)}</td>
                    </tr>
                  ))}
                  {!(projectUsageStats.byApiKey ?? []).length && <tr><td colSpan={9} className="muted">{t("No API-key-attributed usage in this range.")}</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel trace-project-panel">
            <div className="section-split-header">
              <div><h2>{t("Usage by project")}</h2><p className="muted">{t("Codex-attributed consumption with model-level details on demand.")}</p></div>
              <div className="project-attribution-actions">
                <span className="badge">{t("Codex session attribution")}</span>

              </div>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>{t("Project")}</th><th>{t("Attempts")}</th><th>{t("Attempt errors")}</th><th>{t("Input tokens")}</th><th>{t("Output tokens")}</th><th>{t("Total tokens")}</th><th>{t("Cost")}</th><th>{t("Avg latency")}</th><th>{t("p95 latency")}</th></tr>
                </thead>
                <tbody>
                  {projectUsageStats.byProject.map((project) => (
                    <React.Fragment key={project.projectId}>
                      <tr>
                        <td>
                          <div className="mono">{project.projectId === "unattributed" ? t("Unattributed") : sanitized ? "*" : project.projectName ?? project.projectId}</div>
                          {!sanitized && project.projectRemote && <div className="muted mono">{project.projectRemote}</div>}
                          <div className="muted">{t("{priced}/{requests} priced attempts", { priced: project.requestsWithCost, requests: project.requests })}</div>
                        </td>
                        <td>{project.requests}</td><td>{project.errors}</td><td>{formatTokenCount(project.tokens.input)}</td><td>{formatTokenCount(project.tokens.output)}</td><td>{formatTokenCount(project.tokens.total)}</td><td>{usd(project.costUsd)}</td><td>{formatLatency(project.avgLatencyMs)}</td><td>{formatLatency(project.latencyP95Ms)}</td>
                      </tr>
                      <tr className="project-model-details-row">
                        <td colSpan={9}>
                          <details>
                            <summary>{project.models.length === 1 ? t("1 model — usage and cost details") : t("{count} models — usage and cost details", { count: project.models.length })}</summary>
                            <div className="table-wrap project-model-table-wrap">
                              <table className="data-table project-model-table">
                                <thead><tr><th>{t("Model")}</th><th>{t("Attempts")}</th><th>{t("Attempt errors")}</th><th>{t("Input")}</th><th>{t("Cached input")}</th><th>{t("Output")}</th><th>{t("Total")}</th><th>{t("Cost")}</th><th>{t("Avg latency")}</th><th>p50</th><th>p95</th></tr></thead>
                                <tbody>
                                  {project.models.map((model) => (
                                    <tr key={model.model}>
                                      <td className="mono">{model.model}</td><td>{model.requests}</td><td>{model.errors}</td><td>{formatTokenCount(model.tokens.input)}</td><td>{formatTokenCount(model.tokens.cachedInput)}</td><td>{formatTokenCount(model.tokens.output)}</td><td>{formatTokenCount(model.tokens.total)}</td>
                                      <td>{usd(model.costUsd)}<div className="muted">{t("{priced}/{requests} priced attempts", { priced: model.requestsWithCost, requests: model.requests })}</div></td>
                                      <td>{formatLatency(model.avgLatencyMs)}</td><td>{formatLatency(model.latencyP50Ms)}</td><td>{formatLatency(model.latencyP95Ms)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </details>
                        </td>
                      </tr>
                    </React.Fragment>
                  ))}
                  {!projectUsageStats.byProject.length && <tr><td colSpan={9} className="muted">{t("No project-attributed usage in this range.")}</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {activeView === "requests" && (
        <div id="trace-view-requests" role="tabpanel" aria-labelledby="trace-tab-requests" className="trace-view-content">
          <section className="panel trace-request-panel">
            <div className="section-split-header trace-request-header">
              <div>
                <h2>{t("Recorded requests")}</h2>
                <p className="muted">{t("Newest first · select Inspect for the full trace.")}</p>
              </div>
              <div className="trace-pagination" aria-label={t("Trace pages")}>
                <button className="btn ghost" onClick={() => void gotoTracePage(tracePagination.page - 1)} disabled={!tracePagination.hasPrev} aria-label={t("Previous trace page")}>{t("Previous")}</button>
                <span><strong>{tracePagination.total}</strong> {tracePagination.total === 1 ? t("trace · Page {page} of {totalPages}", { page: tracePagination.page, totalPages: tracePagination.totalPages }) : t("traces · Page {page} of {totalPages}", { page: tracePagination.page, totalPages: tracePagination.totalPages })}</span>
                <button className="btn ghost" onClick={() => void gotoTracePage(tracePagination.page + 1)} disabled={!tracePagination.hasNext} aria-label={t("Next trace page")}>{t("Next")}</button>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data-table trace-request-table">
                <thead><tr><th>{t("Request")}</th><th>{t("Source")}</th><th>{t("Target")}</th><th>{t("Outcome")}</th><th>{t("Performance")}</th><th>{t("Usage")}</th><th><span className="sr-only">{t("Details")}</span></th></tr></thead>
                <tbody>
                  {traces.map((trace) => {
                    const isExpanded = expandedTraceId === trace.id;
                    const rowCost = trace.costUsd;
                    const provider = trace.provider ?? (trace.accountId ? accounts.find((account) => account.id === trace.accountId)?.provider : undefined);
                    const runtimeIdentity = trace.accountId
                      ? accountRuntimeById.get(trace.accountId)
                      : undefined;
                    const targetIdentity = runtimeIdentity ?? runtimeIdentityForProvider(provider);
                    const accountLabel = sanitized ? maskEmail(trace.accountEmail) || maskId(trace.accountId) : trace.accountEmail ?? trace.accountId ?? "—";
                    const modelLabel = trace.requestedModel && trace.resolvedModel ? `${trace.requestedModel} → ${trace.resolvedModel}` : (trace.model ?? "—");
                    const hasError = trace.isError || trace.status >= 400;
                    const traceKindLabel = trace.traceKind === "client-request"
                      ? ((trace.providerAttempts ?? 0) === 1
                        ? t("Client outcome · 1 provider attempt")
                        : t("Client outcome · {count} provider attempts", { count: trace.providerAttempts ?? 0 }))
                      : trace.traceKind === "upstream-attempt"
                        ? t("Provider attempt {index}", { index: trace.upstreamAttempt ?? "—" })
                        : trace.traceKind === "diagnostic"
                          ? t("Proxy diagnostic")
                          : t("Legacy trace");
                    return (
                      <React.Fragment key={trace.id}>
                        <tr className={`trace-row${hasError ? " trace-row-error" : ""}`}>
                          <td><div className="trace-cell-stack"><strong>{fmt(trace.at)}</strong><span className="mono">{routeLabel(trace.route)}</span><span className="muted">{traceKindLabel}</span></div></td>
                          <td><div className="trace-cell-stack"><strong className="mono">{trace.application ?? t("Unspecified app")}</strong><span className="mono">{trace.projectId ? sanitized ? t("Private project") : trace.projectName ?? trace.projectId : t("No project")}</span></div></td>
                          <td><div className="trace-cell-stack"><strong className="mono">{modelLabel}</strong><span className="trace-target-account">{(provider || runtimeIdentity) && <span className="provider-badge"><img className="provider-icon" src={targetIdentity.iconUrl} alt="" loading="lazy" />{targetIdentity.label}</span>}<span className="mono">{accountLabel}</span></span></div></td>
                          <td><div className="trace-cell-stack"><span><span className={`badge ${hasError ? "badge-warn" : "badge-live"}`}>{trace.status}</span></span><span className={hasError ? "trace-error-copy" : "muted"}>{trace.error?.slice(0, 72) ?? (hasError ? t("Request failed") : t("Completed"))}</span></div></td>
                          <td><div className="trace-cell-stack"><strong>{formatLatency(trace.latencyMs)} {t("total")}</strong><span>{typeof trace.ttftMs === "number" ? `${Math.round(trace.ttftMs)}ms TTFT` : t("TTFT not measured")}</span></div></td>
                          <td><div className="trace-cell-stack"><strong>{typeof (trace.tokensTotal ?? trace.usage?.total_tokens) === "number" ? formatTokenCount(trace.tokensTotal ?? trace.usage?.total_tokens) : "—"} {t("tokens")}</strong><span className="mono">{usd(rowCost)}</span></div></td>
                          <td><button type="button" className="trace-expand-button" onClick={() => void toggleExpandedTrace(trace.id)} aria-expanded={isExpanded}>{isExpanded ? t("Hide") : t("Inspect")}</button></td>
                        </tr>
                        {isExpanded && (
                          <tr className="trace-expanded-row">
                            <td colSpan={7}>
                              <div className="expanded-trace">
                                <div className="expanded-trace-heading"><div><span className="eyebrow">{t("Trace detail")}</span><strong className="mono">{trace.id}</strong></div><span className="badge">{t("Sanitized")}</span></div>
                                {expandedTraceLoading && <div className="muted trace-loading">{t("Loading trace details...")}</div>}
                                {!expandedTraceLoading && expandedTrace && expandedTrace.id === trace.id && (
                                  <>
                                    {expandedTrace.hasRequestBody && <details open><summary>{t("Request body")}</summary><pre className="mono pre">{JSON.stringify(expandedTrace.requestBody, null, 2)}</pre></details>}
                                    {expandedTrace.hasRequestHeaders && <details><summary>{t("Request headers (sanitized)")}</summary><pre className="mono pre">{JSON.stringify(expandedTrace.requestHeaders, null, 2)}</pre></details>}
                                    <details><summary>{t("Full trace object")}</summary><pre className="mono pre">{JSON.stringify(expandedTrace, null, 2)}</pre></details>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                  {!traces.length && <tr><td colSpan={7} className="trace-empty-state">{t("No traces recorded in this range.")}</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
