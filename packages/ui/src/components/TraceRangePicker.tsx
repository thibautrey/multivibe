import { useState } from "react";
import type { TraceRange, TraceRangePreset } from "../types";
import { getRangeBounds, localDateValue } from "../lib/trace-range";

export function TraceRangePicker({ range, onChange }: { range: TraceRange; onChange: (range: TraceRange) => void }) {
  const [custom, setCustom] = useState(typeof range === "object");
  const [startDate, setStartDate] = useState(() => typeof range === "object" ? range.startDate : localDateValue(new Date(getRangeBounds(range).sinceMs ?? Date.now())));
  const [endDate, setEndDate] = useState(() => typeof range === "object" ? range.endDate : localDateValue(new Date()));
  let error = "";
  try { getRangeBounds({ startDate, endDate }); } catch (cause) { error = (cause as Error).message; }

  return <>
    <label className="trace-range-field">
      <span className="sr-only">Time range</span>
      <select aria-label="Trace time range" value={custom ? "custom" : typeof range === "string" ? range : "custom"}
        onChange={(event) => {
          const value = event.target.value;
          setCustom(value === "custom");
          if (value !== "custom") onChange(value as TraceRangePreset);
        }}>
        <option value="24h">Last 24 hours</option>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
        <option value="all">All time</option>
        <option value="custom">Custom date range</option>
      </select>
    </label>
    {custom && <form className="trace-custom-range" onSubmit={(event) => {
      event.preventDefault();
      if (!error) onChange({ startDate, endDate });
    }}>
      <label className="trace-range-field"><span>Start date</span>
        <input type="date" required value={startDate} max={endDate || undefined} onChange={(event) => setStartDate(event.target.value)} aria-describedby="trace-date-help" />
      </label>
      <label className="trace-range-field"><span>End date</span>
        <input type="date" required value={endDate} min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} aria-describedby="trace-date-help" />
      </label>
      <button type="submit" className="btn secondary" disabled={!!error}>Apply</button>
      <small id="trace-date-help" className="muted" aria-live="polite">{error || "Includes both dates · local time"}</small>
    </form>}
  </>;
}
