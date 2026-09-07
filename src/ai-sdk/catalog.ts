import type { Account } from "../types.js";
import { SDK_PROVIDERS, sdkProvider } from "./providers.js";
import { SDK_CATALOG } from "./catalog.generated.js";

export type SdkCatalogModel = { id: string; name: string; context?: number; output?: number; tools: boolean; reasoning: boolean; input: string[]; cost?: Record<string, number> };
export type SdkCatalog = { source: string; fetchedAt: string; models: Record<string, SdkCatalogModel[]> };

export function sdkProviderCatalog() {
  return { source: SDK_CATALOG.source, fetchedAt: SDK_CATALOG.fetchedAt,
    providers: SDK_PROVIDERS.map(({ id, name }) => ({ id, name, models: SDK_CATALOG.models[id] ?? [] })) };
}

export function sdkAccountModels(account: Account) {
  const provider = sdkProvider(account.sdkProvider);
  if (!provider) return [];
  const catalog = SDK_CATALOG.models[provider.id] ?? [];
  const selected = account.sdkModels?.length
    ? account.sdkModels.map((id) => catalog.find((model) => model.id === id) ?? { id, name: id, input: ["text"] })
    : catalog;
  return selected.map((model) => ({
    id: `${provider.id}/${model.id}`, object: "model", owned_by: provider.id, created: 0,
    name: model.name, ...("context" in model ? { context_window: model.context, max_output_tokens: model.output,
      supports_tools: model.tools, supported_tool_types: model.tools ? ["function"] : [], supports_reasoning: model.reasoning,
      input_modalities: model.input, pricing: model.cost } : {}),
    catalog_source: SDK_CATALOG.source, catalog_fetched_at: SDK_CATALOG.fetchedAt,
  }));
}

export function sdkModelId(account: Account, requested: string) {
  const prefix = `${account.sdkProvider}/`;
  if (!requested.startsWith(prefix) || requested.length === prefix.length) throw new Error("Model does not belong to this provider");
  const model = requested.slice(prefix.length);
  if (account.sdkModels?.length && !account.sdkModels.includes(model)) throw new Error("Model is not enabled on this account");
  return model;
}
