import { randomUUID } from "node:crypto";
import type { Account, OAuthFlowState, UpstreamMode } from "./types.js";

export const COPILOT_BASE_URL = "https://api.githubcopilot.com";
const CLIENT_ID = process.env.GITHUB_COPILOT_CLIENT_ID ?? "Iv1.b507a08c87ecfe98";
const CLIENT_HEADERS = {
  "editor-version": "vscode/1.104.0",
  "editor-plugin-version": "copilot-chat/0.26.7",
  "user-agent": "GitHubCopilotChat/0.26.7",
  "x-github-api-version": "2025-04-01",
};
const OAUTH_HEADERS = { accept: "application/json", "content-type": "application/json" };
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
type FetchLike = typeof fetch;

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function requestCopilotDeviceCode(fetchImpl: FetchLike = fetch) {
  const response = await fetchImpl("https://github.com/login/device/code", {
    method: "POST", headers: OAUTH_HEADERS,
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
    redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub device authorization failed (${response.status})`);
  const data = await response.json() as any;
  if (typeof data.device_code !== "string" || !data.device_code.trim() ||
      typeof data.user_code !== "string" || !/^[A-Za-z0-9-]+$/.test(data.user_code)) {
    throw new Error("GitHub returned invalid device authorization codes");
  }
  const verification = new URL(data.verification_uri);
  if (verification.origin !== "https://github.com" || verification.pathname !== "/login/device" ||
      verification.username || verification.password || verification.search || verification.hash) {
    throw new Error("GitHub returned an untrusted verification URL");
  }
  return {
    deviceCode: data.device_code as string,
    userCode: data.user_code as string,
    verificationUrl: verification.toString(),
    intervalSeconds: Math.max(5, positiveSeconds(data.interval, 5)),
    expiresAt: Date.now() + positiveSeconds(data.expires_in, 900) * 1000,
  };
}

export async function pollCopilotDeviceCode(deviceCode: string, intervalSeconds = 5, fetchImpl: FetchLike = fetch): Promise<
  { status: "pending"; intervalSeconds: number } | { status: "success"; githubToken: string }
> {
  if (!deviceCode.trim()) throw new Error("Missing GitHub device code");
  const response = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST", headers: OAUTH_HEADERS,
    body: JSON.stringify({ client_id: CLIENT_ID, device_code: deviceCode, grant_type: DEVICE_GRANT }),
    redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub device authorization failed (${response.status})`);
  const data = await response.json() as any;
  // GitHub returns OAuth errors with HTTP 200.
  if (data.error === "authorization_pending" || data.error === "slow_down") {
    return { status: "pending", intervalSeconds: Math.max(
      positiveSeconds(intervalSeconds, 5) + (data.error === "slow_down" ? 5 : 0),
      positiveSeconds(data.interval, 5),
    ) };
  }
  if (data.error) {
    const message = data.error === "access_denied" ? "GitHub authorization was denied"
      : data.error === "expired_token" ? "GitHub device code expired"
      : "GitHub device authorization failed";
    throw new Error(message);
  }
  if (typeof data.access_token !== "string" || !data.access_token.trim()) {
    throw new Error("GitHub did not return an access token");
  }
  return { status: "success", githubToken: data.access_token };
}

/** Only GitHub's Copilot API hosts may receive inference credentials. */
export function trustedCopilotBaseUrl(value: string = COPILOT_BASE_URL): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !["api.githubcopilot.com", "api.business.githubcopilot.com", "api.enterprise.githubcopilot.com"].includes(url.hostname) ||
      url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Untrusted GitHub Copilot API endpoint");
  }
  return url.origin;
}

export async function refreshCopilotAccessToken(account: Account & { refreshToken: string }, fetchImpl: FetchLike = fetch): Promise<Account> {
  // refreshToken holds the long-lived GitHub OAuth token, never the inference token.
  const response = await fetchImpl("https://api.github.com/copilot_internal/v2/token", {
    headers: { ...CLIENT_HEADERS, accept: "application/json", authorization: `token ${account.refreshToken}` },
    redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub Copilot token exchange failed (${response.status}). Check Copilot access and organization policy.`);
  const data = await response.json() as any;
  if (typeof data.token !== "string" || !data.token.trim() ||
      typeof data.expires_at !== "number" || !Number.isFinite(data.expires_at) || data.expires_at * 1000 <= Date.now()) {
    throw new Error("GitHub Copilot returned an invalid inference token");
  }
  const baseUrl = trustedCopilotBaseUrl(data.endpoints?.api ?? account.baseUrl ?? COPILOT_BASE_URL);
  return {
    ...account, accessToken: data.token, expiresAt: data.expires_at * 1000, baseUrl,
    state: { ...account.state, needsTokenRefresh: false, authBlockedUntil: undefined, lastError: undefined },
  };
}

export async function accountFromCopilotOAuth(flow: OAuthFlowState, githubToken: string, existing?: Account, fetchImpl: FetchLike = fetch): Promise<Account> {
  return refreshCopilotAccessToken({
    ...existing,
    id: existing?.id ?? flow.targetAccountId ?? randomUUID(),
    provider: "github-copilot", email: flow.email || existing?.email,
    accessToken: "", refreshToken: githubToken,
    enabled: existing?.enabled ?? true, priority: existing?.priority ?? 0,
  }, fetchImpl);
}

export function buildCopilotHeaders(accessToken: string, payload?: any, accept = "text/event-stream"): Record<string, string> {
  const messages = Array.isArray(payload?.messages) ? payload.messages : Array.isArray(payload?.input) ? payload.input : [];
  const last = messages.at(-1);
  const vision = messages.some((message: any) => Array.isArray(message?.content) &&
    message.content.some((part: any) => part?.type === "image_url" || part?.type === "input_image"));
  return {
    ...CLIENT_HEADERS, authorization: `Bearer ${accessToken}`, accept,
    "content-type": "application/json", "copilot-integration-id": "vscode-chat",
    "openai-intent": "conversation-panel", "x-request-id": randomUUID(),
    "x-initiator": last && last.role !== "user" ? "agent" : "user",
    ...(vision ? { "copilot-vision-request": "true" } : {}),
  };
}

/** Expose only enabled text models whose protocol the proxy can serve. */
export function copilotModelEntries(payload: any): Array<Record<string, any> & { id: string; upstreamMode: UpstreamMode }> {
  if (!Array.isArray(payload?.data)) return [];
  return payload.data.flatMap((entry: any) => {
    if (typeof entry?.id !== "string" || !entry.id.trim() || entry.model_picker_enabled === false ||
        (entry.policy?.state && entry.policy.state !== "enabled") ||
        (entry.capabilities?.type && entry.capabilities.type !== "chat")) return [];
    const endpoints = entry.supported_endpoints;
    const upstreamMode: UpstreamMode | undefined = Array.isArray(endpoints)
      ? endpoints.includes("/responses") ? "responses" : endpoints.includes("/chat/completions") ? "chat/completions" : undefined
      : "chat/completions";
    if (!upstreamMode) return [];
    const supports = entry.capabilities?.supports;
    return [{
      ...entry, id: entry.id.trim(), upstreamMode,
      context_window: entry.capabilities?.limits?.max_context_window_tokens ?? entry.capabilities?.limits?.max_prompt_tokens,
      max_output_tokens: entry.capabilities?.limits?.max_output_tokens,
      supported_tool_types: supports?.tool_calls === false ? [] : ["function"],
      supports_reasoning: Boolean(supports?.reasoning_effort?.length || supports?.reasoning),
    }];
  });
}
