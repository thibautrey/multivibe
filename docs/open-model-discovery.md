# Dynamic open-weight discovery

Three bounded Hub feeds (200 entries each with pagination) refresh every six hours. The production server starts synchronization and persists the last successful v2 snapshot beside STORE_PATH. Demo uses a separate temporary cache. Stale data is retained on failure. No model weights or repository code are fetched. Each sync progressively enriches up to 12 candidates through fixed Hub metadata endpoints (five-second timeout); failures preserve list metadata. Structured task categories and evaluation task types are accepted as publisher evidence.

Sorts: Recommended, Trending, Top downloaded, New, Established. Needs and sorting are stored separately from experience level. Metadata supplies task evidence, not inferred family-name quality. Missing metadata excludes models from that task. Explicit quantized parent relations group variants only when the parent is present; fine-tunes remain distinct. Canonical download counts are not summed.

GET /admin/model-recommendations accepts need (writing/coding/translation/documents), sort (recommended/trending/downloads/newest/established), host=local. It returns the catalog, a minimal Host projection and ranked variant estimates. It invokes existing Host capability and compatibility interfaces, not the public-worker projection. No machine profile goes to Hugging Face. Missing or ambiguous exact estimates stay unknown. A compatible estimate does not create an installation or inference route.

Limitations: this increment does not implement absent-weight preflight estimates, verified installable variants, remote Host selection, or Prepare actions in discovery. Exact, unambiguous connected routes can show Chat in discovery; Cloud routes still depend on the separate authenticated catalog. Runtime compatibility often requires already-downloaded metadata. Live execution and installation must be validated separately; the discovery catalog cannot resolve Cloud account access. File sizes/architecture/context remain unknown where upstream list metadata omits them. Downloads reporting period is not assumed from absent payload metadata.

## Validation — 2026-09-14

- Source worktree: `git diff --check` passed; no dependency installation in worktree.
- On main: `npm run build:api` and `npm run build:web` passed. Web bundle retains the >500 kB warning.
- On main: `node --import tsx --test src/open-model-catalog.test.ts web/test/model-guidance.test.ts web/test/model-catalog.test.ts` — 32 tests passed.
- Fixture test injects a different source model on refresh and observes its appearance without source edits or redeployment. Other fixtures cover persistence across restart, upstream failure, pagination, gates, fine-tunes, unknown/ambiguous/insufficient estimates, and fixed metadata-only requests.
- Real localhost demo API returned 471 repositories, 329 grouped writing recommendations; raw evidence covered 43 coding repositories. Translation and document tasks were empty in that cached snapshot: task relevance is deliberately not guessed. This remains a product coverage gap, not a successful end-to-end result for those tasks.
- Internal browser checked Beginner (three cards), Advanced filters, Expert discovery controls, the explicit empty task state, and preference persistence after reload. Narrow viewport cards were visually inspected. No complete keyboard/screen-reader audit was performed.
- No Host download, runtime launch, physical memory fit, successful local chat, or authenticated Cloud inference was performed. Demo is explicitly disconnected. Discovery does not solve the earlier Cloud-access issue.

## Anonymous activity integration (2026-09-14)

`Most used on MultiVibe` consumes the cached Cloud v1 `usage-popular` endpoint,
joining exact `hf:` identities only. Old `catalog-fallback` responses are rejected.
It ranks reported output volume across 30 completed UTC days, not users or quality.
Cloud publishes ranks only after 20 contributions over 7 days; this is not proof
of independent reporters. Collection settings and payloads are unchanged.
The existing HF discovery remains; Cloud adds activity evidence and up to 20
otherwise absent models per refresh, subject to documented task metadata.
No activity evidence means no community recommendation, with no silent fallback.
Reviewed publisher assets are copied from Cloud with source attribution and served
locally; unknown publishers have no icon. This does not establish model provenance.

Validation: 36 Core tests and API/web builds passed from main. Cloud build and 6
telemetry/cache tests passed. PostgreSQL integration could not start: local Docker
socket unavailable. No production deployment or live updated ranking is claimed.
