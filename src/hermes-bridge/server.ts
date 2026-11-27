/**
 * The local OpenAI-compatible surface the harness talks to.
 *
 * Replaces nothing: the harness keeps its own tools, memory, skills and
 * configuration. Only the base URL and key change, and they point at loopback.
 */

import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

import type { BridgeConfig, BridgeSecrets, ModelMapping } from "./config.js";
import { isLoopbackHost, mapModel, redactSecrets } from "./config.js";
import type { EdgeAdmission, Upstream } from "./upstream.js";
import { routeTurn, type SwitchReason } from "./upstream.js";
import { subscribeCapacityStream, type CapacityStream } from "./capacity-stream.js";

export type BridgeLogEvent = {
  kind: "turn" | "switch" | "error" | "health" | "queue";
  /** Content-free: a model name and a reason, never a prompt or a token. */
  upstream?: Upstream;
  model?: string;
  reason?: SwitchReason;
  status?: number;
  durationMs?: number;
  /** How far ahead the edge says the queue is. Content-free, like the rest. */
  waitMs?: number;
  message?: string;
};

export type BridgeDeps = {
  config: BridgeConfig;
  secrets: BridgeSecrets;
  mappings: readonly ModelMapping[];
  /** Reports one event. Implementations must never include prompt content. */
  log?: (event: BridgeLogEvent) => void;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * The persisted loopback key. `run` loads it from the secret store; omitting
   * it mints a fresh one, which is only correct for tests and for the very
   * first start.
   */
  localKey?: string;
};

type StickyEntry = { until: number };

/** Reads the conversation key from the request without touching message bodies. */
export function conversationKey(
  headers: http.IncomingHttpHeaders,
  body: Record<string, unknown>,
): string | undefined {
  const fromHeader = (name: string) => {
    const value = headers[name];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const fromBody = body["prompt_cache_key"] ?? body["promptCacheKey"] ?? body["session_id"];
  return (
    fromHeader("session_id") ??
    fromHeader("x-session-id") ??
    fromHeader("thread-id") ??
    (typeof fromBody === "string" && fromBody.trim() ? fromBody.trim() : undefined)
  );
}

/** Statuses that mean "the edge is busy", not "your request is wrong". */
export function isSaturationStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 529;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(request: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    length += buffer.length;
    if (length > limit) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  value: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(body);
}

/** Headers forwarded to the edge. Everything else is dropped. */
const FORWARDED_HEADERS = [
  "content-type",
  "accept",
  "session_id",
  "x-session-id",
  "thread-id",
  "x-multivibe-priority",
  "x-multivibe-execution",
  "x-multivibe-max-wait-ms",
  "x-multivibe-lease",
] as const;

export function edgeHeaders(secrets: BridgeSecrets, incoming: http.IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${secrets.edgeApiKey}`,
  };
  if (secrets.accessClientId && secrets.accessClientSecret) {
    headers["cf-access-client-id"] = secrets.accessClientId;
    headers["cf-access-client-secret"] = secrets.accessClientSecret;
  }
  for (const name of FORWARDED_HEADERS) {
    const value = incoming[name];
    if (typeof value === "string" && value.length > 0) headers[name] = value;
  }
  return headers;
}

export function nousHeaders(secrets: BridgeSecrets, incoming: http.IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${secrets.nousApiKey ?? ""}`,
    "content-type": "application/json",
  };
  const accept = incoming["accept"];
  if (typeof accept === "string" && accept.length > 0) headers.accept = accept;
  return headers;
}

/**
 * Create the bridge. The returned handle is `listen`-able and closable, and it
 * exposes the sticky map so a restart starts clean rather than resurrecting an
 * old routing decision.
 */
