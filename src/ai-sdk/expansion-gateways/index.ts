import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { setTimeout as delay } from "node:timers/promises";
import type { Account, UsageSnapshot } from "../../types.js";
import { SdkInputError } from "../protocol.js";

export type ExpansionGatewayProvider = {
  id: string;
  name: string;
  adapter: "compatible" | "custom";
  baseURL: string;
  authScheme?: "Bearer" | "Key";
};

/** Fixed endpoints reviewed against the linked provider documentation on 2026-09-09. */
export const PROVIDERS: ExpansionGatewayProvider[] = [
  { id: "orcarouter", name: "OrcaRouter", adapter: "compatible", baseURL: "https://api.orcarouter.ai/v1" },
  { id: "martian", name: "Martian", adapter: "compatible", baseURL: "https://api.withmartian.com/v1" },
  { id: "crofai", name: "CrofAI", adapter: "compatible", baseURL: "https://crof.ai/v1" },
  { id: "inceptron", name: "Inceptron", adapter: "compatible", baseURL: "https://api.inceptron.io/v1" },
  { id: "neuralwatt", name: "Neuralwatt", adapter: "compatible", baseURL: "https://api.neuralwatt.com/v1" },
  { id: "baseten", name: "Baseten", adapter: "compatible", baseURL: "https://inference.baseten.co/v1" },
  { id: "replicate", name: "Replicate", adapter: "custom", baseURL: "https://api.replicate.com/v1" },
  // fal's OpenRouter endpoint uses the OpenAI wire format with `Authorization: Key`, not Bearer.
  { id: "fal", name: "fal.ai", adapter: "compatible", baseURL: "https://fal.run/openrouter/router/openai/v1", authScheme: "Key" },
];

export type ExpansionCatalogModel = {
  id: string;
  name: string;
  input: string[];
  context?: number;
  output?: number;
  tools?: boolean;
  reasoning?: boolean;
};

type ExpansionCatalog = { source: string; fetchedAt: string; models: ExpansionCatalogModel[] };
const fetchedAt = "2026-09-09T00:00:00.000Z";
const text = (id: string, name = id): ExpansionCatalogModel => ({ id, name, input: ["text"] });

export const CATALOGS: Record<string, ExpansionCatalog> = {
  orcarouter: {
    source: "https://docs.orcarouter.ai/getting-started/models",
    fetchedAt,
    models: [text("orcarouter/free", "OrcaRouter Free"), text("orcarouter/fusion", "OrcaRouter Fusion")],
  },
  martian: {
    source: "https://docs.withmartian.com/quickstart",
    fetchedAt,
    models: [text("openai/gpt-4.1-nano", "GPT-4.1 Nano"), text("anthropic/claude-sonnet-4-20250514", "Claude Sonnet 4")],
  },
  crofai: {
    source: "https://crof.ai/v1/models",
    fetchedAt,
    models: [text("greg-2-super", "Greg 2 Super"), text("glm-5.3", "GLM 5.3"), text("kimi-k3", "Kimi K3")],
  },
  inceptron: {
    source: "https://docs.inceptron.io",
    fetchedAt,
    models: [text("zai-org/GLM-5.2", "GLM 5.2"), text("zai-org/GLM-5.3", "GLM 5.3"), text("moonshotai/Kimi-K2.7-Code", "Kimi K2.7 Code")],
  },
  neuralwatt: {
    source: "https://portal.neuralwatt.com/docs",
    fetchedAt,
    models: [text("kimi-k2.7-code", "Kimi K2.7 Code"), text("glm-5.2", "GLM 5.2"), text("deepseek-v4-flash", "DeepSeek V4 Flash")],
  },
  baseten: {
    source: "https://docs.baseten.co/inference/model-apis/overview",
    fetchedAt,
    models: [text("deepseek-ai/DeepSeek-V4-Pro", "DeepSeek V4 Pro"), text("zai-org/GLM-5.2", "GLM 5.2"), text("moonshotai/Kimi-K2.7-Code", "Kimi K2.7 Code")],
  },
  replicate: {
    source: "https://replicate.com/meta/meta-llama-3-70b-instruct",
    fetchedAt,
    models: [{ ...text("meta/meta-llama-3-70b-instruct", "Meta Llama 3 70B Instruct"), context: 8_000 }],
  },
  fal: {
    source: "https://fal.ai/docs/model-api-reference/vision-api/openrouter-router",
    fetchedAt,
    models: [{ ...text("google/gemini-2.5-flash", "Gemini 2.5 Flash"), input: ["text", "image"] }],
  },
};

export const ACCESS: Record<string, { paid: boolean; free: boolean; note: string; source: string }> = {
  orcarouter: { paid: true, free: true, note: "API-key billing; the documented orcarouter/free route has a bounded free tier.", source: "https://docs.orcarouter.ai/routing/free-models" },
  martian: { paid: true, free: false, note: "Gateway API key; public docs do not promise a free inference allowance.", source: "https://docs.withmartian.com/quickstart" },
  crofai: { paid: true, free: false, note: "Pay-per-token API; account creation requires no card, but the site does not promise free inference credit.", source: "https://crof.ai" },
  inceptron: { paid: true, free: false, note: "API-key inference; published pricing is pay as you go.", source: "https://www.inceptron.io/pricing" },
  neuralwatt: { paid: true, free: false, note: "API-key inference; no documented recurring free allowance or key-readable balance.", source: "https://portal.neuralwatt.com/docs" },
  baseten: { paid: true, free: false, note: "Model APIs are usage billed; limits and usage are managed in the Baseten workspace.", source: "https://docs.baseten.co/inference/model-apis/pricing-and-limits" },
  replicate: { paid: true, free: false, note: "Pay-as-you-go prediction jobs; there is no documented generic chat-completions contract.", source: "https://replicate.com/docs/topics/billing/index" },
  fal: { paid: true, free: false, note: "Usage-billed fal endpoint backed by OpenRouter; no documented key-readable allowance.", source: "https://fal.ai/docs/model-api-reference/vision-api/openrouter-router" },
};

