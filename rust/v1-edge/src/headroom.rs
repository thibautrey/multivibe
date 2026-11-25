//! Headroom compression-service client.
//!
//! MultiVibe keeps ownership of provider routing, authentication and quota
//! selection.  Headroom is asked only to rewrite the provider-ready request
//! body through its gateway request half (`POST /v1/compress`); response-half
//! work, CCR retrieval and re-driving are deliberately out of scope.
//!
//! Every failure path returns the original body.  Compression must never fail
//! an inference request, and the client therefore also opens a small circuit
//! breaker after a transport, timeout or HTTP failure so a dead sidecar does
//! not add its timeout to every turn.

use std::{
    fmt,
    io::Write as _,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicU32, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use http::{HeaderName, HeaderValue};
use reqwest::redirect::Policy;
use serde_json::{Map, Value, json};

const DEFAULT_TIMEOUT_MS: u64 = 3_000;
const DEFAULT_MIN_BYTES: usize = 4 * 1024;
const MAX_RESPONSE_BYTES: usize = 128 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES: usize = 16 * 1024;
const MAX_TRANSFORMS: usize = 32;
const MAX_TRANSFORM_CHARS: usize = 120;
const MAX_ERROR_CHARS: usize = 200;
const MAX_SESSION_ID_CHARS: usize = 256;
const MAX_COMPRESSION_HEADERS: usize = 4;
const FAILURE_COOLDOWN_BASE_MS: u64 = 1_000;
const FAILURE_COOLDOWN_MAX_MS: u64 = 30_000;

/// Marker-free modes only.  `ccr` would insert retrieval markers, but this
/// integration never performs the response half that redeems them.
pub const ALLOWED_MODES: &[&str] = &["lossy_inline", "lossless_then_lossy", "lossless"];

const MAX_MIN_BYTES: usize = 1024 * 1024;
const MIN_TIMEOUT_MS: u64 = 50;
const MAX_TIMEOUT_MS: u64 = 30_000;

#[derive(Clone)]
pub struct Config {
    pub url: Option<String>,
    token: Option<String>,
    pub timeout: Duration,
    pub min_bytes: usize,
    pub mode: Option<String>,
}

impl fmt::Debug for Config {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HeadroomConfig")
            .field("url", &self.url)
            .field("token", &self.token.as_ref().map(|_| "[redacted]"))
            .field("timeout", &self.timeout)
            .field("min_bytes", &self.min_bytes)
            .field("mode", &self.mode)
            .finish()
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            url: None,
            token: None,
            timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS),
            min_bytes: DEFAULT_MIN_BYTES,
            mode: None,
        }
    }
}

