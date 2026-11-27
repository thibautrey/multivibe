import assert from "node:assert/strict";
import test from "node:test";
import {
  isOffPeakAt,
  isValidTimeZone,
  normalizeClock,
  normalizeOffPeakSchedule,
  setOffPeakSchedule,
} from "./off-peak.js";

const at = (iso: string) => Date.parse(iso);

test("clock values are normalized and rejected when out of range", () => {
  assert.equal(normalizeClock("7:05"), "07:05");
  assert.equal(normalizeClock(" 22:00 "), "22:00");
  assert.equal(normalizeClock("24:00"), null);
  assert.equal(normalizeClock("10:60"), null);
  assert.equal(normalizeClock("1000"), null);
  assert.equal(normalizeClock(10), null);
});

test("schedule validation keeps the useful parts and rejects typos", () => {
  assert.deepEqual(normalizeOffPeakSchedule(undefined), {
    enabled: false,
    timezone: "UTC",
    days: {},
  });
  const valid = normalizeOffPeakSchedule({
    enabled: true,
    timezone: "Europe/Paris",
    days: {
      mon: [{ start: "22:00", end: "6:00" }, { start: "9:00", end: "12:00" }],
      sunday: [{ start: "10:00", end: "11:00" }],
    },
  });
  assert.deepEqual(valid, {
    enabled: true,
    timezone: "Europe/Paris",
    days: {
      mon: [{ start: "22:00", end: "06:00" }, { start: "09:00", end: "12:00" }],
    },
  });
  assert.equal(normalizeOffPeakSchedule({ timezone: "Mars/Olympus" }), null);
  assert.equal(normalizeOffPeakSchedule({ days: { mon: [{ start: "10:00", end: "10:00" }] } }), null);
  assert.equal(normalizeOffPeakSchedule({ days: { mon: [{ start: "10:00" }] } }), null);
  assert.equal(normalizeOffPeakSchedule({ days: { mon: "10:00-11:00" } }), null);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Not/AZone"), false);
});

test("a weekday range is matched in the schedule timezone", () => {
  setOffPeakSchedule({
    enabled: true,
    timezone: "UTC",
    days: { mon: [{ start: "09:00", end: "12:00" }] },
  });
  try {
    assert.equal(isOffPeakAt(at("2026-11-30T08:59:00Z")), false);
    assert.equal(isOffPeakAt(at("2026-11-30T09:00:00Z")), true);
    assert.equal(isOffPeakAt(at("2026-11-30T11:59:00Z")), true);
    assert.equal(isOffPeakAt(at("2026-11-30T12:00:00Z")), false);
    // Same clock time, another weekday.
    assert.equal(isOffPeakAt(at("2026-12-01T10:00:00Z")), false);
  } finally {
    setOffPeakSchedule(undefined);
  }
});

test("a wrapping range continues into the next morning", () => {
  setOffPeakSchedule({
    enabled: true,
    timezone: "UTC",
    days: { fri: [{ start: "22:00", end: "06:00" }] },
  });
  try {
    assert.equal(isOffPeakAt(at("2026-12-04T21:59:00Z")), false);
    assert.equal(isOffPeakAt(at("2026-12-04T22:00:00Z")), true);
    assert.equal(isOffPeakAt(at("2026-12-04T23:59:00Z")), true);
    assert.equal(isOffPeakAt(at("2026-12-05T05:59:00Z")), true);
    assert.equal(isOffPeakAt(at("2026-12-05T06:00:00Z")), false);
    // Only Friday's range wraps: Thursday night is not covered.
    assert.equal(isOffPeakAt(at("2026-12-03T23:00:00Z")), false);
  } finally {
    setOffPeakSchedule(undefined);
  }
});

test("timezone rules follow daylight saving and several ranges per day", () => {
  setOffPeakSchedule({
    enabled: true,
    timezone: "Europe/Paris",
    days: {
      mon: [{ start: "09:00", end: "10:00" }, { start: "14:00", end: "15:00" }],
    },
  });
  try {
    // 07:30Z is 09:30 in Paris summer time, 08:30 in winter time.
    assert.equal(isOffPeakAt(at("2026-07-06T07:30:00Z")), true);
    assert.equal(isOffPeakAt(at("2026-12-07T07:30:00Z")), false);
    assert.equal(isOffPeakAt(at("2026-12-07T08:30:00Z")), true);
    assert.equal(isOffPeakAt(at("2026-07-06T12:30:00Z")), true);
    assert.equal(isOffPeakAt(at("2026-07-06T13:30:00Z")), false);
  } finally {
    setOffPeakSchedule(undefined);
  }
});

test("a disabled or empty schedule never matches", () => {
  setOffPeakSchedule({
    enabled: false,
    timezone: "UTC",
    days: { mon: [{ start: "00:00", end: "23:59" }] },
  });
  assert.equal(isOffPeakAt(at("2026-11-30T10:00:00Z")), false);
  setOffPeakSchedule({ enabled: true, timezone: "UTC", days: {} });
  assert.equal(isOffPeakAt(at("2026-11-30T10:00:00Z")), false);
  setOffPeakSchedule(undefined);
  assert.equal(isOffPeakAt(at("2026-11-30T10:00:00Z")), false);
});
