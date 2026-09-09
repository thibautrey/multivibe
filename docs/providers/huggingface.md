# Hugging Face

Choose **Hugging Face** and enter a User Access Token permitted to make Inference Providers calls. Requests use `https://router.huggingface.co/v1/chat/completions`. The starter catalog uses the official `openai/gpt-oss-120b` example; additional supported model IDs, including provider suffixes such as `:groq`, can be entered in account setup.

Free and paid accounts receive compute credits. The current [pricing documentation](https://huggingface.co/docs/inference-providers/pricing) directs users to billing settings for remaining credits. The public [Hub OpenAPI schema](https://huggingface.co/.well-known/openapi.json) contains usage reporting routes but does not establish an inference-token endpoint for remaining subscription compute credits. MultiVibe therefore uses API-key access and local request telemetry, with an explicit unsupported quota message.

This connection bills the token owner's account. Organization billing headers and custom provider-key billing are not configured here.

Source: [Inference Providers quickstart](https://huggingface.co/docs/inference-providers/index).
