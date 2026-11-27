# Dashboard i18n guide

The dashboard is bilingual: English source strings plus a complete French
catalog. English literals are the translation keys, so a missing French entry
falls back to readable English.

## API

```tsx
import { useT } from "../../i18n"; // adjust the relative depth

export function Panel() {
  const t = useT(); // subscribes the component to language changes
  return <h2>{t("Available models")}</h2>;
}
```

* `useT()` — call once per component, before any early `return` (React hook
  rules), and use the returned `t` for every visible string in that component.
* `t` imported directly from `../i18n/core` in plain `.ts` modules — for
  formatters, label helpers and API messages. `core.ts` has no React import, so
  Node tests and the API build can load it. Prefer `useT()` in components.
* Never call hooks in loops, conditions, or plain functions.

## What to translate

Translate every user-visible string: JSX text, `aria-label`, `title`,
`placeholder`, `alt`, button/option labels, empty states, helper text,
validation messages, `confirm()`/`alert()` messages, status and error strings.

Do not translate: API paths, CSS class names, storage keys, `id`/`name`
attributes, HTTP methods, model/provider identifiers, URLs, code samples, brand
names (MultiVibe, OpenAI, GitHub, ChatGPT, OpenCode…), acronyms (API, URL, JSON,
MCP, SQL, TTFT…).

## Keys and interpolation

Keep the English key byte-identical to the text currently rendered so the
English UI does not change. Use `{placeholder}` for variables and pass them:

```ts
t("Delete {name}?", { name })
t("Showing {from}–{to} of {total}", { from, to, total })
```

Never concatenate translated fragments. Use explicit plural branches:

```ts
count === 1 ? t("1 model ready") : t("{count} models ready", { count })
```

## Catalog files

Each area owns one file in `packages/ui/src/i18n/fr/`. Add one entry per English
key used by your files:

```ts
const catalog: Record<string, string> = {
  "Available models": "Modèles disponibles",
};

export default catalog;
```

* Write idiomatic, professional French, addressed with **vous**.
* Keep UI capitalization (sentence case), product names, and acronyms.
* Use French typography: space before `:`, `?`, `!`, `;`, `»`, after `«`,
  and non-breaking spaces inside numbers/units where natural.
* Never translate a key into an empty string.
* Do not add the same key twice in the same file.

## Verification

From the repository root:

```sh
cd web && npx tsc -b
```

Type-checking must pass. Do not change behavior, data shapes, or test
expectations; English output must stay identical.
