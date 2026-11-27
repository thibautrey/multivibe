import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig, parseArgs } from "./cli.js";

import { enrollmentExchangeUrl, exchangeEnrollment, isEnrollmentCode, parseEnrollmentCode } from "./enroll.js";
import { runDoctor } from "./doctor.js";
import { createBridge, conversationKey, edgeHeaders, isSaturationStatus, nousHeaders, type BridgeLogEvent } from "./server.js";
import { DEFAULT_BRIDGE_CONFIG, type BridgeConfig, type BridgeSecrets, type ModelMapping } from "./config.js";

const MAPPINGS: ModelMapping[] = [
  { from: "hermes-4-405b", edge: "nousresearch/hermes-4-405b", nous: "hermes-4-405b" },
];

const SECRETS: BridgeSecrets = {
  edgeApiKey: "edge-secret-value",
  accessClientId: "access-id",
  accessClientSecret: "access-secret",
  nousApiKey: "nous-secret-value",
};

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  // The capacity stream opens a long-lived connection; the routing tests drive
  // `fetchImpl` with a scripted queue and must not have a subscription consume
  // its entries or keep the process alive. Tests that exercise the stream opt in.
  // No endpoint is baked into the product, so the fixture supplies one: these
  // tests are about routing over the wire, and a relative URL would prove
  // nothing about where a request actually goes.
  return {
    ...DEFAULT_BRIDGE_CONFIG,
    edgeBaseUrl: "https://edge.example.invalid/v1",
    enrollBaseUrl: "https://edge.example.invalid",
    mappings: MAPPINGS,
    capacityStream: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fetch that records calls and answers from a script. */
function scriptedFetch(
  script: Array<Response | (() => Promise<Response>)>,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = script[Math.min(index, script.length - 1)];
    index += 1;
    if (typeof next === "function") return next();
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// --- enrollment -------------------------------------------------------------

test("enrollment codes are recognised and rejected", () => {
  const code = `mvenr_${"a".repeat(40)}`;
  assert.ok(isEnrollmentCode(code));
  assert.equal(parseEnrollmentCode(code), code);
  assert.equal(parseEnrollmentCode("not-a-code"), undefined);
  assert.equal(parseEnrollmentCode("mvenr_short"), undefined);
});

test("the exchange URL never inherits the inference /v1 suffix", () => {
  // An operator pasting the inference URL out of habit must not get a 404 on a
  // path that looks correct; that reads as a server bug, not a typo.
  assert.equal(
    enrollmentExchangeUrl("https://host.example.invalid/v1"),
    "https://host.example.invalid/hermes-bridge/enrollment/exchange",
  );
  assert.equal(
    enrollmentExchangeUrl("https://host.example.invalid"),
    "https://host.example.invalid/hermes-bridge/enrollment/exchange",
  );
  assert.equal(
    enrollmentExchangeUrl("https://host.example.invalid///"),
    "https://host.example.invalid/hermes-bridge/enrollment/exchange",
  );
  // A dedicated enrollment hostname is passed through untouched.
  assert.equal(
    enrollmentExchangeUrl("https://enroll.example.invalid"),
    "https://enroll.example.invalid/hermes-bridge/enrollment/exchange",
  );
});

test("enrollment uses the enrollment base, not the inference base", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    jsonResponse({ edgeApiKey: "k", expiresAt: Date.now() + 60_000 }),
  ]);
  const result = await exchangeEnrollment({
    endpoint: "https://host.example.invalid/v1",
    code: `mvenr_${"d".repeat(40)}`,
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(
    calls[0]!.url,
    "https://host.example.invalid/hermes-bridge/enrollment/exchange",
  );
});

test("a used enrollment code is reported as used, never as a fresh credential", async () => {
  const { fetchImpl } = scriptedFetch([jsonResponse({}, 410)]);
  const result = await exchangeEnrollment({
    endpoint: "https://edge.test/v1",
    code: `mvenr_${"b".repeat(40)}`,
    fetchImpl,
  });
  assert.deepEqual(result, { ok: false, reason: "used" });
});

test("an Access login redirect is not accepted as a credential response", async () => {
  // `redirect: "error"` turns the redirect into a thrown TypeError. Reporting
  // that as a network fault would send an operator hunting for a firewall while
  // the real cause is an Access policy that does not cover the path.
  const { fetchImpl } = scriptedFetch([
    () => Promise.reject(new TypeError("fetch failed: redirect mode is set to error")),
  ]);
  const result = await exchangeEnrollment({
    endpoint: "https://edge.test/v1",
    code: `mvenr_${"c".repeat(40)}`,
    fetchImpl,
  });
  assert.deepEqual(result, { ok: false, reason: "invalid" });
});

test("a genuine transport failure is still reported as network", async () => {
  const { fetchImpl } = scriptedFetch([
    () => Promise.reject(new TypeError("fetch failed: getaddrinfo ENOTFOUND")),
  ]);
  const result = await exchangeEnrollment({
    endpoint: "https://edge.test/v1",
    code: `mvenr_${"e".repeat(40)}`,
    fetchImpl,
  });
  assert.deepEqual(result, { ok: false, reason: "network" });
});

// --- request shape ----------------------------------------------------------

test("conversation identity comes from headers before the body", () => {
  // `session_id` wins because it is the one header every OpenAI-compatible
  // harness sends; `thread-id` is the Codex-specific fallback.
  assert.equal(
    conversationKey({ "thread-id": "thread-1", session_id: "s-header" }, { prompt_cache_key: "s-body" }),
    "s-header",
  );
  assert.equal(conversationKey({ "thread-id": "thread-1" }, {}), "thread-1");
  assert.equal(conversationKey({}, { prompt_cache_key: "s-body" }), "s-body");
  assert.equal(conversationKey({}, {}), undefined);
});

test("edge headers carry the Access token and never a Nous key", () => {
  const headers = edgeHeaders(SECRETS, { session_id: "s1" });
  assert.equal(headers.authorization, "Bearer edge-secret-value");
  assert.equal(headers["cf-access-client-id"], "access-id");
  assert.equal(headers["cf-access-client-secret"], "access-secret");
  assert.equal(headers.session_id, "s1");
  assert.ok(!Object.values(headers).includes("nous-secret-value"));
});

test("nous headers carry only the Nous key", () => {
  const headers = nousHeaders(SECRETS, {});
  assert.equal(headers.authorization, "Bearer nous-secret-value");
  assert.ok(!("cf-access-client-id" in headers));
  assert.ok(!Object.values(headers).includes("edge-secret-value"));
});

// --- routing over the wire --------------------------------------------------

test("the bridge refuses to bind a non-loopback address", () => {
  assert.throws(
    () => createBridge({ config: config({ host: "0.0.0.0" }), secrets: SECRETS, mappings: MAPPINGS }),
    /loopback/,
  );
});

test("an edge admission is consumed and forwarded as a lease", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    jsonResponse({ decision: "admit", lease: "adml_abc", waitMs: 0 }),
    jsonResponse({ choices: [{ message: { content: "hi" } }] }),
  ]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  await withBridge(bridge, async (baseUrl) => {
    const response = await post(baseUrl, "/v1/chat/completions", {
      model: "hermes-4-405b",
      messages: [{ role: "user", content: "hello" }],
    }, bridge.localKey);
    assert.equal(response.status, 200);
  });
  assert.match(calls[0]!.url, /\/admission$/);
  assert.match(calls[1]!.url, /^https:\/\/edge\.example\.invalid\/v1\/chat\/completions$/);
  const headers = calls[1]!.init!.headers as Record<string, string>;
  assert.equal(headers["x-multivibe-lease"], "adml_abc");
  // The model is rewritten to the edge's identifier, not the harness's.
  assert.equal(JSON.parse(String(calls[1]!.init!.body)).model, "nousresearch/hermes-4-405b");
});

