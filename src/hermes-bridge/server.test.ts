import assert from "node:assert/strict";
import test from "node:test";

import { exchangeEnrollment, isEnrollmentCode, parseEnrollmentCode } from "./enroll.js";
import { runDoctor } from "./doctor.js";
import { createBridge, conversationKey, edgeHeaders, nousHeaders } from "./server.js";
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
  // `redirect: "error"` turns the redirect into a thrown TypeError.
  const { fetchImpl } = scriptedFetch([
    () => Promise.reject(new TypeError("redirect mode is set to error")),
  ]);
  const result = await exchangeEnrollment({
    endpoint: "https://edge.test/v1",
    code: `mvenr_${"c".repeat(40)}`,
    fetchImpl,
  });
  assert.deepEqual(result, { ok: false, reason: "network" });
});

// --- request shape ----------------------------------------------------------

test("conversation identity comes from headers before the body", () => {
  assert.equal(
    conversationKey({ "thread-id": "thread-1", session_id: "s-header" }, { prompt_cache_key: "s-body" }),
    "thread-1",
  );
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
  const response = await dispatch(bridge, "/v1/chat/completions", {
    model: "hermes-4-405b",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(response.status, 200);
  assert.match(calls[0]!.url, /\/admission$/);
  assert.match(calls[1]!.url, /^https:\/\/multivibe\.pleiades\.solutions\/v1\/chat\/completions$/);
  const headers = calls[1]!.init!.headers as Record<string, string>;
  assert.equal(headers["x-multivibe-lease"], "adml_abc");
  // The model is rewritten to the edge's identifier, not the harness's.
  const body = JSON.parse(String(calls[1]!.init!.body));
  assert.equal(body.model, "nousresearch/hermes-4-405b");
});

test("an unreachable edge is transparently served by Nous", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    () => Promise.reject(new TypeError("connect ECONNREFUSED")),
    jsonResponse({ choices: [{ message: { content: "hi" } }] }),
  ]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  const response = await dispatch(bridge, "/v1/chat/completions", {
    model: "hermes-4-405b",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(response.status, 200);
  assert.match(calls[1]!.url, /^https:\/\/inference-api\.nousresearch\.com\/v1\/chat\/completions$/);
  const body = JSON.parse(String(calls[1]!.init!.body));
  assert.equal(body.model, "hermes-4-405b");
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
  await dispatch(bridge, "/v1/chat/completions", {
    model: "hermes-4-405b",
    messages: [{ role: "user", content: "one" }],
    prompt_cache_key: "conv-1",
  });
  clock += 30_000;
  await dispatch(bridge, "/v1/chat/completions", {
    model: "hermes-4-405b",
    messages: [{ role: "user", content: "two" }],
    prompt_cache_key: "conv-1",
  });
  // Only the first turn probed and hit Nous; the second went straight to Nous
  // without asking the edge at all.
  assert.equal(calls.length, 4, "two turns, two requests each at most");
  assert.match(calls[3]!.url, /nousresearch/);
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
  await dispatch(bridge, "/v1/chat/completions", {
    model: "hermes-4-405b",
    messages: [],
    prompt_cache_key: "conv-2",
  });
  clock += DEFAULT_BRIDGE_CONFIG.nousStickinessMs + 1;
  await dispatch(bridge, "/v1/chat/completions", {
    model: "hermes-4-405b",
    messages: [],
    prompt_cache_key: "conv-2",
  });
  assert.match(calls[2]!.url, /\/admission$/);
});

test("an unmapped model fails explicitly instead of being downgraded", async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse({})]);
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS, fetchImpl });
  const response = await dispatch(bridge, "/v1/chat/completions", {
    model: "unmapped-model",
    messages: [],
  });
  assert.equal(response.status, 503);
  assert.equal(calls.length, 0, "no upstream was contacted");
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "no_equivalent_model");
});

test("a local key is required, so another process cannot spend the credentials", async () => {
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS });
  const response = await dispatch(bridge, "/v1/chat/completions", { model: "hermes-4-405b" }, {
    key: "wrong-key",
  });
  assert.equal(response.status, 401);
});

test("models are listed from the mapping table, not invented", async () => {
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS });
  const response = await dispatch(bridge, "/v1/models", undefined, { method: "GET", body: "" });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<{ id: string }> };
  assert.deepEqual(body.data.map((entry) => entry.id), ["hermes-4-405b"]);
});

test("health never exposes a secret value", async () => {
  const bridge = createBridge({ config: config(), secrets: SECRETS, mappings: MAPPINGS });
  const response = await dispatch(bridge, "/health", undefined, { method: "GET", body: "" });
  const text = await response.text();
  assert.equal(response.status, 200);
  for (const secret of Object.values(SECRETS)) {
    assert.ok(!text.includes(secret), `leaked ${secret.slice(0, 4)}...`);
  }
  assert.match(text, /chars/);
});

// --- doctor -----------------------------------------------------------------

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

/** Drive the bridge's handler without opening a socket. */
async function dispatch(
  bridge: Bridge,
  pathname: string,
  body?: unknown,
  options: { method?: string; body?: string; key?: string } = {},
): Promise<Response> {
  const payload =
    options.body !== undefined
      ? options.body
      : body === undefined
        ? ""
        : JSON.stringify(body);
  const requestHeaders = new Headers({
    authorization: `Bearer ${options.key ?? bridge.localKey}`,
    "content-type": "application/json",
  });
  const request = new Request(`http://127.0.0.1:8787${pathname}`, {
    method: options.method ?? (payload ? "POST" : "GET"),
    headers: requestHeaders,
    ...(payload ? { body: payload } : {}),
  });
  // The handler is Node-level; adapt the web Request into the minimal shape it
  // reads so the test does not need a listening socket.
  const nodeRequest = Object.assign(request, {
    url: pathname,
    method: request.method,
    headers: Object.fromEntries(requestHeaders.entries()),
    async *[Symbol.asyncIterator]() {
      if (payload) yield Buffer.from(payload);
    },
  }) as unknown as Parameters<Bridge["handler"]>[0];
  let status = 0;
  let headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  const response = {
    headersSent: false,
    writeHead(next: number, nextHeaders: Record<string, string>) {
      status = next;
      headers = nextHeaders;
      this.headersSent = true;
      return this;
    },
    write(chunk: Buffer) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk?: Buffer) {
      if (chunk) chunks.push(Buffer.from(chunk));
      return this;
    },
    destroy() {},
  } as unknown as Parameters<Bridge["handler"]>[1];
  await bridge.handler(nodeRequest, response);
  return new Response(Buffer.concat(chunks), { status, headers });
}