export function createBridge(deps: BridgeDeps) {
  const { config, mappings, secrets } = deps;
  if (!isLoopbackHost(config.host)) {
    throw new Error("the bridge must bind to a loopback address");
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  // One entry per conversation. Bounded so a long-lived machine cannot grow it
  // without limit; entries are dropped on expiry and by age.
  const sticky = new Map<string, StickyEntry>();
  /**
   * Last capacity reading per model. Reused for `capacityTtlMs` so a turn does
   * not pay a probe it does not need. A stale reading can only make the bridge
   * *try* the edge once more; a real `429` still falls back, so this cannot turn
   * a fast path into a broken one.
   */
  const capacityCache = new Map<string, { at: number; value: EdgeAdmission | null; reachable: boolean }>();
  /**
   * The edge's event stream, used only to expire `capacityCache` sooner than the
   * TTL would. Started lazily on the first turn so `doctor`, `enroll` and tests
   * never hold a connection they did not ask for.
   */
  let capacityStream: CapacityStream | undefined;
  // Content-free counters. `blockedNoMapping` is the one that matters most: it
  // means a client asked for a model the fallback cannot serve, so the promise
  // "you will not notice the switch" is not being kept for that model.
  const counters = {
    turns: 0,
    switched: 0,
    blockedNoMapping: 0,
    refusedCredential: 0,
    fallbackUnavailable: 0,
    /**
     * Cloudflare answers 524 itself and never forwards a byte to us, so the edge
     * cannot count this — only the bridge sits close enough to see it. The plan
     * alerts on any non-zero value because a 524 means a request waited past the
     * 100-second budget and was cut off, which no amount of queueing fixes.
     */
    http524: 0,
  };
  // The key the harness presents. Stable when the caller supplies the persisted
  // one: rotating it on every start would invalidate the value already written
  // to `.hermes/.env` and answer 401 to a harness that worked a moment ago,
  // which is the opposite of the transparency this bridge promises.
  const localKey = deps.localKey ?? randomBytes(32).toString("base64url");
  const base = config.edgeBaseUrl.replace(/\/+$/, "");
  const nous = config.nousBaseUrl.replace(/\/+$/, "");

  function pruneSticky(at: number): void {
    for (const [key, entry] of sticky) {
      if (entry.until <= at) sticky.delete(key);
    }
    if (sticky.size > 4_096) {
      const oldest = [...sticky.entries()]
        .sort((left, right) => left[1].until - right[1].until)
        .slice(0, sticky.size - 4_096);
      for (const [key] of oldest) sticky.delete(key);
    }
  }

  /** Ask the edge whether it has room, without blocking on a slot. */
  async function probeEdge(
    model: string,
    incoming: http.IncomingHttpHeaders,
    signal: AbortSignal,
  ): Promise<{
    reachable: boolean;
    admission?: EdgeAdmission;
    error?: "timeout" | "http" | "network" | "credential";
  }> {
    try {
      const response = await fetchImpl(`${base}/admission`, {
        method: "POST",
        headers: { ...edgeHeaders(secrets, incoming), "content-type": "application/json" },
        // `reserve: false` on purpose: the bridge asks "is there room?" and may
        // then choose Nous. A reservation left behind would hold a real slot for
        // the lease TTL, so asking the question would consume the capacity the
        // question was about.
        body: JSON.stringify({ model, switch_ok: true, reserve: false }),
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        // 404 on an edge that predates /v1/admission means "no admission
        // contract": treat it as reachable with no queue information.
        if (response.status === 404) return { reachable: true };
        // A refused identity is not capacity pressure. Conflating the two would
        // send every turn to Nous forever while the edge sits idle, and the
        // operator would never learn that Access rejects the service token.
        if (response.status === 401 || response.status === 403) {
          return { reachable: false, error: "credential" };
        }
        return { reachable: false, error: "http" };
      }
      const value = (await response.json()) as EdgeAdmission;
      return { reachable: true, admission: value };
    } catch (error) {
      const name = (error as { name?: string }).name;
      return { reachable: false, error: name === "AbortError" || name === "TimeoutError" ? "timeout" : "network" };
    }
  }

  async function handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const startedAt = now();
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        mode: config.mode,
        secrets: redactSecrets(secrets),
        mappings: mappings.map((mapping) => mapping.from),
        counters,
      });
      log({ kind: "health", status: 200 });
      return;
    }

    // A local key means another process on this machine cannot spend the user's
    // credentials by discovering port 8787.
    const authorization = request.headers.authorization ?? "";
    const presented = authorization.replace(/^Bearer\s+/i, "").trim();
    if (!presented || !constantTimeEqual(presented, localKey)) {
      sendJson(response, 401, {
        error: { message: "invalid bridge key", type: "authentication_error", code: "invalid_api_key" },
      });
      return;
    }

    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      sendJson(response, 200, {
        object: "list",
        data: mappings.map((mapping) => ({ id: mapping.from, object: "model" })),
      });
      return;
    }

    const isChat = url.pathname.endsWith("/chat/completions");
    const isResponses = url.pathname.endsWith("/responses");
    if (!isChat && !isResponses) {
      sendJson(response, 404, { error: { message: "not found", type: "invalid_request_error" } });
      return;
    }

    let body: Record<string, unknown>;
    try {
      const raw = await readBody(request, 64 * 1024 * 1024);
      body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch (error) {
      sendJson(response, 400, {
        error: { message: String((error as Error).message), type: "invalid_request_error" },
      });
      return;
    }

    const requestedModel = typeof body.model === "string" ? body.model : "";
    if (!requestedModel) {
      sendJson(response, 400, {
        error: { message: "model is required", type: "invalid_request_error" },
      });
      return;
    }
    const conversation = conversationKey(request.headers, body);
    const at = now();
    pruneSticky(at);
    const stickyUntilMs = conversation ? sticky.get(conversation)?.until : undefined;

    if (config.capacityStream && !capacityStream) {
      // Best effort by construction: a stream that never connects, or dies and
      // retries forever, changes nothing about correctness — the TTL still
      // governs. It only stops a turn from acting on a reading the edge has
      // already told us is obsolete.
      capacityStream = subscribeCapacityStream({
        url: `${base}/capacity/events`,
        headers: edgeHeaders(secrets, request.headers),
        onInvalidate: () => capacityCache.clear(),
        fetchImpl,
        onError: (message) => log({ kind: "error", reason: "edge_unavailable", message: `capacity stream: ${message}` }),
      });
    }

    // One bounded probe, then a single decision. Never a second decision after
    // bytes have reached the harness.
    //
    // A sticky conversation skips the probe entirely: asking the edge about
    // capacity we have already decided not to use would add a round trip to
    // every turn of a conversation that is pinned to Nous.
    const stickilyRouted =
      stickyUntilMs !== undefined &&
      stickyUntilMs > at &&
      mapModel(mappings, requestedModel, "nous") !== undefined;
    const controller = AbortSignal.timeout(config.edgeAttemptTimeoutMs);
    const edgeModel = mapModel(mappings, requestedModel, "edge");
    let edge: { reachable: boolean; admission?: EdgeAdmission; error?: "timeout" | "http" | "network" | "credential" } | undefined;
    if (!stickilyRouted && edgeModel) {
      const cached = capacityCache.get(edgeModel);
      if (cached && at - cached.at < config.capacityTtlMs) {
        edge = { reachable: cached.reachable, ...(cached.value ? { admission: cached.value } : {}) };
      } else {
        edge = await probeEdge(edgeModel, request.headers, controller);
        // Only a *usable* reading is cached. A credential refusal or a timeout is
        // a fault to notice promptly, not a state to bake in for 15 seconds.
        if (!edge.error) {
          capacityCache.set(edgeModel, {
            at,
            value: edge.admission ?? null,
            reachable: edge.reachable,
          });
        }
      }
    }
    const decision = routeTurn(config, mappings, {
      requestedModel,
      stickyUntilMs,
      now: at,
      edge,
    });

    if (decision.upstream === null) {
      // `edge-first` inside its own budget asked to wait, not to fail. The model
      // exists on both sides; answering "no equivalent model" would be a lie and
      // would send the harness hunting a mapping problem that is not there.
      if (decision.reason === "edge_queued") {
        const waitMs = edge?.admission?.waitMs ?? 0;
        sendJson(response, 503, {
          error: {
            message:
              `The edge is busy; this turn was set to wait up to ${config.maxQueueWaitMs} ms ` +
              `but the queue is ${waitMs} ms deep. Retry shortly, or use mode 'nous-first'.`,
            type: "service_unavailable",
            code: "edge_queued",
          },
        }, { "retry-after": String(Math.max(1, Math.ceil(waitMs / 1000))) });
        log({ kind: "queue", reason: "edge_queued", status: 503, waitMs });
        return;
      }
      if (decision.reason === "no_equivalent_model") counters.blockedNoMapping += 1;
      sendJson(response, 503, {
        error: {
          message: `No equivalent model is available for '${requestedModel}' on either upstream.`,
          type: "invalid_request_error",
          code: decision.reason === "no_equivalent_model" ? "no_equivalent_model" : decision.reason,
        },
      });
      log({ kind: "error", reason: decision.reason, status: 503 });
      return;
    }

    const upstream = decision.upstream;
    const target = upstream === "edge" ? `${base}${isChat ? "/chat/completions" : "/responses"}` : `${nous}${isChat ? "/chat/completions" : "/responses"}`;
    const headers = upstream === "edge" ? edgeHeaders(secrets, request.headers) : nousHeaders(secrets, request.headers);
    if (upstream === "edge" && edge?.admission?.lease) {
      headers["x-multivibe-lease"] = edge.admission.lease;
    }
    const forwardBody = { ...body, model: decision.model };

    /**
     * Count one served turn, exactly once.
     *
     * The fallback path used to `return` before the counter line, so every
     * turn the edge could not serve — the case `switch.count` and `turns` exist
     * to measure — was silently uncounted. One helper called at each exit makes
     * that unrepresentable: neither path can serve a turn without counting it,
     * and neither can count it twice.
     */
    function countTurn(servedUpstream: Upstream, reason: string): void {
      counters.turns += 1;
      if (servedUpstream === "nous" && reason !== "mode") counters.switched += 1;
    }

    /**
     * Send the same turn to Nous. Only legal before any byte reaches the
     * harness, which is why every caller is a pre-body failure path.
     */
    async function fallBackToNous(reason: SwitchReason): Promise<boolean> {
      const fallback = mapModel(mappings, requestedModel, "nous");
      if (!fallback || !secrets.nousApiKey) {
        if (upstream === "edge") counters.fallbackUnavailable += 1;
        return false;
      }
      try {
        const retried = await fetchImpl(`${nous}${isChat ? "/chat/completions" : "/responses"}`, {
          method: "POST",
          headers: nousHeaders(secrets, request.headers),
          body: JSON.stringify({ ...body, model: fallback }),
          redirect: "error",
        });
        // Only a usable response deserves stickiness; falling back to an error
        // and then pinning the conversation there would compound the outage.
        if (!retried.ok) return false;
        if (conversation) sticky.set(conversation, { until: at + config.nousStickinessMs });
        countTurn("nous", reason);
        log({ kind: "switch", upstream: "nous", reason, status: retried.status });
        await relay(retried, response, isChat);
        return true;
      } catch {
        return false;
      }
    }

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetchImpl(target, {
        method: "POST",
        headers,
        body: JSON.stringify(forwardBody),
        redirect: "error",
      });
    } catch (error) {
      // The decision was taken before any byte was emitted, so a transport
      // failure here may still fall back — this is the only legal retry.
      if (upstream === "edge" && (await fallBackToNous("edge_unavailable"))) return;
      sendJson(response, 502, {
        error: { message: String((error as Error).message), type: "upstream_error", code: "upstream_unavailable" },
      });
      log({ kind: "error", upstream, status: 502 });
      return;
    }

    // `429` is exactly what the edge answers when its pool is saturated,
    // and `503` when no slot exists at all. Those are the situations the
    // fallback exists for: returning them to the harness would break the
    // promise at the moment it matters most. Nothing has been written to the
    // client yet, so the retry is still the same single turn.
    if (upstream === "edge" && upstreamResponse.status === 524) counters.http524 += 1;
    if (upstream === "edge" && (isSaturationStatus(upstreamResponse.status) || upstreamResponse.status >= 500)) {
      const reason: SwitchReason =
        upstreamResponse.status === 429 ? "edge_queued" : "edge_unavailable";
      if (await fallBackToNous(reason)) return;
    }

    if (conversation) {
      sticky.set(conversation, {
        until: upstream === "nous" ? at + config.nousStickinessMs : 0,
      });
    }
    if (edge?.error === "credential") {
      counters.refusedCredential += 1;
      // Loud on purpose: this will not resolve itself and every turn is being
      // paid for on the fallback until someone fixes the credential.
      log({
        kind: "error",
        upstream,
        reason: "edge_unavailable",
        status: 401,
        message: "the edge refused this machine's credentials; check the Access service token and API key",
      });
    }
    countTurn(upstream, decision.reason);
    log({
      kind: "turn",
      upstream,
      model: decision.model,
      reason: decision.reason,
      status: upstreamResponse.status,
      durationMs: now() - startedAt,
    });
    await relay(upstreamResponse, response, isChat);
  }

  return {
    /** The key the harness must present. Printed once by `init`. */
    localKey,
    handler: handle,
    server: (() => {
      const server = http.createServer((request, response) => {
        handle(request, response).catch((error: unknown) => {
          if (!response.headersSent) {
            sendJson(response, 500, { error: { message: String((error as Error).message) } });
          } else {
            response.destroy();
          }
          log({ kind: "error", status: 500, message: String((error as Error).message) });
        });
      });
      // Closing the server must also close the event stream. Without this the
      // subscription outlives the listener it belongs to: the bridge exits but
      // leaves a retry timer and an open request behind on the way out.
      server.on("close", () => {
        capacityStream?.stop();
        capacityStream = undefined;
      });
      return server;
    })(),
    listening: config,
    sticky,
    capacityStream: () => capacityStream,
  };
}

/**
 * Forward bytes as they arrive. Buffering a stream here would reintroduce the
 * latency and idle-timeout problems the edge already solves.
 */
async function relay(
  upstream: Response,
  response: http.ServerResponse,
  _isChat: boolean,
): Promise<void> {
  const headers: Record<string, string> = {};
  // Only the headers a client needs; upstream auth and edge internals stay here.
  for (const name of ["content-type", "x-multivibe-grace", "x-multivibe-admission"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  response.writeHead(upstream.status, { ...headers, "cache-control": "no-store" });
  if (!upstream.body) {
    response.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) response.write(Buffer.from(value));
    }
  } catch {
    // The client went away or the upstream broke mid-stream. Either way there is
    // nothing to recover: the turn is already counted as started.
  } finally {
    response.end();
  }
}
