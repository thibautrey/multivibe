import { fail } from "./types.js";

export type HarnessEffort = {
  options: { value: string; label: string; description?: string }[];
  currentValue?: string;
};

/** Keep native values and labels, including future levels unknown to MultiVibe. */
export function effortOptions(rows: unknown, currentValue?: unknown): HarnessEffort | null {
  if (!Array.isArray(rows)) return null;
  const options = rows.flatMap(row => {
    const value = typeof row === "string" ? row : row?.value ?? row?.reasoningEffort;
    if (typeof value !== "string" || !value || value.length > 256) return [];
    const label = row?.name ?? row?.label;
    return [{ value, label: typeof label === "string" ? label : value,
      ...(typeof row?.description === "string" ? { description: row.description } : {}) }];
  });
  const unique = [...new Map(options.map(option => [option.value, option])).values()];
  return unique.length ? { options: unique, ...(typeof currentValue === "string" && unique.some(o => o.value === currentValue) ? { currentValue } : {}) } : null;
}

export function acpEffort(info: any): { id: string; effort: HarnessEffort } | null {
  const option = info?.configOptions?.find((o: any) => o.type === "select" &&
    (o.category === "thought_level" || /^(?:effort|reasoning[_-]?effort|thinking[_-]?level|thought[_-]?level)$/iu.test(o.id)));
  if (!option || typeof option.id !== "string") return null;
  const effort = effortOptions((option.options ?? []).flatMap((o: any) => Array.isArray(o.options) ? o.options : [o]), option.currentValue);
  return effort ? { id: option.id, effort } : null;
}

export function validateEffort(effort: HarnessEffort | null, value: unknown): string {
  if (typeof value !== "string" || !effort?.options.some(option => option.value === value)) fail("Effort level is not advertised by this harness/model", 422);
  return value;
}
