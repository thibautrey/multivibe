import {
  MODULE_ANALYTICS_AGGREGATIONS,
  MODULE_ANALYTICS_UNITS,
  type ModuleAnalyticsAggregation,
  type ModuleAnalyticsMetric,
  type ModuleAnalyticsUnit,
} from "./module-sdk.js";

/** A validated manifest declaration paired with its owning module. */
export type ModuleAnalyticsDescriptor = { moduleId: string; metric: ModuleAnalyticsMetric };

export type ModuleAnalyticsValue = {
  id: string;
  label: string;
  description?: string;
  unit?: ModuleAnalyticsUnit;
  aggregation: ModuleAnalyticsAggregation;
  /** Sum/count/average over the dashboard's selected time range. */
  value: number;
  /** Number of traces that contributed to this metric. */
  samples: number;
};

export type ModuleAnalyticsResult = Record<string, ModuleAnalyticsValue[]>;

type Accumulator = { sum: number; count: number };

const PATH = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,5}$/;
const ID = /^[a-z][A-Za-z0-9_-]{1,62}$/;
const MAX_METRICS = 16;
const MAX_WHEN_KEYS = 8;

function validateWhen(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid analytics condition");
  const entries = Object.entries(value);
  if (entries.length > MAX_WHEN_KEYS) throw new Error("Too many analytics conditions");
  const clean: Record<string, unknown> = {};
  for (const [key, expected] of entries) {
    if (!PATH.test(key)) throw new Error("Invalid analytics condition path");
    if (Array.isArray(expected)) {
      if (expected.length > 16 || expected.some((item) => !isPrimitive(item))) throw new Error("Invalid analytics condition value");
      clean[key] = expected.slice();
    } else if (isPrimitive(expected)) {
      clean[key] = expected;
    } else if (expected && typeof expected === "object") {
      clean[key] = validateWhen(expected);
    } else {
      throw new Error("Invalid analytics condition value");
    }
  }
  return clean;
}

function isPrimitive(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid analytics ${field}`);
  return value.trim();
}

/** Reject untrusted manifest declarations before they reach the host or the UI. */
export function validateModuleAnalytics(value: unknown): ModuleAnalyticsMetric[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_METRICS) throw new Error("Invalid module analytics");
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid module analytics metric");
    const item = raw as Record<string, unknown>;
    const aggregation = item.aggregation as ModuleAnalyticsAggregation;
    if (!MODULE_ANALYTICS_AGGREGATIONS.includes(aggregation)) throw new Error("Invalid analytics aggregation");
    const unit = item.unit as ModuleAnalyticsUnit | undefined;
    if (unit !== undefined && !MODULE_ANALYTICS_UNITS.includes(unit)) throw new Error("Invalid analytics unit");
    const path = item.path === undefined ? undefined : text(item.path, "path", 128);
    if (path !== undefined && !PATH.test(path)) throw new Error("Invalid analytics path");
    if (aggregation !== "count" && path === undefined) throw new Error("Analytics metric requires a path");
    const metric: ModuleAnalyticsMetric = {
      id: text(item.id, "id", 64),
      label: text(item.label, "label", 120),
      aggregation,
    };
    if (!ID.test(metric.id)) throw new Error("Invalid analytics metric id");
    if (item.description !== undefined) metric.description = text(item.description, "description", 400);
    if (unit !== undefined) metric.unit = unit;
    if (path !== undefined) metric.path = path;
    const when = validateWhen(item.when);
    if (when !== undefined) metric.when = when;
    return metric;
  });
}

/** Collect validated dashboard contributions from installed/bundled module views. */
export function moduleAnalyticsDescriptors(
  views: Iterable<{ id: string; manifest?: { analytics?: unknown } }>,
): ModuleAnalyticsDescriptor[] {
  const descriptors: ModuleAnalyticsDescriptor[] = [];
  for (const view of views) {
    if (!/^[a-z0-9][a-z0-9.-]{2,127}$/.test(view.id)) continue;
    const metrics = validateModuleAnalytics(view.manifest?.analytics) ?? [];
    for (const metric of metrics) descriptors.push({ moduleId: view.id, metric });
  }
  return descriptors;
}

function readPath(trace: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let current: any = trace;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function matches(trace: unknown, condition: Record<string, unknown> | undefined): boolean {
  if (!condition) return true;
  for (const [path, expected] of Object.entries(condition)) {
    const actual = readPath(trace, path);
    if (Array.isArray(expected)) {
      if (!expected.some((option) => option === actual)) return false;
    } else if (expected && typeof expected === "object") {
      if (!actual || typeof actual !== "object" || !matches(actual, expected as Record<string, unknown>)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

/** Aggregate declared metrics over traces without executing module code. */
export function aggregateModuleAnalytics(
  traces: Iterable<unknown>,
  descriptors: readonly ModuleAnalyticsDescriptor[],
): ModuleAnalyticsResult {
  const accumulators = new Map<string, Accumulator>();
  const keyFor = (moduleId: string, id: string) => `${moduleId}\u0000${id}`;
  for (const trace of traces) {
    for (const { moduleId, metric } of descriptors) {
      if (!matches(trace, metric.when)) continue;
      const key = keyFor(moduleId, metric.id);
      const acc = accumulators.get(key) ?? { sum: 0, count: 0 };
      if (metric.aggregation === "count") acc.count += 1;
      else {
        const value = readPath(trace, metric.path);
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        acc.sum += value;
        acc.count += 1;
      }
      accumulators.set(key, acc);
    }
  }
  const result: ModuleAnalyticsResult = {};
  for (const { moduleId, metric } of descriptors) {
    const values = (result[moduleId] ??= []);
    if (values.some((entry) => entry.id === metric.id)) continue;
    const acc = accumulators.get(keyFor(moduleId, metric.id)) ?? { sum: 0, count: 0 };
    const value = metric.aggregation === "count" ? acc.count
      : metric.aggregation === "average" ? (acc.count ? acc.sum / acc.count : 0)
      : acc.sum;
    const entry: ModuleAnalyticsValue = {
      id: metric.id,
      label: metric.label,
      aggregation: metric.aggregation,
      value: Number.isFinite(value) ? value : 0,
      samples: acc.count,
    };
    if (metric.description !== undefined) entry.description = metric.description;
    if (metric.unit !== undefined) entry.unit = metric.unit;
    values.push(entry);
  }
  return result;
}

/** Top-level trace fields a descriptor reads, for a bounded SQLite prefilter. */
export function analyticsTraceRoots(descriptors: readonly ModuleAnalyticsDescriptor[]): string[] {
  const roots = new Set<string>();
  for (const { metric } of descriptors) {
    if (metric.path) roots.add(metric.path.split(".")[0]);
    for (const key of Object.keys(metric.when ?? {})) roots.add(key.split(".")[0]);
  }
  return [...roots].filter((root) => /^[A-Za-z][A-Za-z0-9_]*$/.test(root));
}
