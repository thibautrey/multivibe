/** Narrow, storage-free Core device authentication boundary for an isolated Team vault.
 * The returned session belongs in the vault process, never in a JSON response.
 * Tenant authorization, persistence and delivery remain the caller's responsibility.
 */
import { accountFromCopilotOAuth, pollCopilotDeviceCode, requestCopilotDeviceCode } from './github-copilot.js';
import { accountFromXaiOAuth, pollXaiDeviceCode, requestXaiDeviceCode } from './xai.js';
import {accountFromOpenCodeOAuth, pollOpenCodeDeviceCode, requestOpenCodeDeviceCode} from './opencode.js';
import {requestTeamOpenAiDeviceCode, pollTeamOpenAiDeviceCode} from './team-openai-device.js';
import {accountFromOAuth} from './oauth.js';
import type { Account, OAuthFlowState } from './types.js';

export type TeamDeviceProvider = 'github-copilot' | 'xai' | 'opencode' | 'openai';
export type TeamDeviceChallenge = Readonly<{
  provider: TeamDeviceProvider;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAt: number;
}>;
export type TeamDeviceSession = {
  challenge: TeamDeviceChallenge;
  poll(): Promise<{ status: 'pending'; intervalSeconds: number } | { status: 'success'; account: Account }>;
  cancel(): void;
};

/** Requires an injected egress transport: there is deliberately no direct-fetch fallback. */
export async function startTeamDeviceAuth(provider: TeamDeviceProvider, transport: typeof fetch): Promise<TeamDeviceSession> {
  if (provider !== 'github-copilot' && provider !== 'xai' && provider !== 'opencode' && provider !== 'openai') throw new Error('Unsupported Team device provider');
  const controller = new AbortController();
  let transportDeadline = Infinity;
  const fetchImpl: typeof fetch = (input, init) => {
    if (Date.now() >= transportDeadline) controller.abort();
    controller.signal.throwIfAborted();
    return transport(input, {
    ...init,
    body: init?.body instanceof URLSearchParams ? init.body.toString() : init?.body,
    redirect: 'error',
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]),
    });
  };
  let result;
  try {
    result = provider === 'openai' ? await requestTeamOpenAiDeviceCode(fetchImpl) : provider === 'github-copilot'
      ? await requestCopilotDeviceCode(fetchImpl)
      : provider === 'opencode' ? await requestOpenCodeDeviceCode(fetchImpl) : await requestXaiDeviceCode(fetchImpl);
  } catch {
    controller.abort();
    throw new Error('Team device authorization could not be started');
  }
  if (!Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() ||
      !Number.isFinite(result.intervalSeconds) || result.intervalSeconds <= 0) {
    throw new Error('Invalid Team device authorization lifetime');
  }
  transportDeadline = result.expiresAt;
  let deviceCode = result.deviceCode;
  let intervalSeconds = Math.max(5, result.intervalSeconds);
  let nextPollAt = Date.now() + intervalSeconds * 1000;
  let closed = false;
  let busy = false;
  const challenge = Object.freeze({ provider, userCode: result.userCode, verificationUrl: result.verificationUrl,
    intervalSeconds, expiresAt: result.expiresAt });
  const cancel = () => { closed = true; deviceCode = ''; controller.abort(); };
  return {
    challenge,
    cancel,
    async poll() {
      if (closed || Date.now() >= challenge.expiresAt) {
        cancel();
        throw new Error('Team device authorization is no longer active');
      }
      if (busy || Date.now() < nextPollAt) return { status: 'pending', intervalSeconds };
      busy = true;
      try {
        const flow: OAuthFlowState = { id: '', email: '', codeVerifier: '', createdAt: Date.now(), method: 'device', provider, status: 'pending' };
        const polled = provider === 'openai' ? await pollTeamOpenAiDeviceCode(deviceCode,challenge.userCode,intervalSeconds,fetchImpl) : provider === 'github-copilot'
          ? await pollCopilotDeviceCode(deviceCode, intervalSeconds, fetchImpl)
          : provider === 'opencode' ? await pollOpenCodeDeviceCode(deviceCode, intervalSeconds, fetchImpl) : await pollXaiDeviceCode(deviceCode, intervalSeconds, fetchImpl);
        if (closed || Date.now() >= challenge.expiresAt) throw new Error('Expired');
        if (polled.status === 'pending') {
          intervalSeconds = Math.max(intervalSeconds, polled.intervalSeconds);
          nextPollAt = Date.now() + intervalSeconds * 1000;
          return { status: 'pending', intervalSeconds };
        }
        // Preserve Core's complete account context, not only the access token.
        const account = 'githubToken' in polled
          ? await accountFromCopilotOAuth(flow, polled.githubToken, undefined, fetchImpl)
          : 'chatgptToken' in polled ? {...accountFromOAuth(flow,polled.chatgptToken),provider:'openai' as const} : 'accessToken' in polled.token ? await accountFromOpenCodeOAuth(flow, polled.token, undefined, fetchImpl) : accountFromXaiOAuth(flow, polled.token);
        if (closed || Date.now() >= challenge.expiresAt) throw new Error('Expired');
        cancel();
        return { status: 'success', account };
      } catch {
        cancel();
        // Provider error descriptions can contain tokens; never forward them.
        throw new Error('Team device authorization failed');
      } finally { busy = false; }
    },
  };
}

export {encodeTeamDeviceCredential} from './team-provider-credential.js';

export {discoverTeamDeviceAccount} from "./team-device-catalog.js";

export {createTeamApiKeyValidator} from './team-api-key-validation.js';
export {executePersonalProviderChat} from './personal-provider-execution.js';
