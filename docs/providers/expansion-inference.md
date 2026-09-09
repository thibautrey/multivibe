# Expansion inference providers

This batch adds ten hosted inference APIs through their documented OpenAI-compatible chat-completions interfaces. MultiVibe sends the configured API key only to the fixed base URL shown below. Model catalogs are deliberately small reviewed seeds; users can select other current model IDs published by the provider in account setup or editing.

| Provider | API base | Catalog/reference | Access and limits |
| --- | --- | --- | --- |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` | [OpenAI compatibility](https://docs.fireworks.ai/tools-sdks/openai-compatibility) | [Pricing](https://fireworks.ai/pricing); metered, with any promotional credit determined by the account |
| DeepInfra | `https://api.deepinfra.com/v1/openai` | [OpenAI API](https://deepinfra.com/docs/advanced/openai_api) | [Pricing](https://deepinfra.com/pricing); pay as you go, with trial promotions subject to account terms |
| Nebius AI Studio | `https://api.studio.nebius.ai/v1` | [OpenAI API](https://docs.studio.nebius.com/api-reference/openai) | [Pricing](https://studio.nebius.com/pricing); metered and subject to regional/account limits |
| SambaNova Cloud | `https://api.sambanovacloud.com/v1` | [OpenAI compatibility](https://docs.sambanova.ai/docs/en/features/openai-compatibility) | [Plans](https://cloud.sambanova.ai/plans/pricing) and [rate limits](https://docs.sambanova.ai/docs/en/models/rate-limits); free and paid plans differ |
| SiliconFlow | `https://api.siliconflow.com/v1` | [Quickstart](https://docs.siliconflow.com/en/userguide/quickstart) | [Model catalog](https://cloud.siliconflow.com/models); prices and free designation are model-specific |
| Novita AI | `https://api.novita.ai/openai/v1` | [Chat completions](https://docs.novita.ai/api-reference/model-apis-llm-create-chat-completion) | [Pricing](https://novita.ai/pricing); credit-metered, with signup credit subject to account terms |
| NVIDIA NIM hosted API | `https://integrate.api.nvidia.com/v1` | [OpenAI APIs](https://docs.api.nvidia.com/nim/reference/openai-apis) | [Hosted model catalog](https://build.nvidia.com/explore/discover); evaluation access has NVIDIA-defined account limits and differs from self-hosted NIM licensing |
| Mistral Codestral | `https://codestral.mistral.ai/v1` | [Code generation](https://docs.mistral.ai/capabilities/code_generation/) | [Pricing](https://mistral.ai/pricing); paid usage and an optional lower-limit experimental tier are controlled by Mistral |
| Cohere | `https://api.cohere.ai/compatibility/v1` | [Compatibility API](https://docs.cohere.com/v2/docs/compatibility-api) | [Rate limits](https://docs.cohere.com/docs/rate-limits); trial keys have lower limits and production keys are billed |
| AI21 Labs | `https://api.ai21.com/studio/v1` | [Jamba API reference](https://docs.ai21.com/reference/jamba-15-api-ref) | [Pricing](https://www.ai21.com/pricing); metered, with trial credit determined by the account |

All entries use bearer-token authentication and the compatible adapter. They support the common `/chat/completions` request and response shape; individual optional OpenAI fields can still vary by model and provider.

No provider in this batch documents a stable, API-key-authenticated endpoint for remaining account credit or subscription quota. MultiVibe therefore does not probe billing endpoints for these connections. Token usage returned by inference responses remains available, and the linked provider billing dashboard is authoritative for spend, credits, and rate limits.

Catalog and documentation review date: 2026-09-09.
