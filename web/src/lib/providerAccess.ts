// Reviewed 2026-09-07. These describe the connected API/OAuth service,
// not a provider's consumer chatbot. Trials do not count as free tiers.
export type AccessFilter = "Paid" | "Free" | "Freemium";
export type ProviderAccess = { paid: boolean; free: boolean; note: string; source: string };
export const PROVIDER_ACCESS: Record<string, ProviderAccess> = {
  openai: { paid: true, free: true, note: "ChatGPT Free includes limited Codex usage; paid plans offer higher limits.", source: "https://developers.openai.com/codex/pricing" },
  xai: { paid: true, free: false, note: "This connection requires SuperGrok or X Premium+.", source: "https://grok.com/plans" },
  opencode: { paid: true, free: true, note: "Selected Zen models are free; other models and Go plans are paid. Availability can change.", source: "https://opencode.ai/docs/zen/" },
  mistral: { paid: true, free: true, note: "Selected API models are free; other models are billed. Check current model availability.", source: "https://mistral.ai/pricing/api" },
  zai: { paid: true, free: true, note: "Selected GLM Flash models are free; other models are billed.", source: "https://docs.z.ai/guides/overview/pricing" },
  anthropic: { paid: true, free: false, note: "Claude API usage is billed separately from the consumer chat plans.", source: "https://claude.com/pricing" },
  google: { paid: true, free: true, note: "A limited free API tier is available for selected models and eligible regions; paid tiers offer higher limits.", source: "https://ai.google.dev/gemini-api/docs/pricing" },
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
