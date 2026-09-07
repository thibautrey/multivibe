use crate::{Account, AccountStore, EdgeConfig, now_ms};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{Client, StatusCode, Url};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Mutex;

const REFRESH_MARGIN_MS: u64 = 5 * 60 * 1_000;
const REFRESH_FAILURE_BLOCK_MS: u64 = 60 * 1_000;

#[derive(Clone, Default)]
pub(crate) struct TokenRefreshManager {
    locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    id_token: Option<String>,
    account_id: Option<String>,
}

impl TokenRefreshManager {
    pub(crate) fn can_refresh(account: &Account) -> bool {
        matches!(provider(account), "openai" | "opencode" | "xai")
            && account
                .refresh_token
                .as_deref()
                .is_some_and(|token| !token.trim().is_empty())
    }

    pub(crate) fn needs_refresh(account: &Account, now: u64) -> bool {
        Self::can_refresh(account)
            && account.expires_at.is_some_and(|expires_at| {
                expires_at > 0 && now >= expires_at.saturating_sub(REFRESH_MARGIN_MS)
            })
    }

    pub(crate) async fn refresh(
        &self,
        client: &Client,
        config: &EdgeConfig,
        store: &AccountStore,
        account: &Account,
        force: bool,
    ) -> Result<Account, String> {
        if !Self::can_refresh(account) || (!force && !Self::needs_refresh(account, now_ms())) {
            return Ok(account.clone());
        }

        let account_lock = {
            let mut locks = self.locks.lock().await;
            locks
                .entry(account.id.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = account_lock.lock().await;

        let current = store
            .snapshot()
            .await?
            .accounts
            .into_iter()
            .find(|candidate| candidate.id == account.id)
            .ok_or_else(|| format!("account {} no longer exists", account.id))?;

        // A concurrent request may have completed the refresh while this one
        // waited. Reuse that credential even for a forced retry after 401.
        if current.access_token != account.access_token {
            return Ok(current);
        }
        if !force && !Self::needs_refresh(&current, now_ms()) {
            return Ok(current);
        }

        // Validate persistence before rotating a provider refresh token.
        persistence_url(&config.node_control_plane_url, &current.id)?;
        let expected_access_token = current.access_token.clone();
        let refresh_result = refresh_token(client, config, &current).await;
        let refreshed = match refresh_result {
            Ok(token) => merge_token(&current, token)?,
            Err(error) => {
                let _ = persist_token_state(
                    client,
                    config,
                    &current,
                    &expected_access_token,
                    true,
                    Some(now_ms().saturating_add(REFRESH_FAILURE_BLOCK_MS)),
                )
                .await;
                return Err(error);
            }
        };

        match persist_token_state(
            client,
            config,
            &refreshed,
            &expected_access_token,
            false,
            None,
        )
        .await
        {
            Ok(()) => Ok(refreshed),
            Err(PersistError::Conflict) => {
                let latest = store
                    .snapshot()
                    .await?
                    .accounts
                    .into_iter()
                    .find(|candidate| candidate.id == account.id)
                    .ok_or_else(|| format!("account {} no longer exists", account.id))?;
                if latest.access_token != expected_access_token {
                    Ok(latest)
                } else {
                    Err("token persistence conflicted without a newer credential".to_owned())
                }
            }
            Err(PersistError::Unavailable(message)) => Err(message),
        }
    }
}

fn provider(account: &Account) -> &str {
    account.provider.as_deref().unwrap_or("openai")
}

async fn refresh_token(
    client: &Client,
    config: &EdgeConfig,
    account: &Account,
) -> Result<TokenResponse, String> {
    let refresh_token = account
        .refresh_token
        .as_deref()
        .ok_or_else(|| "refresh token is missing".to_owned())?;
    let response = match provider(account) {
        "openai" => {
            client
                .post(&config.oauth_token_url)
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("client_id", config.oauth_client_id.as_str()),
                    ("refresh_token", refresh_token),
                ])
                .send()
                .await
        }
        "opencode" => {
            let configured_console = trim_url(&config.opencode_console_url);
            if account
                .opencode_console_url
                .as_deref()
                .is_some_and(|url| trim_url(url) != configured_console)
            {
                return Err("OpenCode account uses an untrusted Console URL".to_owned());
            }
            client
                .post(format!("{configured_console}/auth/device/token"))
                .json(&json!({
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                    "client_id": config.opencode_oauth_client_id,
                }))
                .send()
                .await
        }
        "xai" => {
            let issuer = trim_url(&config.xai_oauth_issuer);
            if account
                .oidc_issuer
                .as_deref()
                .is_some_and(|candidate| trim_url(candidate) != issuer)
            {
                return Err("xAI account uses an untrusted OAuth issuer".to_owned());
            }
            if account
                .oidc_client_id
                .as_deref()
                .is_some_and(|client_id| client_id != config.xai_oauth_client_id)
            {
                return Err("xAI account uses an unexpected OAuth client id".to_owned());
            }
            client
                .post(format!("{issuer}/oauth2/token"))
                .header("accept", "application/json")
                .header("x-grok-client-version", &config.xai_client_version)
                .header("x-grok-client-surface", "headless")
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh_token),
                    ("client_id", config.xai_oauth_client_id.as_str()),
                ])
                .send()
                .await
        }
        _ => return Err("account provider does not support token refresh".to_owned()),
    }
    .map_err(|error| format!("token refresh request failed: {error}"))?;

    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("token refresh response failed: {error}"))?;
    if !status.is_success() {
        let provider_error = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|value| {
                value
                    .get("error_description")
                    .or_else(|| value.get("error"))
                    .and_then(Value::as_str)
                    .map(|message| message.chars().take(200).collect::<String>())
            });
        return Err(match provider_error {
            Some(error) => format!("token refresh returned HTTP {status}: {error}"),
            None => format!("token refresh returned HTTP {status}"),
        });
    }
    let token = serde_json::from_slice::<TokenResponse>(&bytes)
        .map_err(|_| "token refresh returned an invalid JSON response".to_owned())?;
    if token.access_token.trim().is_empty() {
        return Err("token refresh response did not include an access token".to_owned());
    }
    Ok(token)
}