/** No provider in this batch documents a stable inference-key quota denominator. */
export const QUOTA_FETCHERS: Record<string, (account: Account, signal: AbortSignal) => Promise<UsageSnapshot>> = {};

const UNKNOWN_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

async function replicateRequest(path: string, token: string, signal: AbortSignal, fetchImpl: typeof fetch, method = "GET", body?: unknown) {
  const response = await fetchImpl(`https://api.replicate.com/v1/${path}`, {
    method, redirect: "error", signal,
    headers: { authorization: `Token ${token}`, accept: "application/json", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw Object.assign(new Error(`Replicate request failed ${response.status}`), { statusCode: response.status });
  return response.json() as Promise<any>;
}

/** Adapter for the verified prompt/output schema of Replicate's official Llama 3 70B Instruct model. */
export function createReplicateModel(token: string, modelId: string, fetchImpl: typeof fetch = fetch, pollMs = 1_000): LanguageModelV4 {
  const generate = async (options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> => {
    const hasProviderOptions = options.providerOptions !== undefined && Object.keys(options.providerOptions).length > 0;
    if (modelId !== "meta/meta-llama-3-70b-instruct") throw new SdkInputError("Choose the reviewed Replicate model meta/meta-llama-3-70b-instruct");
    if (options.tools?.length || options.toolChoice && options.toolChoice.type !== "none" || options.responseFormat?.type === "json" ||
        options.frequencyPenalty !== undefined || options.presencePenalty !== undefined || options.reasoning !== undefined || hasProviderOptions) {
      throw new SdkInputError("This Replicate model supports text prompts and sampling controls; tools, reasoning controls and structured output are not supported");
    }
    const prompt = options.prompt.map((message) => {
      if (message.role === "tool") throw new SdkInputError("Replicate text predictions do not accept client tool messages");
      const content = typeof message.content === "string" ? message.content : message.content.map((part) => {
        if (part.type !== "text") throw new SdkInputError("This Replicate model accepts text-only conversation history");
        return part.text;
      }).join("\n");
      return `${message.role}:\n${content}`;
    }).join("\n\n") + "\n\nassistant:\n";
    const signal = AbortSignal.any([AbortSignal.timeout(175_000), ...(options.abortSignal ? [options.abortSignal] : [])]);
    let predictionId: string | undefined;
    let finished = false;
    try {
      const input: Record<string, unknown> = { prompt };
      if (options.maxOutputTokens !== undefined) input.max_tokens = options.maxOutputTokens;
      if (options.temperature !== undefined) input.temperature = options.temperature;
      if (options.topP !== undefined) input.top_p = options.topP;
      if (options.topK !== undefined) input.top_k = options.topK;
      if (options.seed !== undefined) input.seed = options.seed;
      if (options.stopSequences?.length) input.stop_sequences = options.stopSequences.join(",");
      let prediction = await replicateRequest("models/meta/meta-llama-3-70b-instruct/predictions", token, signal, fetchImpl, "POST", { input });
      if (typeof prediction?.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(prediction.id)) throw new Error("Replicate returned an invalid prediction ID");
      predictionId = prediction.id;
      while (true) {
        if (prediction.status === "succeeded") {
          if (!Array.isArray(prediction.output) || prediction.output.some((part: unknown) => typeof part !== "string")) throw new Error("Replicate returned invalid text output");
          finished = true;
          return { content: [{ type: "text", text: prediction.output.join("") }], finishReason: { unified: "stop", raw: "succeeded" },
            usage: UNKNOWN_USAGE, warnings: [], response: { id: predictionId }, providerMetadata: { replicate: { predictionId } } };
        }
        if (prediction.status === "failed" || prediction.status === "canceled") throw new Error(`Replicate prediction ${prediction.status}${typeof prediction.error === "string" ? `: ${prediction.error}` : ""}`);
        if (prediction.status !== "starting" && prediction.status !== "processing") throw new Error("Replicate returned an unknown prediction status");
        await delay(pollMs, undefined, { signal });
        prediction = await replicateRequest(`predictions/${predictionId}`, token, signal, fetchImpl);
      }
    } finally {
      if (predictionId && !finished) await replicateRequest(`predictions/${predictionId}/cancel`, token, AbortSignal.timeout(5_000), fetchImpl, "POST").catch(() => undefined);
    }
  };
  return {
    specificationVersion: "v4", provider: "replicate", modelId, supportedUrls: {}, doGenerate: generate,
    async doStream(options) {
      const result = await generate(options);
      return { stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "answer" });
        for (const part of result.content) if (part.type === "text") controller.enqueue({ type: "text-delta", id: "answer", delta: part.text });
        controller.enqueue({ type: "text-end", id: "answer" });
        controller.enqueue({ type: "finish", usage: result.usage, finishReason: result.finishReason });
        controller.close();
      } }) };
    },
  };
}

export function createFalModel(token: string, model: string, fetchImpl: typeof fetch = fetch): LanguageModelV4 {
  const keyAuthFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Key ${token}`);
    return fetchImpl(input, { ...init, headers });
  };
  return createOpenAICompatible({
    name: "fal",
    apiKey: "fal-key-auth-is-applied-by-fetch-wrapper",
    baseURL: "https://fal.run/openrouter/router/openai/v1",
    fetch: keyAuthFetch,
    includeUsage: true,
  }).languageModel(model);
}
