import { V1_EDGE_BASE_URL, V1_EDGE_INTERNAL_JOB_TOKEN } from "./config.js";
import type { AccountStore } from "./store.js";
import type { discoverModels as legacyDiscovery } from "./routes/proxy/index.js";

// Dashboard callers use the same authoritative catalog as inference.
export async function discoverModels(
  _store: AccountStore, _openai: string, _mistral: string, _zai: string,
): Promise<Awaited<ReturnType<typeof legacyDiscovery>>> {
  const response = await fetch(`${V1_EDGE_BASE_URL}/v1/models`, {
    headers: { "x-multivibe-internal-token": V1_EDGE_INTERNAL_JOB_TOKEN },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Native model catalog HTTP ${response.status}`);
  const result = await response.json() as any;
  if (!Array.isArray(result.data)) throw new Error("Invalid native model catalog");
  return result.data;
}