fn merge_token(account: &Account, token: TokenResponse) -> Result<Account, String> {
    let mut refreshed = account.clone();
    if provider(account) == "openai" {
        let identity = openai_identity(&token);
        if let (Some(expected), Some(received)) = (
            account.chatgpt_account_id.as_deref(),
            identity.account_id.as_deref(),
        ) && expected != received
        {
            return Err("OAuth refresh returned a different ChatGPT account".to_owned());
        }
        if account.chatgpt_account_id.is_none() {
            let expected_email = account.email.as_deref().map(normalize_email);
            let received_email = identity.email.as_deref().map(normalize_email);
            if let (Some(expected), Some(received)) = (expected_email, received_email.as_deref())
                && expected != received
            {
                return Err("OAuth refresh returned a different account email".to_owned());
            }
            refreshed.chatgpt_account_id = identity.account_id;
            if refreshed.email.is_none() {
                refreshed.email = identity.email;
            }
        }
    }
    refreshed.access_token = token.access_token;
    if token
        .refresh_token
        .as_deref()
        .is_some_and(|candidate| !candidate.trim().is_empty())
    {
        refreshed.refresh_token = token.refresh_token;
    }
    if let Some(expires_in) = token.expires_in.filter(|seconds| *seconds > 0) {
        refreshed.expires_at = Some(now_ms().saturating_add(expires_in.saturating_mul(1_000)));
    }
    if let Some(state) = refreshed.state.as_mut() {
        state.needs_token_refresh = Some(false);
        state.auth_blocked_until = None;
    }
    Ok(refreshed)
}

#[derive(Default)]
struct OpenAiIdentity {
    account_id: Option<String>,
    email: Option<String>,
}

