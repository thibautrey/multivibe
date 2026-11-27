import type { OffPeakDay, OffPeakSchedule, OffPeakWindow } from "./types.js";

export const OFF_PEAK_DAYS: readonly OffPeakDay[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];

const DAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const CLOCK = /^(\d{1,2}):(\d{2})$/;
const MAX_WINDOWS_PER_DAY = 24;
const MAX_TIME_ZONES = 32;

const DISABLED: OffPeakSchedule = { enabled: false, timezone: "UTC", days: {} };

let schedule: OffPeakSchedule = DISABLED;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** `HH:MM` or `H:MM` → zero-padded `HH:MM`, or null when out of range. */
export function normalizeClock(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = CLOCK.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function isValidTimeZone(value: string): boolean {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate an operator schedule. Returns null when the payload is malformed so
 * the HTTP layer can reject it instead of silently pricing with a typo.
 */
export function normalizeOffPeakSchedule(input: unknown): OffPeakSchedule | null {
  if (input === undefined || input === null) return { enabled: false, timezone: "UTC", days: {} };
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const timezone = typeof raw.timezone === "string" && raw.timezone.trim()
    ? raw.timezone.trim()
    : "UTC";
  if (!isValidTimeZone(timezone)) return null;
  const rawDays = raw.days;
  if (rawDays !== undefined && rawDays !== null && (typeof rawDays !== "object" || Array.isArray(rawDays))) {
    return null;
  }
  const days: Partial<Record<OffPeakDay, OffPeakWindow[]>> = {};
  for (const day of OFF_PEAK_DAYS) {
    const entries = (rawDays as Record<string, unknown> | undefined)?.[day];
    if (entries === undefined || entries === null) continue;
    if (!Array.isArray(entries) || entries.length > MAX_WINDOWS_PER_DAY) return null;
    const windows: OffPeakWindow[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const start = normalizeClock((entry as Record<string, unknown>).start);
      const end = normalizeClock((entry as Record<string, unknown>).end);
      if (!start || !end || start === end) return null;
      windows.push({ start, end });
    }
    if (windows.length) days[day] = windows;
  }
  return { enabled: raw.enabled === true, timezone, days };
}

export function setOffPeakSchedule(next: OffPeakSchedule | undefined): void {
  schedule = normalizeOffPeakSchedule(next) ?? DISABLED;
}

export function getOffPeakSchedule(): OffPeakSchedule {
  return structuredClone(schedule);
}

function minutesOfDay(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached) return cached;
  if (formatters.size >= MAX_TIME_ZONES) formatters.clear();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  formatters.set(timezone, formatter);
  return formatter;
}

function localPosition(at: number, timezone: string): { day: number; minutes: number } | null {
  const parts = formatterFor(timezone).formatToParts(new Date(at));
  let weekday = "";
  let hour = NaN;
  let minute = NaN;
  for (const part of parts) {
    if (part.type === "weekday") weekday = part.value.toLowerCase().slice(0, 3);
    else if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
  }
  const day = DAY_INDEX[weekday];
  if (day === undefined || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { day, minutes: hour * 60 + minute };
}

function dayName(index: number): OffPeakDay {
  return OFF_PEAK_DAYS[(index + 6) % 7];
}

/**
 * A schedule wraps when its end is before its start: the evening belongs to the
 * declared day and the morning to the following day.
 */
export function isOffPeakAt(at: number | Date = Date.now()): boolean {
  if (!schedule.enabled) return false;
  const days = Object.keys(schedule.days).length;
  if (!days) return false;
  const instant = at instanceof Date ? at.getTime() : at;
  if (!Number.isFinite(instant)) return false;
  const position = localPosition(instant, schedule.timezone);
  if (!position) return false;
  const today = dayName(position.day);
  const yesterday = dayName((position.day + 6) % 7);
  for (const window of schedule.days[today] ?? []) {
    const start = minutesOfDay(window.start);
    const end = minutesOfDay(window.end);
    if (start < end) {
      if (position.minutes >= start && position.minutes < end) return true;
    } else if (position.minutes >= start) {
      return true;
    }
  }
  for (const window of schedule.days[yesterday] ?? []) {
    const start = minutesOfDay(window.start);
    const end = minutesOfDay(window.end);
    if (start > end && position.minutes < end) return true;
  }
  return false;
}
