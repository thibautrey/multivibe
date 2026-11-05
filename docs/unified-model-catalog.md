# Unified model metadata

The control plane maintains one materialized catalog from four public sources:

- models.dev (`https://models.dev/api.json`), including `reasoning_options` and canonical identity.
- LangChain Model Profiles, discovered from the LangChain repository tree and read at that tree's commit. Python files are parsed as literals; downloaded code is never executed.
- LiteLLM's `model_prices_and_context_window.json`, including capability flags and provider-specific metadata.
- Pi AI's public `https://pi.dev/api/models` catalog, including explicit native thinking mappings.

LangChain and Pi reuse some models.dev data. Contributions are provenance, not independent votes. Their metadata sources are MIT licensed; LiteLLM's public catalog is distributed in its MIT-licensed repository. No provider credentials or catalog-supplied executable packages/endpoints are installed or executed.

## Consolidation

Identity is the normalized provider plus the exact model ID. A small provider-name alias table reconciles naming differences across catalogs; there are no model-family rules. Canonical IDs from models.dev remain available. Similar names, quantization suffixes and fine-tunes are not guessed to be the same model.

Each entry stores normalized facts, all original public source records, source URLs and observation times, and conflicting values. Scalar priority is models.dev, LangChain, LiteLLM, Pi. Explicit acceptance lists intersect, numeric capacity limits take the minimum, and a denial wins for boolean capabilities on the same provider. Default effort is retained only when compatible with the resolved acceptance list. Unknown capabilities remain absent. Isolated LiteLLM effort flags and Pi fallback UI levels do not invent a complete native allowlist.

Live runtime metadata overrides catalog facts. When a local endpoint has no matching provider identity, only agreed facts from exact ID/canonical-ID matches transfer; disagreements remain visible, and prices never transfer between providers. Catalog metadata enriches discovered models; it does not authorize routing or grant account/model access.

## Refresh and storage

All sources participate in one refresh cycle, deduplicated in flight. Each successful source replaces its previous contribution before the database is rebuilt. A failed source retains its last good contribution. The default refresh interval is 24 hours, with a one-minute retry after partial failures. A stale disk snapshot is immediately available after restart while refresh runs in the background. Malformed/oversized data never removes a last good snapshot.

The unified database uses the existing `SDK_MODELS_DEV_CACHE_PATH` and retains the version-2 `providers` pricing interface, with `unifiedVersion: 1`. Reads are bounded to 96 MiB and source responses to 24 MiB. Cache writes are atomic. The Rust edge reads the same materialized database, caches it for 30 seconds, and performs no external catalog requests on inference paths.

## Harness exposure

`/v1/models` includes available normalized capabilities and `metadata.model_knowledge`, containing the complete source records and conflicts. The native Codex `models` array carries supported effort levels/defaults, modalities and context limits. Pi and OpenClaw get their native model fields; OpenCode gets capabilities, limits, modalities, costs and reasoning variants.

Managed model-aware harness installations additionally receive `.multivibe/catalogs/<harness-id>.json`. This full-fidelity companion preserves every exposed metadata field, even when the harness's native configuration cannot represent it. It is synchronized and restored with the managed integration; it is not a claim that every third-party harness automatically interprets custom fields. Harnesses that only accept an API endpoint discover metadata through `/v1/models`.

Metadata publication and inference parameter translation are separate contracts. This change does not infer unverified runtime-specific request parameters from another host's catalog entry.
