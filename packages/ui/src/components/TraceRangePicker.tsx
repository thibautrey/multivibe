import { useState } from "react";
import type { TraceRange, TraceRangePreset } from "../types";
import { getRangeBounds, localDateValue } from "../lib/trace-range";
import { useT } from "../i18n";

export function TraceRangePicker({ range, onChange }: { range: TraceRange; onChange: (range: TraceRange) => void }) {
  const t = useT();
  const [custom, setCustom] = useState(typeof range === "object");
  const [startDate, setStartDate] = useState(() => typeof range === "object" ? range.startDate : localDateValue(new Date(getRangeBounds(range).sinceMs ?? Date.now())));
  const [endDate, setEndDate] = useState(() => typeof range === "object" ? range.endDate : localDateValue(new Date()));
  let error = "";
  try { getRangeBounds({ startDate, endDate }); } catch (cause) { error = (cause as Error).message; }

  return <>
    <label className="trace-range-field">
      <span className="sr-only">{t("Time range")}</span>
      <select aria-label={t("Trace time range")} value={custom ? "custom" : typeof range === "string" ? range : "custom"}
        onChange={(event) => {
          const value = event.target.value;
          setCustom(value === "custom");
          if (value !== "custom") onChange(value as TraceRangePreset);
        }}>
        <option value="24h">{t("Last 24 hours")}</option>
        <option value="7d">{t("Last 7 days")}</option>
        <option value="30d">{t("Last 30 days")}</option>
        <option value="all">{t("All time")}</option>
        <option value="custom">{t("Custom date range")}</option>
      </select>
    </label>
    {custom && <form className="trace-custom-range" onSubmit={(event) => {
      event.preventDefault();
      if (!error) onChange({ startDate, endDate });
    }}>
      <label className="trace-range-field"><span>{t("Start date")}</span>
        <input type="date" required value={startDate} max={endDate || undefined} onChange={(event) => setStartDate(event.target.value)} aria-describedby="trace-date-help" />
      </label>
      <label className="trace-range-field"><span>{t("End date")}</span>
        <input type="date" required value={endDate} min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} aria-describedby="trace-date-help" />
      </label>
      <button type="submit" className="btn secondary" disabled={!!error}>{t("Apply")}</button>
      <small id="trace-date-help" className="muted" aria-live="polite">{error || t("Includes both dates · local time")}</small>
    </form>}
  </>;
}
