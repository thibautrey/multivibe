# Cloud providers through AI SDK

MultiVibe uses the AI SDK provider interface for additional API-key providers.
The initial registry includes Anthropic, Google Gemini, OpenRouter, DeepSeek,
Groq, Together AI, Cerebras, and Perplexity. Existing ChatGPT/OpenCode/Grok OAuth,
Mistral, z.ai, local runtimes, and custom compatible endpoints retain their
existing integrations.

The provider picker exposes **More cloud providers**. Select a provider, enter
its API key, and optionally restrict the account to comma-separated upstream
model IDs. An empty list uses the bundled models.dev text-generation catalog.
Model names are prefixed with the provider ID, for example
`anthropic/claude-sonnet-4-6`, `google/gemini-2.5-flash`, or
`openrouter/anthropic/claude-sonnet-4.6`. Aliases can refer to these names as usual.
Manual model IDs allow newly released models before the next catalog update.

## Request path

Rust remains the public API edge and owns authentication, account selection,
retry/failover, tracing, and client protocol conversion. For accounts whose
provider is `ai-sdk`, it calls the internal SDK adapter hosted by Node. The
adapter reads the selected account and instantiates an AI SDK language model:

- `@ai-sdk/anthropic` for Anthropic's native Messages API.
- `@ai-sdk/google` for Google's native generation API.
- `@ai-sdk/openai-compatible` for the registered compatible providers.

The adapter uses the SDK's standardized `LanguageModelV4.doGenerate` and
`doStream` contracts. It does not implement provider-specific HTTP codecs, use
Vercel AI Gateway, execute tools, or perform a second retry loop. The same adapter
is available to the standalone Node proxy. Existing providers incur no new hop.

The internal adapter requires `V1_EDGE_INTERNAL_JOB_TOKEN` in the native profile.
Standalone Node generates a process-local token. Provider keys never authorize
adapter calls; the adapter loads them from the account store and only sends them
to the provider's registered endpoint. Rust's public fallback refuses adapter
paths. Remote catalog data cannot select executable packages or change endpoints.

Supported generation features are text, supported image inputs, function calls
and tool results, JSON output formats, reasoning effort, common generation
controls, token usage, and incremental streaming. The existing edge converts
Chat Completions, Responses, and Messages requests to/from the adapter's chat
surface. Unsupported input structures return a clear error. Provider-specific
options can be supplied as `provider_options` on chat requests; provider support
still governs the available features. This adapter does not provide embeddings,
audio generation/transcription, image generation, realtime, provider-executed
tools, or arbitrary provider credentials such as AWS signing or Azure tenancy.

Upstream HTTP errors are returned before committing streaming headers. Later
stream errors emit an error frame without a fabricated successful finish.
Disconnects cancel generation, and response writes respect backpressure.

## Model metadata

`npm run catalog:sdk:refresh` downloads `https://models.dev/api.json` and updates
`src/ai-sdk/catalog.generated.ts`. The catalog is bundled: startup and inference
do not depend on models.dev availability. Review and commit refreshes. Only
non-deprecated text-generation entries for the installed registry are included.

`GET /admin/provider-catalog` serves provider choices and model metadata behind
admin authentication. Model discovery preserves context/output limits, tool and
reasoning capabilities, input modalities, source timestamp, and pricing metadata.
Pricing is models.dev's advertised USD per million tokens, not measured billing
or an account-specific quote. Catalog inclusion does not prove entitlement or
current availability. Upstream failures remain authoritative.

Input modalities describe the upstream catalog; the adapter currently accepts
text and supported image inputs only.

Neither AI SDK nor models.dev provides account subscription quotas. These new
accounts report quota windows as unsupported; request token usage remains in
normal traces and statistics. Provider-specific quota integrations can be added
separately when a documented authenticated API exists.

## Extending the registry

Add a reviewed provider in `src/ai-sdk/providers.ts`. Compatible providers need
an ID, label and fixed endpoint. Native protocols require an installed SDK
adapter factory in `models.ts` plus its pinned package dependency. Add the ID to
the catalog refresh script and refresh metadata. Add request/response fixtures
and account-isolation tests before exposing the new provider in setup. A catalog
entry alone never implies inference support.

## Validation

Worktree checks passed: `git diff --check` and syntax checking the catalog refresh
script. Dependencies were installed and validation run on local main: web/API
builds, 41 targeted TypeScript tests (including OpenCode and quota regressions),
and the Rust `ai_sdk` integration test using Rust 1.88. The native test covers
discovery, Chat Completions, Responses, streaming, Messages, and internal-route
isolation. The protocol tests passed again after account-ID validation was added.
Browser checks verified provider selection, review, saved vendor labels, and
unavailable quota explanations. SDK codec tests use mock upstream responses;
live paid-provider inference and production deployment were not performed.

Sources checked during implementation:

- https://ai-sdk.dev/docs/ai-sdk-core/provider-management
- https://ai-sdk.dev/providers/ai-sdk-providers/anthropic
- https://ai-sdk.dev/v7/providers/ai-sdk-providers/google
- https://ai-sdk.dev/providers/openai-compatible-providers
- AI SDK provider package 4.0.10 public TypeScript interfaces
- https://models.dev/api.json (fetch timestamp recorded in the generated catalog)
