/**
 * `doctor` — prove the bridge is actually usable, without printing a secret.
 *
 * Each check answers one question the operator would otherwise discover in
 * production: can I reach the edge, does Access let me through, does the edge
 * consider my model servable, and can Nous serve the fallback?
 */

import type { BridgeConfig, BridgeSecrets, ModelMapping } from "./config.js";
import { mapModel, redactSecrets } from "./config.js";
import { edgeHeaders, nousHeaders } from "./server.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skipped";

export type CheckResult = {
  name: string;
  status: CheckStatus;
  /** Safe to print: never contains a credential or prompt content. */
  detail: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: CheckResult[];
  secrets: Record<string, unknown>;
};

const REDIRECT = { redirect: "error" as const };

export async function runDoctor(options: {
  config: BridgeConfig;
  secrets: BridgeSecrets;
  mappings: readonly ModelMapping[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<DoctorReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.timeoutMs ?? 15_000;
  const checks: CheckResult[] = [];
  const edge = options.config.edgeBaseUrl.replace(/\/+$/, "");
  const nous = options.config.nousBaseUrl.replace(/\/+$/, "");

  const hasEdgeKey = Boolean(options.secrets.edgeApiKey);
  checks.push({
    name: "edge credential",
    status: hasEdgeKey ? "ok" : "fail",
    detail: hasEdgeKey ? "API key present" : "no edge API key stored; run `enroll` first",
  });

  const access = Boolean(options.secrets.accessClientId && options.secrets.accessClientSecret);
  checks.push({
    name: "cloudflare access",
    status: access ? "ok" : "warn",
    detail: access
      ? "service token present"
      : "no service token; the edge will answer with an Access redirect if it is protected",
  });

  // 1. Reachability and Access in one probe: a JSON body proves we got past the
  //    login page, whereas a 302 means Access rejected the request.
  if (hasEdgeKey) {
    try {
      const response = await fetchImpl(`${edge}/models`, {
        headers: edgeHeaders(options.secrets, {}),
        ...REDIRECT,
        signal: AbortSignal.timeout(timeout),
      });
      if (response.status === 401 || response.status === 403) {
        checks.push({
          name: "edge reachability",
          status: "fail",
          detail: `HTTP ${response.status}: the API key was refused`,
        });
      } else if (!response.ok) {
        checks.push({
          name: "edge reachability",
          status: "fail",
          detail: `HTTP ${response.status} from ${edge}/models`,
        });
      } else {
        const value = (await response.json().catch(() => ({}))) as { data?: unknown[] };
        checks.push({
          name: "edge reachability",
          status: "ok",
          detail: `HTTP ${response.status}, ${Array.isArray(value.data) ? value.data.length : "?"} models`,
        });
      }
    } catch (error) {
      const name = (error as { name?: string }).name;
      checks.push({
        name: "edge reachability",
        status: "fail",
        detail:
          name === "TypeError"
            ? "network error or an Access redirect the client refused"
            : `request failed: ${name ?? "unknown"}`,
      });
    }
  } else {
    checks.push({ name: "edge reachability", status: "skipped", detail: "no credential" });
  }

  // 2. Model mapping: the whole fallback depends on a same-class model existing.
  for (const mapping of options.mappings) {
    const edgeModel = mapModel(options.mappings, mapping.from, "edge");
    const nousModel = mapModel(options.mappings, mapping.from, "nous");
    checks.push({
      name: `mapping ${mapping.from}`,
      status: edgeModel && nousModel ? "ok" : "fail",
      detail:
        edgeModel && nousModel
          ? `edge=${edgeModel} nous=${nousModel}`
          : "a comparable model is missing on one side",
    });
  }

  // 3. The fallback must work, or the promise "never worse than today" is false.
  if (options.secrets.nousApiKey) {
    try {
      const response = await fetchImpl(`${nous}/models`, {
        headers: nousHeaders(options.secrets, {}),
        ...REDIRECT,
        signal: AbortSignal.timeout(timeout),
      });
      checks.push({
        name: "nous reachability",
        status: response.ok ? "ok" : "fail",
        detail: `HTTP ${response.status}`,
      });
    } catch {
      checks.push({ name: "nous reachability", status: "fail", detail: "network error" });
    }
  } else {
    checks.push({
      name: "nous reachability",
      status: "warn",
      detail: "no Nous key stored; the fallback is unavailable and an edge outage will fail the turn",
    });
  }

  const ok = !checks.some((check) => check.status === "fail");
  return { ok, checks, secrets: redactSecrets(options.secrets) };
}
