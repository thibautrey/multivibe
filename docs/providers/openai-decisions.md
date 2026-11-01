# OpenAI Decisions

MultiVibe exposes `POST /v1/decisions` (also `/decisions`). Configure an OpenAI API account and enable `gpt-6-luna`; SDK account model IDs use `openai/gpt-6-luna`. Custom OpenAI-compatible endpoints can also forward Decisions with `gpt-6-luna`. ChatGPT subscription, Cloud and confidential accounts are not eligible for this endpoint.

```bash
curl http://localhost:3000/v1/decisions \
  -H "Authorization: Bearer $MULTIVIBE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"openai/gpt-6-luna","input":"Please refund the duplicate charge.","questions":[{"type":"predicate","name":"refund","instructions":"Does the customer request a refund?"}]}'
```

Requests preserve text, image and JSON evidence, conversation items, all question types and prompt cache controls. Responses preserve typed answers, probabilities, confidence, refusals and usage. Requests require an explicit model, non-empty input and 1–400 questions. Streaming and deferred execution are unavailable. OpenAI validates the remaining question and input schema.

Usage includes cached and cache-write input tokens. MultiVibe deliberately omits cost estimates for Decisions rather than applying text-generation rates: this endpoint has free output, and input pricing varies with cache policy, context and processing region. Organization admin usage reporting (`/v1/organization/usage/decisions`) remains a direct OpenAI administration API; MultiVibe does not proxy admin API keys.

Reviewed against the [official Decisions guide](https://developers.openai.com/api/docs/guides/decisions) and [pricing](https://developers.openai.com/api/docs/pricing) on 2026-10-28. Validation uses local mock upstreams; it does not establish live account access.