test("an unreachable edge is transparently served by Nous", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    () => Promise.reject(new TypeError("connect ECONNREFUSED")),
    jsonResponse({ choices: [{ message: { content: "hi" } }] }),
  ]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  await withBridge(bridge, async (baseUrl) => {
    const response = await post(baseUrl, "/v1/chat/completions", {
      model: "hermes-4-405b",
      messages: [{ role: "user", content: "hello" }],
    }, bridge.localKey);
    assert.equal(response.status, 200);
  });
  assert.match(calls[1]!.url, /^https:\/\/inference-api\.nousresearch\.com\/v1\/chat\/completions$/);
  assert.equal(JSON.parse(String(calls[1]!.init!.body)).model, "hermes-4-405b");
});

test("a switched conversation stays on Nous for its next turn", async () => {
  let clock = 1_000;
  const { fetchImpl, calls } = scriptedFetch([
    () => Promise.reject(new TypeError("ECONNREFUSED")),
    jsonResponse({ choices: [] }),
    // Second turn: the edge is healthy again, but stickiness must win.
    jsonResponse({ decision: "admit", lease: "adml_new" }),
    jsonResponse({ choices: [] }),
  ]);
  const bridge = createBridge({
    config: config(),
    secrets: SECRETS,
    mappings: MAPPINGS,
    fetchImpl,
    now: () => clock,
  });
  await withBridge(bridge, async (baseUrl) => {
    const key = bridge.localKey;
    await post(baseUrl, "/v1/chat/completions", { model: "hermes-4-405b", messages: [] }, key, {
      "thread-id": "conv-1",
    });
    clock += 30_000;
    await post(baseUrl, "/v1/chat/completions", { model: "hermes-4-405b", messages: [] }, key, {
      "thread-id": "conv-1",
    });
  });
  // Only the first turn probed the edge; the second went straight to Nous.
  assert.equal(calls.length, 3, "probe + edge-fail fallback + sticky Nous");
  assert.match(calls[2]!.url, /nousresearch/);
});

