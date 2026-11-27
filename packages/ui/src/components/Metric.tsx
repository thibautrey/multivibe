import React from "react";
import { useT } from "../i18n";
import { FitText } from "./ui/FitText";

type Props = {
  widgetId?: string;
  required?: boolean;
  title: string;
  value: string;
  loading?: boolean;
  preserveValueWhileLoading?: boolean;
  detail?: string;
  action?: { href: string; label: string };
  onClick?: () => void;
  ariaLabel?: string;
  tone?: "default" | "success" | "warning" | "danger";
};

export function Metric({ title, value, detail, action, onClick, ariaLabel, loading = false, preserveValueWhileLoading = false, tone = "default" }: Props) {
  const t = useT();
  const refreshing = loading && preserveValueWhileLoading;
  const showSkeleton = loading && !preserveValueWhileLoading;
  const interactive = Boolean(onClick) && !showSkeleton;

  return (
    <div
      className={`panel metric metric-${showSkeleton ? "default" : tone}${interactive ? " metric-interactive" : ""}${refreshing ? " metric-refreshing" : ""}`}
      aria-busy={loading}
      aria-label={interactive ? ariaLabel ?? t("Open {title}", { title }) : undefined}
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
      <div className="metric-heading">
        <div className="muted metric-title">{title}</div>
        {refreshing && <span className="metric-updating" role="status">{t("Updating")}</span>}
      </div>
      <FitText className="value" aria-label={showSkeleton ? t("Loading {title}", { title }) : undefined}>
        {showSkeleton ? <span className="metric-skeleton metric-skeleton-value" aria-hidden="true" /> : value}
      </FitText>
      {detail && <div className="metric-detail">
        {showSkeleton ? <span className="metric-skeleton metric-skeleton-detail" aria-hidden="true" /> : detail}
      </div>}
      {action && <a className="metric-action" href={action.href} target="_blank" rel="noopener noreferrer">
        {action.label} <span aria-hidden="true">↗</span>
      </a>}
    </div>
  );
}
