/**
 * Pure locale detection and translation helpers shared by the provider and by
 * non-React modules (formatters, API error strings). Kept free of React imports
 * so Node test runs do not need the React runtime.
 */
import { FR_CATALOG } from "./fr";

/**
 * The dashboard ships with two complete UI languages. English strings are the
 * source keys, so a missing French entry always degrades to readable English
 * instead of an untranslated token.
 */
export type Locale = "en" | "fr";

export const LOCALES: readonly Locale[] = ["en", "fr"];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  fr: "Français",
};

export const LOCALE_STORAGE_KEY = "multivibe.locale";

export type TranslateVars = Record<string, string | number>;

export function normalizeLocale(value: string | null | undefined): Locale | undefined {
  const tag = String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!tag) return undefined;
  if (tag === "fr" || tag.startsWith("fr-")) return "fr";
  if (tag === "en" || tag.startsWith("en-")) return "en";
  return undefined;
}

export interface LocaleDetectionOptions {
  /** Query string that may carry an explicit `lang` override. */
  search?: string;
  /** Stored preference, normally `localStorage`. */
  stored?: string | null;
  /** Browser preference list, normally `navigator.languages`. */
  languages?: readonly string[];
}

/**
 * Detection order: explicit URL override, stored choice, then the browser's
 * ordered language preferences. Everything else falls back to English.
 */
export function detectLocale(options: LocaleDetectionOptions = {}): Locale {
  const search = options.search ?? "";
  if (search) {
    const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
    const requested = normalizeLocale(params.get("lang"));
    if (requested) return requested;
  }
  const stored = normalizeLocale(options.stored);
  if (stored) return stored;
  for (const language of options.languages ?? []) {
    const normalized = normalizeLocale(language);
    if (normalized) return normalized;
  }
  return "en";
}

/** Browser detection used on first paint; safe in SSR and test environments. */
export function detectBrowserLocale(): Locale {
  if (typeof window === "undefined") return "en";
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    stored = null;
  }
  const languages =
    typeof navigator !== "undefined"
      ? navigator.languages?.length
        ? navigator.languages
        : [navigator.language]
      : [];
  return detectLocale({ search: window.location.search, stored, languages });
}

export function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

export function translate(locale: Locale, source: string, vars?: TranslateVars): string {
  const template = locale === "fr" ? FR_CATALOG[source] ?? source : source;
  return interpolate(template, vars);
}

// Module-level locale so non-component helpers (formatters, error messages)
// translate consistently. The provider refreshes it before every render.
let currentLocale: Locale = "en";

export function activeLocale(): Locale {
  return currentLocale;
}

export function setActiveLocale(locale: Locale): void {
  currentLocale = locale;
}

/** Translate with the current locale; subscribe with `useT` inside components. */
export function t(source: string, vars?: TranslateVars): string {
  return translate(currentLocale, source, vars);
}

export type Translate = (source: string, vars?: TranslateVars) => string;
