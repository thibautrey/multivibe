import type { Account, UsageSnapshot } from "../../types.js";

export type ExpansionInferenceProvider = {
  id: string;
  name: string;
  adapter: "compatible" | "anthropic";
  baseURL: string;
};

export type ExpansionInferenceModel = {
  id: string;
  name: string;
  input: string[];
  context?: number;
  output?: number;
  tools?: boolean;
  reasoning?: boolean;
  cost?: Record<string, number>;
};

export type ExpansionInferenceCatalog = {
  source: string;
  fetchedAt: string;
  models: ExpansionInferenceModel[];
};

export type ExpansionInferenceAccess = {
  paid: boolean;
  free: boolean;
  note: string;
  source: string;
};

// Reviewed against the linked provider documentation on 2026-09-09. These are
// hosted API roots, not self-hosted NIM or model-specific deployment URLs.
export const PROVIDERS: ExpansionInferenceProvider[] = [
  { id: "fireworks", name: "Fireworks AI", adapter: "compatible", baseURL: "https://api.fireworks.ai/inference/v1" },
  { id: "deepinfra", name: "DeepInfra", adapter: "compatible", baseURL: "https://api.deepinfra.com/v1/openai" },
  { id: "nebius", name: "Nebius AI Studio", adapter: "compatible", baseURL: "https://api.studio.nebius.ai/v1" },
  { id: "sambanova", name: "SambaNova Cloud", adapter: "compatible", baseURL: "https://api.sambanovacloud.com/v1" },
  { id: "siliconflow", name: "SiliconFlow", adapter: "compatible", baseURL: "https://api.siliconflow.com/v1" },
  { id: "novita", name: "Novita AI", adapter: "compatible", baseURL: "https://api.novita.ai/openai/v1" },
  { id: "nvidia-nim", name: "NVIDIA NIM", adapter: "compatible", baseURL: "https://integrate.api.nvidia.com/v1" },
  { id: "codestral", name: "Mistral Codestral", adapter: "compatible", baseURL: "https://codestral.mistral.ai/v1" },
  { id: "cohere", name: "Cohere", adapter: "compatible", baseURL: "https://api.cohere.ai/compatibility/v1" },
  { id: "ai21", name: "AI21 Labs", adapter: "compatible", baseURL: "https://api.ai21.com/studio/v1" },
];

const fetchedAt = "2026-09-09T00:00:00.000Z";
const model = (id: string, name = id): ExpansionInferenceModel => ({ id, name, input: ["text"] });

export const CATALOGS: Record<string, ExpansionInferenceCatalog> = {
  fireworks: { source: "https://docs.fireworks.ai/tools-sdks/openai-compatibility", fetchedAt, models: [model("accounts/fireworks/models/llama-v3p1-8b-instruct", "Llama 3.1 8B Instruct")] },
  deepinfra: { source: "https://api.deepinfra.com/models/list", fetchedAt, models: [model("deepseek-ai/DeepSeek-R1-0528-Turbo", "DeepSeek R1 0528 Turbo")] },
  nebius: { source: "https://docs.tokenfactory.nebius.com/ai-models-inference/models", fetchedAt, models: [model("Qwen/Qwen3-235B-A22B-Instruct-2507", "Qwen3 235B A22B Instruct 2507")] },
  sambanova: { source: "https://docs.sambanova.ai/docs/en/models/sambacloud-models", fetchedAt, models: [model("Meta-Llama-3.3-70B-Instruct", "Llama 3.3 70B Instruct")] },
  siliconflow: { source: "https://docs.siliconflow.com/en/userguide/quickstart", fetchedAt, models: [model("deepseek-ai/DeepSeek-R1", "DeepSeek R1")] },
  novita: { source: "https://docs.novita.ai/api-reference/model-apis-llm-list-models", fetchedAt, models: [model("meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B Instruct")] },
  "nvidia-nim": { source: "https://build.nvidia.com/openai/gpt-oss-120b", fetchedAt, models: [model("openai/gpt-oss-120b", "GPT OSS 120B")] },
  codestral: { source: "https://docs.mistral.ai/capabilities/code_generation", fetchedAt, models: [model("codestral-25-08", "Codestral 25.08")] },
  cohere: { source: "https://docs.cohere.com/v2/docs/compatibility-api", fetchedAt, models: [model("command-a-plus-05-2026", "Command A Plus 05-2026")] },
  ai21: { source: "https://docs.ai21.com/reference/jamba-1-6-api-ref", fetchedAt, models: [model("jamba-large", "Jamba Large")] },
};

export const ACCESS: Record<string, ExpansionInferenceAccess> = {
  fireworks: { paid: true, free: false, note: "Usage is metered; limited promotional credit is a trial, not a free tier.", source: "https://fireworks.ai/pricing" },
  deepinfra: { paid: true, free: false, note: "Pay-as-you-go service; promotional or trial credit is not a free tier.", source: "https://deepinfra.com/pricing" },
  nebius: { paid: true, free: false, note: "Metered inference; account or regional trial credit is not a free tier.", source: "https://studio.nebius.com/pricing" },
  sambanova: { paid: true, free: true, note: "Free and paid cloud plans have separate, model-specific rate limits.", source: "https://cloud.sambanova.ai/plans/pricing" },
  siliconflow: { paid: true, free: true, note: "The catalog includes paid and explicitly marked free models; limits vary by model.", source: "https://cloud.siliconflow.com/models" },
  novita: { paid: true, free: false, note: "Usage is credit-metered; account-specific signup credit is a trial, not a free tier.", source: "https://novita.ai/pricing" },
  "nvidia-nim": { paid: true, free: false, note: "The hosted build API offers evaluation access; evaluation access is not a free production tier.", source: "https://build.nvidia.com/explore/discover" },
  codestral: { paid: true, free: false, note: "Codestral is metered; experimental access is excluded from free-tier availability.", source: "https://mistral.ai/pricing" },
  cohere: { paid: true, free: false, note: "Trial keys are rate-limited and restricted; production keys use paid billing.", source: "https://docs.cohere.com/docs/rate-limits" },
  ai21: { paid: true, free: false, note: "Metered API access; account-specific trial credit is not a free tier.", source: "https://www.ai21.com/pricing" },
};

// No reviewed provider above documents a stable API-key endpoint that exposes
// account credit/quota state. Request-token accounting remains available in the
// normal transport, while billing dashboards remain the source of truth.
export const QUOTA_FETCHERS: Record<string, (account: Account, signal: AbortSignal) => Promise<UsageSnapshot>> = {};
