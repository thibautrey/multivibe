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
  edgeBaseUrl: string;
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
};

export const DEFAULT_BRIDGE_CONFIG: Omit<BridgeConfig, "mappings"> = {
  host: "127.0.0.1",
  port: 8787,
  mode: "nous-first",
  edgeBaseUrl: "https://multivibe.pleiades.solutions/v1",
  nousBaseUrl: "https://inference-api.nousresearch.com/v1",
  nousStickinessMs: 10 * 60_000,
  edgeAttemptTimeoutMs: 45_000,
  maxQueueWaitMs: 120_000,
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
 * Whether the loopback bind is safe. A bridge reachable from the LAN would let
 * any device spend the user's credentials, so only loopback is accepted.
 */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
