export function findAvailableCount(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of [
    "availableCount",
    "available_count",
    "available",
    "amount",
    "remaining",
    "balance",
  ]) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  for (const child of Object.values(record)) {
    const count = findAvailableCount(child);
    if (count !== undefined) return count;
  }
  return undefined;
}
