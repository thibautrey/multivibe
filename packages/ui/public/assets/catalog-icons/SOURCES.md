# OpenRouter icons

These assets were fetched from the public OpenRouter model catalog on 2026-09-04.

- Model catalog: <https://openrouter.ai/models>
- Model data: <https://openrouter.ai/api/frontend/v1/models/find?active=true&fmt=cards>
- Provider data: <https://openrouter.ai/api/frontend/v1/all-providers>
- Curated icon origin: <https://openrouter.ai/images/icons/>
- Favicon fallback used by OpenRouter: <https://t0.gstatic.com/faviconV2>

OpenRouter's model list uses author or model-family icons for model rows; it does
not expose separate artwork for every model. The generated
`openrouter-model-icons.json` manifest therefore stores both `icon` (the model
author icon) and `providerIcon` (the execution provider icon for that endpoint).

The public catalog responses inspected for this import did not expose a license
field for the icons. The manifest keeps the original URLs and fetch timestamp;
review OpenRouter's current brand and terms before redistributing or modifying
these marks. Source attribution: OpenRouter.

## Landing synchronization

Model assets and author selection synchronized from `multivibe-cloud` on 2026-09-07.
Z.ai and DeepSeek organization overrides use the same Wikimedia SVGs as Cloud, vendored locally:
- https://upload.wikimedia.org/wikipedia/commons/f/f4/Z.ai_%28company_logo%29.svg
- https://upload.wikimedia.org/wikipedia/commons/9/95/DeepSeek-icon.svg

`public-models.js` maps slugs to existing filenames, preferring SVG, then PNG, then WebP (as Cloud does). Unknown authors use the shared fallback mark.
