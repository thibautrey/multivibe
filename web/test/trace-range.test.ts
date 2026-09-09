import assert from "node:assert/strict";
import { test } from "node:test";
import { getRangeBounds } from "../src/lib/trace-range";

test("custom dates include the full final day", () => {
  assert.deepEqual(getRangeBounds({ startDate: "2026-09-01", endDate: "2026-09-09" }), {
    sinceMs: new Date(2026, 8, 1).getTime(),
    untilMs: new Date(2026, 8, 10).getTime() - 1,
  });
});
test("invalid, missing and reversed dates cannot become unbounded queries", () => {
  for (const [startDate, endDate] of [["", "2026-09-09"], ["2026-02-30", "2026-03-01"], ["2026-09-10", "2026-09-09"]]) {
    assert.throws(() => getRangeBounds({ startDate, endDate }));
  }
});
test("same-day ranges follow local calendar boundaries across DST", () => {
  for (const date of ["2026-03-29", "2026-10-25"]) {
    const start = new Date(`${date}T00:00:00`);
    const next = new Date(start);
    next.setDate(next.getDate() + 1);
    assert.deepEqual(getRangeBounds({ startDate: date, endDate: date }), { sinceMs: +start, untilMs: +next - 1 });
  }
});
test("presets retain rounded starts and all-time remains unbounded", () => {
  const now = Date.UTC(2026, 8, 9, 10, 35);
  for (const [range, days] of [["24h", 1], ["7d", 7], ["30d", 30]] as const) {
    assert.deepEqual(getRangeBounds(range, now), { sinceMs: Date.UTC(2026, 8, 9 - days, 10), untilMs: now });
  }
  assert.deepEqual(getRangeBounds("all", now), {});
});
