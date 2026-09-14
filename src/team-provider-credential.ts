/** Versioned private wire format owned by Core. Cloud stores/seals coreAccountContext
 * opaquely; it must never spread this JSON into an account or a public response. */
import type { Account, ProviderId, UpstreamMode } from './types.js';
import { trustedCopilotBaseUrl } from './github-copilot.js';
import { OPENCODE_CONSOLE_URL, XAI_OAUTH_CLIENT_ID, XAI_OAUTH_ISSUER } from './config.js';

export interface TeamProviderCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  coreAccountContext?: string;
}
const MAX_CONTEXT = 64 * 1024;
const COMMON = ['schemaVersion', 'provider', 'baseUrl', 'upstreamMode'];
const COPILOT = [...COMMON, 'copilotModelEndpoints'];
const OPENCODE = [...COMMON, 'opencodeAccountId', 'opencodeOrgId', 'opencodeConsoleUrl', 'opencodeApiKey', 'opencodeHeaders'];
const XAI = [...COMMON, 'xaiUserId', 'xaiAuthScope', 'oidcIssuer', 'oidcClientId'];
function invalid(): never { throw new Error('Team provider credential is invalid'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\s\x00-\x1f\x7f]/u.test(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/u.test(value);
}
function mode(value: unknown): value is UpstreamMode { return value === 'responses' || value === 'chat/completions'; }
function canonicalEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return invalid();
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) return invalid();
    return url.href.replace(/\/+$/, '');
  } catch { return invalid(); }
}
/** Validate explicit allowlists; no arbitrary headers, URLs, local state or account IDs. */
function accountContext(value: unknown): Partial<Account> & {provider: 'github-copilot' | 'xai' | 'opencode'; baseUrl: string} {
  const input = object(value);
  if (input.schemaVersion !== 1 || !['github-copilot', 'xai', 'opencode'].includes(String(input.provider))) return invalid();
  const provider = input.provider as 'github-copilot' | 'xai' | 'opencode';
  if (Object.keys(input).some(key => !(provider === 'github-copilot' ? COPILOT : provider === 'opencode' ? OPENCODE : XAI).includes(key))) return invalid();
  const baseUrl = canonicalEndpoint(input.baseUrl);
  if (provider === 'github-copilot') {
    try { if (trustedCopilotBaseUrl(baseUrl) !== baseUrl) return invalid(); } catch { return invalid(); }
  } else if (provider === 'opencode' ? baseUrl !== 'https://opencode.ai/inference/openai' : baseUrl !== 'https://api.x.ai/v1') return invalid();
  const result: Partial<Account> & {provider: 'github-copilot' | 'xai' | 'opencode'; baseUrl: string} = {provider, baseUrl};
  if (input.upstreamMode !== undefined) {
    if (!mode(input.upstreamMode)) return invalid();
    result.upstreamMode = input.upstreamMode;
  }
  if (provider === 'github-copilot' && input.copilotModelEndpoints !== undefined) {
    const entries = Object.entries(object(input.copilotModelEndpoints));
    if (entries.length > 4096) return invalid();
    const endpoints: Record<string, UpstreamMode> = {};
    for (const [id, endpoint] of entries.sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || !mode(endpoint)) return invalid();
      endpoints[id] = endpoint;
    }
    result.copilotModelEndpoints = endpoints;
  }
  if (provider === 'opencode') {
    if (input.opencodeConsoleUrl !== OPENCODE_CONSOLE_URL.replace(/\/+$/, '') ||
        !text(input.opencodeAccountId) || !token(input.opencodeOrgId) ||
        !(input.opencodeApiKey === '{env:OPENCODE_CONSOLE_TOKEN}' || (token(input.opencodeApiKey) && !/[{}]/.test(input.opencodeApiKey)))) return invalid();
    result.opencodeAccountId = input.opencodeAccountId;
    result.opencodeOrgId = input.opencodeOrgId;
    result.opencodeConsoleUrl = input.opencodeConsoleUrl as string;
    result.opencodeApiKey = input.opencodeApiKey as string;
    if (input.opencodeHeaders !== undefined) {
      const headers = object(input.opencodeHeaders);
      // The workspace header is the only currently supported Console routing header.
      // Unknown headers must fail closed rather than silently change request semantics.
      if (Object.keys(headers).some(key => key !== 'x-org-id') ||
          (headers['x-org-id'] !== undefined && headers['x-org-id'] !== input.opencodeOrgId)) return invalid();
      result.opencodeHeaders = {...headers} as Record<string,string>;
    }
  }
  if (provider === 'xai') {
    // Pin to Core's operator-selected OAuth configuration, never to manifest input.
    if (input.oidcIssuer !== XAI_OAUTH_ISSUER || input.oidcClientId !== XAI_OAUTH_CLIENT_ID ||
        input.xaiAuthScope !== `${XAI_OAUTH_ISSUER}::${XAI_OAUTH_CLIENT_ID}`) return invalid();
    result.oidcIssuer = XAI_OAUTH_ISSUER;
    result.oidcClientId = XAI_OAUTH_CLIENT_ID;
    result.xaiAuthScope = input.xaiAuthScope as string;
    if (input.xaiUserId !== undefined) {
      if (!text(input.xaiUserId)) return invalid();
      result.xaiUserId = input.xaiUserId;
    }
  }
  return result;
}

