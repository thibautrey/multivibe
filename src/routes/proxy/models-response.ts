type ModelWithOptionalCodexInfo = {
  id: string;
  codexModelInfo?: Record<string, unknown>;
  metadata?: {
    provider?: string;
  };
  [key: string]: unknown;
};

export function toOpenAiModelShape(model: ModelWithOptionalCodexInfo) {
  const { codexModelInfo: _codexModelInfo, ...openAiModel } = model;
  return openAiModel;
}

/**
 * Return the native model entry consumed by Codex CLI.
 *
 * OpenAI accounts already provide this object upstream. z.ai exposes an
 * OpenAI-compatible providers expose a model list, so synthesize the small native entry Codex
 * needs to list and select the model while keeping the provider metadata out
 * of the OpenAI-compatible `data` entry.
 */
export function toCodexModelShape(model: ModelWithOptionalCodexInfo) {
  if (model.codexModelInfo) return model.codexModelInfo;
  const provider = model.metadata?.provider;
  if (provider !== "zai" && provider !== "openai-compatible") return undefined;
  // Audio, embedding and reranking runtimes also share /v1/models.
  if (/(?:^|[-_/])(?:tts|asr|whisper|kokoro|embed|embedding|rerank|reranker)(?:$|[-_/])/i.test(model.id)) return undefined;
  const providerName = provider === "zai" ? "z.ai" : "OpenAI-compatible";

  return {
    slug: model.id,
    display_name: model.id,
    description: `${providerName} model ${model.id}`,
    base_instructions: "",
    supported_reasoning_levels: [],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 100,
    support_verbosity: false,
    truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [],
  };
}

/**
 * Serve both model catalog dialects from `/v1/models`.
 *
 * OpenAI-compatible clients read `object` and `data`, while Codex CLI 0.144+
 * reads the native `models` array. Extra top-level fields are ignored by both.
 */
export function buildModelsListResponse(
  exposedModels: ModelWithOptionalCodexInfo[],
) {
  return {
    object: "list" as const,
    data: exposedModels.map(toOpenAiModelShape),
    models: exposedModels.flatMap((model) => {
      const codexModel = toCodexModelShape(model);
      return codexModel ? [codexModel] : [];
    }),
  };
}