impl Config {
    /// Config pointing at `url`, with the default timeout and thresholds.
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: Some(url.into()),
            ..Self::default()
        }
    }

    pub fn from_env() -> Self {
        let env = |name: &str| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        let mut config = Self::default();
        config.url = env("HEADROOM_COMPRESS_URL");
        config.token = env("HEADROOM_PROXY_TOKEN").or_else(|| env("HEADROOM_API_TOKEN"));
        config.timeout = Duration::from_millis(
            env("HEADROOM_TIMEOUT_MS")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(DEFAULT_TIMEOUT_MS)
                .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
        );
        config.min_bytes = env("HEADROOM_MIN_BYTES")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(DEFAULT_MIN_BYTES)
            .min(MAX_MIN_BYTES);
        config.mode = env("HEADROOM_COMPRESS_MODE").map(|value| value.to_ascii_lowercase());
        config
    }

    pub fn enabled(&self) -> bool {
        self.url.is_some()
    }

    /// Parse the runtime contract used by the internal control endpoint and by
    /// the persisted state file.  Unknown keys are rejected so a typo cannot
    /// silently leave compression configured differently than the operator
    /// asked for.
    pub fn from_json(value: &Value) -> Result<Self, String> {
        let object = value
            .as_object()
            .ok_or_else(|| "compression settings must be a JSON object".to_owned())?;
        for key in object.keys() {
            if !matches!(
                key.as_str(),
                "url" | "token" | "mode" | "timeoutMs" | "minBytes"
            ) {
                return Err(format!("unknown compression setting: {key}"));
            }
        }
        let mut config = Self::default();
        match object.get("url") {
            None | Some(Value::Null) => {}
            Some(Value::String(url)) => {
                let url = url.trim();
                if !url.is_empty() {
                    config.url = Some(url.to_owned());
                }
            }
            Some(_) => return Err("url must be a string or null".to_owned()),
        }
        match object.get("token") {
            None | Some(Value::Null) => {}
            Some(Value::String(token)) => {
                let token = token.trim();
                if !token.is_empty() {
                    config.token = Some(token.to_owned());
                }
            }
            Some(_) => return Err("token must be a string or null".to_owned()),
        }
        match object.get("mode") {
            None | Some(Value::Null) => {}
            Some(Value::String(mode)) => {
                let mode = mode.trim().to_ascii_lowercase();
                if !mode.is_empty() {
                    if !ALLOWED_MODES.contains(&mode.as_str()) {
                        return Err(format!(
                            "mode must be one of {} (CCR is not supported)",
                            ALLOWED_MODES.join(", ")
                        ));
                    }
                    config.mode = Some(mode);
                }
            }
            Some(_) => return Err("mode must be a string or null".to_owned()),
        }
        if let Some(value) = object.get("timeoutMs") {
            let timeout = value
                .as_u64()
                .ok_or_else(|| "timeoutMs must be a positive integer".to_owned())?;
            config.timeout = Duration::from_millis(timeout.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS));
        }
        if let Some(value) = object.get("minBytes") {
            let min_bytes = value
                .as_u64()
                .ok_or_else(|| "minBytes must be a positive integer".to_owned())?;
            config.min_bytes = usize::try_from(min_bytes)
                .unwrap_or(MAX_MIN_BYTES)
                .min(MAX_MIN_BYTES);
        }
        Ok(config)
    }

    /// Write-only shape: the token is persisted to a `0600` file and never
    /// returned by the status endpoint.
    pub fn to_json(&self) -> Value {
        json!({
            "url": self.url,
            "token": self.token,
            "mode": self.mode,
            "timeoutMs": self.timeout.as_millis() as u64,
            "minBytes": self.min_bytes,
        })
    }

    /// Load the persisted runtime contract.  A missing file means "no runtime
    /// override"; a malformed one is reported and ignored so a bad file never
    /// prevents the edge from starting.
    pub fn load(path: &Path) -> Result<Option<Self>, String> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("failed to read {}: {error}", path.display())),
        };
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(None);
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("invalid {}: {error}", path.display()))?;
        Self::from_json(&value).map(Some)
    }

    pub fn persist(&self, path: &Path) -> Result<(), String> {
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty());
        if let Some(parent) = parent {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
        }
        let temporary = path.with_extension("tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| format!("failed to write {}: {error}", temporary.display()))?;
        let payload = serde_json::to_vec_pretty(&self.to_json())
            .map_err(|error| format!("failed to serialize compression state: {error}"))?;
        file.write_all(&payload)
            .and_then(|()| file.write_all(b"\n"))
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("failed to write {}: {error}", temporary.display()))?;
        drop(file);
        std::fs::rename(&temporary, path)
            .map_err(|error| format!("failed to replace {}: {error}", path.display()))
    }
}

#[derive(Clone, Debug, Default)]
pub struct Metrics {
    pub tokens_before: u64,
    pub tokens_after: u64,
    pub tokens_saved: u64,
    pub tool_tokens_saved: u64,
    pub transforms: Vec<String>,
    pub wire_shape: Option<String>,
    pub frozen_message_count: Option<u64>,
    pub cached_prefix_replayed: Option<bool>,
    pub duration_ms: u64,
}

impl Metrics {
    /// Trace signal kept separate from provider usage.  `tokensSaved` is what
    /// Headroom removed from the request; it is never added to, or derived
    /// from, `tokensInputCached`/`costUsd`.
    pub fn trace_value(&self) -> Value {
        let no_savings = self.tokens_saved == 0;
        let mut value = json!({
            "provider": "headroom",
            "outcome": if no_savings { "skipped" } else { "compressed" },
            "tokensBefore": self.tokens_before,
            "tokensAfter": self.tokens_after,
            "tokensSaved": self.tokens_saved,
            "durationMs": self.duration_ms,
        });
        if no_savings {
            value["reason"] = Value::String("no_savings".to_owned());
        }
        if self.tokens_before > 0
            && let Some(ratio) =
                serde_json::Number::from_f64(self.tokens_after as f64 / self.tokens_before as f64)
        {
            value["compressionRatio"] = Value::Number(ratio);
        }
        if self.tool_tokens_saved > 0 {
            value["toolTokensSaved"] = self.tool_tokens_saved.into();
        }
        if !self.transforms.is_empty() {
            value["transforms"] =
                serde_json::to_value(&self.transforms).unwrap_or_else(|_| Value::Array(Vec::new()));
        }
        if let Some(shape) = self.wire_shape.as_deref() {
            value["wireShape"] = Value::String(shape.to_owned());
        }
        if let Some(count) = self.frozen_message_count {
            value["frozenMessageCount"] = count.into();
        }
        if let Some(replayed) = self.cached_prefix_replayed {
            value["cachedPrefixReplayed"] = Value::Bool(replayed);
        }
        value
    }
}

#[derive(Clone, Debug)]
pub enum CompressionResult {
    Disabled,
    Skipped {
        reason: String,
    },
    Applied {
        body: Value,
        headers: Vec<(String, String)>,
        metrics: Metrics,
    },
    Failed {
        reason: String,
        duration_ms: u64,
    },
}

