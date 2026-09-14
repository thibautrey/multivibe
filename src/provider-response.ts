/** Bounded response consumption shared by Core provider adapters. */
export async function readCoreResponseBytes(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal?.aborted) {
    await response.body?.cancel(signal.reason).catch(() => undefined);
    signal.throwIfAborted();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let rejectAborted!: (reason: unknown) => void;
  let cancellation: Promise<void> | undefined;
  let completed = false;
  let failure: unknown;
  const cancelReader = (reason: unknown): Promise<void> => {
    cancellation ??= reader.cancel(reason).catch(() => undefined);
    return cancellation;
  };
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const onAbort = (): void => {
    void cancelReader(signal?.reason);
    rejectAborted(signal?.reason ?? new DOMException("Operation aborted", "AbortError"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const next = await (signal ? Promise.race([reader.read(), aborted]) : reader.read());
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw new Error("Managed Core response exceeds the configured limit");
      chunks.push(next.value);
    }
    signal?.throwIfAborted();
    completed = true;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!completed) await cancelReader(failure);
    else await cancellation;
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readCoreResponseText(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
): Promise<string> {
  return new TextDecoder().decode(await readCoreResponseBytes(response, maximum, signal));
}

