use super::{
    EdgeConfig, EdgeState, admin_session_value, constant_time_equal, cookie_value, header_value,
    json_response, now_ms, parse_session_value, proxy_api_key_preview, trim_slashes,
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

#[derive(Clone, Debug)]
pub(super) struct DashboardAuth {
    pub role: &'static str,
    pub user_id: Option<String>,
}

fn has_session(headers: &HeaderMap, config: &EdgeConfig) -> bool {
    request_auth(headers, config).is_some()
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

/// Resolve the dashboard caller. The admin token is admin-only; a cookie can
/// name either an admin or a member.
pub(super) fn request_auth(headers: &HeaderMap, config: &EdgeConfig) -> Option<DashboardAuth> {
    if config.admin_token.is_empty() {
        return Some(DashboardAuth {
            role: "admin",
            user_id: None,
        });
    }
    if bearer_token(headers)
        .is_some_and(|token| constant_time_equal(&token, &config.admin_token))
    {
        return Some(DashboardAuth {
            role: "admin",
            user_id: None,
        });
    }
    let claims =
        parse_session_value(&cookie_value(headers, ADMIN_SESSION_COOKIE)?, &config.admin_token)?;
    match claims.role.as_deref() {
        Some("admin") => Some(DashboardAuth {
            role: "admin",
            user_id: None,
        }),
        Some("member") => Some(DashboardAuth {
            role: "member",
            user_id: claims.user_id,
        }),
        _ => None,
    }
}

pub(super) fn request_authorized(headers: &HeaderMap, config: &EdgeConfig) -> bool {
    request_auth(headers, config).is_some()
}

/// Admin-only surface: control-plane policy, capacity admission, enrollment and
/// desktop bootstrap. Members must not reach these.
pub(super) fn request_is_admin(headers: &HeaderMap, config: &EdgeConfig) -> bool {
    request_auth(headers, config).is_some_and(|auth| auth.role == "admin")
}

pub(super) fn path_requires_session(path: &str) -> bool {
    if path != "/admin" && !path.starts_with("/admin/") {
        return false;
    }
    // Login, invite acceptance and logout are the unauthenticated entry points;
    // Node owns them so passwords never reach the edge.
    if path.starts_with("/admin/auth/") {
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
    if !request_is_admin(&headers, &state.config) {
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

/// Only admin authentication travels to the control plane; client credentials
/// and unrelated browser headers stay on the edge.
fn admin_forward_headers(headers: &HeaderMap) -> HeaderMap {
    let mut forwarded = HeaderMap::new();
    for name in [header::COOKIE, header::AUTHORIZATION] {
        if let Some(value) = headers.get(&name) {
            forwarded.insert(name, value.clone());
        }
    }
    if let Some(value) = headers.get("x-admin-token") {
        forwarded.insert("x-admin-token", value.clone());
    }
    forwarded
}

/// The control plane owns the analytics index, so it is the only process that
/// can attach a last-usage timestamp to each key. A missing or unreachable
/// control plane keeps the local view usable without the column.
async fn control_plane_api_keys(state: &EdgeState, headers: &HeaderMap) -> Option<Vec<Value>> {
    let base = trim_slashes(&state.config.node_control_plane_url);
    if base.is_empty() {
        return None;
    }
    let response = timeout(
        Duration::from_secs(3),
        state
            .control_plane_client
            .get(format!("{base}/admin/proxy-api-keys"))
            .headers(admin_forward_headers(headers))
            .send(),
    )
    .await
    .ok()?
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.json::<Value>().await.ok()?;
    body.get("proxyApiKeys")?.as_array().cloned()
}

pub(super) async fn proxy_api_keys(state: &EdgeState, headers: HeaderMap) -> Response {
    let Some(auth) = request_auth(&headers, &state.config) else {
        return json_response(StatusCode::UNAUTHORIZED, json!({"error": "unauthorized"}));
    };
    let scope = match auth.role {
        "member" => match auth.user_id {
            Some(id) => Some(id),
            // A member session without an identity cannot be scoped; refuse it
            // rather than falling back to the shared admin view.
            None => return json_response(StatusCode::UNAUTHORIZED, json!({"error": "unauthorized"})),
        },
        _ => None,
    };
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(_) => {
            return json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error": "account_store_unavailable"}),
            );
        }
    };
    // Members only see the credentials they own; environment keys belong to
    // the shared admin pool and never appear in a member view.
    let mut entries = if scope.is_some() {
        Vec::new()
    } else {
        state
            .config
            .configured_api_keys
            .iter()
            .map(|(application, key)| {
                json!({
                    // Stable identity shared with trace attribution so usage can join.
                    "id": format!("configured:{application}"),
                    "application": application,
                    "keyPreview": proxy_api_key_preview(key),
                    "source": "environment",
                })
            })
            .collect::<Vec<_>>()
    };
    entries.extend(
        store
            .proxy_api_keys
            .iter()
            .filter(|entry| {
                scope
                    .as_deref()
                    .is_none_or(|id| entry.owner_id.as_deref() == Some(id))
            })
            .map(|entry| {
                let mut value = json!({
                    "id": entry.id,
                    "application": entry.application,
                    "keyPreview": proxy_api_key_preview(&entry.key),
                    "source": "dashboard",
                });
                if let Some(created_at) = entry.created_at {
                    value["createdAt"] = json!(created_at);
                }
                if let Some(cloudflare_access) = &entry.cloudflare_access {
                    value["cloudflareAccess"] = cloudflare_access.clone();
                }
                value
            }),
    );

    if let Some(remote_entries) = control_plane_api_keys(state, &headers).await {
        let remote = remote_entries
            .iter()
            .filter(|entry| {
                scope.as_deref().is_none_or(|id| {
                    entry.get("ownerId").and_then(Value::as_str) == Some(id)
                })
            })
            .filter_map(|entry| {
                let id = entry.get("id")?.as_str()?.to_owned();
                Some((id, entry.clone()))
            })
            .collect::<HashMap<_, _>>();
        for entry in &mut entries {
            let Some(id) = entry
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
            else {
                continue;
            };
            if let Some(last_used_at) =
                remote.get(&id).and_then(|value| value.get("lastUsedAt"))
            {
                entry["lastUsedAt"] = last_used_at.clone();
            }
            // The control plane owns the Cloudflare Access association. Carry
            // it through so the dashboard can show the linked token and warn
            // before revoking it, even when the edge snapshot is older.
            if let Some(cloudflare_access) = remote
                .get(&id)
                .and_then(|value| value.get("cloudflareAccess"))
            {
                entry["cloudflareAccess"] = cloudflare_access.clone();
            }
        }
        // Keep control-plane keys the edge snapshot does not know about yet
        // (for example keys managed by another process) without duplicating.
        let local_ids = entries
            .iter()
            .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect::<std::collections::HashSet<_>>();
        entries.extend(
            remote_entries
                .into_iter()
                .filter(|entry| {
                    scope.as_deref().is_none_or(|id| {
                        entry.get("ownerId").and_then(Value::as_str) == Some(id)
                    })
                })
                .filter(|entry| {
                    entry
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !local_ids.contains(id))
                }),
        );
    }

    json_response(StatusCode::OK, json!({"proxyApiKeys": entries}))
}

pub(super) async fn application_policies(state: &EdgeState, headers: &HeaderMap) -> Response {
    if !request_is_admin(headers, &state.config) {
        return json_response(StatusCode::FORBIDDEN, json!({"error": "forbidden"}));
    }
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
