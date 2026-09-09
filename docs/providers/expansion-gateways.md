# Expansion gateways

This batch adds reviewed metadata for OrcaRouter, Martian, CrofAI, Inceptron, Neuralwatt, Baseten Model APIs, Replicate, and fal.ai. Endpoint registration is fixed to the provider-published host; API keys are never sent to a user-supplied host.

| Provider | Inference contract | Fixed base URL | Access and quota evidence |
| --- | --- | --- | --- |
| OrcaRouter | OpenAI-compatible chat | `https://api.orcarouter.ai/v1` | API-key billing and a documented bounded `orcarouter/free` route. No inference-key balance endpoint is documented. |
| Martian | OpenAI-compatible chat | `https://api.withmartian.com/v1` | Gateway API key. Public docs do not promise free inference or a key-readable allowance. |
| CrofAI | OpenAI-compatible chat and Responses | `https://crof.ai/v1` | Pay per token. Account signup without a card is not treated as free inference credit. |
| Inceptron | OpenAI-compatible chat | `https://api.inceptron.io/v1` | Pay-as-you-go API key. No documented quota probe. |
| Neuralwatt | OpenAI-compatible chat | `https://api.neuralwatt.com/v1` | API-key inference. No documented recurring free allowance or quota probe. |
| Baseten | OpenAI-compatible Model APIs | `https://inference.baseten.co/v1` | Usage billed. This connection targets Baseten's shared Model APIs, not per-deployment Truss URLs. |
| Replicate | Prediction jobs with model-specific inputs | `https://api.replicate.com/v1` | Pay as you go. The adapter is intentionally scoped to the official `meta/meta-llama-3-70b-instruct` prompt/output schema; it creates a prediction, polls its fixed ID URL, and cancels unfinished work. |
| fal.ai | OpenAI-compatible chat through its OpenRouter endpoint | `https://fal.run/openrouter/router/openai/v1` | Usage billed. Authentication is `Authorization: Key <FAL_KEY>`, which the dedicated adapter preserves. |

The bundled catalogs are deliberately small reviewed starters. OrcaRouter, CrofAI, Inceptron, and Neuralwatt publish model-list endpoints that remain authoritative for account availability; Martian, Baseten, Replicate, and fal.ai document their current model identifiers. Replicate streaming buffers the prediction result because its generic prediction lifecycle is not an OpenAI token stream. Client tool messages, media, tool declarations, reasoning controls, and structured-output controls are rejected before prediction creation. No quota fetcher is installed for this batch because none of the reviewed sources establishes a stable remaining allowance with a denominator and reset time for the same inference credential.

Sources:

- [OrcaRouter OpenAI compatibility](https://docs.orcarouter.ai/native-formats/openai-compat) and [free models](https://docs.orcarouter.ai/routing/free-models)
- [Martian quickstart](https://docs.withmartian.com/quickstart) and [OpenAI SDK integration](https://docs.withmartian.com/integrations/openai-sdk)
- [CrofAI documentation](https://crof.ai/docs) and [public model list](https://crof.ai/v1/models)
- [Inceptron documentation](https://docs.inceptron.io)
- [Neuralwatt documentation](https://portal.neuralwatt.com/docs)
- [Baseten Model APIs](https://docs.baseten.co/inference/model-apis/overview) and [pricing and limits](https://docs.baseten.co/inference/model-apis/pricing-and-limits)
- [Replicate predictions](https://replicate.com/docs/topics/predictions/index) and [billing](https://replicate.com/docs/topics/billing/index)
- [fal.ai OpenRouter endpoint](https://fal.ai/docs/model-api-reference/vision-api/openrouter-router)
