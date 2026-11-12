//! Pass-through for the ChatGPT backend that Codex Desktop uses for account
//! identity, workspace policy, rate limits and voice.
//!
//! Codex Desktop reads its plan quota from `GET /backend-api/wham/usage` on
//! `chatgpt_base_url`. When the signed-in ChatGPT plan is exhausted, Codex
//! disables the composer even for third-party model providers
//! (openai/codex#59175). Pointing `chatgpt_base_url` at this edge lets the
//! desktop keep its ChatGPT identity while the edge forwards the real backend
//! and rewrites only the exhausted usage payload.
//!
//! The relay is intentionally a pass-through, not a reproduction of the
//! ChatGPT backend: every other `/backend-api/*` request (account check,
//! workspace policy, plugin catalogue, voice SDP) is forwarded to
//! `CHATGPT_BASE_URL` with the caller's own ChatGPT credentials.

use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::Response,
};
use bytes::Bytes;
use serde_json::{Value, json};
use std::time::Instant;
use tokio::time::timeout;

use crate::{EdgeConfig, EdgeState, trim_slashes};

const HOP_BY_HOP_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
];

const FAKE_BALANCE: &str = "9999999";

fn is_hop_by_hop(name: &str) -> bool {
    HOP_BY_HOP_HEADERS.contains(&name)
}

/// Rewrites an exhausted `/wham/usage` payload so Codex keeps the composer
/// enabled. Payloads that still have quota are returned untouched so the
/// desktop shows the real usage.
pub fn rewrite_usage_payload(raw: &[u8]) -> Bytes {
    let Ok(mut data) = serde_json::from_slice::<Value>(raw) else {
        return Bytes::copy_from_slice(raw);
    };
    let allowed = data
        .get("rate_limit")
        .and_then(|rate_limit| rate_limit.get("allowed"))
        .and_then(Value::as_bool)
        == Some(true)
        && data
            .get("rate_limit")
            .and_then(|rate_limit| rate_limit.get("limit_reached"))
            .and_then(Value::as_bool)
            != Some(true);
    if allowed {
        return Bytes::copy_from_slice(raw);
    }

    let Some(object) = data.as_object_mut() else {
        return Bytes::copy_from_slice(raw);
    };

    let rate_limit = object.entry("rate_limit").or_insert_with(|| json!({}));
    if let Some(rate_limit) = rate_limit.as_object_mut() {
        rate_limit.insert("allowed".to_owned(), json!(true));
        rate_limit.insert("limit_reached".to_owned(), json!(false));
        for key in ["primary_window", "secondary_window"] {
            if let Some(window) = rate_limit.get_mut(key).and_then(Value::as_object_mut) {
                window.insert("used_percent".to_owned(), json!(1));
            }
        }
    }

    object.insert("rate_limit_reached_type".to_owned(), Value::Null);
    object.insert("rate_limit_upsell".to_owned(), Value::Null);

    let credits = object.entry("credits").or_insert_with(|| json!({}));
    if let Some(credits) = credits.as_object_mut() {
        credits.insert("has_credits".to_owned(), json!(true));
        credits.insert("unlimited".to_owned(), json!(false));
        credits.insert("overage_limit_reached".to_owned(), json!(false));
        credits.insert("balance".to_owned(), json!(FAKE_BALANCE));
    }

    if let Some(model_usage) = object.get_mut("model_usage").and_then(Value::as_object_mut) {
        for entry in model_usage.values_mut() {
            if let Some(entry) = entry.as_object_mut() {
                entry.insert("available".to_owned(), json!(true));
            }
        }
    }
    if let Some(spend_control) = object
        .get_mut("spend_control")
        .and_then(Value::as_object_mut)
    {
        spend_control.insert("reached".to_owned(), json!(false));
    }

    Bytes::from(serde_json::to_vec(&data).unwrap_or_else(|_| raw.to_vec()))
}

