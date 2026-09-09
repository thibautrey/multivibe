import { createHash } from "node:crypto";
import { createChatStreamAccumulator, convertChatCompletionSSEToResponseSSE } from "../responses/converters.js";
import { providerTokenUsage } from "./usage.js";
import type { ExecutionGrant } from "./authorization.js";
import type { ExecutionReceipt } from "./journal.js";

/** Drains provider evidence even when the client cancels or stops reading. Memory
 * is bounded: slow clients lose their stream, never the billing receipt. */
export function managedProviderStream(options: {
  response: Response; grant: ExecutionGrant; receipt: ExecutionReceipt; maximumBytes: number;
  finish: (receipt: ExecutionReceipt) => Promise<void>; clock: () => number;
}): { response: Response; receipt: Promise<ExecutionReceipt> } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const output = new ReadableStream<Uint8Array>({
    start(value) { controller = value; }, cancel() { cancelled = true; },
  }, { highWaterMark: 256 * 1024, size: chunk => chunk.byteLength });
  const send = (value: string) => {
    if (cancelled || !value) return;
    const bytes = Buffer.from(value);
    if ((controller.desiredSize ?? 0) < bytes.byteLength) {
      cancelled = true; controller.error(Error("managed_stream_consumer_too_slow")); return;
    }
    controller.enqueue(bytes);
  };
  const receipt = (async () => {
    const reader = options.response.body!.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const hash = createHash("sha256");
    const state = createChatStreamAccumulator(options.grant.model);
    let pending = "", length = 0, done = false, invalid = false;
    const usage: { value: ReturnType<typeof providerTokenUsage> } = { value: null };
    const frame = (text: string) => {
      const data = text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (!data) return;
      if (done) { invalid = true; return; }
      if (data === "[DONE]") done = true;
      else {
        const payload = JSON.parse(data);
        if (!payload || payload.object !== "chat.completion.chunk" || payload.error) throw Error("invalid_provider_stream");
        // A tier reported on an earlier chunk must not disappear when the
        // final usage chunk omits it or reports a different tier.
        if (payload.service_tier !== undefined && payload.service_tier !== "default") invalid = true;
        if (payload.usage !== undefined && payload.usage !== null) {
          const next = providerTokenUsage(payload, options.grant.maximumOutputTokens);
          if (!next || (usage.value && JSON.stringify(usage.value) !== JSON.stringify(next))) invalid = true;
          usage.value = next;
          state.usage = payload.usage;
        }
        payload.model = options.grant.model;
        text = `data: ${JSON.stringify(payload)}`;
      }
      send(options.grant.operation === "responses"
        ? convertChatCompletionSSEToResponseSSE(text, state) ?? "" : `${text}\n\n`);
    };
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > options.maximumBytes) throw Error("provider_stream_too_large");
        hash.update(next.value);
        pending += decoder.decode(next.value, { stream: true });
        for (;;) {
          const delimiter = /\r?\n\r?\n/.exec(pending);
          if (!delimiter) break;
          frame(pending.slice(0, delimiter.index));
          pending = pending.slice(delimiter.index + delimiter[0].length);
        }
        if (pending.length > 1024 * 1024) throw Error("provider_stream_frame_too_large");
      }
      pending += decoder.decode();
      if (pending.trim()) invalid = true;
      options.receipt.responseSha256 = hash.digest("hex");
      if (done && !invalid && usage.value) {
        options.receipt.usage = { ...usage.value };
        options.receipt.state = "completed";
      }
    } catch {
      await reader.cancel().catch(() => undefined);
      invalid = true;
    } finally { reader.releaseLock(); }
    options.receipt.finishedAt = options.clock();
    try { await options.finish(options.receipt); }
    catch (error) { if (!cancelled) { cancelled = true; controller.error(Error("receipt_persistence_failed")); } throw error; }
    if (!cancelled) {
      if (!done || invalid) controller.error(Error("provider_stream_incomplete"));
      else controller.close();
    }
    return options.receipt;
  })();
  // Install a handler immediately; callers await this promise for settlement.
  void receipt.catch(() => undefined);
  return { response: new Response(output, { headers: { "content-type": "text/event-stream" } }), receipt };
}
