import type { SdkCatalogModel } from "./catalog.js";

/** Alibaba ModelStudio Coding Plan's dedicated international endpoint. */
export const QWEN_PROVIDER = {
  id: "qwen-coding",
  name: "Qwen Coding Plan (Alibaba)",
  adapter: "compatible",
  baseURL: "https://coding-intl.dashscope.aliyuncs.com/v1",
} as const;

export const QWEN_CODING_PLAN_CHINA_BASE_URL = "https://coding.dashscope.aliyuncs.com/v1";

/** Exact Coding Plan model IDs published by Alibaba and Qwen Code on 2026-09-09. */
export const QWEN_MODELS = [
  { id: "qwen3.7-plus", name: "Qwen3.7 Plus", context: 1_000_000, tools: true, reasoning: true, input: ["text"] },
  { id: "qwen3.6-plus", name: "Qwen3.6 Plus", context: 1_000_000, tools: true, reasoning: true, input: ["text", "image", "video"] },
  { id: "qwen3.5-plus", name: "Qwen3.5 Plus", context: 1_000_000, tools: true, reasoning: true, input: ["text", "image", "video"] },
  { id: "qwen3-max-2026-01-23", name: "Qwen3 Max 2026-01-23", context: 262_144, tools: true, reasoning: true, input: ["text"] },
  { id: "qwen3-coder-next", name: "Qwen3 Coder Next", context: 262_144, tools: true, input: ["text"] },
  { id: "qwen3-coder-plus", name: "Qwen3 Coder Plus", context: 1_000_000, tools: true, input: ["text"] },
  { id: "glm-5", name: "GLM-5", context: 202_752, tools: true, reasoning: true, input: ["text"] },
  { id: "glm-4.7", name: "GLM-4.7", context: 202_752, tools: true, reasoning: true, input: ["text"] },
  { id: "kimi-k2.5", name: "Kimi K2.5", context: 262_144, tools: true, reasoning: true, input: ["text", "image", "video"] },
  { id: "MiniMax-M2.5", name: "MiniMax M2.5", context: 196_608, tools: true, reasoning: true, input: ["text"] },
] as const satisfies readonly SdkCatalogModel[];
