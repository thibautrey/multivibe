import React from "react";
import { LOCALES, LOCALE_LABELS, useI18n, type Locale } from "../../i18n";

/**
 * Visible language control. The initial language is detected automatically
 * from the browser; this toggle lets the user override it at any time.
 */
export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div
      className={`language-switcher${className ? ` ${className}` : ""}`}
      role="group"
      aria-label={t("Language")}
    >
      {LOCALES.map((code: Locale) => (
        <button
          key={code}
          type="button"
          className={locale === code ? "language-option active" : "language-option"}
          onClick={() => setLocale(code)}
          title={LOCALE_LABELS[code]}
          aria-label={t("Switch language to {language}", { language: LOCALE_LABELS[code] })}
          aria-pressed={locale === code}
          lang={code}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
