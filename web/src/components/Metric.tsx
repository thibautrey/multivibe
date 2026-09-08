import React from "react";

type Props = {
  widgetId?: string;
  required?: boolean;
  title: string;
  value: string;
  loading?: boolean;
  detail?: string;
  tone?: "default" | "success" | "warning" | "danger";
};

export function Metric({ title, value, detail, loading = false, tone = "default" }: Props) {
  return (
    <div className={`panel metric metric-${loading ? "default" : tone}`} aria-busy={loading}>
      <div className="muted metric-title">{title}</div>
      <div className="value" aria-label={loading ? `Loading ${title}` : undefined}>
        {loading ? <span className="metric-skeleton metric-skeleton-value" aria-hidden="true" /> : value}
      </div>
      {detail && <div className="metric-detail">
        {loading ? <span className="metric-skeleton metric-skeleton-detail" aria-hidden="true" /> : detail}
      </div>}
    </div>
  );
}
