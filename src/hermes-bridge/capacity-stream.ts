/**
 * Invalidation of the bridge's capacity cache from the edge's event stream.
 *
 * The bridge already reuses a capacity reading for `capacityTtlMs` (15 s) so a
 * turn does not pay a probe it does not need. That TTL alone means a turn can
 * spend up to 15 seconds believing the edge is full after it has drained, or
 * free after it has saturated — and the plan asks for both an SSE subscription
 * *and* the 15 s refresh.
 *
 * This is deliberately not a replacement for the probe. A missed event, an
 * unreachable stream or a proxy that buffers quietly degrades to exactly the
 * TTL behaviour we already had; nothing here may ever be required for a turn to
 * be served. It only makes the cache forget sooner when the edge says something
 * changed.
 */

export type CapacityStreamOptions = {
  /** e.g. `https://multivibe.pleiades.solutions/v1/capacity/events` */
  url: string;
  /** Edge request headers, including the Access token and the API key. */
  headers: Record<string, string>;
  /** Called when the edge reports a capacity or admission change. */
  onInvalidate: () => void;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; `setTimeout`-shaped. */
  schedule?: (callback: () => void, delayMs: number) => unknown;
  /** Injected for tests; cancels a `schedule` handle. */
  cancel?: (handle: unknown) => void;
  /**
   * Bounded retry. A stream that keeps failing must not become a hot loop: the
   * TTL already covers correctness, so backing off costs nothing but latency.
   */
  minRetryMs?: number;
  maxRetryMs?: number;
  /** Reported without content, so an operator can see the stream is dead. */
  onError?: (message: string) => void;
};

export type CapacityStream = {
  /** Abort the stream and any pending retry. Idempotent. */
  stop: () => void;
  /** Number of events that caused an invalidation. Content-free. */
  readonly invalidations: number;
  /** Consecutive failures, reset by a successful connection. */
  readonly failures: number;
};

const DEFAULT_MIN_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 60_000;

/**
 * Parse one SSE frame's `event:` name.
 *
 * Only the event name matters here: the payload is a version number the bridge
 * does not need, and reading it would invite logging it.
 */
export function eventNameOf(frame: string): string | undefined {
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      const name = line.slice("event:".length).trim();
      if (name) return name;
    }
  }
  return undefined;
}

/**
 * Split a byte stream into complete SSE frames.
 *
 * Frames are terminated by a blank line. Partial data is retained: a TCP read
 * can split mid-frame, and treating each read as a frame would either miss
 * events or misparse the next one.
 */
export function createFrameSplitter(handle: (frame: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) return;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (frame.trim()) handle(frame);
    }
  };
}

/**
 * Subscribe to the edge's capacity stream.
 *
 * Never throws and never rejects: a bridge that cannot reach its event stream
 * must keep serving turns, so every failure path is a logged retry.
 */
export function subscribeCapacityStream(options: CapacityStreamOptions): CapacityStream {
  const fetchImpl = options.fetchImpl ?? fetch;
  const schedule =
    options.schedule ??
    ((callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      // A retry timer must not keep the process alive. The bridge is a service
      // that is supposed to stop on `SIGTERM`; a pending retry that held the
      // event loop open would make shutdown wait for a connection that is not
      // needed, and in a test runner it would hang the process outright.
      (handle as unknown as { unref?: () => void }).unref?.();
      return handle;
    });
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const minRetry = options.minRetryMs ?? DEFAULT_MIN_RETRY_MS;
  const maxRetry = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
  const controller = new AbortController();
  let stopped = false;
  let retryHandle: unknown;
  let invalidations = 0;
  let failures = 0;

  const fail = (message: string) => {
    failures += 1;
    options.onError?.(message);
    if (stopped) return;
    // Exponential with a ceiling: a dead stream is a slow drip, not a spin.
    const delay = Math.min(minRetry * 2 ** Math.min(failures - 1, 6), maxRetry);
    retryHandle = schedule(() => {
      if (!stopped) void run();
    }, delay);
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    try {
      const response = await fetchImpl(options.url, {
        method: "GET",
        headers: { ...options.headers, accept: "text/event-stream" },
        signal: controller.signal,
        redirect: "error",
      });
      if (stopped) return;
      if (!response.ok || !response.body) {
        // 404 means an edge that predates the stream. The TTL still covers it,
        // so this is not an error worth retrying quickly; the backoff applies.
        fail(`capacity stream refused with ${response.status}`);
        return;
      }
      failures = 0;
      const split = createFrameSplitter((frame) => {
        const name = eventNameOf(frame);
        // `capacity.changed` and `admission.changed` are the same version under
        // two names; either one invalidates. A heartbeat has no event name and
        // must not throw the cache away for nothing.
        if (name === "capacity.changed" || name === "admission.changed") {
          invalidations += 1;
          options.onInvalidate();
        }
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) split(decoder.decode(value, { stream: true }));
        }
      } finally {
        reader.releaseLock();
      }
      if (stopped) return;
      // The edge closed a stream that is supposed to stay open. Treat it like
      // any other transport failure rather than spinning.
      fail("capacity stream closed");
    } catch (error) {
      if (stopped) return;
      const name = (error as { name?: string }).name;
      // An abort during shutdown is not a failure.
      if (name === "AbortError") return;
      fail(String((error as Error).message ?? error));
    }
  };

  void run();

  return {
    stop: () => {
      stopped = true;
      controller.abort();
      if (retryHandle !== undefined) cancel(retryHandle);
    },
    get invalidations() {
      return invalidations;
    },
    get failures() {
      return failures;
    },
  };
}
