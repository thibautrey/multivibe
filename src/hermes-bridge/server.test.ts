import assert from "node:assert/strict";
import test from "node:test";

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
  return { ...DEFAULT_BRIDGE_CONFIG, mappings: MAPPINGS, ...overrides };
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
    enrollmentExchangeUrl("https://multivibe.pleiades.solutions/v1"),
    "https://multivibe.pleiades.solutions/hermes-bridge/enrollment/exchange",
  );
  assert.equal(
    enrollmentExchangeUrl("https://multivibe.pleiades.solutions"),
    "https://multivibe.pleiades.solutions/hermes-bridge/enrollment/exchange",
  );
  assert.equal(
    enrollmentExchangeUrl("https://multivibe.pleiades.solutions///"),
    "https://multivibe.pleiades.solutions/hermes-bridge/enrollment/exchange",
  );
  // A dedicated enrollment hostname is passed through untouched.
  assert.equal(
    enrollmentExchangeUrl("https://enroll.multivibe.pleiades.solutions"),
    "https://enroll.multivibe.pleiades.solutions/hermes-bridge/enrollment/exchange",
  );
});

test("enrollment uses the enrollment base, not the inference base", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    jsonResponse({ edgeApiKey: "k", expiresAt: Date.now() + 60_000 }),
  ]);
  const result = await exchangeEnrollment({
    endpoint: "https://multivibe.pleiades.solutions/v1",
    code: `mvenr_${"d".repeat(40)}`,
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(
    calls[0]!.url,
    "https://multivibe.pleiades.solutions/hermes-bridge/enrollment/exchange",
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
  assert.match(calls[1]!.url, /^https:\/\/multivibe\.pleiades\.solutions\/v1\/chat\/completions$/);
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
  assert.match(calls[3]!.url, /^https:\/\/multivibe\.pleiades\.solutions/);
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
  // 429 is what the edge answers when our machines are saturated: precisely the
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
      "refusedCredential",
      "switched",
      "turns",
    ]);
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
