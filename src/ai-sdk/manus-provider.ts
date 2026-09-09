import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { setTimeout as delay } from "node:timers/promises";
import type { UsageSnapshot } from "../types.js";
import { SdkInputError } from "./protocol.js";

export const MANUS_PROVIDER = { id: "manus", name: "Manus", adapter: "manus", baseURL: "https://api.manus.ai/v2" } as const;
export const MANUS_MODELS = ["standard", "lite", "max"].map((id) => ({ id, name: `Manus ${id}`, input: ["text"], tools: false }));
const UNKNOWN_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

async function request(path: string, token: string, signal: AbortSignal, fetchImpl: typeof fetch, body?: unknown) {
  const response = await fetchImpl(`${MANUS_PROVIDER.baseURL}/${path}`, {
    method: body === undefined ? "GET" : "POST", redirect: "error", signal,
    headers: { "x-manus-api-key": token, accept: "application/json", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw Object.assign(new Error(`Manus request failed ${response.status}`), { statusCode: response.status });
  const json = await response.json();
  if (json?.ok !== true) throw new Error("Manus returned an unsuccessful response");
  return json;
}

export function parseManusUsage(payload: unknown): UsageSnapshot {
  const root = payload as any;
  const data = root?.data;
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (root?.ok !== true || !valid(data?.total_credits)) throw new Error("Manus usage response has no valid credit balance");
  const quota = valid(data.pro_monthly_credits) && data.pro_monthly_credits > 0 && valid(data.periodic_credits)
    ? { usedPercent: Math.max(0, Math.min(100, 100 * (1 - data.periodic_credits / data.pro_monthly_credits))),
        ...(valid(data.current_period_end) && data.current_period_end > 0 ? { resetAt: data.current_period_end * 1000 } : {}) }
    : undefined;
  return { balance: { remaining: data.total_credits, unit: "credits" },
    allowances: quota ? [{ ...quota, label: "Subscription credits" }] : undefined,
    fetchedAt: Date.now(), quotaStatus: "available",
    quotaMessage: "Available balance includes all spendable credits. Subscription credits show the current billing-cycle allowance." };
}

export async function fetchManusUsage(token: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<UsageSnapshot> {
  return parseManusUsage(await request("usage.availableCredits", token, signal ?? AbortSignal.timeout(10_000), fetchImpl));
}

/** Each completion is a private asynchronous Manus task, using text history. */
export function createManusModel(token: string, modelId: string, fetchImpl: typeof fetch = fetch, pollMs = 2_000): LanguageModelV4 {
  const generate = async (options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> => {
    if (!MANUS_MODELS.some(({ id }) => id === modelId)) throw new SdkInputError("Choose a Manus profile: standard, lite, or max");
    if (options.tools?.length || options.toolChoice && options.toolChoice.type !== "none" ||
        options.responseFormat?.type === "json" || options.maxOutputTokens !== undefined ||
        options.temperature !== undefined || options.topP !== undefined || options.seed !== undefined ||
        options.frequencyPenalty !== undefined || options.presencePenalty !== undefined || options.stopSequences?.length ||
        options.reasoning !== undefined || options.providerOptions !== undefined) {
      throw new SdkInputError("Manus supports text tasks; LLM tools, sampling, token limits and structured-output controls are not supported");
    }
    const transcript = options.prompt.map((message) => {
      if (message.role === "tool") throw new SdkInputError("Manus does not support client tool messages");
      const text = typeof message.content === "string" ? message.content : message.content.map((part) => {
        if (part.type !== "text") throw new SdkInputError("Manus accepts text-only conversation history");
        return part.text;
      }).join("\n");
      return `${message.role}:\n${text}`;
    }).join("\n\n");
    const signal = AbortSignal.any([AbortSignal.timeout(175_000), ...(options.abortSignal ? [options.abortSignal] : [])]);
    signal.throwIfAborted();
    let taskId: string | undefined;
    let finished = false;
    try {
      const created = await request("task.create", token, signal, fetchImpl, {
        message: { content: transcript, connectors: [] }, agent_profile: modelId,
        share_visibility: "private", interactive_mode: true,
      });
      if (typeof created.task_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(created.task_id)) throw new Error("Manus returned an invalid task ID");
      taskId = created.task_id;
      const taskUrl = `https://manus.im/app/${taskId}`;
      while (true) {
        let cursor: string | undefined;
        let status: string | undefined;
        let text: string | undefined;
        for (let page = 0; page < 20; page++) {
          const params = new URLSearchParams({ task_id: taskId!, order: "desc", limit: "200" });
          if (cursor) params.set("cursor", cursor);
          const result = await request(`task.listMessages?${params}`, token, signal, fetchImpl);
          if (!Array.isArray(result.messages)) throw new Error("Manus returned invalid task messages");
          for (const event of result.messages) {
            if (!status && event?.type === "status_update") status = event.status_update?.agent_status;
            if (text === undefined && event?.type === "assistant_message" && typeof event.assistant_message?.content === "string" && event.assistant_message.content.trim()) text = event.assistant_message.content;
          }
          if (status && text !== undefined || !result.has_more) break;
          if (typeof result.next_cursor !== "string" || !result.next_cursor || result.next_cursor === cursor) throw new Error("Manus returned an invalid pagination cursor");
          cursor = result.next_cursor;
          if (page === 19) throw new Error("Manus task history exceeds the supported page limit");
        }
        if (status === "error") throw new Error(`Manus task failed; inspect ${taskUrl}`);
        if (status === "stopped" || status === "waiting") {
          finished = true;
          const answer = status === "waiting"
            ? `${text ?? "Manus needs your input."}\n\nContinue this task in Manus: ${taskUrl}`
            : text ?? `Manus task completed. View its results: ${taskUrl}`;
          return { content: [{ type: "text", text: answer }], finishReason: { unified: "stop", raw: status },
            usage: UNKNOWN_USAGE, warnings: [], response: { id: taskId }, providerMetadata: { manus: { taskId: taskId!, taskUrl } } };
        }
        await delay(pollMs, undefined, { signal });
      }
    } finally {
      // A timed-out/disconnected completion must not intentionally leave an agent running.
      if (taskId && !finished) {
        await request("task.stop", token, AbortSignal.timeout(5_000), fetchImpl, { task_id: taskId }).catch(() => undefined);
      }
    }
  };
  return {
    specificationVersion: "v4", provider: "manus", modelId, supportedUrls: {}, doGenerate: generate,
    async doStream(options) {
      // Manus returns task events, not token deltas. Buffer the task result and
      // then serialize it through the normal SSE codec without fake token counts.
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