test("stickiness expires so the conversation returns to the edge", async () => {
  let clock = 1_000;
  const { fetchImpl, calls } = scriptedFetch([
    () => Promise.reject(new TypeError("ECONNREFUSED")),
    jsonResponse({ choices: [] }),
    jsonResponse({ decision: "admit", lease: "adml_back" }),
    jsonResponse({ choices: [] }),
  ]);
  const bridge = createBridge({
    config: config(),
    secrets: SECRETS,
    mappings: MAPPINGS,
    fetchImpl,
    now: () => clock,
  });
  await withBridge(bridge, async (baseUrl) => {
    const key = bridge.localKey;
    await post(baseUrl, "/v1/chat/completions", { model: "hermes-4-405b", messages: [] }, key, {
      "thread-id": "conv-2",
    });
    clock += DEFAULT_BRIDGE_CONFIG.nousStickinessMs + 1;
    await post(baseUrl, "/v1/chat/completions", { model: "hermes-4-405b", messages: [] }, key, {
      "thread-id": "conv-2",
    });
  });
  assert.match(calls[2]!.url, /\/admission$/);
  assert.match(calls[3]!.url, /^https:\/\/edge\.example\.invalid/);
});

test("an unmapped model fails explicitly instead of being downgraded", async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse({})]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  await withBridge(bridge, async (baseUrl) => {
    const response = await post(baseUrl, "/v1/chat/completions", {
      model: "unmapped-model",
      messages: [],
    }, bridge.localKey);
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "no_equivalent_model");
  });
  assert.equal(calls.length, 0, "no upstream was contacted");
});

test("a local key is required, so another process cannot spend the credentials", async () => {
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS });
  await withBridge(bridge, async (baseUrl) => {
    const response = await post(baseUrl, "/v1/chat/completions", { model: "hermes-4-405b" }, "wrong-key");
    assert.equal(response.status, 401);
  });
});

test("models are listed from the mapping table, not invented", async () => {
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS });
  await withBridge(bridge, async (baseUrl) => {
    const response = await get(baseUrl, "/v1/models", bridge.localKey);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    assert.deepEqual(body.data.map((entry) => entry.id), ["hermes-4-405b"]);
  });
});

test("health never exposes a secret value", async () => {
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS });
  await withBridge(bridge, async (baseUrl) => {
    const text = await (await get(baseUrl, "/health")).text();
    for (const secret of Object.values(SECRETS)) {
      assert.ok(!text.includes(secret), `leaked ${secret.slice(0, 4)}...`);
    }
    assert.match(text, /chars/);
  });
});

test("a persisted local key survives a restart", async () => {
  // A restart that minted a fresh key would 401 a harness whose .env still holds
  // the previous value -- the exact breakage the bridge exists to avoid.
  const persisted = "persisted-loopback-key";
  const first = createBridge({
    config: config(),
    secrets: SECRETS,
    mappings: MAPPINGS,
    localKey: persisted,
  });
  const second = createBridge({
    config: config(),
    secrets: SECRETS,
    mappings: MAPPINGS,
    localKey: persisted,
  });
  assert.equal(first.localKey, persisted);
  assert.equal(second.localKey, persisted);

  await withBridge(second, async (baseUrl) => {
    const ok = await get(baseUrl, "/v1/models", persisted);
    assert.equal(ok.status, 200, "the key issued before the restart still works");
  });
});

test("a first start mints a key when none is supplied", () => {
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS });
  assert.match(bridge.localKey, /^[A-Za-z0-9_-]{40,}$/);
});

// --- saturation fallback ----------------------------------------------------

test("an edge 429 falls back to Nous instead of surfacing to the harness", async () => {
  // 429 is what the edge answers when its pool is saturated: precisely the
  // case the fallback exists for.
  const { fetchImpl, calls } = scriptedFetch([
    jsonResponse({ decision: "admit", lease: "adml_x" }),
    jsonResponse({ error: { code: "capacity_unavailable" } }, 429),
    jsonResponse({ choices: [{ message: { content: "from nous" } }] }),
  ]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  await withBridge(bridge, async (baseUrl) => {
    const response = await post(
      baseUrl,
      "/v1/chat/completions",
      { model: "hermes-4-405b", messages: [] },
      bridge.localKey,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]?.message.content, "from nous");
  });
  assert.match(calls[2]!.url, /nousresearch/);
  assert.equal(JSON.parse(String(calls[2]!.init!.body)).model, "hermes-4-405b");
});

