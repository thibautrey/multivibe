// Reviewed 2026-09-07. These describe the connected API/OAuth service,
// not a provider's consumer chatbot. Trials do not count as free tiers.
export type AccessFilter = "Paid" | "Free" | "Freemium";
export type ProviderAccess = { paid: boolean; free: boolean; note: string; source: string };
export const PROVIDER_ACCESS: Record<string, ProviderAccess> = {
  manus: { paid: true, free: true, note: "Use a Manus API key. Each text request creates a private agent task; profiles are standard, lite and max. No client tool calls or token streaming. Available credits refresh automatically.", source: "https://open.manus.ai/docs/v2/task.create" },
  "qwen-coding": { paid: true, free: false, note: "Use an international Alibaba Coding Plan key. Quotas refresh where Alibaba accepts API-key access; accounts requiring console sign-in show that limitation.", source: "https://www.alibabacloud.com/help/en/model-studio/coding-plan" },
  kimi: { paid: true, free: false, note: "Use a Moonshot API key. Kimi Code subscription keys use the separate Kimi Code connection.", source: "https://platform.moonshot.ai/docs" },
  "kimi-coding": { paid: true, free: false, note: "Use your Kimi Code subscription key. Subscription usage windows are refreshed automatically.", source: "https://www.kimi.com/code/docs/en/" },
  huggingface: { paid: true, free: true, note: "Use an HF token with Inference Providers permission. Free and subscription compute credits apply; view remaining credits in Hugging Face billing settings.", source: "https://huggingface.co/docs/inference-providers/pricing" },
  abacus: { paid: true, free: false, note: "Use your RouteLLM API key from ChatLLM. Subscription credit checks require a separate browser session and are not available with this key.", source: "https://abacus.ai/help/developer-platform/route-llm/" },
  minimax: { paid: true, free: false, note: "Use a pay-as-you-go MiniMax API key. For subscription quota tracking choose MiniMax Token Plan.", source: "https://platform.minimax.io/docs/guides/pricing-paygo" },
  "minimax-coding": { paid: true, free: false, note: "Use your MiniMax Subscription Key to check five-hour and weekly Token Plan quotas.", source: "https://platform.minimax.io/docs/coding-plan/faq" },
  poe: { paid: true, free: false, note: "API requests use your Poe subscription and add-on points. Your available point balance is refreshed automatically.", source: "https://creator.poe.com/docs/external-applications/openai-compatible-api" },
  openai: { paid: true, free: true, note: "ChatGPT Free includes limited Codex usage; paid plans offer higher limits.", source: "https://developers.openai.com/codex/pricing" },
  "github-copilot": { paid: true, free: true, note: "Copilot Free has limited allowances; paid plans offer more access. Organization policy and model availability apply.", source: "https://github.com/features/copilot/plans" },
  xai: { paid: true, free: false, note: "This connection requires SuperGrok or X Premium+.", source: "https://grok.com/plans" },
  opencode: { paid: true, free: true, note: "Selected Zen models are free; other models and Go plans are paid. Availability can change.", source: "https://opencode.ai/docs/zen/" },
  mistral: { paid: true, free: true, note: "Selected API models are free; other models are billed. Check current model availability.", source: "https://mistral.ai/pricing/api" },
  zai: { paid: true, free: false, note: "Use a GLM Coding Plan subscription key. Model quota windows and MCP allowances are refreshed separately.", source: "https://docs.z.ai/devpack/overview" },
  anthropic: { paid: true, free: false, note: "Claude API usage is billed separately from the consumer chat plans.", source: "https://claude.com/pricing" },
  google: { paid: true, free: true, note: "A limited free API tier is available for selected models and eligible regions; paid tiers offer higher limits.", source: "https://ai.google.dev/gemini-api/docs/pricing" },
  mammouth: { paid: true, free: false, note: "API usage consumes paid credits. Mammouth subscriptions include monthly API credits; pay-as-you-go is also available.", source: "https://info.mammouth.ai/docs/api-quick-start/" },
  openrouter: { paid: true, free: true, note: "Selected :free model variants have limited free access; other models are billed.", source: "https://openrouter.ai/docs/guides/routing/model-variants/free" },
  deepseek: { paid: true, free: false, note: "API tokens are billed; promotional credits are not a recurring free tier.", source: "https://api-docs.deepseek.com/quick_start/pricing" },
  groq: { paid: true, free: true, note: "Free API plan with model-specific limits; paid Developer plan offers higher limits.", source: "https://console.groq.com/docs/rate-limits" },
  togetherai: { paid: true, free: false, note: "Requires purchased credits; no current free trial.", source: "https://docs.together.ai/docs/billing" },
  cerebras: { paid: true, free: false, note: "Only a limited trial: $5 for 30 days with a verified payment method. No recurring free tier.", source: "https://inference-docs.cerebras.ai/support/rate-limits" },
  perplexity: { paid: true, free: false, note: "API usage is billed; consumer subscriptions do not make the API free.", source: "https://docs.perplexity.ai/docs/getting-started/pricing" },
};

export function matchesAccessFilter(id: string, filter: AccessFilter | null): boolean {
  if (!filter) return true;
  const access = PROVIDER_ACCESS[id];
  if (!access) return false;
  return filter === "Paid" ? access.paid : filter === "Free" ? access.free : access.paid && access.free;
}
