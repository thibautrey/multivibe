import type { TraceRange } from "../types";

export function localDateValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function getRangeBounds(range: TraceRange, now = Date.now()): { sinceMs?: number; untilMs?: number } {
  if (typeof range === "object") {
    const start = new Date(`${range.startDate}T00:00:00`);
    const end = new Date(`${range.endDate}T00:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(range.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(range.endDate)
      || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())
      || localDateValue(start) !== range.startDate || localDateValue(end) !== range.endDate || start > end) {
      throw new Error("Choose valid dates with the end date on or after the start date.");
    }
    // Calendar arithmetic preserves full local days across daylight-saving changes.
    end.setDate(end.getDate() + 1);
    return { sinceMs: start.getTime(), untilMs: end.getTime() - 1 };
  }
  const hours = range === "24h" ? 24 : range === "7d" ? 168 : range === "30d" ? 720 : undefined;
  return hours === undefined ? {} : {
    sinceMs: Math.floor((now - hours * 3_600_000) / 3_600_000) * 3_600_000,
    untilMs: now,
  };
}
