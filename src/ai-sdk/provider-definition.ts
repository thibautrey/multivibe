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
};