impl CompressionResult {
    pub fn trace_value(&self) -> Option<Value> {
        match self {
            Self::Disabled => None,
            Self::Skipped { reason } => Some(json!({
                "provider": "headroom",
                "outcome": "skipped",
                "reason": reason,
            })),
            Self::Failed {
                reason,
                duration_ms,
            } => Some(json!({
                "provider": "headroom",
                "outcome": "failed",
                "reason": reason,
                "durationMs": duration_ms,
            })),
            Self::Applied { metrics, .. } => Some(metrics.trace_value()),
        }
    }
}

#[derive(Clone)]
pub struct Client {
    config: Config,
    /// `None` when compression is disabled or the configuration is invalid.
    http: Option<reqwest::Client>,
    /// The validated endpoint, independent from the raw configured value.
    endpoint: Option<String>,
    config_error: Option<String>,
    failures: Arc<AtomicU32>,
    blocked_until_ms: Arc<AtomicU64>,
}

impl fmt::Debug for Client {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HeadroomClient")
            .field("endpoint", &self.endpoint)
            .field("config_error", &self.config_error)
            .field("failures", &self.failures.load(Ordering::Relaxed))
            .field(
                "blocked_until_ms",
                &self.blocked_until_ms.load(Ordering::Relaxed),
            )
            .finish()
    }
}

impl Client {
    pub fn new(mut config: Config) -> Self {
        let mut config_error = None;
        if let Some(mode) = config.mode.as_deref()
            && !ALLOWED_MODES.contains(&mode)
        {
            config_error = Some(format!(
                "HEADROOM_COMPRESS_MODE must be one of {} (CCR is not supported)",
                ALLOWED_MODES.join(", ")
            ));
        }
        if config_error.is_none()
            && let Some(token) = config.token.as_deref()
            && HeaderValue::from_str(token).is_err()
        {
            // `reqwest` panics on an invalid header value; fail at startup
            // instead of on an inference path.
            config_error = Some("HEADROOM_PROXY_TOKEN is not a valid HTTP header value".to_owned());
        }

        let mut endpoint = None;
        let mut http = None;
        if config_error.is_none()
            && let Some(url) = config.url.as_deref()
        {
            match normalize_endpoint(url) {
                Some(normalized) => {
                    endpoint = Some(normalized);
                    match reqwest::Client::builder().redirect(Policy::none()).build() {
                        Ok(client) => http = Some(client),
                        Err(error) => {
                            config_error =
                                Some(format!("failed to create Headroom HTTP client: {error}"));
                        }
                    }
                }
                None => {
                    config_error = Some("HEADROOM_COMPRESS_URL must be an http(s) URL".to_owned());
                }
            }
        }
        config.url = endpoint.clone();

        Self {
            config,
            http,
            endpoint,
            config_error,
            failures: Arc::new(AtomicU32::new(0)),
            blocked_until_ms: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn config_error(&self) -> Option<&str> {
        self.config_error.as_deref()
    }

    pub fn enabled(&self) -> bool {
        self.http.is_some() && self.endpoint.is_some() && self.config_error.is_none()
    }

    /// Status view for the internal control endpoint.  The proxy token is
    /// deliberately absent: it is write-only once configured.
    pub fn status_value(&self) -> Value {
        json!({
            "enabled": self.enabled(),
            "configured": self.config.url.is_some(),
            "url": self.endpoint,
            "mode": self.config.mode,
            "timeoutMs": self.config.timeout.as_millis() as u64,
            "minBytes": self.config.min_bytes,
            "configError": self.config_error,
            "failures": self.failures.load(Ordering::Relaxed),
            "blockedForMs": self
                .blocked_until_ms
                .load(Ordering::Relaxed)
                .saturating_sub(now_ms()),
        })
    }

    /// Compress a provider-ready body through the Headroom gateway request
    /// half.  The returned body is only safe to forward when it kept the same
    /// wire shape and model; otherwise the caller gets `Skipped`/`Failed` and
    /// must keep its original payload.
    pub async fn compress(
        &self,
        body: &Value,
        session_id: Option<&str>,
        confidential: bool,
        anthropic_beta: Option<&str>,
    ) -> CompressionResult {
        if !self.enabled() {
            return CompressionResult::Disabled;
        }
        if confidential {
            return skip("confidential");
        }
        let Some(session_id) = session_id.map(str::trim).filter(|value| !value.is_empty()) else {
            return skip("no_session");
        };
        if session_id.chars().count() > MAX_SESSION_ID_CHARS {
            return skip("session_id_too_long");
        }
        if body
            .get("previous_response_id")
            .is_some_and(|value| !value.is_null())
        {
            // The provider already holds the conversation; rewriting the
            // visible tail would not change what it replays.
            return skip("previous_response_id");
        }
        if ["config", "gateway", "token_budget"]
            .iter()
            .any(|key| body.get(*key).is_some())
        {
            // Headroom owns these keys and strips them from the returned body;
            // a provider body that already carries one cannot round-trip.
            return skip("control_key_conflict");
        }
        let Some(shape) = WireShape::from_body(body) else {
            return skip("unsupported_shape");
        };
        if shape == WireShape::Responses
            && body.get("input").is_some_and(|value| match value {
                Value::String(text) => text.trim().is_empty(),
                Value::Array(items) => items.is_empty(),
                _ => true,
            })
        {
            return skip("empty_input");
        }
        if shape == WireShape::Messages
            && body
                .get("messages")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty)
        {
            return skip("empty_messages");
        }
        let Some(model) = body
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return skip("missing_model");
        };

        let now = now_ms();
        if now < self.blocked_until_ms.load(Ordering::Relaxed) {
            return skip("circuit_open");
        }

        let mut request = body.clone();
        let Some(object) = request.as_object_mut() else {
            return skip("unsupported_shape");
        };
        let mut compression_config = Map::new();
        compression_config.insert(
            "session_id".to_owned(),
            Value::String(session_id.to_owned()),
        );
        if let Some(mode) = self.config.mode.as_deref() {
            compression_config.insert("mode".to_owned(), Value::String(mode.to_owned()));
        }
        object.insert("config".to_owned(), Value::Object(compression_config));
        let mut gateway = json!({
            "can_redrive": false,
            "can_relay_response": false,
        });
        if let Some(beta) = anthropic_beta
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            // Headroom only reads `anthropic-beta` from this block and puts
            // the client's tokens first in the returned header.
            let beta = beta.chars().take(4_096).collect::<String>();
            gateway["request_headers"] = json!({"anthropic-beta": beta});
        }
        object.insert("gateway".to_owned(), gateway);

