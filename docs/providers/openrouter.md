# OpenRouter

OpenRouter exposes metadata for the currently authenticated inference key at
`GET https://openrouter.ai/api/v1/key`. MultiVibe calls that endpoint with the
same Bearer API key used for inference.

When the response supplies finite `limit` and `limit_remaining` values,
MultiVibe represents that key-specific spending cap as subscription credits.
When both values are `null`, the key is unlimited and no finite quota window is
invented. The endpoint's `usage` fields are cumulative spend counters and do
not establish the user's account balance, so they are not treated as quotas.

The `GET /api/v1/credits` endpoint reports account credits but requires a
management key. MultiVibe does not request or store a second, more privileged
credential for quota polling. Free-model request caps and platform rate limits
also are not returned as proactive windows by `/api/v1/key`; 429 responses stay
in the normal upstream error path.

Source: [OpenRouter API credit and rate limits](https://openrouter.ai/docs/api-reference/limits)
