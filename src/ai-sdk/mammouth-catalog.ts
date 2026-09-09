import type { SdkCatalog } from "./catalog.js";

// Reviewed against Mammouth's API documentation on 2026-09-09.
// Kept separate from models.dev so SDK catalog refreshes preserve this provider.
// Only text-generation IDs are included. Limits, capabilities and prices are
// omitted because the documentation does not provide stable per-model metadata.
export const MAMMOUTH_CATALOG: SdkCatalog = {
  source: "https://info.mammouth.ai/docs/api-quick-start/",
  fetchedAt: "2026-09-09T00:00:00.000Z",
  models: { mammouth: [
    "mammouth-recommended",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.3-chat",
    "gpt-5.1",
    "mistral-medium-3.1",
    "mistral-small-2603",
    "grok-4.3",
    "gemini-3.1-flash-lite-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-pro-preview",
    "glm-5.2",
    "glm-5.1",
    "minimax-m3",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "kimi-k2.6",
    "llama-4-maverick",
    "llama-4-scout",
    "sonar-pro",
    "sonar-deep-research",
    "claude-haiku-4-5",
    "claude-opus-4.7",
    "claude-sonnet-4-6",
  ].map((id) => ({ id, name: id === "mammouth-recommended" ? "Mammouth Recommended" : id, input: ["text"] })) },
};
