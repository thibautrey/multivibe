use super::{
    EdgeConfig, EdgeState, admin_session_value, constant_time_equal, cookie_value, header_value,
    json_response, now_ms, trim_slashes,
};
use axum::{
    body::{Body, to_bytes},
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, Request, StatusCode, header},
    response::Response,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
    time::Duration,
};
use tokio::time::timeout;

const ADMIN_SESSION_COOKIE: &str = "multivibe_admin_session";
const ADMIN_SESSION_MAX_AGE_SECONDS: u64 = 400 * 24 * 60 * 60;
const DESKTOP_SESSION_MAX_AGE_MS: u64 = 60_000;
const ADMIN_AUTH_REQUEST_LIMIT: u32 = 20;
const ADMIN_AUTH_WINDOW_MS: u64 = 60_000;

#[derive(Default)]
struct FixedWindowBudget {
    reset_at: u64,
    count: u32,
}

impl FixedWindowBudget {
    fn consume(&mut self, now: u64) -> Result<(), u64> {
        if now >= self.reset_at {
            self.reset_at = now.saturating_add(ADMIN_AUTH_WINDOW_MS);
            self.count = 0;
        }
        if self.count >= ADMIN_AUTH_REQUEST_LIMIT {
            return Err(self.reset_at.saturating_sub(now).div_ceil(1_000).max(1));
        }
        self.count += 1;
        Ok(())
    }
}

#[derive(Default)]
pub(super) struct DashboardState {
    auth_budget: Mutex<FixedWindowBudget>,
    desktop_sessions: Mutex<VecDeque<(String, u64)>>,
}

fn has_session(headers: &HeaderMap, config: &EdgeConfig) -> bool {
    cookie_value(headers, ADMIN_SESSION_COOKIE)
        .is_some_and(|value| constant_time_equal(&value, &admin_session_value(&config.admin_token)))
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = header_value(headers, "x-admin-token") {
        return Some(value);
    }
    let value = header_value(headers, "authorization")?;
    let mut parts = value.split_whitespace();
    let scheme = parts.next()?;
    let token = parts.next()?;
    (scheme.eq_ignore_ascii_case("bearer") && parts.next().is_none()).then(|| token.to_owned())
}

pub(super) fn request_authorized(headers: &HeaderMap, config: &EdgeConfig) -> bool {
    config.admin_token.is_empty()
        || has_session(headers, config)
        || bearer_token(headers)
            .is_some_and(|token| constant_time_equal(&token, &config.admin_token))
}

pub(super) fn path_requires_session(path: &str) -> bool {
    if path != "/admin" && !path.starts_with("/admin/") {
        return false;
    }
    !matches!(
        path,
        "/admin/session" | "/admin/cloud/oauth/callback" | "/admin/codex-sessions"
    )
}

fn request_uses_https(headers: &HeaderMap) -> bool {
    header_value(headers, "x-forwarded-proto")
        .and_then(|value| value.split(',').next().map(str::trim).map(str::to_owned))
        .is_some_and(|value| value.eq_ignore_ascii_case("https"))
}

fn session_cookie(config: &EdgeConfig, secure: bool) -> String {
    format!(
        "{ADMIN_SESSION_COOKIE}={}; Max-Age={ADMIN_SESSION_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Strict{}",
        admin_session_value(&config.admin_token),
        if secure { "; Secure" } else { "" }
    )
}

fn cleared_session_cookie(secure: bool) -> String {
    format!(
        "{ADMIN_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict{}",
        if secure { "; Secure" } else { "" }
    )
}

fn with_no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub(super) async fn health(State(state): State<EdgeState>) -> Response {
    let control_plane = timeout(
        Duration::from_secs(5),
        state
            .control_plane_client
            .get(format!(
                "{}/health",
                trim_slashes(&state.config.node_control_plane_url)
            ))
            .send(),
    )
    .await;
    if !matches!(control_plane, Ok(Ok(response)) if response.status().is_success()) {
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"ok": false, "error": "control_plane_unavailable"}),
        );
    }
    json_response(
        StatusCode::OK,
        json!({
            "ok": true,
            "version": state.config.app_version,
            "gitSha": state.config.app_git_sha,
            "buildId": state.config.app_build_id,
        }),
    )
}

pub(super) async fn session_status(State(state): State<EdgeState>, headers: HeaderMap) -> Response {
    let authenticated = state.config.admin_token.is_empty() || has_session(&headers, &state.config);
    with_no_store(json_response(
        StatusCode::OK,
        json!({"authenticated": authenticated}),
    ))
}