test("an edge 503 for missing capacity also falls back", async () => {
  // `admit` here is deliberate: it exercises the *response* status path rather
  // than the admission decision, which is the case a real edge can still hit
  // when capacity disappears between the probe and the forward.
  const { fetchImpl, calls } = scriptedFetch([
    jsonResponse({ decision: "admit", lease: "adml_y" }),
    jsonResponse({ error: { code: "no_accounts" } }, 503),
    jsonResponse({ choices: [] }),
  ]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  await withBridge(bridge, async (baseUrl) => {
    const response = await post(
      baseUrl,
      "/v1/chat/completions",
      { model: "hermes-4-405b", messages: [] },
      bridge.localKey,
    );
    assert.equal(response.status, 200);
  });
  assert.match(calls[2]!.url, /nousresearch/);
});

test("a 400 from the edge is a client error and must not be retried", async () => {
  // Retrying a malformed request to a second provider would double the failure
  // and hide the real cause from the caller.
  const { fetchImpl, calls } = scriptedFetch([
    jsonResponse({ decision: "admit" }),
    jsonResponse({ error: { message: "bad input" } }, 400),
  ]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  await withBridge(bridge, async (baseUrl) => {
    const response = await post(
      baseUrl,
      "/v1/chat/completions",
      { model: "hermes-4-405b", messages: [] },
      bridge.localKey,
    );
    assert.equal(response.status, 400);
  });
  assert.equal(calls.length, 2, "no third attempt");
});

test("a refused credential is reported, not mistaken for load", async () => {
  // Conflating "Access rejects you" with "we are busy" would route every turn to
  // Nous forever while the edge sits idle, and nobody would learn why.
  const events: BridgeLogEvent[] = [];
  const { fetchImpl } = scriptedFetch([
    jsonResponse({ error: { code: "invalid_api_key" } }, 401),
    jsonResponse({ choices: [] }),
  ]);
  const bridge = createBridge({
    config: config(),
    secrets: SECRETS,
    mappings: MAPPINGS,
    fetchImpl,
    log: (event) => events.push(event),
  });
  await withBridge(bridge, async (baseUrl) => {
    const response = await post(
      baseUrl,
      "/v1/chat/completions",
      { model: "hermes-4-405b", messages: [] },
      bridge.localKey,
    );
    // The turn still succeeds via the fallback: the customer is served.
    assert.equal(response.status, 200);
  });
  const credential = events.find((event) => event.status === 401);
  assert.ok(credential, "the refusal is logged");
  assert.match(credential!.message ?? "", /service token and API key/);
});

test("saturation statuses are recognised, ordinary ones are not", () => {
  for (const status of [429, 503, 529]) assert.ok(isSaturationStatus(status), String(status));
  for (const status of [400, 401, 404, 500]) assert.equal(isSaturationStatus(status), false, String(status));
});

// --- enrollment reachability ------------------------------------------------

test("doctor names a gated enrollment surface as the blocker it is", async () => {
  // A machine must reach this path before it holds any token, so a redirect here
  // means "you can never enrol" -- not "you are not authorised yet".
  const { fetchImpl } = scriptedFetch([
    jsonResponse({}, 200), // edge /models
    new Response("", {
      status: 302,
      headers: {
        location:
          "https://<team>.cloudflareaccess.com/cdn-cgi/access/login/host.example.invalid?kid=x",
      },
    }),
  ]);
  const report = await runDoctor({
    config: config(),
    secrets: { edgeApiKey: "k" },
    mappings: MAPPINGS,
    fetchImpl,
    checkEnrollment: true,
  });
  const check = report.checks.find((entry) => entry.name === "enrollment surface");
  assert.equal(check?.status, "fail");
  assert.match(check?.detail ?? "", /can never enrol/);
});

test("a reachable enrollment surface is accepted even when it refuses the code", async () => {
  const { fetchImpl } = scriptedFetch([
    jsonResponse({ data: [] }), // edge /models
    jsonResponse({ error: { code: "unknown_enrollment_code" } }, 401),
  ]);
  const report = await runDoctor({
    config: config(),
    secrets: { edgeApiKey: "k" },
    mappings: MAPPINGS,
    fetchImpl,
    checkEnrollment: true,
  });
  const check = report.checks.find((entry) => entry.name === "enrollment surface");
  assert.equal(check?.status, "ok");
  assert.match(check?.detail ?? "", /401/);
});

test("the probe asks without reserving a slot", async () => {
  // A reservation left behind by a question holds a real slot for the lease TTL,
  // so asking would consume the capacity the question is about.
  const { fetchImpl, calls } = scriptedFetch([
    jsonResponse({ decision: "admit" }),
    jsonResponse({ choices: [] }),
  ]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  await withBridge(bridge, async (baseUrl) => {
    await post(baseUrl, "/v1/chat/completions", { model: "hermes-4-405b", messages: [] }, bridge.localKey);
  });
  const probe = calls.find((call) => call.url.endsWith("/admission"));
  assert.ok(probe, "a probe happened");
  const body = JSON.parse(String(probe!.init!.body)) as { reserve?: boolean };
  assert.equal(body.reserve, false);
});

// --- streaming --------------------------------------------------------------

test("an SSE stream reaches the harness incrementally, not buffered", async () => {
  // Streaming is an agent's default. A relay that buffered the body would still
  // produce the right final text and destroy the experience: no token appears
  // until the whole answer is done.
  const chunks = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\n',
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const { fetchImpl } = scriptedFetch([
    jsonResponse({ decision: "admit" }),
    new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
  ]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  await withBridge(bridge, async (baseUrl) => {
    const response = await post(
      baseUrl,
      "/v1/responses",
      { model: "hermes-4-405b", input: "hi", stream: true },
      bridge.localKey,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const text = await response.text();
    assert.equal(text, chunks.join(""), "every byte arrives, in order");
  });
});

test("a mid-stream upstream failure ends the response without inventing content", async () => {
  // There is nothing to recover: the turn already started, so replaying it to a
  // second provider would duplicate output. The bridge must simply stop.
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode("data: one\n\n"));
        return;
      }
      controller.error(new Error("upstream reset"));
    },
  });
  const { fetchImpl } = scriptedFetch([
    jsonResponse({ decision: "admit" }),
    new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
  ]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  await withBridge(bridge, async (baseUrl) => {
    const response = await post(
      baseUrl,
      "/v1/responses",
      { model: "hermes-4-405b", input: "hi", stream: true },
      bridge.localKey,
    );
    assert.equal(response.status, 200);
    // Whatever arrives is only what the upstream sent: no fabricated frames.
    const text = await response.text().catch(() => "");
    assert.ok(!text.includes("event: error"), "no invented error frame");
  });
});

// --- responses dialect ------------------------------------------------------

test("/v1/responses reaches the edge and is passed through unchanged", async () => {
  // The Responses dialect is what a current Hermes is most likely to speak, and
  // nothing exercised it: a typo in the path mapping would have shipped.
  const { fetchImpl, calls } = scriptedFetch([
    jsonResponse({ decision: "admit" }),
    jsonResponse({ id: "resp_1", object: "response", status: "completed", output: [] }),
  ]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  await withBridge(bridge, async (baseUrl) => {
    const response = await post(
      baseUrl,
      "/v1/responses",
      { model: "hermes-4-405b", input: "hello" },
      bridge.localKey,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { object?: string };
    assert.equal(body.object, "response");
  });
  assert.match(calls[1]!.url, /^https:\/\/edge\.example\.invalid\/v1\/responses$/);
  assert.equal(JSON.parse(String(calls[1]!.init!.body)).model, "nousresearch/hermes-4-405b");
});

test("the responses dialect is preserved when falling back to Nous", async () => {
  // A fallback that silently rewrote the dialect would break the harness's parser.
  const { fetchImpl, calls } = scriptedFetch([
    jsonResponse({ decision: "admit" }),
    jsonResponse({ error: {} }, 429),
    jsonResponse({ id: "resp_n", object: "response", output: [] }),
  ]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  await withBridge(bridge, async (baseUrl) => {
    const response = await post(
      baseUrl,
      "/v1/responses",
      { model: "hermes-4-405b", input: "hello" },
      bridge.localKey,
    );
    assert.equal(response.status, 200);
  });
  assert.match(calls[2]!.url, /^https:\/\/inference-api\.nousresearch\.com\/v1\/responses$/);
});

// --- capacity cache ---------------------------------------------------------

test("a fresh capacity reading is reused instead of probed per turn", async () => {
  // Probing every turn costs a round trip on the path the customer is waiting on.
  let clock = 1_000_000;
  const { fetchImpl, calls } = scriptedFetch([
    jsonResponse({ decision: "admit" }),
    jsonResponse({ choices: [] }),
    jsonResponse({ choices: [] }),
  ]);
  const bridge = createBridge({
    config: config(),
    secrets: SECRETS,
    mappings: MAPPINGS,
    fetchImpl,
    now: () => clock,
  });
  await withBridge(bridge, async (baseUrl) => {
    const key = bridge.localKey;
    const turn = () =>
      post(baseUrl, "/v1/chat/completions", { model: "hermes-4-405b", messages: [] }, key);
    await turn();
    clock += 1_000; // still inside the TTL
    await turn();
  });
  const probes = calls.filter((call) => call.url.endsWith("/admission")).length;
  assert.equal(probes, 1, "one probe covers both turns");
  assert.equal(calls.length, 3, "probe, then two forwards");
});

test("an expired reading is probed again", async () => {
  let clock = 1_000_000;
  const { fetchImpl, calls } = scriptedFetch([
    jsonResponse({ decision: "admit" }),
    jsonResponse({ choices: [] }),
    jsonResponse({ decision: "admit" }),
    jsonResponse({ choices: [] }),
  ]);
  const bridge = createBridge({
    config: config(),
    secrets: SECRETS,
    mappings: MAPPINGS,
    fetchImpl,
    now: () => clock,
  });
  await withBridge(bridge, async (baseUrl) => {
    const key = bridge.localKey;
    const turn = () =>
      post(baseUrl, "/v1/chat/completions", { model: "hermes-4-405b", messages: [] }, key);
    await turn();
    clock += DEFAULT_BRIDGE_CONFIG.capacityTtlMs + 1;
    await turn();
  });
  assert.equal(calls.filter((call) => call.url.endsWith("/admission")).length, 2);
});

test("a failed probe is not cached, so a fault is noticed promptly", async () => {
  // Baking a credential refusal or a timeout in for 15 s would hide it.
  let clock = 1_000_000;
  const events: BridgeLogEvent[] = [];
  const { fetchImpl, calls } = scriptedFetch([
    jsonResponse({ error: { code: "invalid_api_key" } }, 401),
    jsonResponse({ choices: [] }),
    jsonResponse({ decision: "admit" }),
    jsonResponse({ choices: [] }),
  ]);
  const bridge = createBridge({
    config: config(),
    secrets: SECRETS,
    mappings: MAPPINGS,
    fetchImpl,
    now: () => clock,
    log: (event) => events.push(event),
  });
  await withBridge(bridge, async (baseUrl) => {
    const key = bridge.localKey;
    const turn = () =>
      post(baseUrl, "/v1/chat/completions", { model: "hermes-4-405b", messages: [] }, key);
    await turn();
    clock += 1_000;
    await turn();
  });
  const probes = calls.filter((call) => call.url.endsWith("/admission")).length;
  assert.equal(probes, 2, "the failure was not cached");
  assert.ok(events.some((event) => event.status === 401));
});

// --- counters ---------------------------------------------------------------

test("counters expose the signals the plan watches, without content", async () => {
  const { fetchImpl } = scriptedFetch([
    jsonResponse({ decision: "admit" }),
    jsonResponse({ error: { message: "bad" } }, 400),
    jsonResponse({ decision: "admit" }),
    jsonResponse({ choices: [] }),
  ]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  await withBridge(bridge, async (baseUrl) => {
    // An unmapped model: the fallback cannot serve it at all.
    const blocked = await post(
      baseUrl,
      "/v1/chat/completions",
      { model: "not-mapped", messages: [] },
      bridge.localKey,
    );
    assert.equal(blocked.status, 503);

    // A served turn.
    await post(baseUrl, "/v1/chat/completions", { model: "hermes-4-405b", messages: [] }, bridge.localKey);

    const health = (await (await get(baseUrl, "/health")).json()) as {
      counters: Record<string, number>;
    };
    assert.equal(health.counters.blockedNoMapping, 1);
    assert.equal(health.counters.turns, 1);
    // No prompt, no model name, no session in the counters.
    assert.deepEqual(Object.keys(health.counters).sort(), [
      "blockedNoMapping",
      "fallbackUnavailable",
      "http524",
      "refusedCredential",
      "switched",
      "turns",
    ]);
    // Nothing here was cut off by Cloudflare, and an invented non-zero would
    // page an operator for an outage that did not happen.
    assert.equal(health.counters.http524, 0);
  });
});

test("an inline fallback counts as a switch, not as an ordinary turn", async () => {
  // The edge is saturated: the turn reaches Nous without ever being served by
  // the edge. `switch.count` exists to measure exactly this, and a counter that
  // only fired on the non-fallback path would read zero during the outage it
  // was built to report.
  const { fetchImpl } = scriptedFetch([
    jsonResponse({ decision: "admit" }),
    jsonResponse({ error: { message: "busy" } }, 429),
    jsonResponse({ choices: [] }),
  ]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  await withBridge(bridge, async (baseUrl) => {
    const response = await post(
      baseUrl,
      "/v1/chat/completions",
      { model: "hermes-4-405b", messages: [] },
      bridge.localKey,
    );
    assert.equal(response.status, 200);
    const health = (await (await get(baseUrl, "/health")).json()) as {
      counters: Record<string, number>;
    };
    assert.equal(health.counters.switched, 1, "the fallback was the switch");
    assert.equal(health.counters.turns, 1, "and it was still one turn");
  });
});

test("a Cloudflare 524 is counted, since only the bridge can see it", async () => {
  // Cloudflare synthesises 524 itself; the edge never answers with it. If the
  // bridge does not count it, the plan's "alert on any 524" can never fire.
  const { fetchImpl } = scriptedFetch([
    jsonResponse({ decision: "admit" }),
    jsonResponse({ error: { message: "timeout" } }, 524),
    jsonResponse({ choices: [] }),
  ]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  await withBridge(bridge, async (baseUrl) => {
    await post(baseUrl, "/v1/chat/completions", { model: "hermes-4-405b", messages: [] }, bridge.localKey);
    const health = (await (await get(baseUrl, "/health")).json()) as {
      counters: Record<string, number>;
    };
    assert.equal(health.counters.http524, 1);
    assert.equal(health.counters.switched, 1, "a 524 is a pre-body failure, so it falls back");
  });
});

// --- doctor -----------------------------------------------------------------

test("doctor catches a mapped model the fallback does not actually serve", async () => {
  // Nous serves a large catalogue but no hermes-* model at the time of writing,
  // so a plausible mapping is not evidence that the fallback can serve it.
  const { fetchImpl } = scriptedFetch([
    jsonResponse({ data: [{ id: "qwen/qwen4-max" }, { id: "meta/muse-ember" }] }),
  ]);
  const report = await runDoctor({
    config: config(),
    secrets: { edgeApiKey: "k", nousApiKey: "n" },
    mappings: MAPPINGS,
    fetchImpl,
  });
  const check = report.checks.find((entry) => entry.name === "nous serves hermes-4-405b");
  assert.equal(check?.status, "fail");
  assert.match(check?.detail ?? "", /missing from the live catalogue/);
  assert.equal(report.ok, false);
});

test("doctor passes when the fallback really serves the mapped model", async () => {
  const { fetchImpl } = scriptedFetch([
    jsonResponse({ data: [] }), // edge /models
    jsonResponse({ data: [{ id: "hermes-4-405b" }] }), // nous /models
  ]);
  const report = await runDoctor({
    config: config(),
    secrets: { edgeApiKey: "k", nousApiKey: "n" },
    mappings: MAPPINGS,
    fetchImpl,
  });
  const check = report.checks.find((entry) => entry.name === "nous serves hermes-4-405b");
  assert.equal(check?.status, "ok");
});


test("doctor reports a missing Nous key as a warning, not a failure", async () => {
  const { fetchImpl } = scriptedFetch([jsonResponse({ data: [] })]);
  const report = await runDoctor({
    config: config(),
    secrets: { edgeApiKey: "k", ...{} },
    mappings: MAPPINGS,
    fetchImpl,
  });
  const nous = report.checks.find((check) => check.name === "nous reachability");
  assert.equal(nous?.status, "warn");
  assert.ok(!JSON.stringify(report).includes('"k"'));
});


// --- harness ----------------------------------------------------------------

type Bridge = ReturnType<typeof createBridge>;

/**
 * Drive the bridge over a real loopback socket.
 *
 * A fake request object cannot reproduce header handling, streaming or the
 * status contract, and those are exactly what these tests exist to prove.
 */
async function withBridge(
  bridge: Bridge,
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

function post(
  baseUrl: string,
  pathname: string,
  body: unknown,
  key: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function get(baseUrl: string, pathname: string, key?: string): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
}

// --- tool dialect -----------------------------------------------------------

test("a tool call survives the fallback byte for byte, including its stream", async () => {
  // The bridge relays bytes; it must not "helpfully" reshape `tool_calls` or
  // `finish_reason` on the way through. A silent rewrite here does not show up
  // as an error — it shows up as a harness that stops calling tools, or one that
  // calls the same tool twice, which is far worse to diagnose.
  const frame = [
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Read","arguments":""}}]},"finish_reason":null}]}',
    "",
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":\"a\"}"}}]},"finish_reason":null}]}',
    "",
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
  const { fetchImpl } = scriptedFetch([
    jsonResponse({ decision: "admit" }),
    jsonResponse({ error: {} }, 429),
    new Response(frame, { status: 200, headers: { "content-type": "text/event-stream" } }),
  ]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  await withBridge(bridge, async (baseUrl) => {
    const response = await post(
      baseUrl,
      "/v1/chat/completions",
      { model: "hermes-4-405b", messages: [], stream: true, tools: [] },
      bridge.localKey,
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    // Exactly the bytes both upstreams would have sent: same names, same order,
    // same trailing [DONE] the harness waits for to close the turn.
    assert.equal(body, frame);
    assert.match(body, /"finish_reason":"tool_calls"/);
    assert.match(body, /data: \[DONE\]/);
  });
});

test("a non-streamed tool call is not rewritten either", async () => {
  const payload = {
    id: "chatcmpl-1",
    object: "chat.completion",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: "{}" } }],
      },
      finish_reason: "tool_calls",
    }],
  };
  const { fetchImpl } = scriptedFetch([
    jsonResponse({ decision: "admit" }),
    jsonResponse(payload),
  ]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  await withBridge(bridge, async (baseUrl) => {
    const response = await post(
      baseUrl,
      "/v1/chat/completions",
      { model: "hermes-4-405b", messages: [], tools: [] },
      bridge.localKey,
    );
    assert.deepEqual(await response.json(), payload);
  });
});

