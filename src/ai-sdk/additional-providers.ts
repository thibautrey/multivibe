import type { SdkCatalogModel } from "./catalog.js";

// Reviewed against the linked official provider documentation on 2026-09-09.
export const HUGGINGFACE_PROVIDER = {
  id: "huggingface", name: "Hugging Face", adapter: "compatible",
  baseURL: "https://router.huggingface.co/v1",
} as const;
export const ABACUS_PROVIDER = {
  id: "abacus", name: "Abacus.AI", adapter: "compatible",
  baseURL: "https://routellm.abacus.ai/v1",
} as const;

export const HUGGINGFACE_MODELS: SdkCatalogModel[] = [
  { id: "openai/gpt-oss-120b", name: "GPT OSS 120B", input: ["text"] },
];
export const ABACUS_MODELS: SdkCatalogModel[] = [
  "route-llm", "gpt-5.4", "claude-sonnet-4-6", "gemini-3.1-pro",
].map((id) => ({ id, name: id === "route-llm" ? "RouteLLM" : id, input: ["text"] }));
