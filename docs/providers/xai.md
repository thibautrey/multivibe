# xAI

MultiVibe's Grok Build connection uses its existing xAI subscription credential
to call the provider's `billing?format=credits` endpoint. That response exposes
an explicit used percentage and reset time for the connected subscription and
is handled by the dedicated xAI quota adapter.

Ordinary xAI API keys are pay-as-you-go credentials. Public xAI documentation
directs users to the management console for prepaid-credit balance and spending
visibility; it does not document an inference-key endpoint with a stable
remaining-credit window. Consequently an API-key descriptor should not claim
subscription quota support or reuse the Grok Build billing endpoint without
evidence that the credential is accepted there.

Sources:

- [xAI billing documentation](https://docs.x.ai/docs/key-information/billing)
- [xAI API key documentation](https://docs.x.ai/docs/key-information/api-key)
