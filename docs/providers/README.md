# Provider setup and quota coverage

Add connections through **Accounts → Add provider**. API-key providers use fixed reviewed endpoints; subscription products with separate keys have separate picker entries. Model IDs are namespaced by their provider, and account setup accepts additional provider model IDs.

| Provider | Connection | Quota and usage tracking |
| --- | --- | --- |
| [Poe](poe.md) | Poe API key | Plan plus add-on point balance; no invented total or reset |
| [GitHub Copilot](github-copilot.md) | Existing GitHub device sign-in | Premium request and monthly chat quotas when GitHub supplies them |
| [MiniMax](minimax.md) | PAYG API key or separate Token Plan Subscription Key | Token Plan five-hour and weekly windows |
| [OpenRouter](openrouter.md) | Existing API-key provider | Explicit per-key spending cap; not total account credit |
| [Abacus.AI](abacus.md) | RouteLLM API key | Request usage; subscription balance requires separate browser cookies |
| [Manus](manus.md) | Manus API key; private text-agent tasks | Spendable credit balance and informational subscription allowance |
| [Kimi](kimi.md) | Global API key or separate Kimi Code key | Kimi Code five-hour and weekly windows |
| [Hugging Face](huggingface.md) | HF inference token | Request usage; remaining compute credits are not exposed by a documented inference-token endpoint |
| [Mammouth AI](../mammouth.md) | Existing API-key provider | API-key spend and explicit budget if returned |
| [Qwen Coding Plan](qwen.md) | International Alibaba Coding Plan key | Five-hour, weekly and monthly quotas where the console RPC accepts API-key access; explicit browser-session limitation otherwise |
| [Z.AI GLM Coding Plan](zai.md) | Existing native coding key | Existing model quota windows and separate MCP allowance |
| [Perplexity](perplexity.md) | Existing API-key provider | Request usage; consumer subscription balance is not exposed through the inference key |
| [xAI / Grok](xai.md) | Existing Grok Build device sign-in | Existing subscription credit tracking; ordinary xAI API keys can use a custom compatible endpoint |

Quota refreshes use the existing cache and background monitor. Failed probes retain stale readings with a visible error and bounded retry; successful probes clear their own error. Quota windows with hard limits participate in existing routing. Absolute balances and informational allowances remain distinct from percentages so a paid add-on balance is not mistaken for an exhausted subscription.

Provider metadata is maintained separately from the generated models.dev catalog, so catalog refreshes do not remove these integrations. Providers without a bundled icon use the generic provider mark.

The implementation is verified with mocked transports and source-based fixtures, plus API/web builds and repository tests. No authenticated customer inference or quota requests were made. Copilot and Qwen quota endpoints are internal interfaces; MiniMax and Mammouth response schemas partly rely on public client implementations. Account entitlements and those contracts require a live refresh after connecting.

## Additional gateways, inference services and cloud platforms

The following providers are available through API-key setup. Quota probes run in the same background monitor as existing subscriptions, and failures preserve previous readings.

| Provider group | Added connections | Quota coverage |
| --- | --- | --- |
| [Subscription services](expansion-subscriptions.md) | Chutes.ai, Venice AI, Kilo AI Gateway / Kilo Pass, BytePlus Coding Plan, Xiaomi Token Plan (China, Europe, Singapore), Ollama Cloud, Synthetic | Chutes windows, Venice balance, Kilo credit and Pass readings, Synthetic quota lanes. BytePlus, Xiaomi and Ollama show explicit inference-key limitations. |
| [Inference services](expansion-inference.md) | Fireworks AI, DeepInfra, Nebius AI Studio, SambaNova Cloud, SiliconFlow, Novita AI, NVIDIA NIM, Mistral Codestral, Cohere, AI21 Labs | API-key access and upstream request-token accounting; no invented subscription quota. |
| [Gateways and prediction APIs](expansion-gateways.md) | OrcaRouter, Martian, CrofAI, Inceptron, Neuralwatt, Baseten, Replicate, fal.ai | API-key access. Replicate is scoped to the reviewed Llama 3 70B text prediction model, with buffered streaming and no client tools or media. fal uses its `Key` authorization scheme. |
| [Cloud platforms](cloud-platforms.md) | AWS Bedrock, Azure AI Foundry, Google Vertex AI (Express), Cloudflare Workers AI | Provider API keys and validated cloud endpoints. Resource quotas and billing remain in the cloud console. |
| Existing integrations retained | Together AI, Groq, Cerebras, DeepSeek, Mistral AI, OpenCode Go | Existing API-key or native integration; OpenCode Go quota tracking remains active. |

Starter model catalogs are reviewed snapshots, not a promise of account entitlement. Add provider model IDs in account setup or editing; Azure requires your actual deployment names. Replicate accepts only its reviewed prediction schema. Regenerate browser display metadata after changing definitions with `node --import tsx scripts/sync-expanded-provider-metadata.ts`; tests catch stale metadata.