fn openai_identity(token: &TokenResponse) -> OpenAiIdentity {
    let claims = token
        .id_token
        .as_deref()
        .and_then(|jwt| jwt.split('.').nth(1))
        .and_then(|payload| URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok())
        .and_then(|payload| serde_json::from_slice::<Value>(&payload).ok());
    OpenAiIdentity {
        account_id: token.account_id.clone().or_else(|| {
            claims
                .as_ref()
                .and_then(|value| value.get("account_id"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        }),
        email: claims
            .as_ref()
            .and_then(|value| value.get("email"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    }
}

fn normalize_email(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn trim_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_owned()
}

enum PersistError {
    Conflict,
    Unavailable(String),
}

// Credentials may cross the process boundary over loopback HTTP, but must
// never cross a network in cleartext. Keep account IDs in a single URL segment.
fn persistence_url(base: &str, account_id: &str) -> Result<Url, String> {
    let invalid = || "token persistence requires HTTPS or loopback HTTP without URL credentials, query or fragment".to_owned();
    let mut url = Url::parse(base.trim()).map_err(|_| invalid())?;
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host.trim_matches(['[', ']']).parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some()
        || !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
    {
        return Err(invalid());
    }
    url.path_segments_mut().map_err(|_| invalid())?
        .pop_if_empty().extend(["internal", "v1-edge", "accounts", account_id, "token"]);
    Ok(url)
}

async fn persist_token_state(
    client: &Client,
    config: &EdgeConfig,
    account: &Account,
    expected_access_token: &str,
    needs_token_refresh: bool,
    auth_blocked_until: Option<u64>,
) -> Result<(), PersistError> {
    let internal_token = config.internal_job_token.as_deref().ok_or_else(|| {
        PersistError::Unavailable(
            "V1_EDGE_INTERNAL_JOB_TOKEN is required to persist refreshed credentials".to_owned(),
        )
    })?;
    let url = persistence_url(&config.node_control_plane_url, &account.id)
        .map_err(PersistError::Unavailable)?;
    let mut payload = json!({
        "expectedAccessToken": expected_access_token,
        "accessToken": account.access_token,
        "needsTokenRefresh": needs_token_refresh,
        "authBlockedUntil": auth_blocked_until,
    });
    let payload = payload
        .as_object_mut()
        .expect("token persistence payload is an object");
    if let Some(value) = account.refresh_token.as_ref() {
        payload.insert("refreshToken".to_owned(), Value::String(value.clone()));
    }
    if let Some(value) = account.expires_at {
        payload.insert("expiresAt".to_owned(), Value::Number(value.into()));
    }
    if let Some(value) = account.chatgpt_account_id.as_ref() {
        payload.insert("chatgptAccountId".to_owned(), Value::String(value.clone()));
    }
    if let Some(value) = account.email.as_ref() {
        payload.insert("email".to_owned(), Value::String(value.clone()));
    }
    let response = client
        .post(url)
        .header("x-multivibe-internal-token", internal_token)
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            PersistError::Unavailable(format!("token persistence request failed: {error}"))
        })?;
    match response.status() {
        status if status.is_success() => Ok(()),
        StatusCode::CONFLICT => Err(PersistError::Conflict),
        status => Err(PersistError::Unavailable(format!(
            "token persistence returned HTTP {status}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persistence_transport_preserves_local_and_tls_deployments() {
        for base in ["http://127.0.0.1:1456", "http://[::1]:1456", "http://localhost:1456", "https://control.example"] {
            let url = persistence_url(base, "account one").unwrap();
            assert!(url.path().ends_with("/internal/v1-edge/accounts/account%20one/token"));
        }
        assert!(persistence_url("http://control.example", "account").is_err());
        assert!(persistence_url("https://control.example?region=one", "account").is_err());
        assert_eq!(persistence_url("https://control.example/core/", "account").unwrap().path(),
            "/core/internal/v1-edge/accounts/account/token");
    }

    #[test]
    fn refresh_eligibility_matches_supported_expiring_accounts() {
        let account = Account {
            id: "account".to_owned(),
            provider: Some("openai".to_owned()),
            refresh_token: Some("refresh".to_owned()),
            expires_at: Some(REFRESH_MARGIN_MS),
            enabled: true,
            ..Default::default()
        };
        assert!(TokenRefreshManager::needs_refresh(&account, 1));
        let mut api_key = account.clone();
        api_key.provider = Some("mistral".to_owned());
        assert!(!TokenRefreshManager::can_refresh(&api_key));
    }

    #[test]
    fn openai_refresh_rejects_a_different_account_identity() {
        let account = Account {
            id: "account".to_owned(),
            chatgpt_account_id: Some("expected".to_owned()),
            ..Default::default()
        };
        let result = merge_token(
            &account,
            TokenResponse {
                access_token: "new".to_owned(),
                refresh_token: None,
                expires_in: Some(60),
                id_token: None,
                account_id: Some("other".to_owned()),
            },
        );
        assert!(result.is_err());
    }
}
