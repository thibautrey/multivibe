import { formatLatency, formatTokenCount, usd } from "../lib/ui";
import type { ModuleAnalyticsValue } from "../types";

function display(value: ModuleAnalyticsValue): string {
  if (value.unit === "tokens") return formatTokenCount(value.value);
  if (value.unit === "ratio") return `${Math.round(value.value * 100)}%`;
  if (value.unit === "ms") return formatLatency(value.value);
  if (value.unit === "usd") return usd(value.value);
  return Math.round(value.value).toLocaleString();
}

function moduleLabel(id: string): string {
  return id.replace(/^multivibe\./, "").replace(/[._-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Renders only metrics declared by extensions through the module manifest. */
export function ExtensionImpact({ modules }: { modules?: Record<string, ModuleAnalyticsValue[]> }) {
  const groups = Object.entries(modules ?? {}).filter(([, metrics]) => metrics.length > 0);
  if (!groups.length) return null;
  return (
    <section className="panel trace-extension-panel" aria-label="Extension impact">
      <div className="section-split-header">
        <div>
          <h2>Extension impact</h2>
          <p className="muted">Metrics declared by extensions for the selected range.</p>
        </div>
        <span className="badge">{groups.length} extension{groups.length === 1 ? "" : "s"}</span>
      </div>
      <div className="trace-extension-groups">
        {groups.map(([moduleId, metrics]) => (
          <div className="trace-extension-group" key={moduleId}>
            <h3>{moduleLabel(moduleId)}</h3>
            <dl className="trace-compact-stats">
              {metrics.map((metric) => (
                <div key={metric.id} title={metric.description}>
                  <dt>{metric.label}</dt>
                  <dd>{display(metric)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}
