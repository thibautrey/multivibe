import React from "react";

type Props = {
  widgetId?: string;
  required?: boolean;
  title: string;
  value: string;
  loading?: boolean;
  detail?: string;
  action?: { href: string; label: string };
  onClick?: () => void;
  ariaLabel?: string;
  tone?: "default" | "success" | "warning" | "danger";
};

export function Metric({ title, value, detail, action, onClick, ariaLabel, loading = false, tone = "default" }: Props) {
  const interactive = Boolean(onClick) && !loading;

  return (
    <div
      className={`panel metric metric-${loading ? "default" : tone}${interactive ? " metric-interactive" : ""}`}
      aria-busy={loading}
      aria-label={interactive ? ariaLabel ?? `Open ${title}` : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onClick : undefined}
      onKeyDown={interactive ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick?.();
        }
      } : undefined}
    >
      <div className="muted metric-title">{title}</div>
      <div className="value" aria-label={loading ? `Loading ${title}` : undefined}>
        {loading ? <span className="metric-skeleton metric-skeleton-value" aria-hidden="true" /> : value}
      </div>
      {detail && <div className="metric-detail">
        {loading ? <span className="metric-skeleton metric-skeleton-detail" aria-hidden="true" /> : detail}
      </div>}
      {action && <a className="metric-action" href={action.href} target="_blank" rel="noopener noreferrer">
        {action.label} <span aria-hidden="true">↗</span>
      </a>}
    </div>
  );
}
