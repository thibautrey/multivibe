import React, { useEffect, useState } from "react";
import { Metric } from "../Metric";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { ProgressStat } from "../ProgressStat";
import { HostHarnessCards } from "../../host/HostHarnessCarousel";
import { AvailableModels } from "../AvailableModels";
import type { ActivityView, ExposedModel, TraceStats } from "../../types";

import { formatLatency, isMeasured } from "../../lib/ui";
import { activeLocale, useT } from "../../i18n";

const WELCOME_VIEW_COUNT_KEY = "multivibe.workspaceWelcome.viewCount";
const WELCOME_COMPACT_AFTER_VIEWS = 10;

type Props = {
  stats: { total: number; enabled: number; blocked: number };
  usageStats: { primaryAvg: number; secondaryAvg: number; primaryCount: number; secondaryCount: number };
  traceStats: TraceStats;
  traceStatsLoading: boolean;
  traceStatsLoaded: boolean;
  models: ExposedModel[];
  openModelInDocs: (modelId: string) => void;
  navigate: (tab: "accounts" | "docs" | "tracing" | "models", activityView?: ActivityView) => void;
  hostApplication: boolean;
  onHarnessesChanged: () => Promise<void>;
};

export function OverviewTab({
  stats,
  usageStats,
  traceStats,
  traceStatsLoading,
  traceStatsLoaded,
  models,
  openModelInDocs,
  navigate,
  hostApplication,
  onHarnessesChanged,
}: Props) {
  const t = useT();
  const [compactWelcome, setCompactWelcome] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      const storedCount = Number.parseInt(window.localStorage.getItem(WELCOME_VIEW_COUNT_KEY) ?? "0", 10);
      return Number.isFinite(storedCount) && storedCount >= WELCOME_COMPACT_AFTER_VIEWS;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      const storedCount = Number.parseInt(window.localStorage.getItem(WELCOME_VIEW_COUNT_KEY) ?? "0", 10);
      const nextCount = (Number.isFinite(storedCount) ? storedCount : 0) + 1;
      window.localStorage.setItem(WELCOME_VIEW_COUNT_KEY, String(nextCount));
      if (nextCount > WELCOME_COMPACT_AFTER_VIEWS) setCompactWelcome(true);
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  }, []);

  const isReady = stats.enabled > 0 && models.length > 0;
  const hasTraffic = traceStats.totals.requests > 0;
  const isEverythingRunning = isReady && hasTraffic && stats.blocked === 0;
  const showHostHarnesses = hostApplication && stats.total > 0 && models.length > 0;

  const nextStepCard = (
    <section className="panel overview-next-step">
      <div className="overview-next-step-copy">
        <span className="eyebrow">{t("Next step")}</span>
        <h2>{!stats.total ? t("Connect your first provider") : !models.length ? t("Choose models to expose") : !hasTraffic ? t("Send your first request") : stats.blocked ? t("Review your providers") : t("Everything is running")}</h2>
        <p className="muted">
          {!stats.total
            ? t("Add OpenAI, Mistral, Grok Build, OpenCode, or any OpenAI-compatible endpoint.")
            : !models.length
              ? t("Your provider is connected. Finish its model configuration before routing traffic.")
              : !hasTraffic
                ? t("Test an exposed model from the API workspace to validate the complete route.")
                : t("{requests} requests processed with {providers} providers requiring attention.", { requests: traceStats.totals.requests, providers: stats.blocked })}
        </p>
      </div>
      <button className="btn overview-primary-action" onClick={() => navigate(!stats.total || !models.length ? "accounts" : !hasTraffic ? "docs" : stats.blocked ? "accounts" : "tracing")}>
        {!stats.total ? t("Add a provider") : !models.length ? t("Configure providers") : !hasTraffic ? t("Test the API") : stats.blocked ? t("Review providers") : t("View activity")}
      </button>
    </section>
  );
  const hostHarnessCard = <HostHarnessCards onApiKeysChanged={onHarnessesChanged} />;

  return (
    <>
      <h1 className="sr-only">{t("Workspace overview")}</h1>
      <section className={`workspace-welcome${compactWelcome ? " workspace-welcome-compact" : ""}`}>
        <div><span className="welcome-status">{isEverythingRunning ? t("Ready for your next idea") : stats.blocked ? t("Some providers need attention") : isReady ? t("Your workspace is ready") : t("Let’s get you connected")}</span>
        <h2>{t("All your AI. One place to build.")}</h2><p>{t("Use your favorite models through one API. Bring a provider, explore what’s available, download models.")}</p>
        <div className="welcome-actions"><button className="welcome-secondary" onClick={() => navigate("docs")}>{t("Open playground")} ↗</button><button className="btn" onClick={() => navigate("models")}>{t("Explore models")} <span aria-hidden="true">→</span></button><button className="welcome-secondary" onClick={() => navigate("accounts")}>{t("Manage providers")} ↗</button></div></div>
        <div className="welcome-orbit" aria-hidden="true"><div className="orbit-ring orbit-one"/><div className="orbit-ring orbit-two"/><span className="orbit-node orbit-node-a">AI</span><span className="orbit-node orbit-node-b">⌘</span><span className="orbit-node orbit-node-c">✳</span><img src="/assets/brand/multivibe-app-icon.svg" alt="" /></div>
      </section>
      <div className="overview-metrics" aria-label={t("Workspace summary")}>
        <Metric title={t("Connected providers")} value={`${stats.enabled}`} detail={t("{total} total · {blocked} need attention", { total: stats.total, blocked: stats.blocked })} onClick={() => navigate("accounts")} />
        <Metric title={t("Available models")} value={`${models.length}`} detail={t("Ready to explore and use")} onClick={() => navigate("models")} />
        <Metric loading={traceStatsLoading} preserveValueWhileLoading={traceStatsLoaded} title={t("Requests")} value={traceStats.totals.requests.toLocaleString(activeLocale())} detail={t("In the activity date range")} onClick={() => navigate("tracing", "performance")} />
        <Metric loading={traceStatsLoading} preserveValueWhileLoading={traceStatsLoaded} title={t("Estimated cost")} value={isMeasured(traceStats.totals.costUsd) ? new Intl.NumberFormat(activeLocale(), { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(traceStats.totals.costUsd) : t("Unavailable")} detail={t("{priced}/{attempts} attempts priced · missing costs excluded", { priced: traceStats.totals.requestsWithCost, attempts: traceStats.totals.upstreamAttempts })} onClick={() => navigate("tracing", "usage")} />
      </div>

      {showHostHarnesses && !isEverythingRunning ? (
        <div className="overview-host-next-step-layout">
          {hostHarnessCard}
          {nextStepCard}
        </div>
      ) : (
        <>
          {!isEverythingRunning && nextStepCard}
          {showHostHarnesses && hostHarnessCard}
        </>
      )}

      <section className="overview-detail-grid">
        <div className="overview-insights">
        <section className="panel overview-activity-panel">
          <div className="section-split-header"><div><h2>{t("Request activity")}</h2><small>{t("Traffic in your selected activity date range")}</small></div><button className="btn ghost" onClick={() => navigate("tracing")}>{t("View activity")} ↗</button></div>
          {hasTraffic ? <><div className="activity-total">{traceStats.totals.requests.toLocaleString(activeLocale())} <small>{t("requests")}</small></div><div className="overview-chart" role="img" aria-label={t("{requests} requests, {errors} errors in the selected period", { requests: traceStats.totals.requests, errors: traceStats.totals.errors })}><ResponsiveContainer width="100%" height={160}><AreaChart data={traceStats.timeseries} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}><defs><linearGradient id="overview-traffic" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--primary)" stopOpacity={0.22}/><stop offset="100%" stopColor="var(--primary)" stopOpacity={0}/></linearGradient></defs><XAxis dataKey="at" tickFormatter={value => new Date(value).toLocaleDateString(activeLocale(), { month: "short", day: "numeric" })} minTickGap={50} axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} /><Tooltip contentStyle={{ background: "var(--panel)", borderColor: "var(--line)", borderRadius: 12 }} labelFormatter={value => new Date(Number(value)).toLocaleString(activeLocale())}/><Area type="monotone" dataKey="requests" stroke="var(--primary)" strokeWidth={2} fill="url(#overview-traffic)" isAnimationActive={false}/></AreaChart></ResponsiveContainer></div><div className="activity-footnote"><span>{traceStats.totals.errors.toLocaleString(activeLocale())} {t("errors")}</span><span>{t("{latency} avg. latency", { latency: formatLatency(traceStats.totals.latencyAvgMs) })}</span></div></> : <div className="overview-no-activity"><h3>{t("Your first request starts here")}</h3><p className="muted">{t("Once you use a connected model, you’ll see your traffic and performance here.")}</p><button className="btn secondary" onClick={() => navigate("docs")}>{t("Try a request")} →</button></div>}
        </section>
        <div className="panel overview-usage-panel">
          <div className="section-split-header">
            <div>
              <h2>{t("Provider capacity")}</h2>
              <small>{t("Average quota remaining across connected accounts.")}</small>
            </div>
            <span className="badge">{usageStats.primaryCount + usageStats.secondaryCount === 1 ? t("1 window") : t("{count} windows", { count: usageStats.primaryCount + usageStats.secondaryCount })}</span>
          </div>
          {usageStats.primaryCount + usageStats.secondaryCount === 0 && <p className="muted">{t("Quota information isn’t available for your connected providers yet.")}</p>}
          {usageStats.primaryCount > 0 && (
            <ProgressStat label={t("Next 5 hours")} value={usageStats.primaryAvg} count={usageStats.primaryCount} />
          )}
          {usageStats.secondaryCount > 0 && (
            <ProgressStat label={t("This week")} value={usageStats.secondaryAvg} count={usageStats.secondaryCount} />
          )}
        </div>

        </div>
        <AvailableModels models={models} openModelInDocs={openModelInDocs} />
      </section>
    </>
  );
}