        let request_bytes = match serde_json::to_vec(&request) {
            Ok(value) => value,
            Err(_) => return skip("serialization_failed"),
        };
        if request_bytes.len() < self.config.min_bytes {
            return skip("small_payload");
        }

        let started = Instant::now();
        let url = self.endpoint.as_deref().unwrap_or_default();
        let send = async {
            let mut builder = self
                .http
                .as_ref()
                .expect("enabled client has an HTTP client")
                .post(url)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .header(reqwest::header::ACCEPT, "application/json");
            if let Some(token) = self.config.token.as_deref() {
                builder = builder.header("x-headroom-proxy-token", token);
            }
            builder.body(request_bytes).send().await
        };

        let response = match tokio::time::timeout(self.config.timeout, send).await {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                self.record_failure(now_ms());
                return CompressionResult::Failed {
                    reason: bounded(&format!("transport: {error}")),
                    duration_ms: elapsed_ms(started),
                };
            }
            Err(_) => {
                self.record_failure(now_ms());
                return CompressionResult::Failed {
                    reason: "timeout".to_owned(),
                    duration_ms: elapsed_ms(started),
                };
            }
        };

        let status = response.status();
        if !status.is_success() {
            let reason = response_error_reason(response).await;
            self.record_failure(now_ms());
            return CompressionResult::Failed {
                reason: bounded(&format!("http {}: {reason}", status.as_u16())),
                duration_ms: elapsed_ms(started),
            };
        }

        let bytes = match read_bounded(response, MAX_RESPONSE_BYTES).await {
            Ok(bytes) => bytes,
            Err(reason) => {
                self.record_failure(now_ms());
                return CompressionResult::Failed {
                    reason,
                    duration_ms: elapsed_ms(started),
                };
            }
        };
        let value: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => {
                self.record_failure(now_ms());
                return CompressionResult::Failed {
                    reason: "invalid_json_response".to_owned(),
                    duration_ms: elapsed_ms(started),
                };
            }
        };

        let result = self.interpret(value, shape, model, body, elapsed_ms(started));
        match &result {
            CompressionResult::Failed { .. } => self.record_failure(now_ms()),
            _ => self.record_success(),
        }
        result
    }

    fn interpret(
        &self,
        value: Value,
        expected_shape: WireShape,
        expected_model: &str,
        original: &Value,
        duration_ms: u64,
    ) -> CompressionResult {
        let Some(object) = value.as_object() else {
            return CompressionResult::Failed {
                reason: "invalid_json_response".to_owned(),
                duration_ms,
            };
        };

        if object
            .get("compression_skipped")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let reason = object
                .get("skip_reason")
                .and_then(Value::as_str)
                .map(bounded)
                .unwrap_or_else(|| "compression_skipped".to_owned());
            return CompressionResult::Skipped { reason };
        }

        let obligations = object
            .get("obligations")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        if !obligations.is_empty() {
            // This increment never calls `/v1/compress/response`; forwarding a
            // body that expects a redeeming response half would be unsafe.
            return skip("unredeemed_obligation");
        }

        match object.get("wire_shape").and_then(Value::as_str) {
            Some(shape) if shape == expected_shape.as_str() => {}
            Some(_) => return skip("wire_shape_mismatch"),
            None if expected_shape == WireShape::Responses => {
                // Older Headroom builds reject Responses bodies outright; a
                // 200 without `wire_shape` means the body was not compressed.
                return skip("wire_shape_missing");
            }
            None => {}
        }

        let Some(body) = object.get("body").filter(|value| value.is_object()) else {
            return CompressionResult::Failed {
                reason: "missing_body".to_owned(),
                duration_ms,
            };
        };
        if !expected_shape.matches_body(body) {
            return skip("body_shape_mismatch");
        }
        let response_model = body.get("model").and_then(Value::as_str);
        if response_model != Some(expected_model) {
            // Headroom may publish routing advice; MultiVibe's route owns the
            // model, so a changed model must never be forwarded.
            return skip("model_changed");
        }
        if ["config", "gateway", "token_budget"]
            .iter()
            .any(|key| body.get(*key).is_some())
        {
            return skip("control_key_leak");
        }
        if stream_flag(body) != stream_flag(original) {
            // The client's streaming contract is owned by MultiVibe's route,
            // not by the compression service.
            return skip("stream_changed");
        }
        if original.get("prompt_cache_key").is_some()
            && original.get("prompt_cache_key") != body.get("prompt_cache_key")
        {
            // The explicit cache key is how MultiVibe keeps provider prefix
            // caches warm; losing or changing it would erase the savings.
            return skip("cache_key_changed");
        }

        let tokens_before = unsigned(object.get("tokens_before")).unwrap_or(0);
        let tokens_after = unsigned(object.get("tokens_after")).unwrap_or(0);
        let tokens_saved = unsigned(object.get("tokens_saved"))
            .unwrap_or_else(|| tokens_before.saturating_sub(tokens_after));
        let transforms = object
            .get("transforms_applied")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .take(MAX_TRANSFORMS)
                    .map(|value| value.chars().take(MAX_TRANSFORM_CHARS).collect())
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();
        let session = object.get("session");
        let frozen_message_count = session
            .and_then(|value| value.get("frozen_message_count"))
            .and_then(unsigned_value);
        let cached_prefix_replayed = session
            .and_then(|value| value.get("cached_prefix_replayed"))
            .and_then(Value::as_bool);

        CompressionResult::Applied {
            body: body.clone(),
            headers: compression_headers(object.get("headers")),
            metrics: Metrics {
                tokens_before,
                tokens_after,
                tokens_saved,
                tool_tokens_saved: unsigned(object.get("tool_tokens_saved")).unwrap_or(0),
                transforms,
                wire_shape: Some(expected_shape.as_str().to_owned()),
                frozen_message_count,
                cached_prefix_replayed,
                duration_ms,
            },
        }
    }

    fn record_failure(&self, now: u64) {
        let failures = self
            .failures
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        let exponent = failures.saturating_sub(1).min(5);
        let cooldown = FAILURE_COOLDOWN_BASE_MS
            .saturating_mul(1_u64 << exponent)
            .min(FAILURE_COOLDOWN_MAX_MS);
        self.blocked_until_ms
            .store(now.saturating_add(cooldown), Ordering::Relaxed);
    }

    fn record_success(&self) {
        self.failures.store(0, Ordering::Relaxed);
        self.blocked_until_ms.store(0, Ordering::Relaxed);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WireShape {
    Responses,
    Messages,
}

impl WireShape {
    fn from_body(body: &Value) -> Option<Self> {
        if body
            .get("input")
            .is_some_and(|value| value.is_string() || value.is_array())
        {
            return Some(Self::Responses);
        }
        if body.get("messages").is_some_and(Value::is_array) {
            return Some(Self::Messages);
        }
        None
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Responses => "openai_responses",
            Self::Messages => "messages",
        }
    }

    fn matches_body(self, body: &Value) -> bool {
        match self {
            Self::Responses => body
                .get("input")
                .is_some_and(|value| value.is_string() || value.is_array()),
            Self::Messages => body.get("messages").is_some_and(Value::is_array),
        }
    }
}

