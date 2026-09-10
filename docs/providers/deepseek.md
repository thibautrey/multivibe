# DeepSeek

MultiVibe uses the connected DeepSeek inference API key to call the official
`GET https://api.deepseek.com/user/balance` endpoint. The account card displays
the returned total available balance and identifies the granted and topped-up
components in the provider's CNY or USD currency.

This is an absolute, spendable API-credit balance. It is intentionally not
converted into a percentage or presented as a recurring subscription quota
window.

Source: [DeepSeek Get User Balance API](https://api-docs.deepseek.com/api/get-user-balance/).
