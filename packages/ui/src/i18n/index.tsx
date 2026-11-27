import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  activeLocale,
  detectBrowserLocale,
  setActiveLocale,
  LOCALE_STORAGE_KEY,
  t,
  translate,
  type Locale,
  type Translate,
  type TranslateVars,
} from "./core";

export * from "./core";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  children,
  initialLocale,
  onLocaleChange,
}: {
  children: React.ReactNode;
  initialLocale?: Locale;
  onLocaleChange?: (locale: Locale) => void;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? detectBrowserLocale());

  // Keep module-level helpers in sync during render: children may call
  // `formatCurrency`/`t` on their very first render.
  setActiveLocale(locale);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = locale;
    document.documentElement.dataset.locale = locale;
    document.title = translate(locale, "MultiVibe Dashboard");
    const description = document.querySelector('meta[name="description"]');
    if (description) description.setAttribute("content", translate(locale, "MultiVibe multi-provider routing dashboard"));
  }, [locale]);

  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      onLocaleChange?.(next);
      try {
        window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
      } catch {
        // Private browsing can reject storage; the in-memory choice still works.
      }
      const url = new URL(window.location.href);
      if (url.searchParams.get("lang") !== next) {
        url.searchParams.set("lang", next);
        window.history.replaceState({}, "", url.toString());
      }
    },
    [onLocaleChange],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (source: string, vars?: TranslateVars) => translate(locale, source, vars),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (value) return value;
  // Components rendered in isolation (unit tests, embeds) stay in English.
  return { locale: activeLocale(), setLocale: () => undefined, t };
}

/** Components that only need the translate function still re-render on change. */
export function useT(): Translate {
  return useI18n().t;
}

export type { Locale as DashboardLocale };
