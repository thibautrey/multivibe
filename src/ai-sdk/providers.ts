import { POE_PROVIDER } from "./poe-provider.js";
import { MINIMAX_PROVIDER, MINIMAX_CODING_PROVIDER } from "./minimax-provider.js";
import { KIMI_PROVIDER, KIMI_CODING_PROVIDER } from "./kimi-provider.js";
import { HUGGINGFACE_PROVIDER, ABACUS_PROVIDER } from "./additional-providers.js";
import { QWEN_PROVIDER } from "./qwen-provider.js";
import { MANUS_PROVIDER } from "./manus-provider.js";

/** Only installed, reviewed adapters can be selected. Catalog data never loads code or endpoints. */
export const SDK_PROVIDERS = [
  POE_PROVIDER,
  MINIMAX_PROVIDER,
  MINIMAX_CODING_PROVIDER,
  KIMI_PROVIDER,
  KIMI_CODING_PROVIDER,
  HUGGINGFACE_PROVIDER,
  ABACUS_PROVIDER,
  QWEN_PROVIDER,
  MANUS_PROVIDER,
  { id: "anthropic", name: "Anthropic", adapter: "anthropic", baseURL: "https://api.anthropic.com/v1" },
  { id: "google", name: "Google Gemini", adapter: "google", baseURL: "https://generativelanguage.googleapis.com/v1beta" },
  { id: "mammouth", name: "Mammouth AI", adapter: "compatible", baseURL: "https://api.mammouth.ai/v1" },
  { id: "openrouter", name: "OpenRouter", adapter: "compatible", baseURL: "https://openrouter.ai/api/v1" },
  { id: "deepseek", name: "DeepSeek", adapter: "compatible", baseURL: "https://api.deepseek.com" },
  { id: "groq", name: "Groq", adapter: "compatible", baseURL: "https://api.groq.com/openai/v1" },
  { id: "togetherai", name: "Together AI", adapter: "compatible", baseURL: "https://api.together.xyz/v1" },
  { id: "cerebras", name: "Cerebras", adapter: "compatible", baseURL: "https://api.cerebras.ai/v1" },
  { id: "perplexity", name: "Perplexity", adapter: "compatible", baseURL: "https://api.perplexity.ai" },
] as const;

export type SdkProviderId = (typeof SDK_PROVIDERS)[number]["id"];
export function sdkProvider(id: unknown) {
  return SDK_PROVIDERS.find((provider) => provider.id === id);
}

export function validateSdkAccount(account: { id?: unknown; sdkProvider?: unknown; sdkModels?: unknown; accessToken?: unknown; baseUrl?: unknown }) {
  if (account.id !== undefined && (typeof account.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(account.id))) throw new Error("Invalid provider account ID");
  if (!sdkProvider(account.sdkProvider)) throw new Error("Choose a supported cloud provider");
  if (typeof account.accessToken !== "string" || !account.accessToken.trim()) throw new Error("API key required");
  if (account.baseUrl) throw new Error("SDK providers use their registered endpoint; use a custom endpoint account for other servers");
  if (account.sdkModels !== undefined && (!Array.isArray(account.sdkModels) || account.sdkModels.length > 200 ||
      account.sdkModels.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(id)))) {
    throw new Error("Models must be a list of at most 200 provider model IDs");
  }
}
