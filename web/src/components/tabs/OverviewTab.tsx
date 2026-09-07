import React from "react";
import { Metric } from "../Metric";
import { WidgetGrid } from "../WidgetGrid";
import { ProgressStat } from "../ProgressStat";
import { HostHarnessCards } from "../../host/HostHarnessCarousel";
import { usd } from "../../lib/ui";
import { AvailableModels } from "../AvailableModels";
import type { ExposedModel, TraceStats } from "../../types";

type Props = {
  stats: { total: number; enabled: number; blocked: number };
  usageStats: { primaryAvg: number; secondaryAvg: number; primaryCount: number; secondaryCount: number };
  traceStats: TraceStats;
  models: ExposedModel[];
  openModelInDocs: (modelId: string) => void;
  navigate: (tab: "accounts" | "docs" | "tracing") => void;
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
  const isEverythingRunning = Boolean(stats.total && models.length && hasTraffic);

  const nextStepCard = (
    <section className="panel overview-next-step">
      <div>
        <span className="eyebrow">Next step</span>
        <h2>{!stats.total ? "Connect your first provider" : !models.length ? "Choose models to expose" : !hasTraffic ? "Send your first request" : "Everything is running"}</h2>
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
      <button className="btn overview-primary-action" onClick={() => navigate(!stats.total || !models.length ? "accounts" : !hasTraffic ? "docs" : "tracing")}>
        {!stats.total ? "Add a provider" : !models.length ? "Configure providers" : !hasTraffic ? "Test the API" : "View activity"}
      </button>
    </section>
  );

  return (
    <>
      <WidgetGrid storageKey="home" label="System summary">
        <Metric widgetId="system" required
          title="System"
          value={isReady ? "Ready" : "Setup"}
          detail={isReady ? "Providers and models are available" : "Connect a provider to get started"}
          tone={isReady ? "success" : "warning"}
        />
        <Metric widgetId="providers" title="Providers" value={`${stats.enabled}/${stats.total}`} detail="Enabled accounts" tone={stats.enabled > 0 ? "success" : "default"} />
        <Metric widgetId="requests" title="Requests" value={`${traceStats.totals.requests}`} detail="In the selected period" />
        <Metric widgetId="cost" title="Cost" value={usd(traceStats.totals.costUsd)} detail="Estimated provider cost" />
      </WidgetGrid>

      {isEverythingRunning && hostApplication ? (
        <div className="overview-running-layout">
          {nextStepCard}
          <HostHarnessCards onApiKeysChanged={onHarnessesChanged} />
        </div>
      ) : nextStepCard}

      <section className="overview-detail-grid">
        <div className="panel overview-usage-panel">
          <div className="section-split-header">
            <div>
              <h2>Provider capacity</h2>
              <small>Average quota remaining across connected accounts.</small>
            </div>
            <span className="badge">{usageStats.primaryCount + usageStats.secondaryCount} windows</span>
          </div>
          {usageStats.primaryCount > 0 && (
            <ProgressStat label="Next 5 hours" value={usageStats.primaryAvg} count={usageStats.primaryCount} />
          )}
          {usageStats.secondaryCount > 0 && (
            <ProgressStat label="This week" value={usageStats.secondaryAvg} count={usageStats.secondaryCount} />
          )}
        </div>

        <AvailableModels models={models} openModelInDocs={openModelInDocs} />
      </section>
    </>
  );
}
