export type WidgetDefinition = { id: string; required?: boolean };
export type WidgetLayout = { id: string; visible: boolean; size: "small" | "medium" | "large" };

/** Reconcile stored preferences with the current catalogue; required widgets cannot be hidden. */
export function normalizeWidgets(definitions: WidgetDefinition[], stored: unknown): WidgetLayout[] {
  const result: WidgetLayout[] = [];
  if (Array.isArray(stored)) {
    for (const value of stored) {
      if (!value || typeof value !== "object") continue;
      const definition = definitions.find((entry) => entry.id === value.id);
      if (!definition || result.some((entry) => entry.id === definition.id)) continue;
      result.push({ id: definition.id, visible: definition.required || value.visible !== false,
        size: value.size === "medium" || value.size === "large" ? value.size : "small" });
    }
  }
  for (const definition of definitions) {
    if (!result.some((entry) => entry.id === definition.id)) result.push({ id: definition.id, visible: true, size: "small" });
  }
  return result;
}

export function moveWidget(layout: WidgetLayout[], id: string, target: string): WidgetLayout[] {
  const from = layout.findIndex((item) => item.id === id);
  const to = layout.findIndex((item) => item.id === target);
  if (from < 0 || to < 0 || from === to) return layout;
  const result = [...layout];
  result.splice(to, 0, ...result.splice(from, 1));
  return result;
}
