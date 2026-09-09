import { CATALOGS as INFERENCE_CATALOGS } from "./expansion-inference/index.js";
import { CATALOGS as SUBSCRIPTION_CATALOGS } from "./expansion-subscriptions/index.js";
import { CATALOGS as GATEWAY_CATALOGS } from "./expansion-gateways/index.js";
import type { Account } from "../types.js";
import { SDK_PROVIDERS, sdkProvider } from "./providers.js";
import { MAMMOUTH_CATALOG } from "./mammouth-catalog.js";
import { SDK_CATALOG } from "./catalog.generated.js";
import { POE_MODELS, POE_CATALOG_SOURCE } from "./poe-provider.js";
import { MINIMAX_MODELS } from "./minimax-provider.js";
import { KIMI_MODELS, KIMI_CODING_MODELS } from "./kimi-provider.js";
import { HUGGINGFACE_MODELS, ABACUS_MODELS } from "./additional-providers.js";
import { QWEN_MODELS } from "./qwen-provider.js";
import { MANUS_MODELS } from "./manus-provider.js";
import { CLOUD_PLATFORM_CATALOGS } from "./cloud-platforms.js";

export type SdkCatalogModel = { id: string; name: string; context?: number; output?: number; tools?: boolean; reasoning?: boolean; input: string[]; cost?: Record<string, number> };
export type SdkCatalog = { source: string; fetchedAt: string; models: Record<string, SdkCatalogModel[]> };

const REVIEWED_CATALOGS: Record<string, SdkCatalog> = {
  ...CLOUD_PLATFORM_CATALOGS,
  ...Object.fromEntries(Object.entries({ ...INFERENCE_CATALOGS, ...SUBSCRIPTION_CATALOGS, ...GATEWAY_CATALOGS }).map(([id, catalog]) => [id, { ...catalog, models: { [id]: catalog.models } }])),
  poe: { source: POE_CATALOG_SOURCE, fetchedAt: "2026-09-09T00:00:00.000Z", models: { poe: POE_MODELS } },
  mammouth: MAMMOUTH_CATALOG,
  manus: { source: "https://open.manus.ai/docs/v2/task.create", fetchedAt: "2026-09-09T00:00:00.000Z", models: { manus: MANUS_MODELS } },
  "qwen-coding": { source: "https://www.alibabacloud.com/help/en/model-studio/coding-plan", fetchedAt: "2026-09-09T00:00:00.000Z", models: { "qwen-coding": [...QWEN_MODELS] } },
  kimi: { source: "https://platform.moonshot.ai/docs", fetchedAt: "2026-09-09T00:00:00.000Z", models: { kimi: KIMI_MODELS } },
  "kimi-coding": { source: "https://www.kimi.com/code/docs/en/", fetchedAt: "2026-09-09T00:00:00.000Z", models: { "kimi-coding": KIMI_CODING_MODELS } },
  huggingface: { source: "https://huggingface.co/docs/inference-providers/index", fetchedAt: "2026-09-09T00:00:00.000Z", models: { huggingface: HUGGINGFACE_MODELS } },
  abacus: { source: "https://abacus.ai/help/developer-platform/route-llm/chat-completions/", fetchedAt: "2026-09-09T00:00:00.000Z", models: { abacus: ABACUS_MODELS } },
  minimax: { source: "https://platform.minimax.io/docs/api-reference/text-openai-api", fetchedAt: "2026-09-09T00:00:00.000Z", models: { minimax: [...MINIMAX_MODELS] } },
  "minimax-coding": { source: "https://platform.minimax.io/docs/api-reference/text-openai-api", fetchedAt: "2026-09-09T00:00:00.000Z", models: { "minimax-coding": [...MINIMAX_MODELS] } },
};

function catalogForProvider(id: string) {
  return REVIEWED_CATALOGS[id] ?? SDK_CATALOG;
}

export function sdkProviderCatalog() {
  return { source: SDK_CATALOG.source, fetchedAt: SDK_CATALOG.fetchedAt,
    providers: SDK_PROVIDERS.map(({ id, name, endpointPlaceholder, endpointRequired, credentialLabel, requiresModelSelection }) => ({ id, name, endpointPlaceholder, endpointRequired, credentialLabel, requiresModelSelection, source: catalogForProvider(id).source, fetchedAt: catalogForProvider(id).fetchedAt, models: catalogForProvider(id).models[id] ?? [] })) };
}

export function sdkAccountModels(account: Account) {
  const provider = sdkProvider(account.sdkProvider);
  if (!provider) return [];
  const metadata = catalogForProvider(provider.id);
  const catalog = metadata.models[provider.id] ?? [];
  const selected = account.sdkModels?.length
    ? account.sdkModels.map((id) => catalog.find((model) => model.id === id) ?? { id, name: id, input: ["text"] })
    : catalog;
  return selected.map((model) => ({
    id: `${provider.id}/${model.id}`, object: "model", owned_by: provider.id, created: 0,
    name: model.name, context_window: model.context, max_output_tokens: model.output,
    supports_tools: model.tools, supported_tool_types: model.tools === undefined ? undefined : model.tools ? ["function"] : [],
    supports_reasoning: model.reasoning, input_modalities: model.input, pricing: model.cost,
    catalog_source: metadata.source, catalog_fetched_at: metadata.fetchedAt,
  }));
}

export function sdkModelId(account: Account, requested: string) {
  const prefix = `${account.sdkProvider}/`;
  if (!requested.startsWith(prefix) || requested.length === prefix.length) throw new Error("Model does not belong to this provider");
  const model = requested.slice(prefix.length);
  if (account.sdkModels?.length && !account.sdkModels.includes(model)) throw new Error("Model is not enabled on this account");
  return model;
}
