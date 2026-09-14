import type { OAuthConfig } from "./oauth.js";

export const defaultOAuthConfig: Readonly<OAuthConfig> = Object.freeze({
  authorizationUrl:
    "https://auth.openai.com/oauth/authorize",
  tokenUrl:
    "https://auth.openai.com/oauth/token",
  deviceAuthorizationUrl:
    "https://auth.openai.com/api/accounts/deviceauth/usercode",
  deviceTokenUrl:
    "https://auth.openai.com/api/accounts/deviceauth/token",
  deviceVerificationUrl:
    "https://auth.openai.com/codex/device",
  deviceRedirectUri:
    "https://auth.openai.com/deviceauth/callback",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  scope: "openid profile email offline_access",
  audience: undefined,
  redirectUri:
    "http://localhost:1455/auth/callback",
});

// Preserve configurable desktop behavior; isolated Team sessions use only defaults.
export const oauthConfig: OAuthConfig = {
  authorizationUrl: process.env.OAUTH_AUTHORIZATION_URL ?? defaultOAuthConfig.authorizationUrl,
  tokenUrl: process.env.OAUTH_TOKEN_URL ?? defaultOAuthConfig.tokenUrl,
  deviceAuthorizationUrl: process.env.OAUTH_DEVICE_AUTHORIZATION_URL ?? defaultOAuthConfig.deviceAuthorizationUrl,
  deviceTokenUrl: process.env.OAUTH_DEVICE_TOKEN_URL ?? defaultOAuthConfig.deviceTokenUrl,
  deviceVerificationUrl: process.env.OAUTH_DEVICE_VERIFICATION_URL ?? defaultOAuthConfig.deviceVerificationUrl,
  deviceRedirectUri: process.env.OAUTH_DEVICE_REDIRECT_URI ?? defaultOAuthConfig.deviceRedirectUri,
  clientId: process.env.OAUTH_CLIENT_ID ?? defaultOAuthConfig.clientId,
  scope: process.env.OAUTH_SCOPE ?? defaultOAuthConfig.scope,
  audience: process.env.OAUTH_AUDIENCE ?? defaultOAuthConfig.audience,
  redirectUri: process.env.OAUTH_REDIRECT_URI ?? defaultOAuthConfig.redirectUri,
};
