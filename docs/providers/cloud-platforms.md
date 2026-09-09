# Cloud platform connections

Reviewed September 9, 2026. These connections use provider API keys. They do not accept service-account files or IAM access-key pairs.

| Provider | Setup | Coverage |
| --- | --- | --- |
| AWS Bedrock | Amazon Bedrock API key; optional regional endpoint | OpenAI-compatible Chat Completions. Default `https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1`; runtime and mantle regional hosts are accepted. Starter model `openai.gpt-oss-120b`; add model IDs enabled in your region. |
| Azure AI Foundry | Resource API key, resource endpoint, deployed model names | v1 OpenAI-compatible Chat Completions at `https://RESOURCE.openai.azure.com/openai/v1` or `https://RESOURCE.services.ai.azure.com/openai/v1`. A deployment name is required; the API has no universal deployment catalog. |
| Google Vertex AI (Express) | Vertex AI Express mode API key | Gemini GenerateContent and streaming at `https://aiplatform.googleapis.com/v1/publishers/google`. Standard project/service-account Vertex authentication is not included. |
| Cloudflare Workers AI | Workers AI API token and account-specific endpoint | OpenAI-compatible Chat Completions at `https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1`. Account ID must be 32 hexadecimal characters. Starter model `@cf/meta/llama-3.1-8b-instruct`. |

Endpoint editing accepts only the reviewed service hosts and paths. All connections track request token usage reported by the upstream. Cloud resource quotas and billing require separate management APIs and permissions, so the inference-key connection displays an explicit unsupported quota status. Cloudflare's daily free compute allowance and Vertex's time-limited trial are not represented as invented subscription percentages.

Sources:

- [Bedrock Chat Completions](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions-mantle.html)
- [Foundry v1 API](https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/use-chat-completions)
- [Vertex Express mode](https://cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/overview)
- [Cloudflare OpenAI compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)

Mocked transport tests verify endpoint paths, key headers, model names, token accounting and rejection of untrusted endpoint overrides. Authenticated customer calls have not been made.
