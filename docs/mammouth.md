# Mammouth AI

In Accounts, add a provider, choose **Mammouth AI**, and paste your Mammouth API key. Get a key and credits through the [official API quick start](https://info.mammouth.ai/docs/api-quick-start/).

Leave the model selection empty to expose the bundled text models, or enter specific Mammouth model IDs. Use `mammouth/mammouth-recommended` in clients for Mammouth's current recommended model; for a fixed model use a namespaced ID such as `mammouth/claude-sonnet-4-6`. MultiVibe removes the `mammouth/` prefix before sending the request.

Requests use `https://api.mammouth.ai/v1/chat/completions` with bearer authentication and support buffered and streaming responses. API usage consumes credits; subscriptions include a monthly allowance and pay-as-you-go is available.

The bundled model list is reviewed against Mammouth's documentation and kept in `src/ai-sdk/mammouth-catalog.ts`, separately from the generated models.dev catalog. New IDs can be entered manually. Model availability can change; unverified capabilities, context limits and prices are omitted.

API-key spend now refreshes through `GET https://api.mammouth.ai/key/info`. Mammouth documents `/key/info` using a local LiteLLM example; the hosted path returned its authentication error during an unauthenticated probe. The parser uses the [LiteLLM key-info schema](https://docs.litellm.ai/docs/proxy/virtual_keys): `info.spend` in USD and, when present, `max_budget` and `budget_reset_at`. An explicit budget is displayed as **API key budget**, not as the complete chat subscription. Missing budget totals never produce invented percentages. Raw key-info responses may contain credentials; only normalized spend and quota values are retained. Authenticated hosted schema compatibility still requires a live account refresh.