pub(super) async fn session_create(State(state): State<EdgeState>, req: Request<Body>) -> Response {
    let headers = req.headers().clone();
    let body = match to_bytes(req.into_body(), state.config.request_body_limit).await {
        Ok(body) => body,
        Err(_) => {
            return with_no_store(json_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({"error": "Request body is too large"}),
            ));
        }
    };
    let content_type = header_value(&headers, "content-type").unwrap_or_default();
    let payload = if content_type
        .split(';')
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
    {
        match serde_json::from_slice::<Value>(&body) {
            Ok(payload) => payload,
            Err(_) => {
                return with_no_store(json_response(
                    StatusCode::BAD_REQUEST,
                    json!({"error": "Invalid JSON body"}),
                ));
            }
        }
    } else {
        Value::Null
    };

    let retry_after = {
        let mut budget = state
            .dashboard
            .auth_budget
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        budget.consume(now_ms()).err()
    };
    if let Some(retry_after) = retry_after {
        let mut response = with_no_store(json_response(
            StatusCode::TOO_MANY_REQUESTS,
            json!({"error": "Too many authentication requests. Try again later."}),
        ));
        if let Ok(value) = HeaderValue::from_str(&retry_after.to_string()) {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        return response;
    }

    if state.config.admin_token.is_empty() {
        return with_no_store(json_response(
            StatusCode::OK,
            json!({"authenticated": true}),
        ));
    }
    let token = payload
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !constant_time_equal(token, &state.config.admin_token) {
        return with_no_store(json_response(
            StatusCode::UNAUTHORIZED,
            json!({"error": "unauthorized"}),
        ));
    }
    let mut response = with_no_store(json_response(
        StatusCode::OK,
        json!({"authenticated": true}),
    ));
    if let Ok(value) =
        HeaderValue::from_str(&session_cookie(&state.config, request_uses_https(&headers)))
    {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

pub(super) async fn session_delete(headers: HeaderMap) -> Response {
    let mut response = with_no_store(json_response(
        StatusCode::OK,
        json!({"authenticated": false}),
    ));
    if let Ok(value) = HeaderValue::from_str(&cleared_session_cookie(request_uses_https(&headers)))
    {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

pub(super) async fn desktop_session_create(
    State(state): State<EdgeState>,
    headers: HeaderMap,
) -> Response {
    if !request_authorized(&headers, &state.config) {
        return json_response(StatusCode::UNAUTHORIZED, json!({"error": "unauthorized"}));
    }
    let now = now_ms();
    let mut raw = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let code = URL_SAFE_NO_PAD.encode(raw);
    {
        let mut sessions = state
            .dashboard
            .desktop_sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sessions.retain(|(_, expires_at)| *expires_at > now);
        while sessions.len() >= 16 {
            sessions.pop_front();
        }
        sessions.push_back((code.clone(), now.saturating_add(DESKTOP_SESSION_MAX_AGE_MS)));
    }
    with_no_store(json_response(
        StatusCode::OK,
        json!({"path": format!("/desktop/session?code={code}")}),
    ))
}

pub(super) async fn desktop_session_consume(
    State(state): State<EdgeState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let code = query.get("code").map(String::as_str).unwrap_or_default();
    let now = now_ms();
    let valid = {
        let mut sessions = state
            .dashboard
            .desktop_sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sessions.retain(|(_, expires_at)| *expires_at > now);
        sessions
            .iter()
            .position(|(candidate, _)| constant_time_equal(candidate, code))
            .and_then(|index| sessions.remove(index))
            .is_some()
    };
    if code.is_empty() || !valid {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(
                "This desktop session link is invalid or expired.",
            ))
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }

    let mut response = Response::builder()
        .status(StatusCode::SEE_OTHER)
        .header(header::LOCATION, "/")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .body(Body::empty())
        .unwrap_or_else(|_| Response::new(Body::empty()));
    if let Ok(value) =
        HeaderValue::from_str(&session_cookie(&state.config, request_uses_https(&headers)))
    {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

fn proxy_api_key_preview(key: &str) -> String {
    let chars = key.chars().collect::<Vec<_>>();
    if chars.len() <= 12 {
        return format!("{}••••", chars.iter().take(4).collect::<String>());
    }
    format!(
        "{}••••{}",
        chars.iter().take(8).collect::<String>(),
        chars.iter().skip(chars.len() - 4).collect::<String>()
    )
}

pub(super) async fn proxy_api_keys(state: &EdgeState) -> Response {
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(_) => {
            return json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error": "account_store_unavailable"}),
            );
        }
    };
    let mut entries = state
        .config
        .configured_api_keys
        .iter()
        .enumerate()
        .map(|(index, (application, key))| {
            json!({
                "id": format!("configured:{index}"),
                "application": application,
                "keyPreview": proxy_api_key_preview(key),
                "source": "environment",
            })
        })
        .collect::<Vec<_>>();
    entries.extend(store.proxy_api_keys.iter().map(|entry| {
        let mut value = json!({
            "id": entry.id,
            "application": entry.application,
            "keyPreview": proxy_api_key_preview(&entry.key),
            "source": "dashboard",
        });
        if let Some(created_at) = entry.created_at {
            value["createdAt"] = json!(created_at);
        }
        value
    }));
    json_response(StatusCode::OK, json!({"proxyApiKeys": entries}))
}

pub(super) async fn application_policies(state: &EdgeState) -> Response {
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(_) => {
            return json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error": "account_store_unavailable"}),
            );
        }
    };
    let policies = store
        .application_policies
        .iter()
        .map(|policy| {
            let webhooks = policy
                .webhooks
                .iter()
                .map(|webhook| {
                    let mut value = json!({
                        "id": webhook.id,
                        "url": webhook.url,
                        "enabled": webhook.enabled,
                    });
                    if let Some(created_at) = webhook.created_at {
                        value["createdAt"] = json!(created_at);
                    }
                    value
                })
                .collect::<Vec<_>>();
            let mut value = json!({
                "application": policy.application,
                "webhooks": webhooks,
            });
            if let Some(fairness_weight) = policy.fairness_weight {
                value["fairnessWeight"] = json!(fairness_weight);
            }
            value
        })
        .collect::<Vec<_>>();
    json_response(StatusCode::OK, json!({"applicationPolicies": policies}))
}
