# Model guidance — implementation status, 2026-09-14

This is a partial implementation of the guided-model plan, not end-to-end completion.

## Implemented

- Guided (default), Compare and Expert views; locally persisted preference with storage failure fallback.
- Three needs, exact-ID reviewed selection version 2026-09-14.1; maximum three guided options, with another execution mode when available.
- Unknown prices/speed remain unknown; concise cost, data destination, speed and service dependency, expandable evidence.
- No public reference can grant access. Ambiguous multi-account destinations are excluded from guidance because chat does not pin accounts.
- Authenticated Cloud inference-catalog diagnostic separate from public discovery; sanitized responses, timeout and 4 MiB body limit; no credential renewal or secret disclosure.
- Administration recommendation endpoint shares the pure selection logic; frontend currently uses the same logic on its existing catalog, not this new endpoint.
- Expert retains existing discovery, variants and diagnostics. No changes to inference APIs, external runtimes, download policy or existing models.

## Not implemented / not verified

- Persistent Host preparation orchestration, verified preflight, consent, download, bounded calibration, cancellation and synthetic chat test.
- Preparable candidates and availability filters; Compare currently shows usable reviewed models only. Known-price filter has no priced candidates yet.
- Guided catalog coverage is intentionally narrow: unknown identities remain available in Expert, not automatically recommended.
- Browser visual review, actual keyboard/screen-reader/mobile-device validation, and UI interaction tests.
- Physical absent-model-to-local-chat test and authenticated Cloud inference test.
- Initial empty Cloud catalog root cause is not resolved by this UI change. Local unauthenticated probes of /admin/cloud/status and /admin/cloud/accessible-models returned HTTP 401; these prove the admin authentication boundary, not a Cloud rejection or model availability. Running instance was not restarted.
- Cloud admin diagnostics are only requested for configuration-capable users. Team member views retain the existing account-scoped catalog; no admin access is granted.

## Validation

Worktree: dependency-free source review and git diff --check; no dependencies installed.

After integration on main:

- node --import tsx --test web/test/model-guidance.test.ts web/test/model-catalog.test.ts src/multivibe-cloud.test.ts: 43 passed.
- npm run build:api: passed.
- npm run build:web: passed, with Vite native-loader/import-extension and bundle-size warnings.

Tests cover all needs, unknown values, unavailable/reference routes, ambiguous destinations, alternate execution modes, Cloud empty/error/expired/disconnected states, response bounds and alias safety. They do not validate the unimplemented installation flow.

No push, publication, runtime restart, model download or Cloud inference was performed. Pre-existing iOS modifications are preserved.
