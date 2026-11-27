import React from "react";
import { clampPct } from "../lib/ui";
import { useT } from "../i18n";

export function ProgressStat({ label, value, count }: { label: string; value: number; count: number }) {
  const t = useT();
  const rounded = Math.round(value);
  return (
    <div className="progress-stat">
      <div className="progress-head">
        <span>{label}</span>
        <span>{rounded}%</span>
      </div>
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={rounded} aria-label={label}>
        <div className="progress-fill" style={{ width: `${clampPct(value)}%` }} />
      </div>
      <small>{count === 1 ? t("1 account included") : t("{count} accounts included", { count })}</small>
    </div>
  );
}
