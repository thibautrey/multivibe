//! Pass-through for the ChatGPT backend that Codex Desktop uses for account
//! identity, rate limits and voice.
//!
//! Codex Desktop reads its plan quota from `GET /backend-api/wham/usage` on
//! `chatgpt_base_url`. When the signed-in ChatGPT plan is exhausted, Codex
//! disables the composer even for third-party model providers
//! (openai/codex#59175). Pointing `chatgpt_base_url` at this edge lets the
//! desktop keep its ChatGPT identity while the edge forwards the real backend
//! and rewrites only the exhausted usage payload.

use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::Response,
};
use bytes::Bytes;
use serde_json::{Value, json};

use crate::{EdgeState, trim_slashes};

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

    if let Some(rate_limit) = data.get_mut("rate_limit").and_then(Value::as_object_mut) {
        rate_limit.insert("allowed".to_owned(), json!(true));
        rate_limit.insert("limit_reached".to_owned(), json!(false));
        for key in ["primary_window", "secondary_window"] {
            if let Some(window) = rate_limit.get_mut(key).and_then(Value::as_object_mut) {
                window.insert("used_percent".to_owned(), json!(1));
            }
        }
    }

    if let Some(object) = data.as_object_mut() {
        object.insert("rate_limit_reached_type".to_owned(), Value::Null);
        object.insert("rate_limit_upsell".to_owned(), Value::Null);
        if let Some(credits) = object.get_mut("credits").and_then(Value::as_object_mut) {
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

/// Proxies `/backend-api/*` to the configured ChatGPT backend.
pub async fn backend_relay_handler(State(state): State<EdgeState>, request: Request) -> Response {
    let method = request.method().clone();
    let uri = request.uri().clone();
    let path_and_query = uri
        .path_and_query()
        .map(|value| value.as_str().to_owned())
        .unwrap_or_else(|| uri.path().to_owned());
    let upstream_url = format!(
        "{}{}",
        trim_slashes(&state.config.chatgpt_base_url),
        path_and_query
    );
    let is_usage = path_and_query
        .split('?')
        .next()
        .is_some_and(|path| path == "/backend-api/wham/usage");

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

    let body =
        match axum::body::to_bytes(request.into_body(), state.config.request_body_limit).await {
            Ok(body) => body,
            Err(_) => return json_error(StatusCode::PAYLOAD_TOO_LARGE, "request body too large"),
        };

    let mut builder = state.client.request(method, &upstream_url).headers(headers);
    if !body.is_empty() {
        builder = builder.body(body);
    }
    let upstream = match builder.send().await {
        Ok(response) => response,
        Err(error) => {
            eprintln!(
                "{}",
                json!({
                    "event": "backend_relay.upstream_error",
                    "url": upstream_url,
                    "error": error.to_string(),
                })
            );
            return json_error(StatusCode::BAD_GATEWAY, "ChatGPT backend unreachable");
        }
    };

    let status = upstream.status();

    if is_usage && status == StatusCode::OK {
        let raw = match upstream.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                eprintln!(
                    "{}",
                    json!({
                        "event": "backend_relay.usage_read_error",
                        "error": error.to_string(),
                    })
                );
                return json_error(StatusCode::BAD_GATEWAY, "ChatGPT usage response unreadable");
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

    #[test]
    fn exhausted_usage_is_rewritten() {
        let raw = br#"{
            "rate_limit": {
                "allowed": false,
                "limit_reached": true,
                "primary_window": {"used_percent": 100, "limit_window_seconds": 604800},
                "secondary_window": null
            },
            "credits": {"has_credits": false, "unlimited": false, "balance": "0"},
            "rate_limit_reached_type": {"type": "rate_limit_reached", "details": "default"},
            "rate_limit_upsell": {"title": "You're out of Codex messages"},
            "spend_control": {"reached": false},
            "model_usage": {"gpt-6-astra": {"available": false}}
        }"#;
        let rewritten: Value = serde_json::from_slice(&rewrite_usage_payload(raw)).unwrap();
        assert_eq!(rewritten["rate_limit"]["allowed"], json!(true));
        assert_eq!(rewritten["rate_limit"]["limit_reached"], json!(false));
        assert_eq!(
            rewritten["rate_limit"]["primary_window"]["used_percent"],
            json!(1)
        );
        assert_eq!(rewritten["credits"]["has_credits"], json!(true));
        assert_eq!(rewritten["credits"]["balance"], json!(FAKE_BALANCE));
        assert!(rewritten["rate_limit_reached_type"].is_null());
        assert!(rewritten["rate_limit_upsell"].is_null());
        assert_eq!(
            rewritten["model_usage"]["gpt-6-astra"]["available"],
            json!(true)
        );
    }

    #[test]
    fn usage_with_quota_is_untouched() {
        let raw = br#"{"rate_limit":{"allowed":true,"limit_reached":false,"primary_window":{"used_percent":42}}}"#;
        assert_eq!(&rewrite_usage_payload(raw)[..], &raw[..]);
    }

    #[test]
    fn non_json_payload_is_untouched() {
        let raw = b"<html>cloudflare</html>";
        assert_eq!(&rewrite_usage_payload(raw)[..], &raw[..]);
    }
}
