# Perplexity

Perplexity authenticates its Sonar API with a Bearer API key. Its public API
reference documents inference, model, search, and asynchronous request
endpoints, but does not document an endpoint that lets an inference key read
the account's remaining purchased credits or subscription allowance.

MultiVibe therefore does not poll a proactive subscription quota for
Perplexity. Request token usage can still be recorded from inference responses,
and billing or rate-limit failures remain available to normal upstream error
handling. The API key must not be sent to an inferred dashboard or billing URL.

Sources:

- [Perplexity API reference](https://docs.perplexity.ai/api-reference)
- [Perplexity API rate limits and usage tiers](https://docs.perplexity.ai/guides/usage-tiers)