/** Device-only serialization. Expanding supported providers requires a Core codec change. */
export function encodeTeamDeviceCredential(account: Account): TeamProviderCredential {
  const provider = account.provider;
  if (provider !== 'github-copilot' && provider !== 'xai' && provider !== 'opencode') return invalid();
  const context = accountContext({schemaVersion: 1, provider,
    baseUrl: account.baseUrl ?? (provider === 'xai' ? 'https://api.x.ai/v1' : undefined),
    ...(account.upstreamMode !== undefined ? {upstreamMode: account.upstreamMode} : {}),
    ...(provider === 'github-copilot' && account.copilotModelEndpoints !== undefined ? {copilotModelEndpoints: account.copilotModelEndpoints} : {}),
    ...(provider === 'opencode' ? {opencodeAccountId:account.opencodeAccountId,opencodeOrgId:account.opencodeOrgId,opencodeConsoleUrl:account.opencodeConsoleUrl,opencodeApiKey:account.opencodeApiKey,...(account.opencodeHeaders !== undefined ? {opencodeHeaders:account.opencodeHeaders} : {})} : {}),
    ...(provider === 'xai' ? {oidcIssuer: account.oidcIssuer, oidcClientId: account.oidcClientId,
      xaiAuthScope: account.xaiAuthScope, ...(account.xaiUserId !== undefined ? {xaiUserId: account.xaiUserId} : {})} : {}),
  });
  const result: TeamProviderCredential = {accessToken: account.accessToken,
    ...(account.refreshToken !== undefined ? {refreshToken: account.refreshToken} : {}),
    ...(account.expiresAt !== undefined ? {expiresAt: account.expiresAt} : {}),
    coreAccountContext: JSON.stringify({schemaVersion: 1, ...context})};
  // Use exactly the import validator before handing secrets to the isolated store.
  decodeTeamProviderCredential(result, provider, context.baseUrl);
  return result;
}

/** Legacy API-key bundles remain valid. Versioned device context binds provider + endpoint. */
export function decodeTeamProviderCredential(value: unknown, provider: ProviderId, endpoint: string):
  Pick<Account, 'accessToken' | 'refreshToken' | 'expiresAt'> & Partial<Account> {
  const input = object(value);
  if (Object.keys(input).some(key => !['accessToken', 'refreshToken', 'expiresAt', 'coreAccountContext'].includes(key)) ||
      !token(input.accessToken) || (input.refreshToken !== undefined && !token(input.refreshToken)) ||
      (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || (input.expiresAt as number) < 0))) return invalid();
  const credential = {accessToken: input.accessToken,
    ...(input.refreshToken !== undefined ? {refreshToken: input.refreshToken as string} : {}),
    ...(input.expiresAt !== undefined ? {expiresAt: input.expiresAt as number} : {})};
  if (input.coreAccountContext === undefined) return credential;
  if (typeof input.coreAccountContext !== 'string' || Buffer.byteLength(input.coreAccountContext) > MAX_CONTEXT) return invalid();
  let context;
  try { context = accountContext(JSON.parse(input.coreAccountContext)); } catch { return invalid(); }
  if (context.provider !== provider || context.baseUrl !== canonicalEndpoint(endpoint)) return invalid();
  return {...credential, ...context};
}

/** Drop the previous credential's routing/identity state even when switching to an API key
 * or cloud proxy. Preserve only noncredential account preferences outside this allowlist. */
export function withoutTeamCredentialContext(account: Account | undefined): Partial<Account> {
  if (!account) return {};
  const {accessToken, refreshToken, expiresAt, baseUrl, upstreamMode, compatibilityMode, sdkProvider, sdkModels,
    chatgptAccountId, opencodeAccountId, opencodeOrgId, opencodeOrgName, opencodeConsoleUrl, opencodeApiKey,
    opencodeHeaders, copilotModelEndpoints, xaiUserId, xaiAuthScope, oidcIssuer, oidcClientId,
    state, usage, localRuntime, multivibeCloud, ...rest} = account;
  return rest;
}