fn json_error(status: StatusCode, message: &str) -> Response {
    let body = json!({ "error": { "message": message, "type": "backend_relay_error" } });
    let mut response = Response::new(Body::from(body.to_string()));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

fn log_event(value: Value) {
    eprintln!("{value}");
}

/// Proxies `/backend-api/*` to the configured ChatGPT backend.
pub async fn backend_relay_handler(State(state): State<EdgeState>, request: Request) -> Response {
    relay_request(&state.config, &state.backend_relay_client, request).await
}

async fn relay_request(
    config: &EdgeConfig,
    client: &reqwest::Client,
    request: Request,
) -> Response {
    let started = Instant::now();
    let method = request.method().clone();
    let uri = request.uri().clone();
    let path_only = uri.path().to_owned();
    let path_and_query = uri
        .path_and_query()
        .map(|value| value.as_str().to_owned())
        .unwrap_or_else(|| uri.path().to_owned());
    let upstream_url = format!(
        "{}{}",
        trim_slashes(&config.chatgpt_base_url),
        path_and_query
    );
    let is_usage = path_only == "/backend-api/wham/usage";

    let mut headers = HeaderMap::new();
    for (name, value) in request.headers() {
        let lower = name.as_str().to_ascii_lowercase();
        if is_hop_by_hop(&lower) {
            continue;
        }
        headers.insert(name.clone(), value.clone());
    }
    if is_usage {
        // The rewritten payload has to be plain JSON, never a compressed body.
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("identity"),
        );
    }

    let body = match axum::body::to_bytes(request.into_body(), config.request_body_limit).await {
        Ok(body) => body,
        Err(_) => {
            log_event(json!({
                "event": "backend_relay.request",
                "method": method.as_str(),
                "path": path_only,
                "status": StatusCode::PAYLOAD_TOO_LARGE.as_u16(),
                "duration_ms": started.elapsed().as_millis() as u64,
                "error": "request body too large",
            }));
            return json_error(StatusCode::PAYLOAD_TOO_LARGE, "request body too large");
        }
    };

    let mut builder = client
        .request(method.clone(), upstream_url.clone())
        .headers(headers);
    if !body.is_empty() {
        builder = builder.body(body);
    }

    let upstream = match timeout(config.backend_relay_timeout, builder.send()).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            log_event(json!({
                "event": "backend_relay.upstream_error",
                "method": method.as_str(),
                "path": path_only,
                "duration_ms": started.elapsed().as_millis() as u64,
                "error": error.to_string(),
            }));
            return json_error(StatusCode::BAD_GATEWAY, "ChatGPT backend unreachable");
        }
        Err(_) => {
            log_event(json!({
                "event": "backend_relay.upstream_timeout",
                "method": method.as_str(),
                "path": path_only,
                "duration_ms": started.elapsed().as_millis() as u64,
                "timeout_ms": config.backend_relay_timeout.as_millis() as u64,
            }));
            return json_error(StatusCode::GATEWAY_TIMEOUT, "ChatGPT backend timeout");
        }
    };

    let status = upstream.status();
    let rewrite_usage = is_usage && status == StatusCode::OK;

    log_event(json!({
        "event": "backend_relay.request",
        "method": method.as_str(),
        "path": path_only,
        "status": status.as_u16(),
        "duration_ms": started.elapsed().as_millis() as u64,
        "usage_rewritten": rewrite_usage,
    }));

    if rewrite_usage {
        let raw = match timeout(config.backend_relay_timeout, upstream.bytes()).await {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(error)) => {
                log_event(json!({
                    "event": "backend_relay.usage_read_error",
                    "path": path_only,
                    "duration_ms": started.elapsed().as_millis() as u64,
                    "error": error.to_string(),
                }));
                return json_error(StatusCode::BAD_GATEWAY, "ChatGPT usage response unreadable");
            }
            Err(_) => {
                log_event(json!({
                    "event": "backend_relay.upstream_timeout",
                    "path": path_only,
                    "duration_ms": started.elapsed().as_millis() as u64,
                    "timeout_ms": config.backend_relay_timeout.as_millis() as u64,
                }));
                return json_error(
                    StatusCode::GATEWAY_TIMEOUT,
                    "ChatGPT usage response timeout",
                );
            }
        };
        let mut response = Response::new(Body::from(rewrite_usage_payload(&raw)));
        *response.status_mut() = status;
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return response;
    }

    let upstream_headers = upstream
        .headers()
        .iter()
        .filter(|(name, _)| !is_hop_by_hop(&name.as_str().to_ascii_lowercase()))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect::<Vec<_>>();
    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;
    for (name, value) in upstream_headers {
        response.headers_mut().insert(name, value);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::Body,
        extract::{Request as AxumRequest, State},
        http::Request,
        response::Response,
        routing::any,
    };
    use futures_util::stream;
    use std::sync::Arc;
    use tokio::net::TcpListener;
    use tokio::sync::Mutex;
    use tower::ServiceExt;

    #[derive(Clone, Default)]
    struct MockState {
        requests: Arc<Mutex<Vec<RecordedRequest>>>,
        usage_body: Arc<Mutex<Option<String>>>,
    }

    #[derive(Clone, Debug)]
    struct RecordedRequest {
        method: String,
        path: String,
        query: Option<String>,
        authorization: Option<String>,
        account_id: Option<String>,
        body: String,
    }

    async fn mock_handler(State(state): State<MockState>, request: AxumRequest) -> Response {
        let method = request.method().to_string();
        let uri = request.uri().clone();
        let headers = request.headers().clone();
        let body = axum::body::to_bytes(request.into_body(), usize::MAX)
            .await
            .unwrap();
        state.requests.lock().await.push(RecordedRequest {
            method,
            path: uri.path().to_owned(),
            query: uri.query().map(str::to_owned),
            authorization: headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            account_id: headers
                .get("chatgpt-account-id")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            body: String::from_utf8_lossy(&body).into_owned(),
        });

        if uri.path() == "/backend-api/wham/usage" {
            let body = state
                .usage_body
                .lock()
                .await
                .clone()
                .unwrap_or_else(|| "{}".to_owned());
            return Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap();
        }
        if uri.path() == "/backend-api/redirect" {
            return Response::builder()
                .status(StatusCode::FOUND)
                .header("location", "/login")
                .body(Body::from("redirect"))
                .unwrap();
        }
        if uri.path() == "/backend-api/stream" {
            let chunks = vec![
                Ok::<Bytes, std::io::Error>(Bytes::from_static(b"one")),
                Ok(Bytes::from_static(b"two")),
            ];
            return Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(stream::iter(chunks)))
                .unwrap();
        }
        Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header("content-type", "application/json")
            .body(Body::from(r#"{"detail":"unauthorized"}"#))
            .unwrap()
    }

    async fn spawn_mock(state: MockState) -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new().fallback(mock_handler).with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), handle)
    }

    fn test_config(base_url: &str) -> EdgeConfig {
        EdgeConfig {
            chatgpt_base_url: base_url.to_owned(),
            request_body_limit: 1024 * 1024,
            backend_relay_timeout: std::time::Duration::from_secs(5),
            ..EdgeConfig::default()
        }
    }

    fn test_client() -> reqwest::Client {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }

    async fn call(
        config: &EdgeConfig,
        client: &reqwest::Client,
        method: &str,
        uri: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> Response {
        let mut builder = Request::builder().method(method).uri(uri);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let body = body
            .map(|value| Body::from(value.to_owned()))
            .unwrap_or_else(Body::empty);
        relay_request(config, client, builder.body(body).unwrap()).await
    }

    #[tokio::test]
    async fn forwards_method_path_query_headers_and_body() {
        let mock = MockState::default();
        let (base, handle) = spawn_mock(mock.clone()).await;
        let config = test_config(&base);
        let client = test_client();

        let response = call(
            &config,
            &client,
            "POST",
            "/backend-api/me?foo=bar",
            &[
                ("authorization", "Bearer test"),
                ("chatgpt-account-id", "acct"),
                ("connection", "keep-alive"),
            ],
            Some("payload"),
        )
        .await;

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], br#"{"detail":"unauthorized"}"#);

        let requests = mock.requests.lock().await;
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/backend-api/me");
        assert_eq!(request.query.as_deref(), Some("foo=bar"));
        assert_eq!(request.authorization.as_deref(), Some("Bearer test"));
        assert_eq!(request.account_id.as_deref(), Some("acct"));
        assert_eq!(request.body, "payload");
        drop(requests);
        handle.abort();
    }

    #[tokio::test]
    async fn forwards_bare_base_path_and_trailing_slash() {
        let mock = MockState::default();
        let (base, handle) = spawn_mock(mock.clone()).await;
        let config = test_config(&base);
        let client = test_client();

        for path in ["/backend-api", "/backend-api/"] {
            let response = call(&config, &client, "GET", path, &[], None).await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
        }

        let requests = mock.requests.lock().await;
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].path, "/backend-api");
        assert_eq!(requests[1].path, "/backend-api/");
        drop(requests);
        handle.abort();
    }

    #[tokio::test]
    async fn does_not_follow_redirects() {
        let mock = MockState::default();
        let (base, handle) = spawn_mock(mock.clone()).await;
        let config = test_config(&base);
        let client = test_client();

        let response = call(&config, &client, "GET", "/backend-api/redirect", &[], None).await;
        assert_eq!(response.status(), StatusCode::FOUND);
        assert_eq!(
            response
                .headers()
                .get("location")
                .and_then(|value| value.to_str().ok()),
            Some("/login")
        );
        handle.abort();
    }

    #[tokio::test]
    async fn streams_upstream_body() {
        let mock = MockState::default();
        let (base, handle) = spawn_mock(mock.clone()).await;
        let config = test_config(&base);
        let client = test_client();

        let response = call(&config, &client, "GET", "/backend-api/stream", &[], None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok()),
            Some("text/event-stream")
        );
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"onetwo");
        handle.abort();
    }

    #[tokio::test]
    async fn rewrites_exhausted_usage_payload() {
        let mock = MockState {
            usage_body: Arc::new(Mutex::new(Some(
                r#"{
                    "rate_limit": {
                        "allowed": false,
                        "limit_reached": true,
                        "primary_window": {"used_percent": 100},
                        "secondary_window": null
                    },
                    "credits": {"has_credits": false, "unlimited": false, "balance": "0"},
                    "rate_limit_reached_type": {"type": "rate_limit_reached"},
                    "rate_limit_upsell": {"title": "out"},
                    "spend_control": {"reached": false},
                    "model_usage": {"gpt-6-astra": {"available": false}}
                }"#
                .to_owned(),
            ))),
            ..MockState::default()
        };
        let (base, handle) = spawn_mock(mock.clone()).await;
        let config = test_config(&base);
        let client = test_client();

        let response = call(
            &config,
            &client,
            "GET",
            "/backend-api/wham/usage",
            &[("authorization", "Bearer test")],
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["rate_limit"]["allowed"], json!(true));
        assert_eq!(value["rate_limit"]["limit_reached"], json!(false));
        assert_eq!(
            value["rate_limit"]["primary_window"]["used_percent"],
            json!(1)
        );
        assert_eq!(value["credits"]["has_credits"], json!(true));
        assert_eq!(value["credits"]["balance"], json!(FAKE_BALANCE));
        assert!(value["rate_limit_reached_type"].is_null());
        assert!(value["rate_limit_upsell"].is_null());
        assert_eq!(
            value["model_usage"]["gpt-6-astra"]["available"],
            json!(true)
        );
        handle.abort();
    }

    #[tokio::test]
    async fn adds_missing_usage_fields() {
        let mock = MockState {
            usage_body: Arc::new(Mutex::new(Some(r#"{"credits":{}}"#.to_owned()))),
            ..MockState::default()
        };
        let (base, handle) = spawn_mock(mock.clone()).await;
        let config = test_config(&base);
        let client = test_client();

        let response = call(
            &config,
            &client,
            "GET",
            "/backend-api/wham/usage",
            &[],
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["rate_limit"]["allowed"], json!(true));
        assert_eq!(value["rate_limit"]["limit_reached"], json!(false));
        assert_eq!(value["credits"]["has_credits"], json!(true));
        assert_eq!(value["credits"]["balance"], json!(FAKE_BALANCE));
        handle.abort();
    }

    #[tokio::test]
    async fn leaves_usage_with_quota_untouched() {
        let raw = br#"{"rate_limit":{"allowed":true,"limit_reached":false,"primary_window":{"used_percent":42}}}"#;
        assert_eq!(&rewrite_usage_payload(raw)[..], &raw[..]);
    }

    #[test]
    fn non_json_payload_is_untouched() {
        let raw = b"<html>cloudflare</html>";
        assert_eq!(&rewrite_usage_payload(raw)[..], &raw[..]);
    }

    #[tokio::test]
    async fn relay_routes_match_bare_base_path() {
        let app = Router::new()
            .route("/backend-api", any(|| async { "relay" }))
            .route("/backend-api/", any(|| async { "relay" }))
            .route("/backend-api/{*rest}", any(|| async { "relay" }));

        for path in ["/backend-api", "/backend-api/", "/backend-api/me"] {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{path}");
        }
    }
}
