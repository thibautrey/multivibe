# Provider invoices

Reviewed 2026-09-11. `src/provider-invoices.ts` is the complete capability registry, including explicit exclusions. The Invoices page uses only configured connections. Disabled connections still qualify: disabling inference does not erase billing history. Local runtimes and arbitrary compatible endpoints do not identify a billing vendor.

## What is retrieved

| Connection | Implementation | Evidence and limits |
| --- | --- | --- |
| MultiVibe Cloud | Server-side `GET /client/v1/billing/invoices?limit=100`, existing OAuth `billing:read` | Cloud's `src/app.ts` and `src/stripe-billing-repository.ts`. Only `environment=live`, `financialEnvironment=live`, non-draft invoices with valid USD amounts qualify. Empty/test/shadow accounts never create the menu entry. Invoice amount is `amountDueMinor`, not a credit balance or estimated usage. Current PostgreSQL projection does not persist document URLs, so rows fall back to Cloud billing when a URL is absent. |
| DeepInfra | API-key `GET https://api.deepinfra.com/payment/invoices`, up to four pages of 50 | [List Invoices](https://docs.deepinfra.com/api-reference/billing/list-invoices.md) documents Bearer auth and cursor pagination. The schema has integer totals but **no currency or unit definition**: display available documents and let the document provide the authoritative amount. Missing permission/schema/network errors retain the portal. No authenticated customer invoice was accessed in development. |
| Fireworks | Billing portal | [firectl billing list-invoices](https://docs.fireworks.ai/tools-sdks/firectl/commands/billing-list-invoices.md) exists, but needs a Fireworks account ID, which this inference-key connection does not store. The page does not install or execute an external CLI or guess an undocumented REST response. [Billing model](https://docs.fireworks.ai/faq-new/billing-pricing/how-does-billing-and-credit-usage-work.md). |

Only fixed provider origins receive credentials. Billing-page links never include credentials, and server errors never return raw upstream bodies. Document links accept HTTPS Stripe document/portal hosts only. Invoices from other hosts remain accessible through the provider billing portal. Reads are bounded; pagination beyond the bound is visibly linked to the full history. Team access is checked server-side for owner/admin/billing; ordinary members and unverified contexts receive 403.

## Portal audit

Portal-only means a billing destination is available, **not** a claim that the vendor has no billing API. Management credentials, browser sessions and organizational billing access differ from inference credentials. No browser cookies are imported or replayed. Dashboard destinations that require choosing an organization or opening account settings include short navigation guidance rather than a fabricated account ID.

Public destination checks followed login redirects, without signing in. A 200/login response confirms reachability, not that a customer has invoices or that every authenticated menu label is unchanged. Cloudflare-protected pages, organization-specific screens and app-store receipts require user-side verification. See the registry for exact destinations and guidance.

| Provider | Invoice/billing route or audit reference |
| --- | --- |
| ChatGPT (`openai`) | ChatGPT Settings → Billing → Manage → Invoice history. Consumer subscription, not OpenAI API billing. Mobile purchases use original-store receipts. |
| GitHub Copilot | Personal billing/payment information; organizations use their own billing account. |
| Grok Build (`xai`) | Grok subscription settings; X Premium+ or mobile purchases use their original billing store. Never the unrelated xAI API console. |
| OpenCode Zen / Go | OpenCode Console workspace → Billing; [Zen docs](https://opencode.ai/docs/zen/). |
| Mistral, Codestral | Mistral organization's billing page; organization sign-in required. |
| Z.AI Coding Plan | [Official FAQ](https://docs.z.ai/devpack/faq) links `z.ai/manage-apikey/billing`; Coding Plan and ordinary API billing remain distinct. |
| Anthropic API | Claude Platform billing; not Claude consumer subscription settings. |
| Gemini, Vertex Express | Google Cloud billing account → Documents. Project/inference key does not grant billing-document access. |
| AWS Bedrock | AWS Billing → Bills, usually requiring payer account permission. |
| Azure Foundry | Azure billing account → Invoices, requiring billing scope. |
| Cloudflare Workers AI | Account → Billing → Invoices; account selection required. |
| OpenRouter | [FAQ](https://openrouter.ai/docs/faq): Credits → Payment history → Stripe invoice portal. |
| DeepSeek | Platform billing/payment history; authenticated portal. |
| Groq | [Billing FAQs](https://console.groq.com/docs/billing-faqs); billing URL redirects to `/settings/billing/manage`. |
| Together AI | [Billing](https://docs.together.ai/docs/billing-credits) links current organization billing; payment methods & invoices. |
| Perplexity API | [FAQ](https://docs.perplexity.ai/docs/resources/faq.md) explicitly documents Invoice history → Invoices and the API Console billing link. |
| Nebius AI Studio | Studio now redirects to Token Factory; [billing](https://docs.tokenfactory.nebius.com/other-capabilities/billing-new.md) distinguishes card charges and bank-transfer invoices. Not the separate AI Cloud console. |
| SambaNova | Cloud dashboard, organization's billing settings. |
| SiliconFlow | Cloud console, billing/payment history; regional account login required. |
| Novita | Console billing (public console links `/billing`). |
| Cohere | Dashboard billing, preserved by login redirect. |
| AI21 | Studio organization's billing settings. |
| Venice | Account subscription/API purchase settings. Direct `/settings/billing` returned 404, so the app entry point is used. Balance/usage APIs are not invoice APIs. |
| Kilo | App account billing for Gateway credits / Kilo Pass; sign-in required. |
| BytePlus Coding Plan | Finance console; choose the billing account used for Coding Plan. |
| Ollama Cloud | Settings → Manage subscription → billing history. Local Ollama is excluded. |
| Synthetic | Account billing/subscription management. |
| Baseten | [Billing documentation](https://docs.baseten.co/organization/billing.md) explicitly links billing with past invoices/payments. Management usage summaries are not invoices. |
| Replicate | [Billing docs](https://replicate.com/docs/topics/billing) → account billing → Manage billing. |
| fal.ai | Billing URL redirects to `/dashboard/usage-billing/billing`. [Account billing API](https://fal.ai/docs/platform-apis/v1/account/billing.md) returns credits, not invoice documents. |
| Poe | Settings → Manage subscription; mobile purchases use original-store receipts. Points API is not invoices. |
| MiniMax API / Token Plan | Platform payment balance / Token Plan pages. [FAQ](https://platform.minimax.io/docs/coding-plan/faq) publishes the separate Token Plan billing route. |
| Kimi API | Moonshot platform redirects to Kimi platform; use API account billing. |
| Kimi Code | Code Console subscription management, separate from API account billing. |
| Hugging Face | [Billing docs](https://huggingface.co/docs/hub/billing) explicitly links `/settings/billing/invoices`. |
| Abacus | ChatLLM profile's subscription management, not unrelated developer-platform usage. |
| Qwen Coding Plan | International Alibaba expenses/invoices portal; the configured plan is international. |
| Manus | Account settings/billing history; available credits are not invoices. |
| Mammouth | Account subscription/billing management; API balances are not invoices. |
| Cerebras | Organization billing in Cloud console. |

## Explicitly unresolved or inapplicable

These provider types are fully accounted for in the registry but do not create an invoice source until a correct destination is established:

- Chutes: subscription/usage endpoints established; invoice retrieval/destination not established by this audit.
- Xiaomi MiMo Token Plan China, Europe and Singapore: region-specific invoice access not established. Do not route regional credentials to another region.
- OrcaRouter: BYOK charges are upstream; a gateway invoice destination was not established.
- Martian, CrofAI, Inceptron and Neuralwatt: public invoice destination/schema not established. Public doc discovery yielded unavailable or non-invoice responses; no claim that these vendors never issue invoices.
- NVIDIA NIM: hosted evaluation versus enterprise licensing/vendor contract; no universal invoice portal for this connection.
- NVIDIA PAIR and custom OpenAI-compatible endpoints: no unique billing vendor.

## Validation boundaries

Automated tests cover complete picker coverage, configured-only gating, credential redaction, role authorization, Cloud live/empty/error distinctions, money and document validation, DeepInfra pagination and failures. The local demo uses fictional provider connections and portal links; it never retrieves customer invoices or fabricates a Cloud invoice to force navigation visibility. Real customer permissions, provider portal contents and native Host packaging were not exercised by these tests.
