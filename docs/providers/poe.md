# Poe

Poe provides an OpenAI-compatible API at `https://api.poe.com/v1`. MultiVibe
uses the standard compatible adapter and authenticates with a Poe API key as a
Bearer token.

The bundled catalog contains the model IDs used by Poe's official API examples:
`GPT-5.4`, `Claude-Sonnet-4.6`, `Claude-Opus-4.7`, and `Gemini-3.1-Pro`.
Poe's bot availability changes over time, so users can also configure a custom
model ID supported by their account.

Poe's [Usage API](https://creator.poe.com/docs/resources/usage-api) exposes
`GET https://api.poe.com/usage/current_balance` with the same bearer API key.
MultiVibe refreshes and displays `current_point_balance`, which includes both
plan and add-on points. No allowance total or reset date is returned, so this
balance is never converted into an invented percentage. Failed refreshes retain
the last reading and show an error. Request token usage is tracked separately.

Source: [Poe OpenAI Compatible API](https://creator.poe.com/docs/external-applications/openai-compatible-api)
