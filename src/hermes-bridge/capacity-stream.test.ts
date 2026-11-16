import assert from "node:assert/strict";
import test from "node:test";

import { createFrameSplitter, eventNameOf, subscribeCapacityStream } from "./capacity-stream.js";
import { createBridge } from "./server.js";
import { DEFAULT_BRIDGE_CONFIG } from "./config.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test("a frame split across reads is not lost and not double-counted", () => {
  const frames: string[] = [];
  const split = createFrameSplitter((frame) => frames.push(frame));
  // A TCP read can land anywhere, including mid-word and mid-terminator.
  split("event: admission.cha");
  split("nged\ndata: {}\n");
  split("\n");
  assert.deepEqual(frames, ["event: admission.changed\ndata: {}"]);
});

test("an event name is read without touching the payload", () => {
  assert.equal(eventNameOf("event: capacity.changed\ndata: {\"version\":3}"), "capacity.changed");
  assert.equal(eventNameOf("id: 3\ndata: {}"), undefined);
  assert.equal(eventNameOf("event:\n"), undefined, "an empty name is not a name");
});

test("a heartbeat does not throw the cache away", async () => {
  let invalidations = 0;
  const stream = subscribeCapacityStream({
    url: "https://edge.example/v1/capacity/events",
    headers: {},
    onInvalidate: () => { invalidations += 1; },
    // Only a bare keepalive comment and an unnamed frame, then close.
    fetchImpl: async () => new Response(streamOf([": keepalive\n\n", "data: {}\n\n"]), { status: 200 }),
    schedule: () => undefined,
    cancel: () => undefined,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  stream.stop();
  assert.equal(invalidations, 0, "nothing changed, so nothing was invalidated");
});

test("both event names invalidate, since they carry the same version", async () => {
  let invalidations = 0;
  const stream = subscribeCapacityStream({
    url: "https://edge.example/v1/capacity/events",
    headers: {},
    onInvalidate: () => { invalidations += 1; },
    fetchImpl: async () => new Response(streamOf([
      "id: 1\nevent: capacity.changed\ndata: {\"version\":1}\n\n",
      "id: 2\nevent: admission.changed\ndata: {\"version\":2}\n\n",
    ]), { status: 200 }),
    schedule: () => undefined,
    cancel: () => undefined,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  stream.stop();
  assert.equal(invalidations, 2);
});

test("a refused stream is a logged retry, never a thrown error", async () => {
  const errors: string[] = [];
  let retried = 0;
  const stream = subscribeCapacityStream({
    url: "https://edge.example/v1/capacity/events",
    headers: {},
    onInvalidate: () => undefined,
    // An edge that predates the stream answers 404 to the path.
    fetchImpl: async () => new Response("not found", { status: 404 }),
    schedule: (callback) => { retried += 1; void callback; },
    cancel: () => undefined,
    onError: (message) => errors.push(message),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  stream.stop();
  assert.equal(errors.length >= 1, true);
  assert.match(errors[0] ?? "", /404/);
  assert.equal(retried >= 1, true, "it reschedules instead of giving up or spinning");
});

test("the access headers are sent, so the stream is not anonymous", async () => {
  const seen: Record<string, string> = {};
  const stream = subscribeCapacityStream({
    url: "https://edge.example/v1/capacity/events",
    headers: { "CF-Access-Client-Id": "id", authorization: "Bearer key" },
    onInvalidate: () => undefined,
    fetchImpl: async (_url, init) => {
      Object.assign(seen, init?.headers ?? {});
      return new Response(streamOf([]), { status: 200 });
    },
    schedule: () => undefined,
    cancel: () => undefined,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  stream.stop();
  assert.equal(seen["CF-Access-Client-Id"], "id");
  assert.equal(seen.authorization, "Bearer key");
  assert.equal(seen.accept, "text/event-stream");
});

test("stopping aborts the request, so shutdown does not leak a connection", async () => {
  let aborted = false;
  const stream = subscribeCapacityStream({
    url: "https://edge.example/v1/capacity/events",
    headers: {},
    onInvalidate: () => undefined,
    fetchImpl: async (_url, init) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; });
      // Never resolves on its own: models a stream that stays open.
      return await new Promise<Response>(() => undefined);
    },
    schedule: () => undefined,
    cancel: () => undefined,
  });
  stream.stop();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(aborted, true);
});

test("a pending retry never keeps the process alive", async () => {
  // Observed for real: a failing stream retried forever and the test runner hung
  // for minutes. The default retry timer is unref'd so a service — or a test —
  // can still exit while a retry is pending.
  const stream = subscribeCapacityStream({
    url: "https://edge.example/v1/capacity/events",
    headers: {},
    onInvalidate: () => undefined,
    fetchImpl: async () => new Response("down", { status: 503 }),
    onError: () => undefined,
    // No injected `schedule` or `cancel`: exercise the real default, which is
    // the one that hung. If the timer were ref'd, this file would never finish.
    minRetryMs: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(stream.failures >= 1, true, "the stream did attempt and fail");
  stream.stop();
});

test("a stream event makes the next turn probe instead of trusting the cache", async () => {
  // The wiring, not the parser: a 15 s-old reading is acceptable, but one the
  // edge has explicitly declared obsolete is not. Without this the plan's
  // "SSE + 15 s refresh" is only half implemented.
  const encoder = new TextEncoder();
  let push: ((chunk: string) => void) | undefined;
  let probes = 0;
  const bridge = createBridge({
    config: { ...DEFAULT_BRIDGE_CONFIG, mappings: [], capacityStream: true },
    secrets: { edgeApiKey: "k" },
    mappings: [{ from: "hermes-4-405b", edge: "edge-hermes", nous: "nous-hermes" }],
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.endsWith("/capacity/events")) {
        return new Response(new ReadableStream({
          start(controller) {
            push = (chunk) => controller.enqueue(encoder.encode(chunk));
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (target.endsWith("/admission")) {
        probes += 1;
        return new Response(JSON.stringify({ decision: "admit" }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    },
  });

  await withBridge(bridge, async (baseUrl) => {
    const post = () =>
      fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.localKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "hermes-4-405b", messages: [] }),
      });
    // First turn probes and caches.
    await post();
    assert.equal(probes, 1);
    // A second turn inside the TTL reuses the reading.
    await post();
    assert.equal(probes, 1, "the reading was reused");
    // The edge says something changed...
    push?.("id: 2\nevent: admission.changed\ndata: {\"version\":2}\n\n");
    await new Promise((resolve) => setTimeout(resolve, 30));
    // ...so the next turn asks again instead of acting on a stale reading.
    await post();
    assert.equal(probes, 2, "the event expired the cache");
  });
});

/** Minimal listen/close, matching the helper the server tests use. */
async function withBridge(
  bridge: ReturnType<typeof createBridge>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    bridge.server.once("error", reject);
    bridge.server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = bridge.server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
  }
}

test("closing the bridge closes its stream, so shutdown does not hang", async () => {
  let opened = 0;
  const bridge = createBridge({
    config: { ...DEFAULT_BRIDGE_CONFIG, mappings: [], capacityStream: true },
    secrets: { edgeApiKey: "k" },
    mappings: [{ from: "hermes-4-405b", edge: "edge-hermes", nous: "nous-hermes" }],
    fetchImpl: async (url) => {
      if (String(url).endsWith("/capacity/events")) {
        opened += 1;
        // Stays open until aborted, like a real SSE connection.
        return await new Promise<Response>(() => undefined);
      }
      return new Response(JSON.stringify({ decision: "admit" }), { status: 200 });
    },
  });
  await withBridge(bridge, async (baseUrl) => {
    await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.localKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "hermes-4-405b", messages: [] }),
    });
    assert.equal(opened, 1, "the first turn subscribed");
    assert.notEqual(bridge.capacityStream(), undefined);
  });
  // `withBridge` closed the server; the stream must have gone with it.
  assert.equal(bridge.capacityStream(), undefined, "closed with its server");
});
