import React from "react";
import { Metric } from "../Metric";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { ProgressStat } from "../ProgressStat";
import { HostHarnessCards } from "../../host/HostHarnessCarousel";
import { AvailableModels } from "../AvailableModels";
import type { ActivityView, ExposedModel, TraceStats } from "../../types";

type Props = {
  stats: { total: number; enabled: number; blocked: number };
  usageStats: { primaryAvg: number; secondaryAvg: number; primaryCount: number; secondaryCount: number };
  traceStats: TraceStats;
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
  models,
  openModelInDocs,
  navigate,
  hostApplication,
  onHarnessesChanged,
}: Props) {
  const isReady = stats.enabled > 0 && models.length > 0;
  const hasTraffic = traceStats.totals.requests > 0;
  const isEverythingRunning = isReady && hasTraffic && stats.blocked === 0;
  const showHostHarnesses = hostApplication && stats.total > 0 && models.length > 0;

  const nextStepCard = (
    <section className="panel overview-next-step">
      <div className="overview-next-step-copy">
        <span className="eyebrow">Next step</span>
        <h2>{!stats.total ? "Connect your first provider" : !models.length ? "Choose models to expose" : !hasTraffic ? "Send your first request" : stats.blocked ? "Review your providers" : "Everything is running"}</h2>
        <p className="muted">
          {!stats.total
            ? "Add OpenAI, Mistral, Grok Build, OpenCode, or any OpenAI-compatible endpoint."
            : !models.length
              ? "Your provider is connected. Finish its model configuration before routing traffic."
              : !hasTraffic
                ? "Test an exposed model from the API workspace to validate the complete route."
                : `${traceStats.totals.requests} requests processed with ${stats.blocked} providers requiring attention.`}
        </p>
      </div>
      <button className="btn overview-primary-action" onClick={() => navigate(!stats.total || !models.length ? "accounts" : !hasTraffic ? "docs" : stats.blocked ? "accounts" : "tracing")}>
        {!stats.total ? "Add a provider" : !models.length ? "Configure providers" : !hasTraffic ? "Test the API" : stats.blocked ? "Review providers" : "View activity"}
      </button>
    </section>
  );
  const hostHarnessCard = <HostHarnessCards onApiKeysChanged={onHarnessesChanged} />;

  return (
    <>
      <h1 className="sr-only">Workspace overview</h1>
      <section className="workspace-welcome">
        <div><span className="welcome-status">{isEverythingRunning ? "Ready for your next idea" : stats.blocked ? "Some providers need attention" : isReady ? "Your workspace is ready" : "Let’s get you connected"}</span>
        <h2>All your AI. One place to build.</h2><p>Use your favorite models through one API. Bring a provider, explore what’s available, and make your first request.</p>
        <div className="welcome-actions"><button className="welcome-secondary" onClick={() => navigate("docs")}>Open playground ↗</button><button className="btn" onClick={() => navigate("models")}>Explore models <span aria-hidden="true">→</span></button><button className="welcome-secondary" onClick={() => navigate("accounts")}>Manage providers ↗</button></div></div>
        <div className="welcome-orbit" aria-hidden="true"><div className="orbit-ring orbit-one"/><div className="orbit-ring orbit-two"/><span className="orbit-node orbit-node-a">AI</span><span className="orbit-node orbit-node-b">⌘</span><span className="orbit-node orbit-node-c">✳</span><img src="/assets/brand/multivibe-app-icon.svg" alt="" /></div>
      </section>
      <div className="overview-metrics" aria-label="Workspace summary">
        <Metric title="Connected providers" value={`${stats.enabled}`} detail={`${stats.total} total · ${stats.blocked} need attention`} onClick={() => navigate("accounts")} />
        <Metric title="Available models" value={`${models.length}`} detail="Ready to explore and use" onClick={() => navigate("models")} />
        <Metric title="Requests" value={traceStats.totals.requests.toLocaleString()} detail="In the activity date range" onClick={() => navigate("tracing", "performance")} />
        <Metric title="Estimated cost" value={new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(traceStats.totals.costUsd)} detail="In the activity date range" onClick={() => navigate("tracing", "usage")} />
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
          <div className="section-split-header"><div><h2>Request activity</h2><small>Traffic in your selected activity date range</small></div><button className="btn ghost" onClick={() => navigate("tracing")}>View activity ↗</button></div>
          {hasTraffic ? <><div className="activity-total">{traceStats.totals.requests.toLocaleString()} <small>requests</small></div><div className="overview-chart" role="img" aria-label={`${traceStats.totals.requests} requests, ${traceStats.totals.errors} errors in the selected period`}><ResponsiveContainer width="100%" height={160}><AreaChart data={traceStats.timeseries} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}><defs><linearGradient id="overview-traffic" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--primary)" stopOpacity={0.22}/><stop offset="100%" stopColor="var(--primary)" stopOpacity={0}/></linearGradient></defs><XAxis dataKey="at" tickFormatter={value => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })} minTickGap={50} axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} /><Tooltip contentStyle={{ background: "var(--panel)", borderColor: "var(--line)", borderRadius: 12 }} labelFormatter={value => new Date(Number(value)).toLocaleString()}/><Area type="monotone" dataKey="requests" stroke="var(--primary)" strokeWidth={2} fill="url(#overview-traffic)" isAnimationActive={false}/></AreaChart></ResponsiveContainer></div><div className="activity-footnote"><span>{traceStats.totals.errors.toLocaleString()} errors</span><span>{Math.round(traceStats.totals.latencyAvgMs).toLocaleString()} ms avg. latency</span></div></> : <div className="overview-no-activity"><h3>Your first request starts here</h3><p className="muted">Once you use a connected model, you’ll see your traffic and performance here.</p><button className="btn secondary" onClick={() => navigate("docs")}>Try a request →</button></div>}
        </section>
        <div className="panel overview-usage-panel">
          <div className="section-split-header">
            <div>
              <h2>Provider capacity</h2>
              <small>Average quota remaining across connected accounts.</small>
            </div>
            <span className="badge">{usageStats.primaryCount + usageStats.secondaryCount} windows</span>
          </div>
          {usageStats.primaryCount + usageStats.secondaryCount === 0 && <p className="muted">Quota information isn’t available for your connected providers yet.</p>}
          {usageStats.primaryCount > 0 && (
            <ProgressStat label="Next 5 hours" value={usageStats.primaryAvg} count={usageStats.primaryCount} />
          )}
          {usageStats.secondaryCount > 0 && (
            <ProgressStat label="This week" value={usageStats.secondaryAvg} count={usageStats.secondaryCount} />
          )}
        </div>

        </div>
        <AvailableModels models={models} openModelInDocs={openModelInDocs} />
      </section>
    </>
  );
}