fn normalize_endpoint(raw: &str) -> Option<String> {
    let mut url = reqwest::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let path = url.path().trim_end_matches('/').to_owned();
    if path.is_empty() {
        url.set_path("/v1/compress");
    } else if path != url.path() {
        url.set_path(&path);
    }
    Some(url.to_string())
}

fn compression_headers(value: Option<&Value>) -> Vec<(String, String)> {
    let Some(object) = value.and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut headers = Vec::new();
    for (name, value) in object {
        if headers.len() >= MAX_COMPRESSION_HEADERS {
            break;
        }
        let name = name.to_ascii_lowercase();
        // Headroom currently emits only `anthropic-beta`.  Never apply an
        // arbitrary provider header from the sidecar.
        if name != "anthropic-beta" {
            continue;
        }
        let Some(value) = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if value.len() > 4_096
            || HeaderName::try_from(name.as_str()).is_err()
            || HeaderValue::from_str(value).is_err()
        {
            continue;
        }
        headers.push((name, value.to_owned()));
    }
    headers
}

async fn read_bounded(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| bounded(&format!("body_read: {error}")))?;
        if body.len().saturating_add(chunk.len()) > limit {
            return Err("response_too_large".to_owned());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn response_error_reason(response: reqwest::Response) -> String {
    let bytes = match read_bounded(response, MAX_ERROR_BODY_BYTES).await {
        Ok(bytes) => bytes,
        Err(reason) => return reason,
    };
    let value = serde_json::from_slice::<Value>(&bytes).ok();
    value
        .as_ref()
        .and_then(|value| value.get("error"))
        .and_then(|error| {
            error
                .get("type")
                .or_else(|| error.get("code"))
                .or_else(|| error.get("message"))
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
        })
        .map(bounded)
        .unwrap_or_else(|| "request_rejected".to_owned())
}

fn skip(reason: &str) -> CompressionResult {
    CompressionResult::Skipped {
        reason: reason.to_owned(),
    }
}

fn stream_flag(body: &Value) -> bool {
    body.get("stream").and_then(Value::as_bool).unwrap_or(false)
}

fn unsigned(value: Option<&Value>) -> Option<u64> {
    value.and_then(unsigned_value)
}

fn unsigned_value(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|value| u64::try_from(value).ok()))
        .or_else(|| {
            value
                .as_f64()
                .filter(|value| *value >= 0.0)
                .map(|value| value as u64)
        })
}

