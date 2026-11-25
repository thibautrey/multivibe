import assert from "node:assert/strict";
import test from "node:test";
import { HeadroomEdgeClient, normalizeCompressionUrl } from "./headroom-edge-client.js";

test("a base URL is normalized to the compress endpoint", () => {
  assert.equal(normalizeCompressionUrl("http://headroom:8787"), "http://headroom:8787/v1/compress");
  assert.equal(normalizeCompressionUrl("http://headroom:8787/"), "http://headroom:8787/v1/compress");
  assert.equal(normalizeCompressionUrl("https://headroom.test/v1/compress"), "https://headroom.test/v1/compress");
  assert.equal(normalizeCompressionUrl("http://headroom:8787/custom/"), "http://headroom:8787/custom");
  assert.equal(normalizeCompressionUrl("  http://headroom:8787  "), "http://headroom:8787/v1/compress");
});

test("credentials, non-HTTP schemes and query strings are rejected", () => {
  assert.equal(normalizeCompressionUrl("http://user:pass@headroom:8787"), null);
  assert.equal(normalizeCompressionUrl("ftp://headroom:8787"), null);
  assert.equal(normalizeCompressionUrl("file:///etc/passwd"), null);
  assert.equal(normalizeCompressionUrl("not a url"), null);
  assert.equal(normalizeCompressionUrl("http://headroom:8787?x=1"), null);
  assert.equal(normalizeCompressionUrl(""), null);
});

function recordingRequest(response: { status?: number; body?: unknown; reject?: string }) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    if (response.reject) throw new Error(response.reject);
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { request, calls };
}

test("the client pushes and clears the contract over the internal route", async () => {
  const { request, calls } = recordingRequest({
    body: {
      enabled: true,
      url: "http://headroom:8787/v1/compress",
      mode: "lossy_inline",
      timeoutMs: 1500,
      minBytes: 2048,
      configError: null,
    },
  });
  const client = new HeadroomEdgeClient({ baseUrl: "http://edge.test/", token: "internal-secret", request });

  const applied = await client.apply({
    url: "http://headroom:8787/v1/compress",
    token: "proxy-token",
    mode: "lossy_inline",
    timeoutMs: 1500,
    minBytes: 2048,
  });
  assert.equal(applied.enabled, true);
  assert.deepEqual(calls.at(-1), {
    url: "http://edge.test/internal/v1-edge/compression",
    method: "PUT",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-multivibe-internal-token": "internal-secret",
    },
    body: {
      url: "http://headroom:8787/v1/compress",
      token: "proxy-token",
      mode: "lossy_inline",
      timeoutMs: 1500,
      minBytes: 2048,
    },
  });

  await client.clear();
  assert.equal(calls.at(-1)?.method, "DELETE");
  assert.equal(calls.at(-1)?.body, null);

  await client.status();
  assert.equal(calls.at(-1)?.method, "GET");
});

test("an edge rejection surfaces the server message", async () => {
  const { request } = recordingRequest({
    status: 400,
    body: { error: "unsupported mode", code: "invalid_compression_config" },
  });
  const client = new HeadroomEdgeClient({ baseUrl: "http://edge.test", token: "internal-secret", request });
  await assert.rejects(
    client.apply({ url: "http://headroom:8787/v1/compress", timeoutMs: 1000, minBytes: 0 }),
    /unsupported mode/u,
  );
});

test("a missing internal token fails before any request is sent", async () => {
  const { request, calls } = recordingRequest({});
  const client = new HeadroomEdgeClient({ baseUrl: "http://edge.test", token: "", request });
  assert.equal(client.available, false);
  await assert.rejects(client.status(), /V1_EDGE_INTERNAL_JOB_TOKEN/u);
  assert.equal(calls.length, 0);
});
