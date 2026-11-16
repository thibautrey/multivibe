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
  /**
   * Probe the enrollment surface. Off by default: it is an unauthenticated POST
   * to a deployment endpoint, and the CLI turns it on explicitly.
   */
  checkEnrollment?: boolean;
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
  //
  // A mapped model must actually exist on the fallback: Nous serves a large
  // catalogue and *no* `hermes-*` model at the time of writing, so a plausible
  // name is not evidence. The check compares against the live list.
  if (options.secrets.nousApiKey) {
    try {
      const response = await fetchImpl(`${nous}/models`, {
        headers: nousHeaders(options.secrets, {}),
        ...REDIRECT,
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        checks.push({
          name: "nous reachability",
          status: "fail",
          detail: `HTTP ${response.status}`,
        });
      } else {
        const body = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
        const available = new Set(
          (body.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === "string"),
        );
        checks.push({
          name: "nous reachability",
          status: "ok",
          detail: `HTTP ${response.status}, ${available.size} models`,
        });
        for (const mapping of options.mappings) {
          const target = mapModel(options.mappings, mapping.from, "nous");
          if (!target) continue;
          checks.push({
            name: `nous serves ${target}`,
            status: available.has(target) ? "ok" : "fail",
            detail: available.has(target)
              ? "present in the live catalogue"
              : "missing from the live catalogue; the fallback cannot serve this turn",
          });
        }
      }
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

  // Whether the *enrollment* surface is reachable without a token. This is worth
  // its own check because it is the one path a machine must reach before it holds
  // any credential, and because it fails differently from inference: a 302 here
  // means "you can never enrol", not "you are not authorised yet".
  if (options.checkEnrollment && options.config.enrollBaseUrl) {
    const exchangeUrl = `${options.config.enrollBaseUrl
      .replace(/\/+$/, "")
      .replace(/\/v1$/i, "")}/hermes-bridge/enrollment/exchange`;
    const tokenHeaders: Record<string, string> =
      access && options.secrets.accessClientId && options.secrets.accessClientSecret
        ? {
            "cf-access-client-id": options.secrets.accessClientId,
            "cf-access-client-secret": options.secrets.accessClientSecret,
          }
        : {};
    try {
      // `redirect: "manual"` on purpose: a 302 is the answer we need to *read*,
      // not an error to swallow. With `redirect: "error"` the reason is lost and
      // the operator only learns "unreachable", which is the wrong search.
      const response = await fetchImpl(exchangeUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...tokenHeaders },
        body: JSON.stringify({ code: `mvenr_${"0".repeat(43)}` }),
        redirect: "manual",
        signal: AbortSignal.timeout(timeout),
      });
      if (response.status === 302 || response.status === 301 || response.status === 307) {
        const location = response.headers.get("location") ?? "";
        const gatedByAccess = /cloudflareaccess\.com|\/cdn-cgi\/access\//.test(location);
        checks.push({
          name: "enrollment surface",
          status: "fail",
          detail: gatedByAccess
            ? "Access intercepts enrollment with a login redirect. A machine holds no token at this point, so it can never enrol: this path needs a Bypass policy or a separate unprotected hostname."
            : "unexpected redirect from the enrollment path",
        });
      } else {
        // Any other answer proves the path is reachable. `401` is the expected
        // "this code is not valid" reply and is a success for this check.
        checks.push({
          name: "enrollment surface",
          status: response.status < 500 ? "ok" : "fail",
          detail:
            response.status < 500
              ? `reachable (HTTP ${response.status}); the path is not gated`
              : `reachable but failing (HTTP ${response.status})`,
        });
      }
    } catch (error) {
      const message = String((error as Error).message ?? "");
      checks.push({
        name: "enrollment surface",
        status: "fail",
        detail: /redirect/i.test(message)
          ? "Access answers with a login redirect: enrollment is gated and must be exempted"
          : `unreachable: ${message.slice(0, 120)}`,
      });
    }
  }

  const ok = !checks.some((check) => check.status === "fail");
  return { ok, checks, secrets: redactSecrets(options.secrets) };
}
