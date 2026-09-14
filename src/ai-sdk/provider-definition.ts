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
};
