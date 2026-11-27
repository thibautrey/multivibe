/**
 * Bridge configuration and secret resolution.
 *
 * The bridge is the user's only upstream. It holds three secrets and must never
 * write them anywhere but the OS secret store (or a 0600 file where none
 * exists), and must never put them in a log line, a health endpoint, or an
 * error message.
 */

export type BridgeMode = "nous-first" | "edge-first" | "nous-only" | "edge-only";

export type ModelMapping = {
  /** The model identifier the harness sends. */
  from: string;
  /** The model served by MultiVibe. */
  edge: string;
  /** The model served by Nous Research. */
  nous: string;
};

export type BridgeConfig = {
  /** Local listen address. Loopback only: this is a per-machine service. */
  host: string;
  port: number;
  mode: BridgeMode;
  /** Inference base, e.g. `https://host/v1`. */
  edgeBaseUrl: string;
  /**
   * Enrollment base, **without** the `/v1` suffix.
   *
   * Enrollment happens before any credential exists, so it is deliberately a
   * different surface: the exchange must not be gated by the same Access policy
   * as inference, and it lives outside `/v1`. Deriving it from `edgeBaseUrl`
   * would produce `/v1/hermes-bridge/enrollment/exchange`, which does not exist.
   */
  enrollBaseUrl: string;
  nousBaseUrl: string;
  /** Model substitutions applied per upstream. */
  mappings: ModelMapping[];
  /** A conversation that switched to Nous stays there for this long. */
  nousStickinessMs: number;
  /** How long a single edge attempt may take before Nous is preferred. */
  edgeAttemptTimeoutMs: number;
  /**
   * Longest a `edge-first` turn will accept a queued wait before switching.
   * `nous-first` switches on any queue, because a queued turn is a slower turn.
   */
  maxQueueWaitMs: number;
  /**
   * How long a capacity reading may be reused before the next probe.
   *
   * Probing every turn costs a round trip on the path the customer is waiting
   * on. The reading is only a *hint* for whether probing is worth it: a stale
   * "plenty free" still meets a real `429`, which falls back, so caching cannot
   * make the bridge wrong -- only occasionally one request slower.
   */
  capacityTtlMs: number;
  /**
   * Whether to subscribe to the edge's `capacity.changed` stream.
   *
   * On by default for `run`: without it a turn can spend up to `capacityTtlMs`
   * believing the edge is full after it drained. Off in tests and in `doctor`,
   * which must not hold an open connection.
   */
  capacityStream: boolean;
};

export const DEFAULT_BRIDGE_CONFIG: Omit<BridgeConfig, "mappings"> = {
  host: "127.0.0.1",
  port: 8787,
  mode: "nous-first",
  // No vendor endpoint is baked in. The bridge is a client-side router that a
  // specific operator points at a specific deployment; hardcoding a default
  // would publish a private hostname in a public repository and would also make
  // every build of this binary silently call a third-party service.
  // `enroll --edge` (or `--edge` / `--enroll`) supplies the base, and it is
  // persisted from there.
  edgeBaseUrl: "",
  enrollBaseUrl: "",
  nousBaseUrl: "https://inference-api.nousresearch.com/v1",
  nousStickinessMs: 10 * 60_000,
  edgeAttemptTimeoutMs: 45_000,
  maxQueueWaitMs: 120_000,
  capacityTtlMs: 15_000,
  capacityStream: true,
};

/**
 * Secrets, kept in memory only after they are read from the store. `redact`
 * exists so an accidental log call cannot leak them.
 */
export type BridgeSecrets = {
  edgeApiKey: string;
  /** Cloudflare Access service token, if the edge is behind Access. */
  accessClientId?: string;
  accessClientSecret?: string;
  nousApiKey?: string;
};

export type SecretSource = "keychain" | "file" | "environment" | "missing";

export function redactSecrets(secrets: BridgeSecrets): Record<string, unknown> {
  const describe = (value: string | undefined) =>
    value === undefined ? null : value.length === 0 ? "empty" : `${value.length} chars`;
  return {
    edgeApiKey: describe(secrets.edgeApiKey),
    accessClientId: describe(secrets.accessClientId),
    accessClientSecret: describe(secrets.accessClientSecret),
    nousApiKey: describe(secrets.nousApiKey),
  };
}

/**
 * Resolve the Model substitution for one upstream.
 *
 * This is deliberately a table lookup rather than a heuristic: the whole
 * promise of "transparent" depends on the same *class* of model being served on
 * both sides, and inventing a correspondence would quietly change quality.
 * `undefined` means "no equivalent", which must cause a wait rather than a
 * silent downgrade.
 */
export function mapModel(
  mappings: readonly ModelMapping[],
  requested: string,
  target: "edge" | "nous",
): string | undefined {
  const entry =
    mappings.find((mapping) => mapping.from === requested) ??
    mappings.find((mapping) => mapping.from.toLowerCase() === requested.toLowerCase());
  if (!entry) return undefined;
  return target === "edge" ? entry.edge : entry.nous;
}

/**
 * Which Nous identifiers are the same model as an edge identifier.
 *
 * Nous publishes its catalogue at `GET /v1/models` without authentication and
 * names a model `vendor/name`, while the edge often exposes the bare `name`.
 * That makes the correspondence mechanical rather than a judgement call:
 * `deepseek-v4.1-flash` on the edge is `deepseek/deepseek-v4.1-flash` on Nous.
 *
 * This is still a lookup against a real catalogue, not a heuristic. A candidate
 * that Nous does not list is never returned: an invented mapping would silently
 * change which model answers, and a wrong answer is worse than a wait.
 */
export function nousCandidates(edgeModel: string): string[] {
  const trimmed = edgeModel.trim();
  if (!trimmed) return [];
  const candidates = [trimmed];
  if (trimmed.includes("/")) {
    candidates.push(trimmed.slice(trimmed.indexOf("/") + 1));
  } else {
    // Nous qualifies every hosted model with its vendor. The prefix is not
    // knowable from the bare name, so this widening is only a *candidate*: the
    // catalogue decides.
    for (const vendor of ["deepseek", "openai", "anthropic", "google", "meta-llama", "qwen", "mistralai", "moonshotai", "z-ai"]) {
      candidates.push(`${vendor}/${trimmed}`);
    }
  }
  return [...new Set(candidates)];
}

/**
 * Pick the Nous identifier for an edge model from a live catalogue.
 *
 * Returns `undefined` when Nous does not list any candidate, which callers must
 * treat as "wait" — never as an excuse to keep the edge name.
 */
export function deriveNousModel(
  edgeModel: string,
  nousModelIds: readonly string[],
): string | undefined {
  const available = new Set(nousModelIds);
  for (const candidate of nousCandidates(edgeModel)) {
    if (available.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Whether the loopback bind is safe. A bridge reachable from the LAN would let
 * any device spend the user's credentials, so only loopback is accepted.
 */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
