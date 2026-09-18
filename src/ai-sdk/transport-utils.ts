import { SdkProviderError } from "./model.js";

/** Throw a transport failure that preserves the provider envelope. */
export async function throwResponseError(response: Response): Promise<never> {
  const responseBody = await response.text().catch(() => undefined);
  let data: unknown;
  let message = `Provider request failed (${response.status})`;
  if (responseBody) {
    try {
      data = JSON.parse(responseBody);
      const record = data as Record<string, unknown>;
      const nested = record?.error;
      const candidate = nested && typeof nested === "object"
        ? (nested as Record<string, unknown>).message
        : typeof record?.message === "string"
          ? record.message
          : undefined;
      if (typeof candidate === "string" && candidate.trim()) message = candidate.trim();
    } catch {
      const text = responseBody.trim();
      if (text) message = text.slice(0, 500);
    }
  }
  throw new SdkProviderError(message, { statusCode: response.status, responseBody, data });
}

/** Minimal SSE line reader; yields one line at a time from a fetch body. */
export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        yield buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer.replace(/\r$/, "");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Parsed `data:` payloads from an SSE stream. */
export async function* sseData<T = any>(body: ReadableStream<Uint8Array>): AsyncGenerator<T | "[DONE]"> {
  for await (const line of sseLines(body)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      if (payload === "[DONE]") yield "[DONE]";
      continue;
    }
    try {
      yield JSON.parse(payload) as T;
    } catch {
      // A malformed keepalive/comment line must not kill the stream.
    }
  }
}

/** Parse a tool-call input string, preserving the raw text when it is not JSON. */
export function parseToolInput(value: string): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
