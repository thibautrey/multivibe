import {readCoreResponseBytes} from "./provider-response.js";

/** Shared catalog protocol for managed inventory and storage-free Team onboarding.
 * The caller owns endpoint, credentials and admitted egress; upstream cursors can
 * only select a subsequent /models page, never replace the host or request method.
 */
export async function discoverProviderModelCatalog(options: {
  signal: AbortSignal;
  anthropic: boolean;
  request: (path: string) => Promise<Response>;
  maximumModels?: number;
  normalizeModel?: (entry: unknown) => string | undefined;
}): Promise<readonly string[]> {
  const maximumModels = options.maximumModels ?? 10000;
  const normalize = options.normalizeModel ?? ((entry: unknown): string => {
    const id = entry && typeof entry === "object" ? (entry as {id?: unknown}).id : undefined;
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(id)) throw Error("provider_discovery_invalid");
    return id;
  });
  const allIds = new Set<string>(), cursors = new Set<string>();
  let path = "/models", remainingBytes = 2 * 1024 * 1024, modelCount = 0;
  for (let page = 0; page < 100; page++) {
    options.signal.throwIfAborted();
    const response = await options.request(path);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) throw Error("provider_discovery_authentication_rejected");
      if (response.status === 404) throw Error("provider_discovery_endpoint_unavailable");
      if (response.status === 429) throw Error("provider_discovery_rate_limited");
      if (response.status >= 500) throw Error("provider_discovery_upstream_unavailable");
      throw Error("provider_discovery_unavailable");
    }
    if (!response.body) throw Error("provider_discovery_invalid");
    let bytes: Uint8Array;
    try { bytes = await readCoreResponseBytes(response, remainingBytes, options.signal); }
    catch (error) {
      options.signal.throwIfAborted();
      if (error instanceof Error && error.message === "Managed Core response exceeds the configured limit") throw Error("provider_discovery_too_large");
      throw Error("provider_discovery_invalid");
    }
    remainingBytes -= bytes.byteLength;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw Error("provider_discovery_invalid"); }
    if (!Array.isArray(parsed?.data) || parsed.data.length > maximumModels) throw Error("provider_discovery_invalid");
    modelCount += parsed.data.length;
    if (modelCount > maximumModels) throw Error("provider_discovery_too_large");
    const ids = parsed.data.map(normalize);
    for (const id of ids) if (id !== undefined) allIds.add(id);
    if (!options.anthropic) {
      if (parsed.has_more === true) throw Error("provider_discovery_incomplete");
      return Object.freeze([...allIds].sort());
    }
    if (typeof parsed.has_more !== "boolean") throw Error("provider_discovery_invalid");
    if (!parsed.has_more) return Object.freeze([...allIds].sort());
    const cursor = parsed.last_id;
    if (!ids.length || typeof cursor !== "string" || cursor !== ids.at(-1) || cursors.has(cursor)) throw Error("provider_discovery_invalid_cursor");
    cursors.add(cursor);
    path = `/models?after_id=${encodeURIComponent(cursor)}`;
  }
  throw Error("provider_discovery_incomplete");
}