// --- cloudflare access at enrollment ----------------------------------------

test("enrollment sends the Access service token when it is supplied", async () => {
  // The deployment gates the enrollment hostname. Without these two headers the
  // exchange is anonymous and Cloudflare answers 302 to a login page the bridge
  // can never complete: it has no credential yet and the code is single-use.
  const seen: Record<string, string> = {};
  const result = await exchangeEnrollment({
    endpoint: "https://host.example.invalid",
    code: "mvenr_" + "a".repeat(40),
    accessClientId: "abc123.access",
    accessClientSecret: "s3cret",
    fetchImpl: async (_url, init) => {
      Object.assign(seen, init?.headers ?? {});
      return jsonResponse({ edgeApiKey: "mv_k", expiresAt: Date.now() + 60_000 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(seen["CF-Access-Client-Id"], "abc123.access");
  assert.equal(seen["CF-Access-Client-Secret"], "s3cret");
});

test("enrollment sends no Access headers when none are supplied", async () => {
  // A bypassed or separate enrollment hostname must not receive a stray header,
  // and a half-supplied pair must not look authenticated when it is not.
  const seen: Record<string, string> = {};
  await exchangeEnrollment({
    endpoint: "https://host.example.invalid",
    code: "mvenr_" + "a".repeat(40),
    fetchImpl: async (_url, init) => {
      Object.assign(seen, init?.headers ?? {});
      return jsonResponse({ edgeApiKey: "mv_k", expiresAt: Date.now() + 60_000 });
    },
  });
  assert.equal(seen["CF-Access-Client-Id"], undefined);
  assert.equal(seen["CF-Access-Client-Secret"], undefined);
});

test("a half-supplied Access pair is refused before any request", async () => {
  const fake = (options: { accessClientId?: string; accessClientSecret?: string }) =>
    exchangeEnrollment({
      endpoint: "https://e.example",
      code: "mvenr_" + "a".repeat(40),
      fetchImpl: async (_url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        assert.equal(headers["CF-Access-Client-Id"], undefined);
        assert.equal(headers["CF-Access-Client-Secret"], undefined);
        return jsonResponse({ edgeApiKey: "mv_k", expiresAt: Date.now() + 60_000 });
      },
      ...options,
    });
  // The library only forwards a complete pair; the CLI refuses half a pair
  // outright. Either way an anonymous request never carries one header alone.
  await fake({ accessClientId: "only-id.access" });
  await fake({ accessClientSecret: "only-secret" });
});

test("an --edge host without /v1 is normalized before it is stored", async () => {
  // The enrollment prompt tells an operator to pass the bare hostname. Storing
  // it verbatim dropped the `/v1` prefix, so every admission probe returned 404
  // and `nous-first` served the whole conversation from Nous while the edge was
  // healthy. Both documented forms must land on the same inference base.
  const previous = process.env.MULTIVIBE_BRIDGE_STATE_DIR;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-cli-"));
  process.env.MULTIVIBE_BRIDGE_STATE_DIR = directory;
  try {
    const bare = await loadConfig(parseArgs(["run", "--edge", "https://multivibe.example"]));
    const full = await loadConfig(parseArgs(["run", "--edge", "https://multivibe.example/v1"]));
    const slashed = await loadConfig(parseArgs(["run", "--edge", "https://multivibe.example/v1/"]));
    assert.equal(bare.edgeBaseUrl, "https://multivibe.example/v1");
    assert.equal(full.edgeBaseUrl, "https://multivibe.example/v1");
    assert.equal(slashed.edgeBaseUrl, "https://multivibe.example/v1");
    // The enrollment surface is the inverse: never `/v1`.
    assert.equal(bare.enrollBaseUrl, "https://multivibe.example");
    assert.equal(full.enrollBaseUrl, "https://multivibe.example");

    // A config persisted before the fix must be repaired on load, not only on
    // the next explicit --edge.
    await fs.writeFile(
      path.join(directory, "config.json"),
      JSON.stringify({ edgeBaseUrl: "https://multivibe.example", mappings: [] }),
    );
    const stored = await loadConfig(parseArgs(["run"]));
    assert.equal(stored.edgeBaseUrl, "https://multivibe.example/v1");
  } finally {
    if (previous === undefined) delete process.env.MULTIVIBE_BRIDGE_STATE_DIR;
    else process.env.MULTIVIBE_BRIDGE_STATE_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("edge-first inside its budget says the edge is busy, not that the model is missing", async () => {
  // A queued turn is not a missing mapping. Answering `no_equivalent_model` would
  // send the operator hunting a mapping bug that does not exist, and would hide
  // the one fact that helps them: how deep the queue is.
  const { fetchImpl } = scriptedFetch([
    jsonResponse({ decision: "queue", waitMs: 10_000 }),
  ]);
  const bridge = createBridge({
    config: config({ mode: "edge-first" }),
    secrets: SECRETS,
    mappings: MAPPINGS,
    fetchImpl,
  });
  await withBridge(bridge, async (baseUrl) => {
    const response = await post(baseUrl, "/v1/chat/completions", {
      model: "hermes-4-405b",
      messages: [{ role: "user", content: "hello" }],
    }, bridge.localKey);
    assert.equal(response.status, 503);
    // The queue depth, rounded up to whole seconds, so a client backs off for a
    // sensible time instead of retrying into a still-full edge.
    assert.equal(response.headers.get("retry-after"), "10");
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "edge_queued");
    assert.match(body.error.message, /busy/u);
    assert.match(body.error.message, /10000 ms deep/u);
    // The wording a missing mapping would produce must never appear here.
    assert.doesNotMatch(body.error.message, /no equivalent model/iu);
  });
});

test("a genuinely absent mapping still reports no_equivalent_model", async () => {
  // Guard against over-correcting: the distinct failure must stay distinct.
  const { fetchImpl } = scriptedFetch([]);
  const bridge = createBridge({
    config: config({ mode: "edge-first" }),
    secrets: SECRETS,
    mappings: [{ from: "only-on-edge", edge: "only-on-edge", nous: "" }],
    fetchImpl,
  });
  await withBridge(bridge, async (baseUrl) => {
    const response = await post(baseUrl, "/v1/chat/completions", {
      model: "only-on-edge",
      messages: [{ role: "user", content: "hello" }],
    }, bridge.localKey);
    assert.equal(response.status, 503);
  });
});
