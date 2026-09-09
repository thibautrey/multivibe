# Kimi

MultiVibe connects to Kimi through its OpenAI-compatible API using an API key from the Kimi API Platform.

## Endpoint and authentication

The global platform uses `https://api.moonshot.ai/v1`. Create a key at [platform.kimi.ai](https://platform.kimi.ai/console/api-keys) and send it as `Authorization: Bearer <key>`.

Kimi also operates a separate China platform. Its keys and endpoint are independent of the global platform, so a `platform.kimi.com` key cannot authenticate against `api.moonshot.ai`. This integration registers the global endpoint only.

## Models

The provider catalog contains the models that Kimi listed as active on September 9, 2026:

- `kimi-k3` (1M-token context)
- `kimi-k2.7-code` (256K-token context)
- `kimi-k2.7-code-highspeed` (256K-token context)
- `kimi-k2.6` (256K-token context)

All four support multimodal input, reasoning, and tool calling. Kimi's authenticated [`GET /v1/models`](https://platform.kimi.ai/docs/api/list-models) endpoint remains the authority for the models available to a particular account.

## Balance and quota

Kimi documents an API-key-authenticated [`GET /v1/users/me/balance`](https://platform.kimi.ai/docs/api/balance) endpoint. It returns available, voucher, and cash balances in USD. These are currency amounts, not a subscription allowance or a percentage usage window; MultiVibe must not invent a utilization percentage from them. A non-positive available balance prevents inference requests.

The provider helper validates this response and exposes its original currency values. Kimi's public documentation does not describe a subscription usage endpoint with a total allowance and reset window, so subscription quota rotation remains unsupported.

That limitation applies to the Open Platform. Kimi Code is a separate membership subscription product with its own API key, endpoint, model IDs, and quota response.

## Kimi Code subscriptions

Kimi's official [Kimi Code documentation](https://www.kimi.com/code/docs/en/) publishes the OpenAI-compatible base URL `https://api.kimi.com/coding/v1` and these model IDs: `k3`, `k3-256k`, `kimi-for-coding`, and `kimi-for-coding-highspeed`. Members create API keys in the [Kimi Code Console](https://www.kimi.com/code/console).

The authenticated `GET https://api.kimi.com/coding/v1/usages` endpoint returns a subscription usage total and shorter rate-limit windows as `limit`, `used`, `remaining`, and `resetTime`. MultiVibe normalizes the total as the weekly window and converts each `used / limit` ratio into a percentage. The published 300-minute limit becomes the five-hour window. An invalid or denominator-free response is rejected rather than estimated.

## Sources

- [Kimi API quickstart](https://platform.kimi.ai/docs/overview)
- [Kimi model list](https://platform.kimi.ai/docs/models)
- [Kimi list-models API](https://platform.kimi.ai/docs/api/list-models)
- [Kimi balance API](https://platform.kimi.ai/docs/api/balance)
- [Kimi Code documentation](https://www.kimi.com/code/docs/en/)
