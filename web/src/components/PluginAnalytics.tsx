import { useEffect, useState } from "react";
import { api } from "../lib/api";

type Summary = { retention: number; types: Record<string, { count: number; metrics: Record<string, number> }> };
const money = (value: number) => `$${value.toFixed(6)}`;
export function PluginAnalytics({ pluginId }: { pluginId: string }) {
  const [summary, setSummary] = useState<Summary>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    api(`/admin/modules/${encodeURIComponent(pluginId)}/analytics`).then((value) => { if (active) { setSummary(value); setError(""); } })
      .catch(() => { if (active) setError("Could not load plugin analytics."); });
    return () => { active = false; };
  }, [pluginId, revision]);
  const usage = summary?.types["routing.usage"];
  const classifier = summary?.types["routing.classifier"];
  const decision = summary?.types["routing.decision"];
  return <section className="plugin-analytics" aria-label="Plugin analytics">
    <h4>Private data and analytics</h4>
    <p className="muted">This plugin has its own SQLite database. Data survives updates, disabling, and restarts. Installed plugins cannot access each other’s storage.</p>
    {error && <p role="alert">{error}</p>}
    {!summary && !error && <p>Loading analytics…</p>}
    {summary && <>
      {!Object.keys(summary.types).length ? <p>No events recorded yet.</p> : pluginId === "multivibe.automatic-router" ? <>
        <dl className="plugin-analytics-metrics">
          <div><dt>Routing decisions</dt><dd>{decision?.count ?? 0}</dd></div>
          <div><dt>Sticky model reuses</dt><dd>{decision?.metrics.sticky ?? 0}</dd></div>
          <div><dt>Classifier calls</dt><dd>{classifier?.metrics.calls ?? 0}</dd></div>
          <div><dt>Priced usage comparisons</dt><dd>{usage?.metrics.comparable ?? 0} / {usage?.count ?? 0}</dd></div>
          <div><dt>Estimated gross token-cost difference</dt><dd>{usage?.metrics.comparable ? money(usage.metrics.grossSavingsUsd ?? 0) : "Not available"}</dd></div>
          <div><dt>Known classifier cost</dt><dd>{classifier && classifier.count > (classifier.metrics.unknown ?? 0) ? money(classifier.metrics.costUsd ?? 0) : "Not available"}</dd></div>
          <div><dt>Estimated net difference (known costs)</dt><dd>{usage?.metrics.comparable ? money((usage.metrics.grossSavingsUsd ?? 0) - (classifier?.metrics.costUsd ?? 0) - (usage.metrics.failedAttemptCostUsd ?? 0)) : "Not available"}</dd></div>
          <div><dt>Classifier calls without pricing</dt><dd>{classifier?.metrics.unknown ?? 0}</dd></div>
        </dl>
        <p className="muted">Estimates compare the same measured tokens and cache usage at the baseline and actual model rates. For multivibe/autorouter, the baseline is the configured advanced model. They are not invoice savings. Missing usage/prices and unmeasured failed calls are excluded; classifier overhead and failed-attempt costs are deducted only when known. Negative differences indicate higher cost.</p>
      </> : <ul>{Object.entries(summary.types).map(([type, entry]) => <li key={type}>{type}: {entry.count} events</li>)}</ul>}
      <p className="muted">Rolling window of up to {summary.retention.toLocaleString()} events, not a lifetime total.</p>
    </>}
    <button className="btn ghost" type="button" onClick={() => setRevision((value) => value + 1)}>Refresh analytics</button>
  </section>;
}
