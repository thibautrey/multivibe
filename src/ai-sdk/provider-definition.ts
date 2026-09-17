import type { ProviderModelCatalogFormat } from "../provider-model-catalog.js";

export type SdkProviderDiscoveryAuth = "bearer" | "key" | "google" | "none";

/** Reviewed connection metadata; never loaded from a remote model catalog. */
export type SdkProviderDefinition = {
  id: string;
  name: string;
  adapter: string;
  baseURL: string;
  headers?: Record<string, string>;
  authScheme?: "Bearer" | "Key";
  includeUsage?: boolean;
  credentialLabel?: string;
  endpointPlaceholder?: string;
  endpointRequired?: boolean;
  requiresModelSelection?: boolean;
  /** Reviewed provider `/models` path, relative to `baseURL`. Present only for
   * adapters whose endpoint is documented to list chat models for the account
   * key; its presence enables live model discovery for that provider. */
  modelsPath?: string;
  /** Response shape served by `modelsPath`; defaults to OpenAI-compatible `data`. */
  modelsFormat?: ProviderModelCatalogFormat;
  /** Credential placement for discovery; defaults to the inference `authScheme`. */
  modelsAuth?: SdkProviderDiscoveryAuth;
  /** Reviewed non-secret headers for discovery requests (for example
   * `anthropic-version`). Secrets never belong here. */
  modelsHeaders?: Record<string, string>;
  /** Runtime models.dev provider id when it differs from this provider id. */
  modelsDevId?: string;
};

/** Optional reviewed discovery metadata shared by provider-group definitions. */
export type SdkProviderDiscoveryMetadata = Pick<
  SdkProviderDefinition,
  "modelsPath" | "modelsFormat" | "modelsAuth" | "modelsHeaders" | "modelsDevId"
>;