fn bounded(value: &str) -> String {
    value.chars().take(MAX_ERROR_CHARS).collect()
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u64::MAX as u128) as u64
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
    };

    struct TestServer {
        url: String,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn serve(status: &str, body: String, delay: Option<Duration>) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_owned();
        let task = tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let _ = read_request(&mut socket).await;
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        });
        TestServer {
            url: format!("http://{address}/v1/compress"),
            task,
        }
    }

    async fn read_request(socket: &mut TcpStream) -> Vec<u8> {
        let mut data = Vec::new();
        let mut buffer = [0_u8; 8_192];
        loop {
            let read = match socket.read(&mut buffer).await {
                Ok(read) => read,
                Err(_) => return data,
            };
            if read == 0 {
                return data;
            }
            data.extend_from_slice(&buffer[..read]);
            if let Some(end) = data.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&data[..end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                if data.len() >= end + 4 + content_length {
                    return data;
                }
            }
        }
    }

    fn config(url: String, min_bytes: usize) -> Config {
        Config {
            url: Some(url),
            token: None,
            timeout: Duration::from_millis(500),
            min_bytes,
            mode: None,
        }
    }

    fn chat_body() -> Value {
        json!({
            "model": "gpt-5.3-codex",
            "messages": [
                {"role": "user", "content": "a long enough prompt for compression"}
            ],
            "stream": true
        })
    }

    fn responses_body() -> Value {
        json!({
            "model": "gpt-5.3-codex",
            "input": [
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "a long enough prompt for compression"}
                ]}
            ],
            "stream": true
        })
    }

    #[tokio::test]
    async fn disabled_without_endpoint() {
        let client = Client::new(Config::default());
        assert!(!client.enabled());
        assert!(matches!(
            client
                .compress(&chat_body(), Some("session"), false, None)
                .await,
            CompressionResult::Disabled
        ));
    }

    #[tokio::test]
    async fn skips_without_stable_session() {
        let client = Client::new(config("http://127.0.0.1:1/v1/compress".to_owned(), 0));
        assert!(matches!(
            client.compress(&chat_body(), None, false, None).await,
            CompressionResult::Skipped { reason } if reason == "no_session"
        ));
        assert!(matches!(
            client.compress(&chat_body(), Some("  "), false, None).await,
            CompressionResult::Skipped { reason } if reason == "no_session"
        ));
    }

    #[tokio::test]
    async fn skips_small_payloads_before_calling_headroom() {
        let client = Client::new(config("http://127.0.0.1:1/v1/compress".to_owned(), 10_000));
        assert!(matches!(
            client.compress(&chat_body(), Some("session"), false, None).await,
            CompressionResult::Skipped { reason } if reason == "small_payload"
        ));
    }

    #[tokio::test]
    async fn skips_bodies_that_already_carry_headroom_control_keys() {
        let client = Client::new(config("http://127.0.0.1:1/v1/compress".to_owned(), 0));
        let mut body = chat_body();
        body["config"] = json!({"mode": "lossless"});
        assert!(matches!(
            client.compress(&body, Some("session"), false, None).await,
            CompressionResult::Skipped { reason } if reason == "control_key_conflict"
        ));
    }

    #[tokio::test]
    async fn applies_compressed_body_metrics_and_headers() {
        let compressed = json!({
            "model": "gpt-5.3-codex",
            "messages": [{"role": "user", "content": "short"}],
            "stream": true
        });
        let response = json!({
            "body": compressed,
            "tokens_before": 100,
            "tokens_after": 40,
            "tokens_saved": 60,
            "transforms_applied": ["router:smart_crusher:0.4"],
            "wire_shape": "messages",
            "obligations": [],
            "headers": {"anthropic-beta": "advanced-tool-use-2025-11-20"},
            "session": {"frozen_message_count": 2, "cached_prefix_replayed": false}
        });
        let server = serve("200 OK", response.to_string(), None).await;
        let client = Client::new(config(server.url.clone(), 0));

        let result = client
            .compress(&chat_body(), Some("session-1"), false, None)
            .await;
        let CompressionResult::Applied {
            body,
            headers,
            metrics,
        } = result
        else {
            panic!("expected applied compression, got {result:?}");
        };
        assert_eq!(body["messages"][0]["content"], "short");
        assert_eq!(
            headers,
            vec![(
                "anthropic-beta".to_owned(),
                "advanced-tool-use-2025-11-20".to_owned()
            )]
        );
        assert_eq!(metrics.tokens_before, 100);
        assert_eq!(metrics.tokens_after, 40);
        assert_eq!(metrics.tokens_saved, 60);
        assert_eq!(metrics.frozen_message_count, Some(2));
        assert_eq!(metrics.cached_prefix_replayed, Some(false));
        let trace = metrics.trace_value();
        assert_eq!(trace["outcome"], "compressed");
        assert_eq!(trace["tokensSaved"], 60);
    }

    #[tokio::test]
    async fn accepts_responses_bodies_with_matching_wire_shape() {
        let compressed = responses_body();
        let response = json!({
            "body": compressed,
            "tokens_before": 200,
            "tokens_after": 120,
            "tokens_saved": 80,
            "wire_shape": "openai_responses",
            "obligations": []
        });
        let server = serve("200 OK", response.to_string(), None).await;
        let client = Client::new(config(server.url.clone(), 0));

        let result = client
            .compress(&responses_body(), Some("session-1"), false, None)
            .await;
        assert!(matches!(
            result,
            CompressionResult::Applied { metrics, .. } if metrics.tokens_saved == 80
        ));
    }

    #[tokio::test]
    async fn rejects_responses_bodies_without_wire_shape() {
        let response = json!({
            "body": responses_body(),
            "tokens_before": 200,
            "tokens_after": 200,
            "tokens_saved": 0,
            "obligations": []
        });
        let server = serve("200 OK", response.to_string(), None).await;
        let client = Client::new(config(server.url.clone(), 0));

        assert!(matches!(
            client.compress(&responses_body(), Some("session-1"), false, None).await,
            CompressionResult::Skipped { reason } if reason == "wire_shape_missing"
        ));
    }

    #[tokio::test]
    async fn rejects_model_changes_from_headroom_routing_advice() {
        let mut compressed = chat_body();
        compressed["model"] = Value::String("a-different-model".to_owned());
        let response = json!({
            "body": compressed,
            "tokens_before": 100,
            "tokens_after": 40,
            "tokens_saved": 60,
            "wire_shape": "messages",
            "obligations": []
        });
        let server = serve("200 OK", response.to_string(), None).await;
        let client = Client::new(config(server.url.clone(), 0));

        assert!(matches!(
            client.compress(&chat_body(), Some("session-1"), false, None).await,
            CompressionResult::Skipped { reason } if reason == "model_changed"
        ));
    }

    #[tokio::test]
    async fn rejects_a_changed_streaming_contract() {
        let mut compressed = chat_body();
        compressed["stream"] = Value::Bool(false);
        let response = json!({
            "body": compressed,
            "tokens_before": 100,
            "tokens_after": 40,
            "tokens_saved": 60,
            "wire_shape": "messages",
            "obligations": []
        });
        let server = serve("200 OK", response.to_string(), None).await;
        let client = Client::new(config(server.url.clone(), 0));

        assert!(matches!(
            client.compress(&chat_body(), Some("session-1"), false, None).await,
            CompressionResult::Skipped { reason } if reason == "stream_changed"
        ));
    }

    #[tokio::test]
    async fn rejects_a_changed_prompt_cache_key() {
        let mut original = chat_body();
        original["prompt_cache_key"] = Value::String("cache-key".to_owned());
        let response = json!({
            "body": chat_body(),
            "tokens_before": 100,
            "tokens_after": 40,
            "tokens_saved": 60,
            "wire_shape": "messages",
            "obligations": []
        });
        let server = serve("200 OK", response.to_string(), None).await;
        let client = Client::new(config(server.url.clone(), 0));

        assert!(matches!(
            client.compress(&original, Some("session-1"), false, None).await,
            CompressionResult::Skipped { reason } if reason == "cache_key_changed"
        ));
    }

    #[tokio::test]
    async fn rejects_obligations_this_increment_cannot_redeem() {
        let response = json!({
            "body": chat_body(),
            "tokens_before": 100,
            "tokens_after": 40,
            "tokens_saved": 60,
            "wire_shape": "messages",
            "obligations": ["relay_usage"]
        });
        let server = serve("200 OK", response.to_string(), None).await;
        let client = Client::new(config(server.url.clone(), 0));

        assert!(matches!(
            client.compress(&chat_body(), Some("session-1"), false, None).await,
            CompressionResult::Skipped { reason } if reason == "unredeemed_obligation"
        ));
    }

    #[tokio::test]
    async fn fails_open_on_http_error() {
        let server = serve(
            "503 Service Unavailable",
            json!({"error": {"type": "compression_timeout"}}).to_string(),
            None,
        )
        .await;
        let client = Client::new(config(server.url.clone(), 0));

        let result = client
            .compress(&chat_body(), Some("session-1"), false, None)
            .await;
        let CompressionResult::Failed { reason, .. } = result else {
            panic!("expected failure, got {result:?}");
        };
        assert!(reason.contains("503"));
        assert!(reason.contains("compression_timeout"));
    }

    #[tokio::test]
    async fn malformed_success_responses_fail_open_and_open_the_circuit() {
        let server = serve("200 OK", json!({"tokens_before": 10}).to_string(), None).await;
        let client = Client::new(config(server.url.clone(), 0));

        let result = client
            .compress(&chat_body(), Some("session-1"), false, None)
            .await;
        assert!(matches!(
            result,
            CompressionResult::Failed { reason, .. } if reason == "missing_body"
        ));
        assert!(matches!(
            client.compress(&chat_body(), Some("session-1"), false, None).await,
            CompressionResult::Skipped { reason } if reason == "circuit_open"
        ));
    }

    #[tokio::test]
    async fn fails_open_on_timeout_and_opens_the_circuit() {
        let server = serve("200 OK", "{}".to_owned(), Some(Duration::from_millis(300))).await;
        let client = Client::new(Config {
            timeout: Duration::from_millis(30),
            ..config(server.url.clone(), 0)
        });

        let result = client
            .compress(&chat_body(), Some("session-1"), false, None)
            .await;
        assert!(matches!(
            result,
            CompressionResult::Failed { reason, .. } if reason == "timeout"
        ));
        assert!(matches!(
            client.compress(&chat_body(), Some("session-1"), false, None).await,
            CompressionResult::Skipped { reason } if reason == "circuit_open"
        ));
    }

    #[test]
    fn rejects_ccr_mode() {
        let client = Client::new(Config {
            url: Some("http://127.0.0.1:1/v1/compress".to_owned()),
            mode: Some("ccr".to_owned()),
            ..Config::default()
        });
        assert!(!client.enabled());
        assert!(client.config_error().is_some());
    }

    #[test]
    fn rejects_an_invalid_proxy_token() {
        let client = Client::new(Config {
            url: Some("http://127.0.0.1:1/v1/compress".to_owned()),
            token: Some("bad\nvalue".to_owned()),
            ..Config::default()
        });
        assert!(!client.enabled());
        assert!(client.config_error().is_some());
    }

    #[test]
    fn normalizes_a_base_url_to_the_compress_endpoint() {
        assert_eq!(
            normalize_endpoint("http://127.0.0.1:8787").as_deref(),
            Some("http://127.0.0.1:8787/v1/compress")
        );
        assert_eq!(
            normalize_endpoint("http://127.0.0.1:8787/v1/compress").as_deref(),
            Some("http://127.0.0.1:8787/v1/compress")
        );
        assert_eq!(
            normalize_endpoint("http://127.0.0.1:8787/").as_deref(),
            Some("http://127.0.0.1:8787/v1/compress")
        );
        assert_eq!(
            normalize_endpoint("http://127.0.0.1:8787/v1/compress/").as_deref(),
            Some("http://127.0.0.1:8787/v1/compress")
        );
        assert_eq!(normalize_endpoint("file:///tmp/socket"), None);
        assert_eq!(normalize_endpoint("http://user:pass@127.0.0.1:8787"), None);
        assert_eq!(
            normalize_endpoint("http://127.0.0.1:8787/v1/compress?token=x"),
            None
        );
    }
}
