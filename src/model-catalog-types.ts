import type { ProviderId } from "./types.js";

export type ExposedModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  /** Native Codex `/models` entry supplied by the authoritative Rust edge. */
  codexModelInfo?: Record<string, unknown>;
  metadata: {
    provider: ProviderId;
    provider_candidates?: ProviderId[];
    account_ids?: string[];
    context_window: number | null;
    max_output_tokens: number | null;
    supports_reasoning: boolean;
    supports_tools: boolean;
    supported_tool_types: string[];
    is_virtual?: boolean;
    plugin_id?: string;
    is_alias?: boolean;
    alias_targets?: string[];
    catalog_source?: string;
    catalog_fetched_at?: string;
    model_author?: string;
    sdk_provider?: string;
    pricing?: Record<string, number>;
    input_modalities?: string[];
  };
};
