# DeepSeek

MultiVibe uses the connected DeepSeek inference API key to call the official
`GET https://api.deepseek.com/user/balance` endpoint. The account card displays
the returned total available balance and identifies the granted and topped-up
components in the provider's CNY or USD currency.

This is an absolute, spendable API-credit balance. It is intentionally not
converted into a percentage or presented as a recurring subscription quota
window.

Source: [DeepSeek Get User Balance API](https://api-docs.deepseek.com/api/get-user-balance/).

## Model list

The account's model list comes from `GET https://api.deepseek.com/models` with
the connected API key, cached for ten minutes and refreshed in the background, so
a model DeepSeek adds or renames (for example `deepseek-flash` for
DeepSeek-V4.1-Flash) appears without waiting for a new MultiVibe build. The
reviewed catalog of 2026-09-07 remains as metadata and as the fallback when the
endpoint cannot be reached. Entering explicit model IDs in the account overrides
the discovered list.

Source: [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing), which names `deepseek-flash` as DeepSeek-V4.1-Flash.
