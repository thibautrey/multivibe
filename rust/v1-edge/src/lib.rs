//! Native HTTP edge for the `/v1` API.
//!
//! This crate deliberately owns the public inference boundary.  The Node
//! process is a control-plane peer (admin UI, OAuth and background tasks), not
//! an intermediate hop for inference.  Keeping the edge in one process also
//! means request bytes, upstream bytes and SSE frames do not cross a JS/native
//! boundary on the hot path.

mod chat_tools;
mod confidential;
mod dashboard;
mod idempotency;
mod token_refresh;

use async_stream::stream;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{
        Path, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{
        HeaderMap, Method, Request, StatusCode, Uri,
        header::{self, HeaderName, HeaderValue},
    },
    response::Response,
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bytes::Bytes;
use futures_util::{StreamExt, future::join_all};
use hmac::{Hmac, Mac};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    convert::Infallible,
    io::{Cursor, Read, Write},
    path::PathBuf,
    sync::atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrdering},
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Notify, Semaphore, broadcast};
use tokio::{
    fs,
    sync::{Mutex, RwLock},
    time::timeout,
};
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

const HOP_BY_HOP_HEADERS: &[&str] = &[
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];
const PUBLIC_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "request-id",
    "openai-request-id",
    "anthropic-request-id",
];

#[derive(Clone, Debug)]
pub struct EdgeConfig {
    pub app_version: String,
    pub app_git_sha: String,
    pub app_build_id: String,
    pub listen_host: String,
    pub listen_port: u16,
    pub node_control_plane_url: String,
    pub store_path: PathBuf,
    pub jobs_path: PathBuf,
    pub legacy_jobs_db_path: Option<PathBuf>,
    pub trace_path: Option<PathBuf>,
    pub trace_include_body: bool,
    pub trace_include_headers: bool,
    pub request_body_limit: usize,
    pub realtime_body_limit: usize,
    pub models_cache_ttl: Duration,
    pub session_affinity_enabled: bool,
    pub session_affinity_ttl: Duration,
    pub session_affinity_max_entries: usize,
    pub upstream_timeout: Duration,
    pub max_account_retry_attempts: usize,
    pub max_upstream_retries: usize,
    pub upstream_retry_base_delay: Duration,
    pub idempotency_ttl: Duration,
    pub idempotency_in_flight_timeout: Duration,
    pub idempotency_max_entries: usize,
    pub idempotency_max_bytes: usize,
    pub idempotency_max_response_bytes: usize,
    pub cloud_privacy_mode: String,
    pub confidential_inference_trust_policy: Option<String>,
    pub job_worker_concurrency: usize,
    pub oauth_token_url: String,
    pub oauth_client_id: String,
    pub opencode_console_url: String,
    pub opencode_oauth_client_id: String,
    pub xai_oauth_issuer: String,
    pub xai_oauth_client_id: String,
    pub xai_client_version: String,
    pub chatgpt_base_url: String,
    pub mistral_base_url: String,
    pub mistral_upstream_path: String,
    pub mistral_compact_upstream_path: String,
    pub zai_base_url: String,
    pub zai_upstream_path: String,
    pub zai_compact_upstream_path: String,
    pub zai_models_path: String,
    pub xai_base_url: String,
    pub xai_responses_path: String,
    pub xai_chat_completions_path: String,
    pub xai_models_path: String,
    pub models_client_version: String,
    pub realtime_provider: String,
    pub realtime_webrtc_call_url: Option<String>,
    pub proxy_models: Vec<String>,
    pub admin_token: String,
    pub configured_api_keys: Vec<(String, String)>,
    pub internal_job_token: Option<String>,
}

impl Default for EdgeConfig {
    fn default() -> Self {
        Self {
            app_version: "0.2.0".to_owned(),
            app_git_sha: "unknown".to_owned(),
            app_build_id: "unknown".to_owned(),
            listen_host: "0.0.0.0".to_owned(),
            listen_port: 1455,
            node_control_plane_url: "http://127.0.0.1:1456".to_owned(),
            store_path: PathBuf::from("/data/accounts.json"),
            jobs_path: PathBuf::from("/data/v1-edge-jobs.json"),
            legacy_jobs_db_path: Some(PathBuf::from("/data/jobs.sqlite")),
            trace_path: None,
            trace_include_body: false,
            trace_include_headers: false,
            request_body_limit: 100 * 1024 * 1024,
            realtime_body_limit: 2 * 1024 * 1024,
            models_cache_ttl: Duration::from_secs(10 * 60),
            session_affinity_enabled: false,
            session_affinity_ttl: Duration::from_secs(60 * 60),
            session_affinity_max_entries: 10_000,
            upstream_timeout: Duration::from_secs(10 * 60),
            max_account_retry_attempts: 10,
            max_upstream_retries: 5,
            upstream_retry_base_delay: Duration::from_secs(2),
            idempotency_ttl: Duration::from_secs(5 * 60),
            idempotency_in_flight_timeout: Duration::from_secs(5 * 60),
            idempotency_max_entries: 1_000,
            idempotency_max_bytes: 32 * 1024 * 1024,
            idempotency_max_response_bytes: 1024 * 1024,
            cloud_privacy_mode: "standard".to_owned(),
            confidential_inference_trust_policy: None,
            job_worker_concurrency: 16,
            oauth_token_url: "https://auth.openai.com/oauth/token".to_owned(),
            oauth_client_id: "app_EMoamEEZ73f0CkXaXp7hrann".to_owned(),
            opencode_console_url: "https://opencode.ai/console".to_owned(),
            opencode_oauth_client_id: "opencode-cli".to_owned(),
            xai_oauth_issuer: "https://auth.x.ai".to_owned(),
            xai_oauth_client_id: "b1a00492-073a-47ea-816f-4c329264a828".to_owned(),
            xai_client_version: "0.2.114".to_owned(),
            chatgpt_base_url: "https://chatgpt.com".to_owned(),
            mistral_base_url: "https://api.mistral.ai".to_owned(),
            mistral_upstream_path: "/v1/responses".to_owned(),
            mistral_compact_upstream_path: "/v1/responses/compact".to_owned(),
            zai_base_url: "https://api.z.ai".to_owned(),
            zai_upstream_path: "/api/coding/paas/v4/chat/completions".to_owned(),
            zai_compact_upstream_path: "/api/coding/paas/v4/chat/completions".to_owned(),
            zai_models_path: "/api/paas/v4/models".to_owned(),
            xai_base_url: "https://cli-chat-proxy.grok.com/v1".to_owned(),
            xai_responses_path: "/responses".to_owned(),
            xai_chat_completions_path: "/chat/completions".to_owned(),
            xai_models_path: "/models".to_owned(),
            models_client_version: "0.144.1".to_owned(),
            realtime_provider: "openai".to_owned(),
            realtime_webrtc_call_url: None,
            proxy_models: vec![
                "gpt-5.3-codex".to_owned(),
                "gpt-5.2-codex".to_owned(),
                "gpt-5-codex".to_owned(),
            ],
            admin_token: String::new(),
            configured_api_keys: Vec::new(),
            internal_job_token: None,
        }
    }
}

impl EdgeConfig {
    pub fn from_env() -> Self {
        let defaults = Self::default();
        let env = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let listen_port = env("V1_EDGE_PORT")
            .or_else(|| env("PORT"))
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(defaults.listen_port);
        let listen_host = env("V1_EDGE_HOST")
            .or_else(|| env("HOST"))
            .unwrap_or(defaults.listen_host.clone());
        let store_path = env("V1_EDGE_STORE_PATH")
            .or_else(|| env("STORE_PATH"))
            .map(PathBuf::from)
            .unwrap_or(defaults.store_path.clone());
        let jobs_path = env("V1_EDGE_JOBS_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| store_path.with_file_name("v1-edge-jobs.json"));
        let legacy_jobs_db_path = env("JOBS_DB_PATH")
            .map(PathBuf::from)
            .or(defaults.legacy_jobs_db_path.clone());
        let request_body_limit = env("REQUEST_BODY_LIMIT")
            .map(|v| parse_byte_limit(&v))
            .unwrap_or(defaults.request_body_limit);
        let configured_api_keys = parse_configured_api_keys(
            env("PROXY_API_KEY").as_deref().unwrap_or_default(),
            env("PROXY_API_KEYS").as_deref().unwrap_or_default(),
        )
        .unwrap_or_default();
        let proxy_models = env("PROXY_MODELS")
            .map(|v| {
                v.split(',')
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .filter(|v| !v.is_empty())
            .unwrap_or(defaults.proxy_models.clone());
        let timeout_ms = env("V1_EDGE_UPSTREAM_TIMEOUT_MS")
            .or_else(|| env("REALTIME_REQUEST_TIMEOUT_MS"))
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(defaults.upstream_timeout.as_millis() as u64);
        let realtime_url = env("REALTIME_WEBRTC_CALL_URL");
        Self {
            app_version: env("APP_VERSION").unwrap_or(defaults.app_version),
            app_git_sha: env("APP_GIT_SHA").unwrap_or(defaults.app_git_sha),
            app_build_id: env("APP_BUILD_ID").unwrap_or(defaults.app_build_id),
            listen_host,
            listen_port,
            node_control_plane_url: env("NODE_CONTROL_PLANE_URL")
                .unwrap_or(defaults.node_control_plane_url),
            store_path,
            jobs_path,
            legacy_jobs_db_path,
            trace_path: env("TRACE_FILE_PATH").map(PathBuf::from),
            trace_include_body: env("TRACE_INCLUDE_BODY")
                .is_some_and(|value| value.eq_ignore_ascii_case("true")),
            trace_include_headers: env("TRACE_INCLUDE_HEADERS")
                .is_some_and(|value| value.eq_ignore_ascii_case("true")),
            request_body_limit: request_body_limit.max(1),
            realtime_body_limit: 2 * 1024 * 1024,
            models_cache_ttl: Duration::from_millis(
                env("MODELS_CACHE_MS")
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(defaults.models_cache_ttl.as_millis() as u64)
                    .max(1_000),
            ),
            session_affinity_enabled: env("CODEX_SESSION_AFFINITY")
                .is_some_and(|value| value.eq_ignore_ascii_case("true")),
            session_affinity_ttl: Duration::from_millis(
                env("CODEX_SESSION_AFFINITY_TTL_MS")
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(defaults.session_affinity_ttl.as_millis() as u64)
                    .max(1_000),
            ),
            session_affinity_max_entries: env("CODEX_SESSION_AFFINITY_MAX_ENTRIES")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(defaults.session_affinity_max_entries)
                .max(1),
            upstream_timeout: Duration::from_millis(timeout_ms.max(1)),
            max_account_retry_attempts: env("MAX_ACCOUNT_RETRY_ATTEMPTS")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(defaults.max_account_retry_attempts)
                .max(1),
            max_upstream_retries: env("MAX_UPSTREAM_RETRIES")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(defaults.max_upstream_retries),
            upstream_retry_base_delay: Duration::from_millis(
                env("UPSTREAM_BASE_DELAY_MS")
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(defaults.upstream_retry_base_delay.as_millis() as u64),
            ),
            idempotency_ttl: Duration::from_millis(
                env("INFERENCE_IDEMPOTENCY_TTL_MS")
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(defaults.idempotency_ttl.as_millis() as u64)
                    .max(1_000),
            ),
            idempotency_in_flight_timeout: Duration::from_millis(
                env("INFERENCE_IDEMPOTENCY_IN_FLIGHT_TIMEOUT_MS")
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(defaults.idempotency_in_flight_timeout.as_millis() as u64)
                    .max(1_000),
            ),
            idempotency_max_entries: env("INFERENCE_IDEMPOTENCY_MAX_ENTRIES")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(defaults.idempotency_max_entries)
                .max(1),
            idempotency_max_bytes: env("INFERENCE_IDEMPOTENCY_MAX_BYTES")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(defaults.idempotency_max_bytes)
                .max(1_024),
            idempotency_max_response_bytes: env("INFERENCE_IDEMPOTENCY_MAX_RESPONSE_BYTES")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(defaults.idempotency_max_response_bytes)
                .max(1_024),
            cloud_privacy_mode: env("MULTIVIBE_CLOUD_PRIVACY_MODE")
                .unwrap_or(defaults.cloud_privacy_mode),
            confidential_inference_trust_policy: env(
                "MULTIVIBE_CONFIDENTIAL_INFERENCE_TRUST_POLICY",
            ),
            job_worker_concurrency: env("JOB_WORKER_CONCURRENCY")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(defaults.job_worker_concurrency)
                .max(1),
            oauth_token_url: env("OAUTH_TOKEN_URL").unwrap_or(defaults.oauth_token_url),
            oauth_client_id: env("OAUTH_CLIENT_ID").unwrap_or(defaults.oauth_client_id),
            opencode_console_url: env("OPENCODE_CONSOLE_URL")
                .unwrap_or(defaults.opencode_console_url),
            opencode_oauth_client_id: env("OPENCODE_OAUTH_CLIENT_ID")
                .unwrap_or(defaults.opencode_oauth_client_id),
            xai_oauth_issuer: env("XAI_OAUTH_ISSUER").unwrap_or(defaults.xai_oauth_issuer),
            xai_oauth_client_id: env("XAI_OAUTH_CLIENT_ID").unwrap_or(defaults.xai_oauth_client_id),
            xai_client_version: env("XAI_CLIENT_VERSION").unwrap_or(defaults.xai_client_version),
            chatgpt_base_url: env("CHATGPT_BASE_URL").unwrap_or(defaults.chatgpt_base_url),
            mistral_base_url: env("MISTRAL_BASE_URL").unwrap_or(defaults.mistral_base_url),
            mistral_upstream_path: env("MISTRAL_UPSTREAM_PATH")
                .unwrap_or(defaults.mistral_upstream_path),
            mistral_compact_upstream_path: env("MISTRAL_COMPACT_UPSTREAM_PATH")
                .unwrap_or(defaults.mistral_compact_upstream_path),
            zai_base_url: env("ZAI_BASE_URL").unwrap_or(defaults.zai_base_url),
            zai_upstream_path: env("ZAI_UPSTREAM_PATH").unwrap_or(defaults.zai_upstream_path),
            zai_compact_upstream_path: env("ZAI_COMPACT_UPSTREAM_PATH")
                .unwrap_or(defaults.zai_compact_upstream_path),
            zai_models_path: env("ZAI_MODELS_PATH").unwrap_or(defaults.zai_models_path),
            xai_base_url: env("XAI_BASE_URL").unwrap_or(defaults.xai_base_url),
            xai_responses_path: env("XAI_RESPONSES_PATH").unwrap_or(defaults.xai_responses_path),
            xai_chat_completions_path: env("XAI_CHAT_COMPLETIONS_PATH")
                .unwrap_or(defaults.xai_chat_completions_path),
            xai_models_path: env("XAI_MODELS_PATH").unwrap_or(defaults.xai_models_path),
            models_client_version: env("MODELS_CLIENT_VERSION")
                .unwrap_or(defaults.models_client_version),
            realtime_provider: env("REALTIME_PROVIDER").unwrap_or(defaults.realtime_provider),
            realtime_webrtc_call_url: realtime_url,
            proxy_models,
            admin_token: env("ADMIN_TOKEN").unwrap_or_default(),
            configured_api_keys,
            internal_job_token: env("V1_EDGE_INTERNAL_JOB_TOKEN"),
        }
    }
}

pub fn parse_byte_limit(value: &str) -> usize {
    let trimmed = value.trim().to_ascii_lowercase();
    let mut digits = String::new();
    let mut suffix = String::new();
    for ch in trimmed.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            if suffix.is_empty() {
                digits.push(ch);
            }
        } else if !ch.is_ascii_whitespace() {
            suffix.push(ch);
        }
    }
    let amount = digits.parse::<f64>().unwrap_or(100.0);
    let multiplier = match suffix.as_str() {
        "kb" | "kib" => 1024.0,
        "mb" | "mib" => 1024.0 * 1024.0,
        "gb" | "gib" => 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    (amount * multiplier).floor().max(1.0) as usize
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub used_percent: Option<f64>,
    pub reset_at: Option<u64>,
    pub window_seconds: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub primary: Option<UsageWindow>,
    pub secondary: Option<UsageWindow>,
    pub monthly: Option<UsageWindow>,
    pub credits: Option<UsageWindow>,
    pub fetched_at: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelBlock {
    pub until: u64,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    #[serde(default)]
    pub model_blocks: HashMap<String, ModelBlock>,
    pub auth_blocked_until: Option<u64>,
    pub last_selected_at: Option<u64>,
    pub needs_token_refresh: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CapacityProfile {
    pub max_concurrent: Option<u32>,
    pub prefill_tokens_per_second: Option<f64>,
    pub decode_tokens_per_second: Option<f64>,
    pub context_window: Option<u64>,
    pub health_url: Option<String>,
    pub metrics_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalRuntime {
    pub source: Option<String>,
    pub adapter: Option<String>,
    pub endpoint: Option<String>,
    #[serde(default)]
    pub confirmed_model_ids: Vec<String>,
    pub authentication: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub provider: Option<String>,
    pub sdk_provider: Option<String>,
    pub sdk_models: Option<Vec<String>>,
    pub upstream_mode: Option<String>,
    pub compatibility_mode: Option<String>,
    pub email: Option<String>,
    #[serde(default)]
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<u64>,
    pub chatgpt_account_id: Option<String>,
    pub opencode_console_url: Option<String>,
    pub opencode_org_id: Option<String>,
    pub opencode_api_key: Option<String>,
    #[serde(default)]
    pub opencode_headers: HashMap<String, String>,
    pub base_url: Option<String>,
    pub oidc_issuer: Option<String>,
    pub oidc_client_id: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    pub priority: Option<i64>,
    pub location: Option<String>,
    pub capacity_profile: Option<CapacityProfile>,
    pub privacy_mode: Option<String>,
    pub multivibe_cloud: Option<bool>,
    pub usage: Option<UsageSnapshot>,
    pub state: Option<AccountState>,
    pub local_runtime: Option<LocalRuntime>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoutingCandidate {
    pub model: String,
    pub provider: Option<String>,
    #[serde(default)]
    pub account_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoutingRule {
    pub id: String,
    #[serde(default)]
    pub candidates: Vec<RoutingCandidate>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelAlias {
    pub id: String,
    #[serde(default)]
    pub rules: Vec<RoutingRule>,
    #[serde(default)]
    pub enabled: bool,
    pub defaults: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoredProxyApiKey {
    pub id: String,
    pub application: String,
    pub key: String,
    pub created_at: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationWebhook {
    pub id: String,
    pub url: String,
    pub secret: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationPolicy {
    pub application: String,
    pub fairness_weight: Option<f64>,
    #[serde(default)]
    pub webhooks: Vec<ApplicationWebhook>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoreSettings {
    pub image_request_model_override: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoreFile {
    #[serde(default)]
    pub accounts: Vec<Account>,
    #[serde(default)]
    pub model_aliases: Vec<ModelAlias>,
    #[serde(default)]
    pub proxy_api_keys: Vec<StoredProxyApiKey>,
    #[serde(default)]
    pub application_policies: Vec<ApplicationPolicy>,
    #[serde(default)]
    pub settings: StoreSettings,
}

#[derive(Clone)]
pub struct AccountStore {
    path: Arc<PathBuf>,
    cache: Arc<RwLock<Option<CachedStore>>>,
    write_lock: Arc<Mutex<()>>,
}

#[derive(Clone)]
struct CachedStore {
    modified: Option<SystemTime>,
    data: StoreFile,
}

impl AccountStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: Arc::new(path.into()),
            cache: Arc::new(RwLock::new(None)),
            write_lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn snapshot(&self) -> Result<StoreFile, String> {
        let modified = fs::metadata(self.path.as_ref())
            .await
            .ok()
            .and_then(|meta| meta.modified().ok());
        if let Some(cached) = self.cache.read().await.as_ref() {
            if cached.modified == modified {
                return Ok(cached.data.clone());
            }
        }

        let raw = fs::read(self.path.as_ref())
            .await
            .map_err(|error| format!("failed to read account store: {error}"))?;
        let data = serde_json::from_slice::<StoreFile>(&raw)
            .map_err(|error| format!("failed to parse account store: {error}"))?;
        *self.cache.write().await = Some(CachedStore {
            modified,
            data: data.clone(),
        });
        Ok(data)
    }

    pub async fn update_account<F>(&self, account_id: &str, update: F) -> Result<(), String>
    where
        F: FnOnce(&mut Account),
    {
        let _guard = self.write_lock.lock().await;
        let mut data = self.snapshot().await?;
        let account = data
            .accounts
            .iter_mut()
            .find(|account| account.id == account_id)
            .ok_or_else(|| format!("account {account_id} no longer exists"))?;
        update(account);
        let serialized = serde_json::to_vec_pretty(&data)
            .map_err(|error| format!("failed to serialize account store: {error}"))?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("failed to create account store directory: {error}"))?;
        }
        let temporary = self
            .path
            .with_extension(format!("tmp-{}", Uuid::new_v4().simple()));
        fs::write(&temporary, serialized)
            .await
            .map_err(|error| format!("failed to write account store: {error}"))?;
        fs::rename(&temporary, self.path.as_ref())
            .await
            .map_err(|error| format!("failed to replace account store: {error}"))?;
        let modified = fs::metadata(self.path.as_ref())
            .await
            .ok()
            .and_then(|meta| meta.modified().ok());
        *self.cache.write().await = Some(CachedStore { modified, data });
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct AuthContext {
    pub application: String,
}

pub fn constant_time_equal(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut difference = (left.len() ^ right.len()) as u8;
    let max = left.len().max(right.len());
    for index in 0..max {
        difference |= left.get(index).copied().unwrap_or_default()
            ^ right.get(index).copied().unwrap_or_default();
    }
    difference == 0
}

fn parse_configured_api_keys(
    legacy: &str,
    serialized: &str,
) -> Result<Vec<(String, String)>, String> {
    let mut entries = Vec::new();
    if !legacy.trim().is_empty() {
        entries.push(("default".to_owned(), legacy.trim().to_owned()));
    }
    if serialized.trim().is_empty() {
        return Ok(entries);
    }
    let object = serde_json::from_str::<HashMap<String, String>>(serialized)
        .map_err(|_| "PROXY_API_KEYS must be a JSON object".to_owned())?;
    for (application, key) in object {
        let application = application.trim().to_owned();
        let key = key.trim().to_owned();
        if application.is_empty() || key.is_empty() {
            return Err(
                "PROXY_API_KEYS application names and keys must be non-empty strings".to_owned(),
            );
        }
        if entries.iter().any(|(name, _)| name == &application) {
            return Err(format!(
                "Duplicate proxy API key application: {application}"
            ));
        }
        if entries
            .iter()
            .any(|(_, value)| constant_time_equal(value, &key))
        {
            return Err(format!(
                "Proxy API keys must be unique (duplicate for {application})"
            ));
        }
        entries.push((application, key));
    }
    Ok(entries)
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
}

fn bearer_or_api_key(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = header_value(headers, "x-api-key") {
        return Some(value);
    }
    let value = header_value(headers, "authorization")?;
    value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .map(ToOwned::to_owned)
}

fn admin_session_value(token: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(token.as_bytes()).expect("HMAC accepts any key");
    mac.update(b"multivibe-admin-session-v1");
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let cookie = header_value(headers, "cookie")?;
    cookie.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        (key == name).then(|| value.to_owned())
    })
}

pub fn authorize(
    headers: &HeaderMap,
    path: &str,
    store: &StoreFile,
    config: &EdgeConfig,
) -> Result<AuthContext, Response> {
    let mut keys = config.configured_api_keys.clone();
    keys.extend(
        store
            .proxy_api_keys
            .iter()
            .map(|entry| (entry.application.clone(), entry.key.clone())),
    );
    if let Some(internal) = config.internal_job_token.as_deref() {
        if header_value(headers, "x-multivibe-internal-token")
            .is_some_and(|value| constant_time_equal(&value, internal))
        {
            return Ok(AuthContext {
                application: header_value(headers, "x-multivibe-internal-application")
                    .unwrap_or_else(|| "internal-job".to_owned()),
            });
        }
    }
    if keys.is_empty() {
        return Ok(AuthContext {
            application: "default".to_owned(),
        });
    }
    if !config.admin_token.is_empty()
        && cookie_value(headers, "multivibe_admin_session").is_some_and(|value| {
            constant_time_equal(&value, &admin_session_value(&config.admin_token))
        })
    {
        return Ok(AuthContext {
            // Express lets an authenticated dashboard session use the normal
            // default proxy scope; keep the native edge attribution identical.
            application: "default".to_owned(),
        });
    }
    let token = bearer_or_api_key(headers);
    if let Some(token) = token {
        if let Some((application, _)) = keys
            .iter()
            .find(|(_, key)| constant_time_equal(&token, key))
        {
            return Ok(AuthContext {
                application: application.clone(),
            });
        }
    }
    if path.ends_with("/messages") {
        Err(anthropic_error_response(
            StatusCode::UNAUTHORIZED,
            "Invalid or missing proxy API key",
        ))
    } else {
        Err(error_response(
            StatusCode::UNAUTHORIZED,
            "Invalid or missing proxy API key",
            "invalid_api_key",
        ))
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn new_id(prefix: &str) -> String {
    let raw = Uuid::new_v4().simple().to_string();
    format!("{prefix}_{}", &raw[..24])
}

fn json_response(status: StatusCode, value: Value) -> Response {
    let body = serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec());
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::from("{}")))
}

fn error_response(status: StatusCode, message: impl Into<String>, code: &str) -> Response {
    json_response(
        status,
        json!({
            "error": {
                "message": message.into(),
                "type": if status == StatusCode::UNAUTHORIZED { "authentication_error" } else { "invalid_request_error" },
                "code": code,
            }
        }),
    )
}

fn anthropic_error_response(status: StatusCode, message: impl Into<String>) -> Response {
    let kind = if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        "authentication_error"
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        "rate_limit_error"
    } else if status == StatusCode::SERVICE_UNAVAILABLE || status.as_u16() == 529 {
        "overloaded_error"
    } else if status.is_client_error() {
        "invalid_request_error"
    } else {
        "api_error"
    };
    json_response(
        status,
        json!({"type": "error", "error": {"type": kind, "message": message.into()}}),
    )
}

async fn read_json_body(
    req: Request<Body>,
    limit: usize,
    anthropic: bool,
) -> Result<(HeaderMap, Value, Bytes), Response> {
    let headers = req.headers().clone();
    let compressed = to_bytes(req.into_body(), limit).await.map_err(|_| {
        if anthropic {
            anthropic_error_response(StatusCode::PAYLOAD_TOO_LARGE, "Request body is too large")
        } else {
            error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Request body is too large",
                "payload_too_large",
            )
        }
    })?;
    let encoding = header_value(&headers, "content-encoding").unwrap_or_default();
    let body = if encoding
        .split(',')
        .map(|value| value.trim().to_ascii_lowercase())
        .any(|value| value == "zstd")
    {
        decompress_zstd(&compressed, limit).map_err(|message| {
            error_response(StatusCode::BAD_REQUEST, message, "invalid_request_error")
        })?
    } else if encoding
        .split(',')
        .map(|value| value.trim().to_ascii_lowercase())
        .any(|value| !value.is_empty() && value != "identity")
    {
        return Err(error_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Unsupported content encoding",
            "unsupported_content_encoding",
        ));
    } else {
        compressed
    };
    let parsed = serde_json::from_slice::<Value>(&body).map_err(|_| {
        if anthropic {
            anthropic_error_response(StatusCode::BAD_REQUEST, "Invalid JSON")
        } else {
            error_response(
                StatusCode::BAD_REQUEST,
                "Invalid JSON",
                "invalid_request_error",
            )
        }
    })?;
    if !parsed.is_object() {
        return Err(if anthropic {
            anthropic_error_response(
                StatusCode::BAD_REQUEST,
                "Request body must be a JSON object",
            )
        } else {
            error_response(
                StatusCode::BAD_REQUEST,
                "Request body must be a JSON object",
                "invalid_request_error",
            )
        });
    }
    Ok((headers, parsed, body))
}

fn decompress_zstd(input: &[u8], limit: usize) -> Result<Bytes, String> {
    let mut decoder = zstd::stream::read::Decoder::new(Cursor::new(input))
        .map_err(|_| "Failed to decompress zstd body within the request body limit".to_owned())?;
    let mut output = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = decoder.read(&mut buffer).map_err(|_| {
            "Failed to decompress zstd body within the request body limit".to_owned()
        })?;
        if count == 0 {
            break;
        }
        output.extend_from_slice(&buffer[..count]);
        if output.len() > limit {
            return Err("Failed to decompress zstd body within the request body limit".to_owned());
        }
    }
    Ok(Bytes::from(output))
}

fn normalize_provider(account: &Account) -> String {
    match account.provider.as_deref() {
        Some("ai-sdk") => "ai-sdk".to_owned(),
        Some("openai-compatible") => "openai-compatible".to_owned(),
        Some("opencode") => "opencode".to_owned(),
        Some("mistral") => "mistral".to_owned(),
        Some("zai") => "zai".to_owned(),
        Some("xai") => "xai".to_owned(),
        _ => "openai".to_owned(),
    }
}

fn account_is_confidential(account: &Account) -> bool {
    account.privacy_mode.as_deref() == Some("confidential_verified")
}

fn privacy_error(status: StatusCode, code: &str, message: &str) -> Response {
    json_response(
        status,
        json!({
            "error": {
                "message": message,
                "type": "invalid_request_error",
                "code": code,
            },
        }),
    )
}

fn confidential_error_response(error: &confidential::ConfidentialError) -> Response {
    let status = if error.disposition == "not_sent" {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::BAD_GATEWAY
    };
    json_response(
        status,
        json!({
            "error": {
                "message": error.message,
                "type": "upstream_error",
                "code": error.code,
                "execution_state": error.disposition,
            },
        }),
    )
}

fn confidential_requested(config: &EdgeConfig, headers: &HeaderMap) -> Result<bool, Response> {
    let requested = header_value(headers, "x-multivibe-privacy")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if config.cloud_privacy_mode == "confidential_verified" {
        if requested
            .as_deref()
            .is_some_and(|value| value != "confidential_verified")
        {
            return Err(privacy_error(
                StatusCode::CONFLICT,
                "privacy_policy_downgrade_rejected",
                "This Core instance requires verified confidential computing.",
            ));
        }
        return Ok(true);
    }
    match requested.as_deref() {
        None | Some("standard") => Ok(false),
        Some("confidential_verified") => Ok(true),
        Some(_) => Err(privacy_error(
            StatusCode::BAD_REQUEST,
            "invalid_privacy_mode",
            "X-MultiVibe-Privacy is invalid.",
        )),
    }
}

fn confidential_path_supported(path: &str) -> bool {
    matches!(
        idempotency::normalized_route(path),
        Some("/responses" | "/chat/completions")
    )
}

fn normalize_model_key(model: &str) -> String {
    let value = model.trim().to_ascii_lowercase();
    value.rsplit('/').next().unwrap_or(&value).to_owned()
}

fn infer_provider(model: &str) -> String {
    let key = normalize_model_key(model);
    if key.starts_with("mistral")
        || key.starts_with("codestral")
        || key.starts_with("ministral")
        || key.starts_with("pixtral")
        || key.starts_with("open-mistral")
        || key.starts_with("open-mixtral")
    {
        return "mistral".to_owned();
    }
    if key.starts_with("glm-") || key.starts_with("chatglm") || key.starts_with("codegeex") {
        return "zai".to_owned();
    }
    if key.starts_with("grok-") || key == "grok" {
        return "xai".to_owned();
    }
    "openai".to_owned()
}

fn catalog_model<'a>(models: &'a [Value], requested: &str) -> Option<&'a Value> {
    let key = normalize_model_key(requested);
    models.iter().find(|entry| {
        entry
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| normalize_model_key(id) == key)
    })
}

fn catalog_string_array(entry: &Value, key: &str) -> Vec<String> {
    entry
        .get("metadata")
        .and_then(|metadata| metadata.get(key))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn providers_for_model(model: &str, catalog: &[Value]) -> Vec<String> {
    let Some(entry) = catalog_model(catalog, model) else {
        return vec![infer_provider(model)];
    };
    let mut providers = catalog_string_array(entry, "provider_candidates");
    if providers.is_empty()
        && let Some(provider) = entry
            .get("metadata")
            .and_then(|metadata| metadata.get("provider"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
    {
        providers.push(provider.to_owned());
    }
    if providers.is_empty() {
        providers.push(infer_provider(model));
    }
    let mut unique = HashSet::new();
    providers
        .into_iter()
        .filter(|provider| unique.insert(provider.clone()))
        .collect()
}

fn account_ids_for_model(model: &str, catalog: &[Value]) -> Vec<String> {
    catalog_model(catalog, model)
        .map(|entry| catalog_string_array(entry, "account_ids"))
        .unwrap_or_default()
}

fn is_local_runtime(account: &Account) -> bool {
    let runtime = account.local_runtime.as_ref();
    let discovered = account.location.as_deref() == Some("local")
        && runtime.and_then(|value| value.source.as_deref()) == Some("multivibe-local-discovery");
    let pair = account.id == "local-runtime-nvidia-pair"
        && account.location.as_deref() == Some("personal-cluster")
        && runtime.and_then(|value| value.source.as_deref()) == Some("multivibe-local-configuration")
        && runtime.and_then(|value| value.adapter.as_deref()) == Some("nvidia-pair");
    account.provider.as_deref() == Some("openai-compatible")
        && (discovered || pair)
        && account.access_token.is_empty()
        && runtime.and_then(|value| value.authentication.as_deref()) == Some("none")
        && !runtime
            .map(|value| value.confirmed_model_ids.is_empty())
            .unwrap_or(true)
        && account.base_url.is_some()
}

fn account_inference_token(account: &Account) -> &str {
    if normalize_provider(account) != "opencode" {
        return &account.access_token;
    }
    match account.opencode_api_key.as_deref().map(str::trim) {
        None | Some("") | Some("{env:OPENCODE_CONSOLE_TOKEN}") => &account.access_token,
        // Never send an unresolved config reference as a provider credential.
        Some(key) if key.contains("{env:") || key.contains("{file:") => "",
        Some(key) => key,
    }
}

fn apply_opencode_headers(account: &Account, headers: &mut HeaderMap) {
    for (name, value) in &account.opencode_headers {
        if !name.eq_ignore_ascii_case("authorization") {
            set_header(headers, name, value);
        }
    }
    if let Some(org_id) = &account.opencode_org_id {
        set_header(headers, "x-org-id", org_id);
    }
}

fn account_usable(account: &Account, model: &str, blocked: &HashMap<String, u64>) -> bool {
    if !account.enabled {
        return false;
    }
    if account_inference_token(account).is_empty() && !is_local_runtime(account)
    {
        return false;
    }
    let now = now_ms();
    if account
        .state
        .as_ref()
        .and_then(|state| state.auth_blocked_until)
        .is_some_and(|until| until > now)
    {
        return false;
    }
    let model_key = normalize_model_key(model);
    if account
        .state
        .as_ref()
        .and_then(|state| state.model_blocks.get(&model_key))
        .is_some_and(|block| block.until > now)
    {
        return false;
    }
    blocked
        .get(&format!("{}:{model_key}", account.id))
        .is_none_or(|until| *until <= now)
}

fn usage_percent(window: Option<&UsageWindow>) -> Option<f64> {
    window
        .and_then(|value| value.used_percent)
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 100.0))
}

fn remaining_percent(value: Option<&UsageWindow>) -> Option<f64> {
    usage_percent(value).map(|used| 100.0 - used)
}

fn account_headroom(account: &Account) -> Option<f64> {
    [
        remaining_percent(
            account
                .usage
                .as_ref()
                .and_then(|usage| usage.primary.as_ref()),
        ),
        remaining_percent(
            account
                .usage
                .as_ref()
                .and_then(|usage| usage.secondary.as_ref()),
        ),
        remaining_percent(
            account
                .usage
                .as_ref()
                .and_then(|usage| usage.monthly.as_ref()),
        ),
        remaining_percent(
            account
                .usage
                .as_ref()
                .and_then(|usage| usage.credits.as_ref()),
        ),
    ]
    .into_iter()
    .flatten()
    .min_by(|left, right| left.partial_cmp(right).unwrap_or(Ordering::Equal))
}

fn five_hour_near_limit(account: &Account) -> bool {
    usage_percent(
        account
            .usage
            .as_ref()
            .and_then(|usage| usage.primary.as_ref()),
    )
    .is_some_and(|used| used >= 90.0)
}

fn select_accounts(
    accounts: &[Account],
    route: &RouteCandidate,
    blocked: &HashMap<String, u64>,
    selected: &HashMap<String, String>,
) -> Vec<Account> {
    let mut candidates = accounts
        .iter()
        .filter(|account| {
            normalize_provider(account) == route.provider.as_deref().unwrap_or("")
                && (!is_cloud_model_selector(&route.requested_model) || account.multivibe_cloud == Some(true))
                && (route.account_ids.is_empty() || route.account_ids.contains(&account.id))
                && account_usable(account, &route.model, blocked)
        })
        .cloned()
        .collect::<Vec<_>>();
    let provider = route.provider.clone().unwrap_or_default();
    if candidates.iter().any(|account| account_headroom(account) != Some(0.0)) {
        candidates.retain(|account| account_headroom(account) != Some(0.0));
    }
    let effective_pool = {
        let filtered = candidates
            .iter()
            .filter(|account| !five_hour_near_limit(account))
            .cloned()
            .collect::<Vec<_>>();
        if filtered.is_empty() {
            candidates.clone()
        } else {
            filtered
        }
    };
    let all_effective_accounts_near_limit =
        !effective_pool.is_empty() && effective_pool.iter().all(five_hour_near_limit);
    candidates = effective_pool;
    candidates.sort_by(|left, right| {
        if all_effective_accounts_near_limit {
            match (account_headroom(left), account_headroom(right)) {
                (None, Some(_)) => return Ordering::Greater,
                (Some(_), None) => return Ordering::Less,
                (Some(left), Some(right)) if left != right => {
                    return right.partial_cmp(&left).unwrap_or(Ordering::Equal);
                }
                _ => {}
            }
        }
        let left_usage = usage_percent(
            left.usage
                .as_ref()
                .and_then(|usage| usage.secondary.as_ref()),
        );
        let right_usage = usage_percent(
            right
                .usage
                .as_ref()
                .and_then(|usage| usage.secondary.as_ref()),
        );
        if left_usage.is_none() && right_usage.is_none() {
            match (account_headroom(left), account_headroom(right)) {
                (None, Some(_)) => return Ordering::Greater,
                (Some(_), None) => return Ordering::Less,
                (Some(left), Some(right)) if left != right => {
                    return right.partial_cmp(&left).unwrap_or(Ordering::Equal);
                }
                _ => {}
            }
        }
        match (left_usage, right_usage) {
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(left), Some(right)) if left != right => {
                left.partial_cmp(&right).unwrap_or(Ordering::Equal)
            }
            _ => {
                let priority = left
                    .priority
                    .unwrap_or(i64::MAX)
                    .cmp(&right.priority.unwrap_or(i64::MAX));
                if priority == Ordering::Equal {
                    left.id.cmp(&right.id)
                } else {
                    priority
                }
            }
        }
    });
    if let Some(previous) = selected.get(&provider) {
        if let Some(index) = candidates
            .iter()
            .position(|account| &account.id == previous)
        {
            // Credit-only accounts rotate only within the best headroom tier.
            let credit_only = candidates.iter().all(|account| {
                account.usage.as_ref().and_then(|usage| usage.secondary.as_ref()).is_none()
            });
            let count = if credit_only {
                let best = account_headroom(&candidates[0]);
                candidates.iter().take_while(|account| account_headroom(account) == best).count()
            } else {
                candidates.len()
            };
            if index < count {
                let rotation = (index + 1) % count;
                candidates[..count].rotate_left(rotation);
            }
        }
    }
    candidates
}

#[derive(Clone, Debug)]
struct RouteCandidate {
    requested_model: String,
    model: String,
    provider: Option<String>,
    account_ids: Vec<String>,
}

fn is_cloud_model_selector(model: &str) -> bool {
    model.starts_with("multivibe/")
}

fn routes_for_model(
    store: &StoreFile,
    model: &str,
    default_model: &str,
    catalog: &[Value],
) -> Vec<RouteCandidate> {
    let requested = if model.trim().is_empty() {
        default_model
    } else {
        model
    };
    if is_cloud_model_selector(requested) {
        return vec![RouteCandidate {
            requested_model: requested.to_owned(), model: requested.to_owned(),
            provider: Some("openai-compatible".to_owned()),
            account_ids: vec![],
        }];
    }
    if let Some(alias) = store
        .model_aliases
        .iter()
        .find(|alias| alias.enabled && alias.id.eq_ignore_ascii_case(requested))
    {
        let routes = alias
            .rules
            .iter()
            .flat_map(|rule| rule.candidates.iter())
            .flat_map(|candidate| {
                let providers = candidate
                    .provider
                    .clone()
                    .map(|provider| vec![provider])
                    .unwrap_or_else(|| providers_for_model(&candidate.model, catalog));
                let account_ids = if candidate.account_ids.is_empty() {
                    account_ids_for_model(&candidate.model, catalog)
                } else {
                    candidate.account_ids.clone()
                };
                providers.into_iter().map(move |provider| RouteCandidate {
                    requested_model: requested.to_owned(),
                    model: candidate.model.clone(),
                    provider: Some(provider),
                    account_ids: account_ids.clone(),
                })
            })
            .collect::<Vec<_>>();
        if !routes.is_empty() {
            return routes;
        }
    }
    providers_for_model(requested, catalog)
        .into_iter()
        .map(|provider| RouteCandidate {
            requested_model: requested.to_owned(),
            model: requested.to_owned(),
            provider: Some(provider),
            account_ids: account_ids_for_model(requested, catalog),
        })
        .collect()
}

fn payload_has_image(body: &Value) -> bool {
    fn value_type_has_image(value: &Value) -> bool {
        value
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind.to_ascii_lowercase().contains("image"))
    }

    body.get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .chain(
            body.get("input")
                .and_then(Value::as_array)
                .into_iter()
                .flatten(),
        )
        .any(|item| {
            value_type_has_image(item)
                || item
                    .get("content")
                    .and_then(Value::as_array)
                    .is_some_and(|content| content.iter().any(value_type_has_image))
        })
}

fn image_aware_routing_model(
    store: &StoreFile,
    catalog: &[Value],
    body: &Value,
    requested_model: &str,
) -> String {
    if is_cloud_model_selector(requested_model) || !payload_has_image(body) {
        return requested_model.to_owned();
    }
    let Some(override_model) = store
        .settings
        .image_request_model_override
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
    else {
        return requested_model.to_owned();
    };
    let valid_model = catalog_model(catalog, override_model).is_some();
    let valid_alias = store.model_aliases.iter().any(|alias| {
        alias.enabled && normalize_model_key(&alias.id) == normalize_model_key(override_model)
    });
    if valid_model || valid_alias {
        override_model.to_owned()
    } else {
        requested_model.to_owned()
    }
}

fn alias_default(store: &StoreFile, model: &str, key: &str) -> Option<String> {
    store
        .model_aliases
        .iter()
        .find(|alias| alias.enabled && normalize_model_key(&alias.id) == normalize_model_key(model))
        .and_then(|alias| alias.defaults.as_ref())
        .and_then(|defaults| defaults.get(key))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn trim_slashes(value: &str) -> String {
    value.trim_end_matches('/').to_owned()
}

fn account_base_url(account: &Account, config: &EdgeConfig) -> String {
    match normalize_provider(account).as_str() {
        "ai-sdk" => format!("{}/internal/ai-sdk/{}", trim_slashes(&config.node_control_plane_url),
            account.id.bytes().map(|byte| if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_') { char::from(byte).to_string() } else { format!("%{byte:02X}") }).collect::<String>()),
        "openai-compatible" => account.base_url.clone().unwrap_or_default(),
        "opencode" => account
            .base_url
            .clone()
            .unwrap_or_else(|| "https://opencode.ai/zen".to_owned()),
        "mistral" => config.mistral_base_url.clone(),
        "zai" => config.zai_base_url.clone(),
        "xai" => account
            .base_url
            .clone()
            .unwrap_or_else(|| config.xai_base_url.clone()),
        _ => config.chatgpt_base_url.clone(),
    }
}

fn resolve_upstream_mode(account: &Account, chat_route: bool, compact: bool) -> bool {
    if normalize_provider(account) == "ai-sdk" { return true; }
    if let Some(mode) = account.upstream_mode.as_deref() {
        return mode == "chat/completions";
    }
    match normalize_provider(account).as_str() {
        "zai" => true,
        "openai-compatible" => account.compatibility_mode.as_deref() != Some("responses"),
        _ if compact => false,
        _ if chat_route => false,
        _ => false,
    }
}

fn upstream_path(
    account: &Account,
    config: &EdgeConfig,
    sends_chat: bool,
    compact: bool,
) -> String {
    match normalize_provider(account).as_str() {
        "mistral" => {
            if compact {
                config.mistral_compact_upstream_path.clone()
            } else {
                config.mistral_upstream_path.clone()
            }
        }
        "zai" => {
            if compact {
                config.zai_compact_upstream_path.clone()
            } else {
                config.zai_upstream_path.clone()
            }
        }
        "openai-compatible" | "opencode" | "ai-sdk" => {
            if sends_chat {
                "/v1/chat/completions".to_owned()
            } else {
                "/v1/responses".to_owned()
            }
        }
        "xai" => {
            if sends_chat {
                config.xai_chat_completions_path.clone()
            } else {
                config.xai_responses_path.clone()
            }
        }
        _ => {
            if compact {
                std::env::var("UPSTREAM_COMPACT_PATH")
                    .unwrap_or_else(|_| "/backend-api/codex/responses/compact".to_owned())
            } else {
                std::env::var("UPSTREAM_PATH")
                    .unwrap_or_else(|_| "/backend-api/codex/responses".to_owned())
            }
        }
    }
}

fn upstream_url(account: &Account, config: &EdgeConfig, sends_chat: bool, compact: bool) -> String {
    format!(
        "{}{}",
        trim_slashes(&account_base_url(account, config)),
        upstream_path(account, config, sends_chat, compact)
    )
}

fn value_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

/// Read protocol payload text without normalizing its boundaries.
///
/// Generated-token streams commonly put the separator before the next token
/// (for example, `" world"`). Using `value_string` for those deltas silently
/// joins words together because it trims the separator on every chunk.
fn raw_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(ToOwned::to_owned)
}

fn object_value(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn json_string(value: &Value) -> String {
    value.to_string()
}

fn tool_content_to_output(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) => Value::String(text.clone()),
        Some(Value::Array(parts)) => {
            let texts = parts
                .iter()
                .filter_map(|part| {
                    if let Some(text) = part.as_str() {
                        return Some(text.to_owned());
                    }
                    part.get("text")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                })
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>();
            if texts.is_empty() {
                Value::String(json_string(value.unwrap_or(&Value::Null)))
            } else {
                Value::String(texts.join("\n"))
            }
        }
        Some(value) => Value::String(json_string(value)),
        None => Value::String(String::new()),
    }
}

fn response_image_to_chat(value: &Value) -> Option<Value> {
    if value.get("type").and_then(Value::as_str) != Some("input_image") {
        return None;
    }
    let url = value_string(value.get("image_url"))
        .or_else(|| {
            value
                .get("image_url")
                .and_then(|image| value_string(image.get("url")))
        })
        .or_else(|| {
            value_string(value.get("data")).map(|data| {
                let mime =
                    value_string(value.get("mime_type")).unwrap_or_else(|| "image/png".to_owned());
                format!("data:{mime};base64,{data}")
            })
        })?;
    let mut image_url = Map::new();
    image_url.insert("url".to_owned(), Value::String(url));
    if let Some(detail) = value_string(value.get("detail")).or_else(|| {
        value
            .get("image_url")
            .and_then(|image| value_string(image.get("detail")))
    }) {
        image_url.insert("detail".to_owned(), Value::String(detail));
    }
    Some(json!({"type": "image_url", "image_url": Value::Object(image_url)}))
}

fn input_content(value: Option<&Value>, role: &str) -> Vec<Value> {
    let text_type = if role == "assistant" {
        "output_text"
    } else {
        "input_text"
    };
    match value {
        Some(Value::String(text)) => vec![json!({"type": text_type, "text": text})],
        Some(Value::Array(parts)) => {
            let mut output = Vec::new();
            for part in parts {
                if let Some(text) = part.as_str() {
                    output.push(json!({"type": text_type, "text": text}));
                } else if matches!(
                    part.get("type").and_then(Value::as_str),
                    Some("text" | "input_text" | "output_text")
                ) {
                    if let Some(text) = value_string(part.get("text")) {
                        output.push(json!({"type": text_type, "text": text}));
                    }
                } else if role != "assistant"
                    && part.get("type").and_then(Value::as_str) == Some("image_url")
                {
                    let image_url = part.get("image_url").and_then(|image| {
                        value_string(Some(image)).or_else(|| value_string(image.get("url")))
                    });
                    if let Some(image_url) = image_url {
                        let mut item = json!({"type": "input_image", "image_url": image_url});
                        if let Some(detail) = value_string(part.get("detail")).or_else(|| {
                            part.get("image_url")
                                .and_then(|image| value_string(image.get("detail")))
                        }) {
                            item["detail"] = Value::String(detail);
                        }
                        output.push(item);
                    }
                }
            }
            if output.is_empty() {
                vec![json!({"type": text_type, "text": json_string(value.unwrap_or(&Value::Null))})]
            } else {
                output
            }
        }
        Some(value) => vec![json!({"type": text_type, "text": json_string(value)})],
        None => vec![json!({"type": text_type, "text": ""})],
    }
}

fn apply_codex_parity_defaults(mut payload: Map<String, Value>, session_id: Option<&str>) -> Value {
    payload.insert("store".to_owned(), Value::Bool(false));
    payload.insert("stream".to_owned(), Value::Bool(true));
    let has_tools = payload
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| !tools.is_empty());
    if !payload.contains_key("tool_choice") && has_tools {
        payload.insert("tool_choice".to_owned(), Value::String("auto".to_owned()));
    }
    if !has_tools && payload.get("tool_choice").and_then(Value::as_str) == Some("auto") {
        payload.remove("tool_choice");
    }
    payload
        .entry("parallel_tool_calls".to_owned())
        .or_insert(Value::Bool(true));
    let mut text = payload
        .remove("text")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    text.entry("verbosity".to_owned())
        .or_insert(Value::String("medium".to_owned()));
    payload.insert("text".to_owned(), Value::Object(text));
    match payload.get_mut("include") {
        Some(Value::Array(include)) => {
            if !include
                .iter()
                .any(|value| value.as_str() == Some("reasoning.encrypted_content"))
            {
                include.push(Value::String("reasoning.encrypted_content".to_owned()));
            }
        }
        _ => {
            payload.insert("include".to_owned(), json!(["reasoning.encrypted_content"]));
        }
    }
    if let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) {
        payload
            .entry("prompt_cache_key".to_owned())
            .or_insert_with(|| Value::String(session_id.to_owned()));
    }
    let instructions = value_string(payload.get("instructions"));
    payload.insert(
        "instructions".to_owned(),
        Value::String(instructions.unwrap_or_else(|| "You are a helpful assistant.".to_owned())),
    );
    if let Some(effort) = payload.remove("reasoning_effort") {
        let mut reasoning = payload
            .remove("reasoning")
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        reasoning.insert("effort".to_owned(), effort);
        payload.insert("reasoning".to_owned(), Value::Object(reasoning));
    }
    if let Some(reasoning) = payload.get_mut("reasoning").and_then(Value::as_object_mut) {
        if reasoning.contains_key("effort") {
            reasoning
                .entry("summary".to_owned())
                .or_insert(Value::String("auto".to_owned()));
        }
    }
    Value::Object(payload)
}

fn normalize_responses_payload(body: &Value, session_id: Option<&str>) -> Value {
    let mut payload = object_value(body);
    if !payload.get("input").is_some_and(Value::is_array) {
        let text = value_string(payload.get("input"))
            .or_else(|| value_string(payload.get("prompt")))
            .unwrap_or_default();
        payload.insert(
            "input".to_owned(),
            json!([{"role": "user", "content": [{"type": "input_text", "text": text}]}]),
        );
    }
    if payload
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|model| model.starts_with("gpt-5"))
    {
        payload.remove("max_output_tokens");
    }
    apply_codex_parity_defaults(payload, session_id)
}

fn chat_completions_to_responses(body: &Value, session_id: Option<&str>) -> Value {
    let object = object_value(body);
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let system = messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("system"))
        .filter_map(|message| value_string(message.get("content")))
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut input = Vec::new();
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        if role == "system" {
            continue;
        }
        if role == "tool" {
            input.push(json!({
                "type": "function_call_output",
                "call_id": value_string(message.get("tool_call_id")).unwrap_or_else(|| new_id("call")),
                "output": tool_content_to_output(message.get("content")),
            }));
            continue;
        }
        if role == "assistant" {
            let content = input_content(message.get("content"), "assistant");
            if !content.is_empty() {
                input.push(json!({"role": "assistant", "content": content}));
            }
            if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in tool_calls {
                    let function = call.get("function").cloned().unwrap_or_else(|| json!({}));
                    input.push(json!({
                        "type": "function_call",
                        "call_id": value_string(call.get("id")).unwrap_or_else(|| new_id("call")),
                        "name": value_string(function.get("name")).unwrap_or_else(|| "unknown".to_owned()),
                        "arguments": function.get("arguments").map(|value| value.as_str().map(str::to_owned).unwrap_or_else(|| json_string(value))).unwrap_or_else(|| "{}".to_owned()),
                    }));
                }
            }
            continue;
        }
        input.push(
            json!({"role": "user", "content": input_content(message.get("content"), "user")}),
        );
    }
    if input
        .first()
        .and_then(|value| value.get("role"))
        .and_then(Value::as_str)
        != Some("user")
    {
        input.insert(
            0,
            json!({"role": "user", "content": [{"type": "input_text", "text": " "}]}),
        );
    }
    let mut payload = Map::new();
    payload.insert(
        "model".to_owned(),
        object.get("model").cloned().unwrap_or(Value::Null),
    );
    if let Some(instructions) =
        value_string(object.get("instructions")).or_else(|| (!system.is_empty()).then_some(system))
    {
        payload.insert("instructions".to_owned(), Value::String(instructions));
    }
    payload.insert("input".to_owned(), Value::Array(input));
    if let Some(tools) = object.get("tools").and_then(Value::as_array) {
        payload.insert(
            "tools".to_owned(),
            Value::Array(
                tools
                    .iter()
                    .map(|tool| {
                        if tool.get("type").and_then(Value::as_str) == Some("function") {
                            let function = tool.get("function").cloned().unwrap_or_else(|| json!({}));
                            json!({
                                "type": "function",
                                "name": function.get("name"),
                                "description": function.get("description"),
                                "parameters": function.get("parameters").cloned().unwrap_or_else(|| json!({"type": "object", "properties": {}})),
                                "strict": function.get("strict").cloned().unwrap_or(Value::Null),
                            })
                        } else {
                            tool.clone()
                        }
                    })
                    .collect(),
            ),
        );
    }
    for key in [
        "tool_choice",
        "reasoning_effort",
        "reasoning",
        "temperature",
    ] {
        if let Some(value) = object.get(key) {
            payload.insert(key.to_owned(), value.clone());
        }
    }
    apply_codex_parity_defaults(payload, session_id)
}

fn responses_to_chat_completions(body: &Value, client_stream: bool) -> Value {
    let object = object_value(body);
    let mut messages = Vec::new();
    if let Some(instructions) = value_string(object.get("instructions")) {
        messages.push(json!({"role": "system", "content": instructions}));
    }
    if let Some(input) = object.get("input") {
        if let Some(text) = input.as_str() {
            messages.push(json!({"role": "user", "content": text}));
        } else if let Some(items) = input.as_array() {
            for item in items {
                match item.get("type").and_then(Value::as_str) {
                    Some("input_image") => {
                        if let Some(part) = response_image_to_chat(item) {
                            messages.push(json!({"role": "user", "content": [part]}));
                        }
                    }
                    Some("function_call") => {
                        let id = value_string(item.get("call_id"))
                            .or_else(|| value_string(item.get("id")))
                            .unwrap_or_else(|| new_id("call"));
                        messages.push(json!({
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [{
                                "id": id,
                                "type": "function",
                                "function": {
                                    "name": value_string(item.get("name")).unwrap_or_else(|| "unknown".to_owned()),
                                    "arguments": item.get("arguments").map(|value| value.as_str().map(str::to_owned).unwrap_or_else(|| json_string(value))).unwrap_or_else(|| "{}".to_owned()),
                                }
                            }]
                        }));
                    }
                    Some("function_call_output") | Some("custom_tool_call_output") => {
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": value_string(item.get("call_id")).or_else(|| value_string(item.get("id"))).unwrap_or_else(|| new_id("call")),
                            "content": item.get("output").map(|value| if let Some(text) = value.as_str() { text.to_owned() } else { json_string(value) }).unwrap_or_default(),
                        }));
                    }
                    _ => {
                        let role = if item.get("role").and_then(Value::as_str) == Some("assistant")
                        {
                            "assistant"
                        } else {
                            "user"
                        };
                        let content = item
                            .get("content")
                            .and_then(Value::as_array)
                            .map(|parts| {
                                Value::Array(
                                    parts
                                        .iter()
                                        .filter_map(|part| {
                                            if let Some(text) = part.as_str() {
                                                Some(json!({"type": "text", "text": text}))
                                            } else if let Some(text) =
                                                value_string(part.get("text"))
                                            {
                                                Some(json!({"type": "text", "text": text}))
                                            } else {
                                                response_image_to_chat(part)
                                            }
                                        })
                                        .collect(),
                                )
                            })
                            .or_else(|| value_string(item.get("content")).map(Value::String))
                            .unwrap_or_else(|| Value::String(String::new()));
                        messages.push(json!({"role": role, "content": content}));
                    }
                }
            }
        }
    }
    let mut output = Map::new();
    output.insert(
        "model".to_owned(),
        object.get("model").cloned().unwrap_or(Value::Null),
    );
    output.insert("messages".to_owned(), Value::Array(messages));
    output.insert("stream".to_owned(), Value::Bool(client_stream));
    if let Some(tools) = object.get("tools").and_then(Value::as_array) {
        // Responses also carries built-in tools which are not valid Chat
        // Completions tools. Local OpenAI-compatible runtimes such as OMLX
        // accept function tools only, so normalize the envelope and drop
        // every other tool before forwarding the request.
        let normalized_tools: Vec<Value> = tools
            .iter()
            .filter_map(|tool| {
                if tool.get("type").and_then(Value::as_str) != Some("function") {
                    return None;
                }
                let source = tool.get("function").unwrap_or(tool);
                let name = source.get("name").and_then(Value::as_str)?;
                if name.trim().is_empty() {
                    return None;
                }
                let mut function = Map::new();
                function.insert("name".to_owned(), Value::String(name.to_owned()));
                for key in ["description", "parameters"] {
                    if let Some(value) = source.get(key) {
                        function.insert(key.to_owned(), value.clone());
                    }
                }
                if source.get("strict").and_then(Value::as_bool).is_some() {
                    function.insert("strict".to_owned(), source["strict"].clone());
                }
                Some(json!({"type": "function", "function": function}))
            })
            .collect();

        output.insert(
            "tools".to_owned(),
            Value::Array(normalized_tools),
        );
    }
    if let Some(choice) = object.get("tool_choice") {
        let normalized_choice = choice
            .as_str()
            .filter(|value| matches!(*value, "auto" | "none" | "required"))
            .map(|value| Value::String(value.to_owned()))
            .or_else(|| {
                let choice_object = choice.as_object()?;
                if choice_object.get("type").and_then(Value::as_str) != Some("function") {
                    return None;
                }
                let name = choice_object
                    .get("name")
                    .and_then(Value::as_str)
                    .or_else(|| choice_object.get("function")?.get("name").and_then(Value::as_str))?;
                Some(json!({"type": "function", "function": {"name": name}}))
            });
        if let Some(value) = normalized_choice {
            output.insert("tool_choice".to_owned(), value);
        }
    }
    let no_tools = output
        .get("tools")
        .and_then(Value::as_array)
        .is_none_or(|tools| tools.is_empty());
    if no_tools {
        output.remove("tools");
        if matches!(output.get("tool_choice").and_then(Value::as_str), Some("auto" | "required")) {
            output.remove("tool_choice");
        }
    }
    if let Some(value) = object.get("temperature") {
        output.insert("temperature".to_owned(), value.clone());
    }
    if let Some(value) = object
        .get("max_tokens")
        .or_else(|| object.get("max_completion_tokens"))
        .or_else(|| object.get("max_output_tokens"))
    {
        output.insert("max_tokens".to_owned(), value.clone());
    }
    Value::Object(output)
}

fn validate_chat_tool_contract(body: &Value) -> Result<(), String> {
    let empty = Vec::new();
    let tools = match body.get("tools") {
        None => &empty,
        Some(value) => value.as_array().ok_or("tools must be an array")?,
    };
    let mut names = Vec::new();
    for (index, tool) in tools.iter().enumerate() {
        if tool["type"] != "function" {
            return Err(format!("tools[{index}].type is unsupported by the Chat Completions bridge"));
        }
        let source = tool.get("function").filter(|v| !v.is_null()).unwrap_or(tool);
        let name = source["name"].as_str().filter(|name| !name.trim().is_empty())
            .ok_or_else(|| format!("tools[{index}] requires a function name"))?;
        names.push(name);
    }
    match body.get("tool_choice") {
        None => Ok(()),
        Some(choice) if matches!(choice.as_str(), Some("auto" | "none")) => Ok(()),
        Some(choice) if choice == "required" && !names.is_empty() => Ok(()),
        Some(choice) if choice["type"] == "function" && names.contains(&choice.get("name")
            .or_else(|| choice.get("function")?.get("name"))
            .and_then(Value::as_str).unwrap_or("")) => Ok(()),
        _ => Err("tool_choice must select an available function or be auto, none, or required".to_owned()),
    }
}

fn sanitize_generic_chat_payload(body: &Value) -> Value {
    let mut payload = object_value(body);
    for key in [
        "reasoning",
        "reasoning_effort",
        "include",
        "text",
        "store",
        "parallel_tool_calls",
    ] {
        payload.remove(key);
    }
    if let Some(value) = payload.remove("max_output_tokens") {
        payload.entry("max_tokens".to_owned()).or_insert(value);
    }
    if let Some(value) = payload.remove("max_completion_tokens") {
        payload.entry("max_tokens".to_owned()).or_insert(value);
    }
    Value::Object(payload)
}

fn has_reasoning_effort(payload: &Value) -> bool {
    payload.get("reasoning_effort").is_some()
        || payload
            .get("reasoning")
            .and_then(Value::as_object)
            .is_some_and(|reasoning| reasoning.contains_key("effort"))
}

fn default_chatgpt_reasoning_effort(payload: &mut Value, sends_chat: bool) {
    if has_reasoning_effort(payload) {
        return;
    }
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    if sends_chat {
        object.insert(
            "reasoning_effort".to_owned(),
            Value::String("low".to_owned()),
        );
        return;
    }
    let mut reasoning = object
        .remove("reasoning")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    reasoning.insert("effort".to_owned(), Value::String("low".to_owned()));
    object.insert("reasoning".to_owned(), Value::Object(reasoning));
}

fn is_claude_code_request(headers: &HeaderMap) -> bool {
    header_value(headers, "user-agent").is_some_and(|value| value.starts_with("claude-cli/"))
        && header_value(headers, "x-app").is_some_and(|value| value.eq_ignore_ascii_case("cli"))
}

fn claude_code_model(requested_model: &str) -> String {
    let requested = requested_model.to_ascii_lowercase();
    if requested.contains("haiku") || requested.contains("fast") {
        std::env::var("CLAUDE_CODE_FAST_MODEL").unwrap_or_else(|_| "gpt-5.4-mini".to_owned())
    } else {
        std::env::var("CLAUDE_CODE_MODEL").unwrap_or_else(|_| "gpt-5.6-luna".to_owned())
    }
}

fn claude_code_routing_model(requested_model: &str, detected: bool) -> String {
    if !is_cloud_model_selector(requested_model) && detected && requested_model.to_ascii_lowercase().contains("claude") {
        claude_code_model(requested_model)
    } else {
        requested_model.to_owned()
    }
}

fn anthropic_text(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(parts)) => {
            let text = parts
                .iter()
                .filter_map(|part| {
                    (part.get("type").and_then(Value::as_str) == Some("text"))
                        .then(|| raw_string(part.get("text")))
                        .flatten()
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn anthropic_image_to_responses(part: &Value) -> Option<Value> {
    if part.get("type").and_then(Value::as_str) != Some("image") {
        return None;
    }
    let source = part.get("source")?;
    match source.get("type").and_then(Value::as_str) {
        Some("base64") => {
            let mime =
                value_string(source.get("media_type")).unwrap_or_else(|| "image/png".to_owned());
            let data = value_string(source.get("data"))?;
            Some(json!({"type": "input_image", "image_url": format!("data:{mime};base64,{data}")}))
        }
        Some("url") => {
            Some(json!({"type": "input_image", "image_url": value_string(source.get("url"))?}))
        }
        _ => None,
    }
}

fn anthropic_to_responses(body: &Value, claude_code: bool, config: &EdgeConfig) -> Value {
    let object = object_value(body);
    let mut input = Vec::new();
    if let Some(messages) = object.get("messages").and_then(Value::as_array) {
        for message in messages {
            let role = if message.get("role").and_then(Value::as_str) == Some("assistant") {
                "assistant"
            } else {
                "user"
            };
            let raw_content = message
                .get("content")
                .cloned()
                .unwrap_or_else(|| json!([{"type": "text", "text": ""}]));
            let parts = raw_content.as_array().cloned().unwrap_or_else(|| {
                vec![json!({"type": "text", "text": raw_content.as_str().unwrap_or("")})]
            });
            let mut message_content = Vec::new();
            for part in parts {
                if part.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(text) = raw_string(part.get("text")) {
                        message_content.push(json!({"type": if role == "assistant" { "output_text" } else { "input_text" }, "text": text}));
                    }
                } else if role == "user" {
                    if let Some(image) = anthropic_image_to_responses(&part) {
                        message_content.push(image);
                    }
                } else if part.get("type").and_then(Value::as_str) == Some("tool_use") {
                    input.push(json!({
                        "type": "function_call",
                        "call_id": value_string(part.get("id")).unwrap_or_else(|| new_id("toolu")),
                        "name": value_string(part.get("name")).unwrap_or_else(|| "unknown".to_owned()),
                        "arguments": part.get("input").map(json_string).unwrap_or_else(|| "{}".to_owned()),
                    }));
                } else if part.get("type").and_then(Value::as_str) == Some("tool_result") {
                    input.push(json!({
                        "type": "function_call_output",
                        "call_id": value_string(part.get("tool_use_id")).unwrap_or_default(),
                        "output": tool_content_to_output(part.get("content")),
                    }));
                }
            }
            if !message_content.is_empty() {
                input.push(json!({"role": role, "content": message_content}));
            }
        }
    }
    let requested_model = value_string(object.get("model")).unwrap_or_default();
    let mapped_model = if claude_code && requested_model.to_ascii_lowercase().contains("claude") {
        claude_code_model(&requested_model)
    } else {
        requested_model
    };
    let mut payload = Map::new();
    payload.insert("model".to_owned(), Value::String(mapped_model));
    payload.insert("input".to_owned(), Value::Array(input));
    payload.insert(
        "stream".to_owned(),
        Value::Bool(
            object
                .get("stream")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    if let Some(system) = anthropic_text(object.get("system")) {
        payload.insert("instructions".to_owned(), Value::String(system));
    }
    if let Some(max_tokens) = object.get("max_tokens") {
        payload.insert("max_output_tokens".to_owned(), max_tokens.clone());
    }
    // Anthropic metadata is client-side attribution for Claude Code. The
    // ChatGPT Responses endpoint rejects this field as an unsupported
    // parameter, so it must not cross the protocol boundary.
    if let Some(tools) = object.get("tools").and_then(Value::as_array) {
        payload.insert(
            "tools".to_owned(),
            Value::Array(
                tools
                    .iter()
                    .map(|tool| json!({
                        "type": "function",
                        "name": tool.get("name"),
                        "description": tool.get("description"),
                        "parameters": tool.get("input_schema").cloned().unwrap_or_else(|| json!({"type": "object", "properties": {}})),
                    }))
                    .collect(),
            ),
        );
    }
    if let Some(choice) = object.get("tool_choice").and_then(Value::as_object) {
        match choice.get("type").and_then(Value::as_str) {
            Some("auto") => {
                payload.insert("tool_choice".to_owned(), Value::String("auto".to_owned()));
            }
            Some("any") => {
                payload.insert(
                    "tool_choice".to_owned(),
                    Value::String("required".to_owned()),
                );
            }
            Some("none") => {
                payload.insert("tool_choice".to_owned(), Value::String("none".to_owned()));
            }
            Some("tool") => {
                payload.insert(
                    "tool_choice".to_owned(),
                    json!({"type": "function", "name": choice.get("name")}),
                );
            }
            _ => {}
        }
    }
    if let Some(thinking) = object.get("thinking").and_then(Value::as_object) {
        if thinking.get("type").and_then(Value::as_str) != Some("disabled") {
            let budget = thinking
                .get("budget_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(8_192);
            let effort = if budget <= 1_024 {
                "low"
            } else if budget <= 8_192 {
                "medium"
            } else {
                "high"
            };
            payload.insert("reasoning".to_owned(), json!({"effort": effort}));
        }
    }
    // `config` is intentionally used only for defaults in future-compatible
    // deployments; keeping the argument makes the conversion self-contained.
    let _ = config;
    Value::Object(payload)
}

fn safe_json(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) => {
            serde_json::from_str(text).unwrap_or_else(|_| Value::Object(Map::new()))
        }
        Some(value) => value.clone(),
        None => Value::Object(Map::new()),
    }
}

fn response_usage(response: &Value) -> Value {
    let usage = response.get("usage").cloned().unwrap_or_else(|| json!({}));
    json!({
        "input_tokens": usage.get("input_tokens").or_else(|| usage.get("prompt_tokens")).and_then(Value::as_u64).unwrap_or(0),
        "output_tokens": usage.get("output_tokens").or_else(|| usage.get("completion_tokens")).and_then(Value::as_u64).unwrap_or(0),
        "cache_creation_input_tokens": usage.get("input_tokens_details").and_then(|value| value.get("cache_creation_tokens")).and_then(Value::as_u64).unwrap_or(0),
        "cache_read_input_tokens": usage.get("input_tokens_details").and_then(|value| value.get("cached_tokens")).and_then(Value::as_u64).unwrap_or(0),
    })
}

fn responses_to_anthropic(response: &Value, requested_model: &str) -> Value {
    let mut content = Vec::new();
    let mut has_tool = false;
    if let Some(output) = response.get("output").and_then(Value::as_array) {
        for item in output {
            if item.get("type").and_then(Value::as_str) == Some("message") {
                if let Some(parts) = item.get("content").and_then(Value::as_array) {
                    for part in parts {
                        if matches!(
                            part.get("type").and_then(Value::as_str),
                            Some("output_text" | "text")
                        ) {
                            if let Some(text) = raw_string(part.get("text")) {
                                content.push(json!({"type": "text", "text": text}));
                            }
                        }
                    }
                }
            } else if item.get("type").and_then(Value::as_str) == Some("function_call") {
                has_tool = true;
                content.push(json!({
                    "type": "tool_use",
                    "id": value_string(item.get("call_id")).or_else(|| value_string(item.get("id"))).unwrap_or_default(),
                    "name": value_string(item.get("name")).unwrap_or_else(|| "unknown".to_owned()),
                    "input": safe_json(item.get("arguments")),
                }));
            }
        }
    }
    let stop_reason = if has_tool {
        "tool_use"
    } else if response.get("status").and_then(Value::as_str) == Some("incomplete")
        && response
            .get("incomplete_details")
            .and_then(|value| value.get("reason"))
            .and_then(Value::as_str)
            == Some("max_output_tokens")
    {
        "max_tokens"
    } else {
        "end_turn"
    };
    json!({
        "id": format!("msg_{}", value_string(response.get("id")).unwrap_or_else(|| new_id("response"))),
        "type": "message",
        "role": "assistant",
        "model": requested_model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": Value::Null,
        "usage": response_usage(response),
    })
}

fn sanitize_response(value: &Value) -> Value {
    let mut output = object_value(value);
    output.remove("reasoning");
    if let Some(items) = output.get_mut("output").and_then(Value::as_array_mut) {
        items.retain(|item| item.get("type").and_then(Value::as_str) != Some("reasoning"));
        for item in items {
            if item.get("type").and_then(Value::as_str) == Some("function_call")
                && item
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.to_ascii_lowercase().starts_with("functions."))
            {
                *item = json!({"type": "message", "role": "assistant", "content": []});
            }
        }
    }
    Value::Object(output)
}

fn sanitize_chat(value: &Value) -> Value {
    let mut output = object_value(value);
    output.remove("reasoning");
    if let Some(choices) = output.get_mut("choices").and_then(Value::as_array_mut) {
        for choice in choices {
            if let Some(message) = choice.get_mut("message").and_then(Value::as_object_mut) {
                if let Some(calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) {
                    calls.retain(|call| {
                        !call
                            .get("function")
                            .and_then(|function| function.get("name"))
                            .and_then(Value::as_str)
                            .is_some_and(|name| name.to_ascii_lowercase().starts_with("functions."))
                    });
                }
            }
        }
    }
    Value::Object(output)
}

fn chat_to_response(value: &Value, fallback_model: &str) -> Value {
    let value = sanitize_chat(value);
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let message = choice.get("message").cloned().unwrap_or_else(|| json!({}));
    let mut output = Vec::new();
    let text = message
        .get("content")
        .map(|content| {
            if let Some(text) = content.as_str() {
                text.to_owned()
            } else if let Some(parts) = content.as_array() {
                parts
                    .iter()
                    .filter_map(|part| raw_string(part.get("text")))
                    .collect::<Vec<_>>()
                    .join("")
            } else {
                String::new()
            }
        })
        .unwrap_or_default()
        .replace("<think>", "")
        .replace("</think>", "");
    if !text.trim().is_empty() {
        output.push(json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text.trim_start()}]}));
    }
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let function = call.get("function").cloned().unwrap_or_else(|| json!({}));
            output.push(json!({
                "type": "function_call",
                "id": call.get("id"),
                "call_id": call.get("id"),
                "name": function.get("name").cloned().unwrap_or_else(|| Value::String("unknown".to_owned())),
                "arguments": function.get("arguments").map(|value| value.as_str().map(str::to_owned).unwrap_or_else(|| json_string(value))).unwrap_or_else(|| "{}".to_owned()),
            }));
        }
    }
    if output.is_empty() {
        output.push(json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": ""}]}));
    }
    let usage = value.get("usage").cloned().unwrap_or_else(|| json!({}));
    json!({
        "id": new_id("resp"),
        "object": "response",
        "created_at": value.get("created").and_then(Value::as_i64).unwrap_or((now_ms() / 1000) as i64),
        "model": value.get("model").cloned().unwrap_or_else(|| Value::String(fallback_model.to_owned())),
        "status": "completed",
        "output": output,
        "usage": {
            "input_tokens": usage.get("prompt_tokens").or_else(|| usage.get("input_tokens")).and_then(Value::as_u64).unwrap_or(0),
            "output_tokens": usage.get("completion_tokens").or_else(|| usage.get("output_tokens")).and_then(Value::as_u64).unwrap_or(0),
            "total_tokens": usage.get("total_tokens").and_then(Value::as_u64).unwrap_or(0),
        }
    })
}

fn response_to_chat(value: &Value, model: &str) -> Value {
    let value = sanitize_response(value);
    let mut content = String::new();
    let mut tool_calls = Vec::new();
    if let Some(items) = value.get("output").and_then(Value::as_array) {
        for item in items {
            match item.get("type").and_then(Value::as_str) {
                Some("message") => {
                    if let Some(parts) = item.get("content").and_then(Value::as_array) {
                        for part in parts {
                            if matches!(
                                part.get("type").and_then(Value::as_str),
                                Some("output_text" | "refusal")
                            ) {
                                content.push_str(
                                    raw_string(part.get("text"))
                                        .or_else(|| raw_string(part.get("refusal")))
                                        .as_deref()
                                        .unwrap_or_default(),
                                );
                            }
                        }
                    }
                }
                Some("function_call") => {
                    let name =
                        value_string(item.get("name")).unwrap_or_else(|| "unknown".to_owned());
                    if !name.to_ascii_lowercase().starts_with("functions.") {
                        let id = value_string(item.get("call_id"))
                            .or_else(|| value_string(item.get("id")))
                            .unwrap_or_else(|| new_id("call"));
                        tool_calls.push(json!({"id": id, "type": "function", "function": {"name": name, "arguments": item.get("arguments").map(|value| value.as_str().map(str::to_owned).unwrap_or_else(|| json_string(value))).unwrap_or_else(|| "{}".to_owned())}}));
                    }
                }
                _ => {}
            }
        }
    }
    let usage = value.get("usage").cloned().unwrap_or_else(|| json!({}));
    let mut message = json!({"role": "assistant", "content": content});
    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls);
    }
    json!({
        "id": new_id("chatcmpl"),
        "object": "chat.completion",
        "created": now_ms() / 1000,
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": if message.get("tool_calls").is_some() { "tool_calls" } else { "stop" }}],
        "usage": {
            "prompt_tokens": usage.get("input_tokens").or_else(|| usage.get("prompt_tokens")).and_then(Value::as_u64).unwrap_or(0),
            "completion_tokens": usage.get("output_tokens").or_else(|| usage.get("completion_tokens")).and_then(Value::as_u64).unwrap_or(0),
            "total_tokens": usage.get("total_tokens").and_then(Value::as_u64).unwrap_or(0),
        }
    })
}

fn sse_frame(event: &str, data: &Value) -> String {
    format!("event: {event}\ndata: {}\n\n", data)
}

fn response_completed_sse(value: &Value) -> String {
    sse_frame(
        "response.completed",
        &json!({"type": "response.completed", "response": sanitize_response(value)}),
    )
}

fn chat_completion_sse(value: &Value) -> String {
    format!("data: {}\n\ndata: [DONE]\n\n", value)
}

fn parse_sse_events(text: &str) -> Vec<(String, Value)> {
    text.replace("\r\n", "\n")
        .split("\n\n")
        .filter_map(|frame| {
            let mut event = String::new();
            let mut data = Vec::new();
            for line in frame.lines() {
                if let Some(value) = line.strip_prefix("event:") {
                    event = value.trim().to_owned();
                } else if let Some(value) = line.strip_prefix("data:") {
                    data.push(value.trim());
                }
            }
            if data.is_empty() {
                return None;
            }
            let text = data.join("\n");
            if text == "[DONE]" {
                return Some((event, Value::String("[DONE]".to_owned())));
            }
            serde_json::from_str::<Value>(&text)
                .ok()
                .map(|value| (event, value))
        })
        .collect()
}

fn response_from_sse(text: &str, model: &str) -> Value {
    let mut completed = None;
    let mut output_text = String::new();
    let mut function_calls: HashMap<String, Value> = HashMap::new();
    for (_, event) in parse_sse_events(text) {
        if event.as_str() == Some("[DONE]") {
            continue;
        }
        if event.get("type").and_then(Value::as_str) == Some("response.completed") {
            completed = event.get("response").cloned();
        } else if event.get("type").and_then(Value::as_str) == Some("response.output_text.delta") {
            output_text.push_str(
                raw_string(event.get("delta"))
                    .as_deref()
                    .unwrap_or_default(),
            );
        } else if event.get("type").and_then(Value::as_str)
            == Some("response.function_call_arguments.delta")
        {
            let id = value_string(event.get("item_id")).unwrap_or_else(|| "call_0".to_owned());
            let call = function_calls.entry(id.clone()).or_insert_with(|| json!({"type": "function_call", "id": id, "call_id": id, "name": "unknown", "arguments": ""}));
            let delta = raw_string(event.get("delta")).unwrap_or_default();
            call["arguments"] = Value::String(format!(
                "{}{}",
                call.get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                delta
            ));
        }
    }
    if let Some(mut value) = completed {
        let has_text = value
            .get("output")
            .and_then(Value::as_array)
            .map(|items| {
                items.iter().any(|item| {
                    item.get("type").and_then(Value::as_str) == Some("message")
                        && item
                            .get("content")
                            .and_then(Value::as_array)
                            .map(|parts| {
                                parts.iter().any(|part| {
                                    part.get("type").and_then(Value::as_str) == Some("output_text")
                                        && value_string(part.get("text"))
                                            .is_some_and(|text| !text.is_empty())
                                })
                            })
                            .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        if !output_text.is_empty() && !has_text {
            if let Some(object) = value.as_object_mut() {
                object
                    .entry("output")
                    .or_insert_with(|| Value::Array(Vec::new()))
                    .as_array_mut()
                    .expect("response output is an array")
                    .push(json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": output_text}]}));
            }
        }
        if let Some(output) = value.get_mut("output").and_then(Value::as_array_mut) {
            output.extend(function_calls.into_values());
        }
        return sanitize_response(&value);
    }
    let mut output = Vec::new();
    if !output_text.is_empty() {
        output.push(json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": output_text}]}));
    }
    output.extend(function_calls.into_values());
    json!({"id": new_id("resp"), "object": "response", "created_at": now_ms() / 1000, "model": model, "status": "completed", "output": output, "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}})
}

fn chat_from_sse(text: &str, model: &str) -> Value {
    let mut id = new_id("chatcmpl");
    let mut created = now_ms() / 1000;
    let mut content = String::new();
    let mut usage = json!({});
    let mut finish_reason = "stop";
    let mut tool_calls: Vec<Value> = Vec::new();
    for (_, event) in parse_sse_events(text) {
        if event.as_str() == Some("[DONE]") {
            continue;
        }
        if event.get("object").and_then(Value::as_str) != Some("chat.completion.chunk") {
            continue;
        }
        if let Some(value) = value_string(event.get("id")) {
            id = value;
        }
        if let Some(value) = event.get("created").and_then(Value::as_u64) {
            created = value;
        }
        if let Some(value) = event.get("usage") {
            usage = value.clone();
        }
        if let Some(choice) = event
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        {
            if let Some(reason) = value_string(choice.get("finish_reason")) {
                finish_reason = Box::leak(reason.into_boxed_str());
            }
            if let Some(delta) = choice.get("delta") {
                if let Some(value) =
                    raw_string(delta.get("content")).filter(|value| !value.is_empty())
                {
                    content.push_str(&value);
                }
                if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                    for call in calls {
                        let index = call
                            .get("index")
                            .and_then(Value::as_u64)
                            .unwrap_or(tool_calls.len() as u64)
                            as usize;
                        while tool_calls.len() <= index {
                            tool_calls.push(json!({"id": new_id("call"), "type": "function", "function": {"name": "", "arguments": ""}}));
                        }
                        if let Some(id) = value_string(call.get("id")) {
                            tool_calls[index]["id"] = Value::String(id);
                        }
                        if let Some(function) = call.get("function") {
                            if let Some(name) = value_string(function.get("name")) {
                                tool_calls[index]["function"]["name"] = Value::String(name);
                            }
                            if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                                tool_calls[index]["function"]["arguments"] =
                                    Value::String(format!(
                                        "{}{}",
                                        tool_calls[index]["function"]
                                            .get("arguments")
                                            .and_then(Value::as_str)
                                            .unwrap_or_default(),
                                        arguments
                                    ));
                            }
                        }
                    }
                }
            }
        }
    }
    let mut message = json!({"role": "assistant", "content": content});
    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls);
    }
    json!({"id": id, "object": "chat.completion", "created": created, "model": model, "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}], "usage": usage})
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StreamTransform {
    None,
    ChatToResponse,
    ResponseToChat,
    ResponseToAnthropic,
}

#[derive(Clone)]
struct BufferedReply {
    status: StatusCode,
    headers: Vec<(String, String)>,
    body: Bytes,
}

struct StreamingReply {
    chat_tools: chat_tools::ChatTools,
    status: StatusCode,
    headers: Vec<(String, String)>,
    upstream: reqwest::Response,
    transform: StreamTransform,
    requested_model: String,
    trace: Option<StreamingTrace>,
    capacity_lease: AdmissionLease,
    activity_lease: Option<ActivityLease>,
}

enum ProxyResult {
    Buffered(BufferedReply),
    Streaming(StreamingReply),
}

#[derive(Clone, Copy)]
enum ActivityKind {
    Request,
    WebsocketTurn,
    Job,
}

#[derive(Default)]
struct ActivityCounters {
    requests: AtomicU64,
    websocket_turns: AtomicU64,
    jobs: AtomicU64,
}

#[derive(Clone, Default)]
struct DrainController {
    draining: Arc<AtomicBool>,
    counters: Arc<ActivityCounters>,
}

impl DrainController {
    fn admit(&self, kind: ActivityKind) -> Option<ActivityLease> {
        if self.draining.load(AtomicOrdering::SeqCst) {
            return None;
        }
        let counter = self.counter(kind);
        counter.fetch_add(1, AtomicOrdering::SeqCst);
        if self.draining.load(AtomicOrdering::SeqCst) {
            counter.fetch_sub(1, AtomicOrdering::SeqCst);
            return None;
        }
        Some(ActivityLease {
            controller: self.clone(),
            kind,
        })
    }

    fn counter(&self, kind: ActivityKind) -> &AtomicU64 {
        match kind {
            ActivityKind::Request => &self.counters.requests,
            ActivityKind::WebsocketTurn => &self.counters.websocket_turns,
            ActivityKind::Job => &self.counters.jobs,
        }
    }

    fn begin(&self) {
        self.draining.store(true, AtomicOrdering::SeqCst);
    }

    fn resume(&self) {
        self.draining.store(false, AtomicOrdering::SeqCst);
    }

    fn is_draining(&self) -> bool {
        self.draining.load(AtomicOrdering::SeqCst)
    }

    fn snapshot(&self) -> (bool, u64, u64, u64) {
        (
            self.is_draining(),
            self.counters.requests.load(AtomicOrdering::SeqCst),
            self.counters.websocket_turns.load(AtomicOrdering::SeqCst),
            self.counters.jobs.load(AtomicOrdering::SeqCst),
        )
    }
}

struct ActivityLease {
    controller: DrainController,
    kind: ActivityKind,
}

impl Drop for ActivityLease {
    fn drop(&mut self) {
        self.controller
            .counter(self.kind)
            .fetch_sub(1, AtomicOrdering::SeqCst);
    }
}

fn draining_response() -> Response {
    let mut response = error_response(
        StatusCode::SERVICE_UNAVAILABLE,
        "MultiVibe Host is draining for a verified update",
        "host_update_draining",
    );
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("60"));
    response
}

const MAX_ADMISSION_WAIT_MS: u64 = 24 * 60 * 60 * 1_000;

#[derive(Default)]
struct AdmissionCounters {
    active_by_account: HashMap<String, u32>,
    waiters: HashMap<u64, HashSet<String>>,
    next_waiter_id: u64,
}

struct AdmissionController {
    counters: StdMutex<AdmissionCounters>,
    changed: Notify,
    version: Arc<AtomicU64>,
}

impl AdmissionController {
    fn new(version: Arc<AtomicU64>) -> Self {
        Self {
            counters: StdMutex::new(AdmissionCounters::default()),
            changed: Notify::new(),
            version,
        }
    }

    fn counters(&self) -> std::sync::MutexGuard<'_, AdmissionCounters> {
        self.counters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn bump(&self) {
        self.version.fetch_add(1, AtomicOrdering::Relaxed);
    }

    fn try_acquire(self: &Arc<Self>, accounts: &[Account]) -> Option<(usize, AdmissionLease)> {
        let mut counters = self.counters();
        let index = accounts.iter().position(|account| {
            let active = counters
                .active_by_account
                .get(&account.id)
                .copied()
                .unwrap_or_default();
            active < account_max_concurrent(account)
        })?;
        let account_id = accounts[index].id.clone();
        *counters
            .active_by_account
            .entry(account_id.clone())
            .or_default() += 1;
        drop(counters);
        self.bump();
        Some((
            index,
            AdmissionLease {
                controller: self.clone(),
                account_id: Some(account_id),
            },
        ))
    }

    fn register_waiter(self: &Arc<Self>, accounts: &[Account]) -> AdmissionWaiter {
        let mut counters = self.counters();
        counters.next_waiter_id = counters.next_waiter_id.wrapping_add(1).max(1);
        let id = counters.next_waiter_id;
        counters.waiters.insert(
            id,
            accounts.iter().map(|account| account.id.clone()).collect(),
        );
        drop(counters);
        self.bump();
        AdmissionWaiter {
            controller: self.clone(),
            id: Some(id),
        }
    }

    fn has_capacity(&self, accounts: &[Account]) -> bool {
        let counters = self.counters();
        accounts.iter().any(|account| {
            counters
                .active_by_account
                .get(&account.id)
                .copied()
                .unwrap_or_default()
                < account_max_concurrent(account)
        })
    }

    async fn wait_for_capacity(self: &Arc<Self>, accounts: &[Account], max_wait: Duration) -> bool {
        if self.has_capacity(accounts) {
            return true;
        }
        if max_wait.is_zero() {
            return false;
        }

        let _waiter = self.register_waiter(accounts);
        let deadline = tokio::time::Instant::now() + max_wait;
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.has_capacity(accounts) {
                return true;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return false;
            }
        }
    }

    fn acquire_any(self: &Arc<Self>, accounts: &[Account]) -> Option<(usize, AdmissionLease)> {
        self.try_acquire(accounts)
    }

    fn snapshot(&self, accounts: &[Account]) -> (u64, u64) {
        let account_ids = accounts
            .iter()
            .map(|account| account.id.as_str())
            .collect::<HashSet<_>>();
        let counters = self.counters();
        let free_slots = accounts
            .iter()
            .map(|account| {
                let active = counters
                    .active_by_account
                    .get(&account.id)
                    .copied()
                    .unwrap_or_default();
                account_max_concurrent(account).saturating_sub(active) as u64
            })
            .sum();
        let queue_depth = counters
            .waiters
            .values()
            .filter(|waiter_accounts| {
                waiter_accounts
                    .iter()
                    .any(|account_id| account_ids.contains(account_id.as_str()))
            })
            .count() as u64;
        (free_slots, queue_depth)
    }

    fn unregister_waiter(&self, id: u64) {
        if self.counters().waiters.remove(&id).is_some() {
            self.bump();
        }
    }

    fn release(&self, account_id: &str) {
        let mut counters = self.counters();
        let removed = if let Some(active) = counters.active_by_account.get_mut(account_id) {
            *active = active.saturating_sub(1);
            let remove = *active == 0;
            if remove {
                counters.active_by_account.remove(account_id);
            }
            true
        } else {
            false
        };
        drop(counters);
        if removed {
            self.bump();
            self.changed.notify_waiters();
        }
    }
}

struct AdmissionWaiter {
    controller: Arc<AdmissionController>,
    id: Option<u64>,
}

impl Drop for AdmissionWaiter {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            self.controller.unregister_waiter(id);
        }
    }
}

struct AdmissionLease {
    controller: Arc<AdmissionController>,
    account_id: Option<String>,
}

impl Drop for AdmissionLease {
    fn drop(&mut self) {
        if let Some(account_id) = self.account_id.take() {
            self.controller.release(&account_id);
        }
    }
}

fn account_max_concurrent(account: &Account) -> u32 {
    account
        .capacity_profile
        .as_ref()
        .and_then(|profile| profile.max_concurrent)
        .unwrap_or_else(|| {
            if account.location.as_deref() == Some("cloud") {
                32
            } else {
                1
            }
        })
        .max(1)
}

fn admission_wait(headers: &HeaderMap) -> Result<Duration, Response> {
    let Some(raw) = header_value(headers, "x-multivibe-max-wait-ms") else {
        return Ok(Duration::ZERO);
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(Duration::ZERO);
    }
    if !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "X-MultiVibe-Max-Wait-Ms must be a non-negative integer",
            "invalid_max_wait",
        ));
    }
    let milliseconds = raw
        .parse::<u64>()
        .unwrap_or(u64::MAX)
        .min(MAX_ADMISSION_WAIT_MS);
    Ok(Duration::from_millis(milliseconds))
}

const ROUTING_OPT_IN_HEADERS: &[&str] = &[
    "x-multivibe-priority",
    "x-multivibe-execution",
    "x-multivibe-max-wait-ms",
    "x-multivibe-deadline",
    "x-multivibe-idempotency-key",
    "x-multivibe-webhook",
    "x-multivibe-privacy",
];

fn routing_headers_opted_in(headers: &HeaderMap) -> bool {
    ROUTING_OPT_IN_HEADERS
        .iter()
        .any(|name| header_value(headers, name).is_some_and(|value| !value.trim().is_empty()))
}

fn apply_alias_defaults(headers: &mut HeaderMap, store: &StoreFile, model: &str) {
    if routing_headers_opted_in(headers) {
        return;
    }
    if let Some(priority) = alias_default(store, model, "priority")
        && matches!(
            priority.as_str(),
            "critical" | "interactive" | "standard" | "batch"
        )
        && let Ok(value) = HeaderValue::from_str(&priority)
    {
        headers.insert(HeaderName::from_static("x-multivibe-priority"), value);
    }
    if let Some(execution) = alias_default(store, model, "executionMode")
        && matches!(execution.as_str(), "sync" | "auto" | "defer")
        && let Ok(value) = HeaderValue::from_str(&execution)
    {
        headers.insert(HeaderName::from_static("x-multivibe-execution"), value);
    }
}

fn validate_routing_headers(
    headers: &HeaderMap,
    store: &StoreFile,
    application: &str,
) -> Result<(), Response> {
    if let Some(priority) =
        header_value(headers, "x-multivibe-priority").filter(|value| !value.trim().is_empty())
        && !matches!(
            priority.as_str(),
            "critical" | "interactive" | "standard" | "batch"
        )
    {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "X-MultiVibe-Priority must be critical, interactive, standard, or batch",
            "invalid_priority",
        ));
    }
    if let Some(execution) =
        header_value(headers, "x-multivibe-execution").filter(|value| !value.trim().is_empty())
        && !matches!(execution.as_str(), "sync" | "auto" | "defer")
    {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "invalid X-MultiVibe-Execution",
            "invalid_execution",
        ));
    }
    admission_wait(headers)?;
    if let Some(deadline) =
        header_value(headers, "x-multivibe-deadline").filter(|value| !value.trim().is_empty())
        && chrono::DateTime::parse_from_rfc3339(deadline.trim()).is_err()
    {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "X-MultiVibe-Deadline must be RFC 3339",
            "invalid_deadline",
        ));
    }
    if let Some(privacy) =
        header_value(headers, "x-multivibe-privacy").filter(|value| !value.trim().is_empty())
        && !matches!(privacy.as_str(), "standard" | "confidential_verified")
    {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "invalid X-MultiVibe-Privacy",
            "invalid_privacy",
        ));
    }
    if let Some(idempotency_key) = header_value(headers, "x-multivibe-idempotency-key")
        && idempotency_key.trim().len() > 200
    {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "X-MultiVibe-Idempotency-Key is too long",
            "invalid_idempotency_key",
        ));
    }
    if let Some(webhook) =
        header_value(headers, "x-multivibe-webhook").filter(|value| !value.trim().is_empty())
    {
        let webhook = webhook.trim();
        if webhook.len() > 100 {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                "X-MultiVibe-Webhook is too long",
                "invalid_webhook",
            ));
        }
        let registered = !webhook.is_empty()
            && store
                .application_policies
                .iter()
                .find(|policy| policy.application == application)
                .is_some_and(|policy| {
                    policy
                        .webhooks
                        .iter()
                        .any(|candidate| candidate.enabled && candidate.id == webhook)
                });
        if !registered {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                "webhook is not registered for this application",
                "invalid_webhook",
            ));
        }
    }
    Ok(())
}

#[derive(Clone, Default)]
struct AccountModelCatalogCache {
    source_signature: String,
    last_success_at: u64,
    last_attempt_at: u64,
    models: Vec<Value>,
    last_error: Option<String>,
}

#[derive(Default)]
struct ModelCatalogCache {
    signature: String,
    /// Last time every active account completed discovery successfully.
    fetched_at: u64,
    last_attempt_at: u64,
    next_refresh_at: u64,
    consecutive_failures: u32,
    models: Vec<Value>,
    accounts: HashMap<String, AccountModelCatalogCache>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct SessionAffinityKey {
    application: String,
    session_id: String,
    provider: String,
}

#[derive(Clone, Debug)]
struct SessionAffinityEntry {
    account_id: String,
    expires_at: u64,
    recency: u64,
}

/// Bounded in-memory account stickiness for Codex sessions.
///
/// The cache is deliberately scoped by application, session and provider. It
/// is only consulted after normal account eligibility/quota filtering, so a
/// sticky mapping cannot bypass policy or a blocked account. The cache is not
/// persisted: an edge restart must not make an old session claim a credential
/// from a different process lifetime.
struct SessionAffinityCache {
    ttl_ms: u64,
    max_entries: usize,
    next_recency: u64,
    entries: HashMap<SessionAffinityKey, SessionAffinityEntry>,
}

impl SessionAffinityCache {
    fn new(ttl: Duration, max_entries: usize) -> Self {
        Self {
            ttl_ms: ttl.as_millis().min(u64::MAX as u128) as u64,
            max_entries: max_entries.max(1),
            next_recency: 0,
            entries: HashMap::new(),
        }
    }

    fn key(application: &str, session_id: &str, provider: &str) -> SessionAffinityKey {
        SessionAffinityKey {
            application: application.to_owned(),
            session_id: session_id.to_owned(),
            provider: provider.to_owned(),
        }
    }

    fn next_recency(&mut self) -> u64 {
        self.next_recency = self.next_recency.saturating_add(1);
        self.next_recency
    }

    fn peek(
        &self,
        application: &str,
        session_id: &str,
        provider: &str,
        now: u64,
    ) -> Option<String> {
        let entry = self
            .entries
            .get(&Self::key(application, session_id, provider))?;
        (entry.expires_at > now).then(|| entry.account_id.clone())
    }

    fn get(
        &mut self,
        application: &str,
        session_id: &str,
        provider: &str,
        now: u64,
    ) -> Option<String> {
        let key = Self::key(application, session_id, provider);
        if self.peek(application, session_id, provider, now).is_none() {
            self.entries.remove(&key);
            return None;
        }
        let recency = self.next_recency();
        self.entries.get_mut(&key).map(|entry| {
            // A read changes LRU order but, like the Express implementation,
            // does not extend the affinity TTL.
            entry.recency = recency;
            entry.account_id.clone()
        })
    }

    fn remember(
        &mut self,
        application: &str,
        session_id: &str,
        provider: &str,
        account_id: &str,
        now: u64,
    ) {
        self.prune_expired(now);
        let key = Self::key(application, session_id, provider);
        let recency = self.next_recency();
        self.entries.insert(
            key,
            SessionAffinityEntry {
                account_id: account_id.to_owned(),
                expires_at: now.saturating_add(self.ttl_ms),
                recency,
            },
        );
        while self.entries.len() > self.max_entries {
            let Some(oldest_key) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.recency)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.entries.remove(&oldest_key);
        }
    }

    fn forget(&mut self, application: &str, session_id: &str, provider: &str) {
        self.entries
            .remove(&Self::key(application, session_id, provider));
    }

    fn prune_expired(&mut self, now: u64) {
        self.entries.retain(|_, entry| entry.expires_at > now);
    }
}

const TRACE_PRICING_VERSION: &str = "2026-08-01";

#[derive(Clone)]
struct TraceContext {
    id: String,
    client_request_id: String,
    trace_kind: &'static str,
    route: String,
    application: String,
    requested_model: Option<String>,
    resolved_model: Option<String>,
    model: Option<String>,
    account_id: Option<String>,
    account_email: Option<String>,
    provider: Option<String>,
    stream: bool,
    started_at: u64,
    upstream_attempt: usize,
    provider_attempts: usize,
    recovered_retry: bool,
    codex_session_id: Option<String>,
    project_root: Option<String>,
    project_host: Option<String>,
    priority: Option<String>,
    routing_decision: Option<String>,
    execution_location: Option<String>,
    capacity_version: Option<u64>,
    admission_wait_ms: Option<u64>,
    latency_breakdown: Option<Value>,
    account_selection: Option<Value>,
    input_context: Option<Value>,
    request_body: Option<Value>,
    request_headers: Option<Value>,
}

struct TraceOutcome {
    status: u16,
    completed_at: u64,
    lifecycle_state: &'static str,
    usage: Option<Value>,
    error: Option<String>,
    upstream_error: Option<String>,
    upstream_content_type: Option<String>,
    upstream_empty_body: Option<bool>,
    ttft_ms: Option<u64>,
    response_stream_diagnostics: Option<Value>,
    assistant_empty_output: Option<bool>,
    assistant_finish_reason: Option<String>,
    client_disconnected: Option<bool>,
}

fn client_trace_outcome(
    status: u16,
    completed_at: u64,
    error: Option<String>,
    client_disconnected: Option<bool>,
) -> TraceOutcome {
    TraceOutcome {
        status,
        completed_at,
        lifecycle_state: if status == 499 {
            "interrupted"
        } else {
            "completed"
        },
        usage: None,
        error,
        upstream_error: None,
        upstream_content_type: None,
        upstream_empty_body: None,
        ttft_ms: None,
        response_stream_diagnostics: None,
        assistant_empty_output: None,
        assistant_finish_reason: None,
        client_disconnected,
    }
}

#[derive(Default, Clone)]
struct NativeStreamDiagnostics {
    event_count: u64,
    event_types: HashMap<String, u64>,
    invalid_data_payload_count: u64,
    output_text_delta_count: u64,
    output_text_done_count: u64,
    reasoning_event_count: u64,
    refusal_event_count: u64,
    function_call_count: u64,
    hidden_function_call_count: u64,
    sanitizer_dropped_event_count: u64,
    sanitizer_dropped_text_event_count: u64,
    terminal_event_type: Option<String>,
    saw_response_completed: bool,
    saw_chat_completion_chunk: bool,
    saw_meaningful_output: bool,
    saw_assistant_text: bool,
    saw_function_call: bool,
    custom_tool_calls: Vec<NativeCustomToolCall>,
    usage: Option<Value>,
    finish_reason: Option<String>,
}

#[derive(Default, Clone)]
struct NativeCustomToolCall {
    item_id_present: bool,
    call_id_present: bool,
    name: Option<String>,
    status: Option<String>,
    input_delta_count: u64,
    input_bytes: u64,
    saw_input_done: bool,
    saw_output_item_added: bool,
    saw_output_item_done: bool,
    key: String,
}

impl NativeStreamDiagnostics {
    fn inspect_frame(&mut self, frame: &str) {
        let normalized = frame.replace('\r', "");
        for line in normalized.lines() {
            let Some(payload) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if payload.is_empty() || payload == "[DONE]" {
                continue;
            }
            let Ok(event) = serde_json::from_str::<Value>(payload) else {
                self.invalid_data_payload_count = self.invalid_data_payload_count.saturating_add(1);
                continue;
            };
            self.inspect_event(&event);
        }
    }

    fn inspect_event(&mut self, event: &Value) {
        let event_type = value_string(event.get("type")).unwrap_or_default();
        self.inspect_custom_tool_call(event, &event_type);
        if event.get("object").and_then(Value::as_str) == Some("chat.completion.chunk") {
            self.saw_chat_completion_chunk = true;
        }
        if !event_type.is_empty() || self.saw_chat_completion_chunk {
            self.event_count = self.event_count.saturating_add(1);
        }
        if !event_type.is_empty() {
            *self.event_types.entry(event_type.clone()).or_default() += 1;
        }
        match event_type.as_str() {
            "response.output_text.delta" => {
                self.output_text_delta_count = self.output_text_delta_count.saturating_add(1);
                if value_string(event.get("delta")).is_some_and(|value| !value.is_empty()) {
                    self.saw_meaningful_output = true;
                    self.saw_assistant_text = true;
                }
            }
            "response.output_text.done" => {
                self.output_text_done_count = self.output_text_done_count.saturating_add(1);
                if value_string(event.get("text")).is_some_and(|value| !value.is_empty()) {
                    self.saw_meaningful_output = true;
                    self.saw_assistant_text = true;
                }
            }
            value if value.starts_with("response.reasoning") => {
                self.reasoning_event_count = self.reasoning_event_count.saturating_add(1);
                if has_generated_value(event.get("delta")) {
                    self.saw_meaningful_output = true;
                }
            }
            value if value.starts_with("response.refusal") => {
                self.refusal_event_count = self.refusal_event_count.saturating_add(1);
                if has_generated_value(event.get("delta")) {
                    self.saw_meaningful_output = true;
                }
            }
            "response.completed" | "response.failed" | "response.incomplete" | "error" => {
                if self.terminal_event_type.is_none() {
                    self.terminal_event_type = Some(event_type.clone());
                }
                if event_type == "response.completed" {
                    self.saw_response_completed = true;
                }
                self.finish_reason = value_string(event.get("status"))
                    .or_else(|| value_string(event.get("stop_reason")))
                    .or_else(|| {
                        event
                            .get("response")
                            .and_then(|response| value_string(response.get("status")))
                    });
                if let Some(response) = event.get("response") {
                    if let Some(usage) = response.get("usage") {
                        self.usage = Some(usage.clone());
                    }
                    if response_has_assistant_output(response) {
                        self.saw_meaningful_output = true;
                        self.saw_assistant_text = response_has_assistant_text(response);
                        self.saw_function_call = response_has_function_call(response);
                    }
                }
            }
            _ => {}
        }
        if let Some(usage) = event.get("usage") {
            self.usage = Some(usage.clone());
        }
        if event.get("object").and_then(Value::as_str) == Some("chat.completion.chunk") {
            let choices = event.get("choices").and_then(Value::as_array);
            if let Some(choice) = choices.and_then(|values| values.first()) {
                self.finish_reason = value_string(choice.get("finish_reason"))
                    .or_else(|| self.finish_reason.clone());
                if let Some(delta) = choice.get("delta") {
                    if has_generated_value(delta.get("content"))
                        || has_generated_value(delta.get("reasoning_content"))
                        || has_generated_value(delta.get("refusal"))
                        || has_generated_value(delta.get("function_call"))
                        || has_generated_value(delta.get("tool_calls"))
                    {
                        self.saw_meaningful_output = true;
                    }
                    if delta.get("tool_calls").is_some() || delta.get("function_call").is_some() {
                        self.saw_function_call = true;
                    }
                }
            }
        }
        if let Some(item) = event.get("item") {
            if item.get("type").and_then(Value::as_str) == Some("function_call") {
                self.function_call_count = self.function_call_count.saturating_add(1);
                self.saw_function_call = true;
                self.saw_meaningful_output = true;
                if value_string(item.get("name"))
                    .is_some_and(|name| name.to_ascii_lowercase().starts_with("functions."))
                {
                    self.hidden_function_call_count =
                        self.hidden_function_call_count.saturating_add(1);
                }
            }
        }
        if event_type.contains("function_call") && event_type.ends_with(".delta") {
            self.saw_function_call = true;
            self.saw_meaningful_output |= has_generated_value(event.get("delta"));
        }
    }

    fn inspect_custom_tool_call(&mut self, event: &Value, event_type: &str) {
        let item = event.get("item").unwrap_or(&Value::Null);
        let item_type = value_string(item.get("type")).unwrap_or_default();
        if item_type != "custom_tool_call" && !event_type.starts_with("response.custom_tool_call_")
        {
            return;
        }
        let item_id = value_string(event.get("item_id")).or_else(|| value_string(item.get("id")));
        let call_id =
            value_string(event.get("call_id")).or_else(|| value_string(item.get("call_id")));
        let key = item_id
            .clone()
            .or(call_id.clone())
            .unwrap_or_else(|| format!("anonymous-{}", self.custom_tool_calls.len() + 1));
        let index = self
            .custom_tool_calls
            .iter()
            .position(|entry| entry.key == key);
        let Some(index) = index.or_else(|| {
            if self.custom_tool_calls.len() >= 8 {
                return None;
            }
            self.custom_tool_calls.push(NativeCustomToolCall {
                item_id_present: item_id.is_some(),
                call_id_present: call_id.is_some(),
                name: value_string(event.get("name")).or_else(|| value_string(item.get("name"))),
                status: value_string(item.get("status")),
                key,
                ..Default::default()
            });
            Some(self.custom_tool_calls.len() - 1)
        }) else {
            return;
        };
        let entry = &mut self.custom_tool_calls[index];
        if event_type == "response.output_item.added" {
            entry.saw_output_item_added = true;
        }
        if event_type == "response.output_item.done" {
            entry.saw_output_item_done = true;
        }
        if event_type == "response.custom_tool_call_input.delta" {
            entry.input_delta_count = entry.input_delta_count.saturating_add(1);
            entry.input_bytes = entry.input_bytes.saturating_add(
                value_string(event.get("delta"))
                    .map(|value| value.len() as u64)
                    .unwrap_or(0),
            );
        }
        if event_type == "response.custom_tool_call_input.done" {
            entry.saw_input_done = true;
        }
    }

    fn as_value(&self) -> Value {
        let mut event_types = Map::new();
        for (key, value) in &self.event_types {
            event_types.insert(key.clone(), Value::Number((*value).into()));
        }
        let custom_tool_calls = self
            .custom_tool_calls
            .iter()
            .map(|entry| {
                json!({
                    "itemIdPresent": entry.item_id_present,
                    "callIdPresent": entry.call_id_present,
                    "name": entry.name,
                    "status": entry.status,
                    "inputDeltaCount": entry.input_delta_count,
                    "inputBytes": entry.input_bytes,
                    "sawInputDone": entry.saw_input_done,
                    "sawOutputItemAdded": entry.saw_output_item_added,
                    "sawOutputItemDone": entry.saw_output_item_done,
                })
            })
            .collect::<Vec<_>>();
        json!({
            "eventCount": self.event_count,
            "eventTypes": event_types,
            "customToolCalls": custom_tool_calls,
            "invalidDataPayloadCount": self.invalid_data_payload_count,
            "outputTextDeltaCount": self.output_text_delta_count,
            "outputTextDoneCount": self.output_text_done_count,
            "reasoningEventCount": self.reasoning_event_count,
            "refusalEventCount": self.refusal_event_count,
            "functionCallCount": self.function_call_count,
            "hiddenFunctionCallCount": self.hidden_function_call_count,
            "sanitizerDroppedEventCount": self.sanitizer_dropped_event_count,
            "sanitizerDroppedTextEventCount": self.sanitizer_dropped_text_event_count,
            "terminalEventType": self.terminal_event_type,
            "sawResponseCompleted": self.saw_response_completed,
            "sawChatCompletionChunk": self.saw_chat_completion_chunk,
        })
    }

    fn assistant_empty_output(&self) -> bool {
        !self.saw_meaningful_output
    }
}

struct SseTraceObserver {
    buffer: String,
    diagnostics: NativeStreamDiagnostics,
}

impl SseTraceObserver {
    fn new() -> Self {
        Self {
            buffer: String::new(),
            diagnostics: NativeStreamDiagnostics::default(),
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.buffer.push_str(&String::from_utf8_lossy(bytes));
        while let Some(index) = self.buffer.find("\n\n") {
            let frame = self.buffer[..index].to_owned();
            self.buffer.drain(..index + 2);
            self.diagnostics.inspect_frame(&frame);
        }
    }

    fn finish(mut self) -> NativeStreamDiagnostics {
        if !self.buffer.trim().is_empty() {
            self.diagnostics.inspect_frame(&self.buffer);
        }
        self.diagnostics
    }
}

fn has_generated_value(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(values)) => values.iter().any(|value| has_generated_value(Some(value))),
        Some(Value::Object(values)) => values
            .values()
            .any(|value| has_generated_value(Some(value))),
        _ => false,
    }
}

fn response_has_function_call(response: &Value) -> bool {
    response
        .get("output")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .any(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
        })
}

fn response_has_assistant_text(response: &Value) -> bool {
    response
        .get("output")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("type").and_then(Value::as_str) == Some("message")
                    && item.get("role").and_then(Value::as_str) == Some("assistant")
                    && item
                        .get("content")
                        .and_then(Value::as_array)
                        .is_some_and(|parts| {
                            parts.iter().any(|part| {
                                (part.get("type").and_then(Value::as_str) == Some("output_text")
                                    || part.get("type").and_then(Value::as_str) == Some("refusal"))
                                    && value_string(
                                        part.get("text").or_else(|| part.get("refusal")),
                                    )
                                    .is_some_and(|text| !text.is_empty())
                            })
                        })
            })
        })
}

fn response_has_assistant_output(response: &Value) -> bool {
    response_has_function_call(response) || response_has_assistant_text(response)
}

fn trace_number(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64).or_else(|| {
        value
            .and_then(Value::as_i64)
            .and_then(|value| u64::try_from(value).ok())
    })
}

fn normalized_trace_usage(usage: &Value) -> (Option<u64>, u64, u64, u64, u64, u64) {
    let input = trace_number(
        usage
            .get("input_tokens")
            .or_else(|| usage.get("prompt_tokens")),
    );
    let output = trace_number(
        usage
            .get("output_tokens")
            .or_else(|| usage.get("completion_tokens")),
    )
    .unwrap_or(0);
    let total = trace_number(usage.get("total_tokens"))
        .unwrap_or_else(|| input.unwrap_or(0).saturating_add(output));
    let cached = trace_number(
        usage
            .get("input_tokens_details")
            .and_then(|value| value.get("cached_tokens")),
    )
    .or_else(|| {
        trace_number(
            usage
                .get("prompt_tokens_details")
                .and_then(|value| value.get("cached_tokens")),
        )
    })
    .or_else(|| trace_number(usage.get("cached_input_tokens")))
    .or_else(|| trace_number(usage.get("input_cached_tokens")))
    .or_else(|| trace_number(usage.get("cached_tokens")))
    .unwrap_or(0);
    let cache_write = trace_number(
        usage
            .get("input_tokens_details")
            .and_then(|value| value.get("cache_write_tokens")),
    )
    .or_else(|| {
        trace_number(
            usage
                .get("prompt_tokens_details")
                .and_then(|value| value.get("cache_write_tokens")),
        )
    })
    .or_else(|| trace_number(usage.get("cache_write_tokens")))
    .unwrap_or(0);
    let reasoning = trace_number(
        usage
            .get("output_tokens_details")
            .and_then(|value| value.get("reasoning_tokens")),
    )
    .or_else(|| {
        trace_number(
            usage
                .get("completion_tokens_details")
                .and_then(|value| value.get("reasoning_tokens")),
        )
    })
    .or_else(|| trace_number(usage.get("reasoning_tokens")))
    .unwrap_or(0);
    (input, cached, cache_write, output, reasoning, total)
}

fn trace_pricing(model: Option<&str>, input: u64) -> Option<(f64, f64, f64, f64)> {
    let model = model?.trim();
    if model.is_empty() || model == "gpt-5.3-codex-spark" || model == "codex-auto-review" {
        return None;
    }
    let mut pricing = if model.starts_with("gpt-5.6-sol") || model == "gpt-5.6" {
        (5.0, 0.5, 6.25, 30.0)
    } else if model.starts_with("gpt-5.6-terra") {
        (2.0, 0.2, 2.5, 12.0)
    } else if model.starts_with("gpt-5.6-luna") {
        (0.2, 0.02, 0.25, 1.2)
    } else if model.starts_with("gpt-5.4-mini") {
        (0.75, 0.075, 0.75, 4.5)
    } else if model.starts_with("gpt-5.4") {
        if input > 272_000 {
            (5.0, 0.5, 5.0, 22.5)
        } else {
            (2.5, 0.25, 2.5, 15.0)
        }
    } else if model.starts_with("gpt-5.5") {
        if input > 272_000 {
            (10.0, 1.0, 10.0, 45.0)
        } else {
            (5.0, 0.5, 5.0, 30.0)
        }
    } else if model.starts_with("gpt-5.3-codex") || model.starts_with("gpt-5.2-codex") {
        (1.75, 0.175, 1.75, 14.0)
    } else if model.starts_with("gpt-5.1-codex-mini") {
        (0.25, 0.25, 0.25, 2.0)
    } else if model.starts_with("gpt-5.1-codex") || model.starts_with("gpt-5-codex") {
        (1.25, 1.25, 1.25, 10.0)
    } else if model.starts_with("gpt-5") {
        (5.0, 5.0, 5.0, 15.0)
    } else if model.starts_with("gpt-4o-mini") {
        (0.15, 0.15, 0.15, 0.6)
    } else if model.starts_with("gpt-4.1-mini") {
        (0.3, 0.3, 0.3, 1.2)
    } else if model.starts_with("gpt-4.1-nano") {
        (0.1, 0.1, 0.1, 0.4)
    } else if model.starts_with("gpt-4o") || model.starts_with("gpt-4.1") {
        (5.0, 5.0, 5.0, 15.0)
    } else if model.starts_with("codex-mini-latest") {
        (1.5, 1.5, 1.5, 6.0)
    } else if model.starts_with("daybreak-blue") || model.starts_with("gpt-daybreak-blue") {
        (4.0, 0.4, 5.0, 20.0)
    } else if model.starts_with("deepseek-v4-flash") || model.starts_with("deepseek-chat") {
        (0.14, 0.14, 0.14, 0.28)
    } else if model.starts_with("deepseek-v4-pro") {
        (0.435, 0.435, 0.435, 0.87)
    } else if model.starts_with("deepseek-reasoner") {
        (0.14, 0.14, 0.14, 0.28)
    } else {
        return None;
    };
    if pricing.1 == pricing.0 && pricing.2 == pricing.0 {
        pricing.1 = pricing.0;
        pricing.2 = pricing.0;
    }
    Some(pricing)
}

fn trace_cost(
    model: Option<&str>,
    input: u64,
    cached: u64,
    cache_write: u64,
    output: u64,
) -> Option<f64> {
    let (input_rate, cached_rate, cache_write_rate, output_rate) = trace_pricing(model, input)?;
    let cached = cached.min(input);
    let cache_write = cache_write.min(input.saturating_sub(cached));
    let uncached = input.saturating_sub(cached).saturating_sub(cache_write);
    Some(
        (uncached as f64 / 1_000_000.0) * input_rate
            + (cached as f64 / 1_000_000.0) * cached_rate
            + (cache_write as f64 / 1_000_000.0) * cache_write_rate
            + (output as f64 / 1_000_000.0) * output_rate,
    )
}

fn usage_from_payload(value: &Value) -> Option<Value> {
    value.get("usage").cloned().or_else(|| {
        value
            .get("response")
            .and_then(|response| response.get("usage"))
            .cloned()
    })
}

fn chat_has_assistant_output(value: &Value) -> bool {
    let Some(choice) = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
    else {
        return false;
    };
    let message = choice.get("message").unwrap_or(&Value::Null);
    let has_text = match message.get("content") {
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Array(parts)) => parts
            .iter()
            .any(|part| value_string(part.get("text")).is_some_and(|text| !text.trim().is_empty())),
        _ => false,
    };
    let has_tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|calls| !calls.is_empty());
    has_text || has_tool_calls
}

fn assistant_payload_diagnostics(value: &Value) -> (Option<bool>, Option<String>) {
    match value.get("object").and_then(Value::as_str) {
        Some("chat.completion") => {
            let choice = value
                .get("choices")
                .and_then(Value::as_array)
                .and_then(|choices| choices.first());
            (
                Some(!chat_has_assistant_output(value)),
                choice.and_then(|choice| value_string(choice.get("finish_reason"))),
            )
        }
        Some("response") => (
            Some(!response_has_assistant_output(value)),
            value_string(value.get("status")).or_else(|| value_string(value.get("stop_reason"))),
        ),
        _ => (None, None),
    }
}

fn buffered_trace_outcome(
    reply: &BufferedReply,
    content_type: &str,
    upstream_empty_body: bool,
) -> TraceOutcome {
    let text = String::from_utf8_lossy(&reply.body).to_string();
    let is_sse = content_type
        .to_ascii_lowercase()
        .contains("text/event-stream")
        || text.contains("data:");
    let mut observer = if is_sse {
        Some(SseTraceObserver::new())
    } else {
        None
    };
    if let Some(observer) = observer.as_mut() {
        observer.push(&reply.body);
    }
    let parsed = if is_sse {
        None
    } else {
        serde_json::from_slice::<Value>(&reply.body).ok()
    };
    let payload = parsed.unwrap_or_else(|| {
        if text.contains("chat.completion.chunk") {
            chat_from_sse(&text, "unknown")
        } else {
            response_from_sse(&text, "unknown")
        }
    });
    let (assistant_empty_output, assistant_finish_reason) = assistant_payload_diagnostics(&payload);
    let diagnostics = observer.map(|observer| observer.finish());
    let usage = usage_from_payload(&payload)
        .or_else(|| diagnostics.as_ref().and_then(|value| value.usage.clone()));
    TraceOutcome {
        status: reply.status.as_u16(),
        completed_at: now_ms(),
        lifecycle_state: "completed",
        usage,
        error: (reply.status.as_u16() >= 400).then(|| trace_string(&text, 500)),
        upstream_error: (reply.status.as_u16() >= 400).then(|| trace_string(&text, 500)),
        upstream_content_type: (!content_type.trim().is_empty()).then(|| content_type.to_owned()),
        upstream_empty_body: Some(upstream_empty_body),
        ttft_ms: None,
        response_stream_diagnostics: diagnostics.map(|value| value.as_value()),
        assistant_empty_output,
        assistant_finish_reason,
        client_disconnected: Some(false),
    }
}

fn opaque_trace_outcome(
    reply: &BufferedReply,
    content_type: &str,
    upstream_empty_body: bool,
) -> TraceOutcome {
    let error = (reply.status.as_u16() >= 400)
        .then(|| trace_string(&String::from_utf8_lossy(&reply.body), 500));
    TraceOutcome {
        status: reply.status.as_u16(),
        completed_at: now_ms(),
        lifecycle_state: "completed",
        usage: None,
        error: error.clone(),
        upstream_error: error,
        upstream_content_type: (!content_type.trim().is_empty()).then(|| content_type.to_owned()),
        upstream_empty_body: Some(upstream_empty_body),
        ttft_ms: None,
        response_stream_diagnostics: None,
        assistant_empty_output: None,
        assistant_finish_reason: None,
        client_disconnected: Some(false),
    }
}

fn transport_trace_outcome(status: StatusCode, error: String) -> TraceOutcome {
    TraceOutcome {
        status: status.as_u16(),
        completed_at: now_ms(),
        lifecycle_state: "completed",
        usage: None,
        error: Some(error.clone()),
        upstream_error: Some(error),
        upstream_content_type: None,
        upstream_empty_body: Some(true),
        ttft_ms: None,
        response_stream_diagnostics: None,
        assistant_empty_output: None,
        assistant_finish_reason: None,
        client_disconnected: Some(false),
    }
}

fn trace_string(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

struct TraceSink {
    path: Option<PathBuf>,
    lock: Mutex<()>,
}

impl TraceSink {
    async fn record(&self, context: &TraceContext, outcome: TraceOutcome) {
        let Some(path) = self.path.as_ref() else {
            return;
        };
        let _guard = self.lock.lock().await;
        let mut entry = json!({
            "id": context.id,
            "at": outcome.completed_at,
            "route": context.route,
            "clientRequestId": context.client_request_id,
            "traceKind": context.trace_kind,
            "upstreamAttempt": context.upstream_attempt,
            "providerAttempts": context.provider_attempts,
            "recoveredRetry": context.recovered_retry,
            "application": context.application,
            "status": outcome.status,
            "isError": outcome.status >= 400,
            "stream": context.stream,
            "latencyMs": outcome.completed_at.saturating_sub(context.started_at),
            "lifecycleState": outcome.lifecycle_state,
            "startedAt": context.started_at,
            "completedAt": outcome.completed_at,
            "usageStatus": if outcome.usage.is_some() { "measured" } else { "missing" },
        });
        if let Some(model) = context
            .model
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            entry["model"] = Value::String(model.to_owned());
        }
        if let Some(model) = context
            .requested_model
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            entry["requestedModel"] = Value::String(model.to_owned());
        }
        if let Some(model) = context
            .resolved_model
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            entry["resolvedModel"] = Value::String(model.to_owned());
        }
        if let Some(value) = context.account_id.as_deref() {
            entry["accountId"] = Value::String(value.to_owned());
        }
        if let Some(value) = context.account_email.as_deref() {
            entry["accountEmail"] = Value::String(value.to_owned());
        }
        if let Some(value) = context.provider.as_deref() {
            entry["provider"] = Value::String(value.to_owned());
        }
        if let Some(value) = context.codex_session_id.as_deref() {
            entry["codexSessionId"] = Value::String(value.to_owned());
        }
        if let Some(value) = context.project_root.as_deref() {
            entry["projectRoot"] = Value::String(value.to_owned());
        }
        if let Some(value) = context.project_host.as_deref() {
            entry["projectHost"] = Value::String(value.to_owned());
        }
        if let Some(value) = context.priority.as_deref() {
            entry["priority"] = Value::String(value.to_owned());
        }
        if let Some(value) = context.routing_decision.as_deref() {
            entry["routingDecision"] = Value::String(value.to_owned());
        }
        if let Some(value) = context.execution_location.as_deref() {
            entry["executionLocation"] = Value::String(value.to_owned());
        }
        if let Some(value) = context.capacity_version {
            entry["capacityVersion"] = Value::Number(value.into());
        }
        if let Some(value) = context.admission_wait_ms {
            entry["admissionWaitMs"] = Value::Number(value.into());
        }
        if let Some(value) = context.latency_breakdown.as_ref() {
            entry["latencyBreakdown"] = value.clone();
        }
        if let Some(value) = context.account_selection.as_ref() {
            entry["accountSelection"] = value.clone();
        }
        if let Some(value) = context.input_context.as_ref() {
            entry["inputContext"] = value.clone();
        }
        if context.provider_attempts > 0 {
            entry["providerAttempts"] = Value::Number((context.provider_attempts as u64).into());
        }
        if let Some(usage) = outcome.usage.as_ref() {
            let (input, cached, cache_write, output, reasoning, total) =
                normalized_trace_usage(usage);
            if let Some(value) = input {
                entry["tokensInput"] = value.into();
            }
            entry["tokensInputCached"] = cached.into();
            entry["tokensInputCacheWrite"] = cache_write.into();
            entry["tokensOutput"] = output.into();
            entry["tokensReasoning"] = reasoning.into();
            entry["tokensTotal"] = total.into();
            let cost = trace_cost(
                context.model.as_deref(),
                input.unwrap_or(0),
                cached,
                cache_write,
                output,
            );
            if let Some(cost) = cost.and_then(serde_json::Number::from_f64) {
                entry["costUsd"] = Value::Number(cost);
                entry["pricingVersion"] = Value::String(TRACE_PRICING_VERSION.to_owned());
                entry["costStatus"] = Value::String("estimated".to_owned());
            } else {
                entry["costStatus"] = Value::String(
                    if context.model.is_some() {
                        "unpriced"
                    } else {
                        "unknown"
                    }
                    .to_owned(),
                );
            }
            entry["usage"] = usage.clone();
        } else {
            entry["costStatus"] = Value::String("unknown".to_owned());
        }
        if let Some(value) = outcome.error.as_deref() {
            entry["error"] = Value::String(trace_string(value, 500));
        }
        if let Some(value) = outcome.upstream_error.as_deref() {
            entry["upstreamError"] = Value::String(trace_string(value, 500));
        }
        if let Some(value) = outcome.upstream_content_type.as_deref() {
            entry["upstreamContentType"] = Value::String(value.to_owned());
        }
        if let Some(value) = outcome.upstream_empty_body {
            entry["upstreamEmptyBody"] = Value::Bool(value);
        }
        if let Some(value) = outcome.ttft_ms {
            entry["ttftMs"] = Value::Number(value.into());
        }
        if let Some(value) = outcome.response_stream_diagnostics {
            entry["responseStreamDiagnostics"] = value;
        }
        if let Some(value) = outcome.assistant_empty_output {
            entry["assistantEmptyOutput"] = Value::Bool(value);
        }
        if let Some(value) = outcome.assistant_finish_reason {
            entry["assistantFinishReason"] = Value::String(value);
        }
        if let Some(value) = outcome.client_disconnected {
            entry["clientDisconnected"] = Value::Bool(value);
        }
        if let Some(value) = context.request_body.as_ref() {
            entry["requestBody"] = value.clone();
        }
        if let Some(value) = context.request_headers.as_ref() {
            entry["requestHeaders"] = value.clone();
        }
        if let Ok(line) = serde_json::to_vec(&entry) {
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent).await;
            }
            if let Ok(mut file) = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .await
            {
                use tokio::io::AsyncWriteExt;
                let _ = file.write_all(&line).await;
                let _ = file.write_all(b"\n").await;
            }
        }
    }
}

struct StreamingTrace {
    sink: Arc<TraceSink>,
    context: TraceContext,
    client_context: TraceContext,
    observer: SseTraceObserver,
    upstream_content_type: Option<String>,
    saw_bytes: bool,
    ttft_ms: Option<u64>,
    status: u16,
    finished: bool,
}

impl StreamingTrace {
    fn new(
        sink: Arc<TraceSink>,
        context: TraceContext,
        client_context: TraceContext,
        upstream_content_type: Option<String>,
        status: StatusCode,
    ) -> Self {
        Self {
            sink,
            context,
            client_context,
            observer: SseTraceObserver::new(),
            upstream_content_type,
            saw_bytes: false,
            ttft_ms: None,
            status: status.as_u16(),
            finished: false,
        }
    }

    fn observe(&mut self, bytes: &[u8]) {
        self.saw_bytes |= !bytes.is_empty();
        self.observer.push(bytes);
        if self.ttft_ms.is_none() && self.observer.diagnostics.saw_meaningful_output {
            self.ttft_ms = Some(now_ms().saturating_sub(self.context.started_at));
        }
    }

    fn outcome(
        &self,
        status: u16,
        completed_at: u64,
        lifecycle_state: &'static str,
        error: Option<String>,
        client_disconnected: Option<bool>,
    ) -> TraceOutcome {
        let diagnostics = self.observer.diagnostics.clone();
        TraceOutcome {
            status,
            completed_at,
            lifecycle_state,
            usage: diagnostics.usage.clone(),
            error: error.clone(),
            upstream_error: error,
            upstream_content_type: self.upstream_content_type.clone(),
            upstream_empty_body: Some(!self.saw_bytes),
            ttft_ms: self.ttft_ms,
            response_stream_diagnostics: Some(diagnostics.as_value()),
            assistant_empty_output: Some(diagnostics.assistant_empty_output()),
            assistant_finish_reason: diagnostics.finish_reason.clone(),
            client_disconnected,
        }
    }

    async fn finish(
        &mut self,
        status: u16,
        error: Option<String>,
        client_disconnected: Option<bool>,
    ) {
        if self.finished {
            return;
        }
        self.finished = true;
        let completed_at = now_ms();
        let client_error = error.clone();
        let outcome = self.outcome(
            status,
            completed_at,
            if error.is_some() {
                "interrupted"
            } else {
                "completed"
            },
            error,
            client_disconnected,
        );
        self.sink.record(&self.context, outcome).await;
        self.sink
            .record(
                &self.client_context,
                client_trace_outcome(
                    if client_disconnected == Some(true) {
                        499
                    } else {
                        status
                    },
                    completed_at,
                    client_error,
                    client_disconnected,
                ),
            )
            .await;
    }
}

impl Drop for StreamingTrace {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let Some(handle) = tokio::runtime::Handle::try_current().ok() else {
            return;
        };
        let sink = self.sink.clone();
        let context = self.context.clone();
        let client_context = self.client_context.clone();
        let completed_at = now_ms();
        if self.observer.diagnostics.saw_response_completed {
            let outcome = self.outcome(
                self.status,
                completed_at,
                "completed",
                None,
                Some(true),
            );
            let status = self.status;
            handle.spawn(async move {
                sink.record(&context, outcome).await;
                sink.record(
                    &client_context,
                    client_trace_outcome(status, completed_at, None, Some(true)),
                )
                .await;
            });
            return;
        }
        let error = "client disconnected before the upstream stream completed".to_owned();
        let outcome = self.outcome(
            499,
            completed_at,
            "interrupted",
            Some(error.clone()),
            Some(true),
        );
        handle.spawn(async move {
            sink.record(&context, outcome).await;
            sink.record(
                &client_context,
                client_trace_outcome(499, completed_at, Some(error), Some(true)),
            )
            .await;
        });
    }
}

#[derive(Clone)]
pub struct EdgeState {
    pub config: Arc<EdgeConfig>,
    pub store: AccountStore,
    pub client: reqwest::Client,
    control_plane_client: reqwest::Client,
    webhook_client: reqwest::Client,
    blocked: Arc<Mutex<HashMap<String, u64>>>,
    selected: Arc<Mutex<HashMap<String, String>>>,
    confidential: Option<confidential::ConfidentialClient>,
    idempotency: idempotency::Cache,
    model_catalog: Arc<Mutex<ModelCatalogCache>>,
    model_catalog_refresh: Arc<Mutex<()>>,
    session_affinity: Arc<Mutex<SessionAffinityCache>>,
    token_refresh: token_refresh::TokenRefreshManager,
    pub jobs: Arc<JobManager>,
    trace: Arc<TraceSink>,
    capacity_version: Arc<AtomicU64>,
    admission: Arc<AdmissionController>,
    drain: DrainController,
    job_runner_started: Arc<AtomicBool>,
    dashboard: Arc<dashboard::DashboardState>,
}

impl EdgeState {
    pub async fn new(config: EdgeConfig) -> Result<Self, String> {
        if !matches!(
            config.cloud_privacy_mode.as_str(),
            "standard" | "confidential_verified"
        ) {
            return Err(
                "MULTIVIBE_CLOUD_PRIVACY_MODE must be standard or confidential_verified".to_owned(),
            );
        }
        let confidential = config
            .confidential_inference_trust_policy
            .as_deref()
            .map(|policy| confidential::ConfidentialClient::new(policy, config.upstream_timeout))
            .transpose()
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
        if config.cloud_privacy_mode == "confidential_verified" && confidential.is_none() {
            return Err(
                "MULTIVIBE_CONFIDENTIAL_INFERENCE_TRUST_POLICY is required for confidential_verified mode"
                    .to_owned(),
            );
        }
        let client = reqwest::Client::builder()
            .redirect(Policy::limited(5))
            .build()
            .map_err(|error| format!("failed to create upstream HTTP client: {error}"))?;
        let control_plane_client = reqwest::Client::builder()
            .redirect(Policy::none())
            .build()
            .map_err(|error| format!("failed to create control-plane HTTP client: {error}"))?;
        // Also used for credential refresh/persistence: redirects must not
        // forward token bodies or the internal authentication header.
        let webhook_client = reqwest::Client::builder()
            .redirect(Policy::none())
            .build()
            .map_err(|error| format!("failed to create webhook HTTP client: {error}"))?;
        let session_affinity = SessionAffinityCache::new(
            config.session_affinity_ttl,
            config.session_affinity_max_entries,
        );
        let idempotency = idempotency::Cache::new(idempotency::Options {
            ttl: config.idempotency_ttl,
            in_flight_timeout: config.idempotency_in_flight_timeout,
            max_entries: config.idempotency_max_entries,
            max_bytes: config.idempotency_max_bytes,
            max_response_bytes: config.idempotency_max_response_bytes,
        });
        let capacity_version = Arc::new(AtomicU64::new(1));
        Ok(Self {
            store: AccountStore::new(config.store_path.clone()),
            jobs: Arc::new(
                JobManager::new_with_legacy(
                    config.jobs_path.clone(),
                    config.legacy_jobs_db_path.clone(),
                )
                .await?,
            ),
            trace: Arc::new(TraceSink {
                path: config.trace_path.clone(),
                lock: Mutex::new(()),
            }),
            config: Arc::new(config),
            client,
            control_plane_client,
            webhook_client,
            blocked: Arc::new(Mutex::new(HashMap::new())),
            selected: Arc::new(Mutex::new(HashMap::new())),
            confidential,
            idempotency,
            model_catalog: Arc::new(Mutex::new(ModelCatalogCache::default())),
            model_catalog_refresh: Arc::new(Mutex::new(())),
            session_affinity: Arc::new(Mutex::new(session_affinity)),
            token_refresh: token_refresh::TokenRefreshManager::default(),
            admission: Arc::new(AdmissionController::new(capacity_version.clone())),
            drain: DrainController::default(),
            capacity_version,
            job_runner_started: Arc::new(AtomicBool::new(false)),
            dashboard: Arc::new(dashboard::DashboardState::default()),
        })
    }

    pub fn start_job_runner(&self) -> Option<tokio::task::JoinHandle<()>> {
        if self
            .job_runner_started
            .compare_exchange(false, true, AtomicOrdering::AcqRel, AtomicOrdering::Acquire)
            .is_err()
        {
            return None;
        }
        let dispatcher = self.clone();
        let webhooks = self.clone();
        Some(tokio::spawn(async move {
            tokio::join!(
                job_dispatch_loop(dispatcher),
                webhook_delivery_loop(webhooks)
            );
        }))
    }

    async fn mark_blocked(&self, account: &Account, model: &str, duration: Duration) {
        self.blocked.lock().await.insert(
            format!("{}:{}", account.id, normalize_model_key(model)),
            now_ms() + duration.as_millis() as u64,
        );
    }
}

fn set_header(headers: &mut HeaderMap, name: &str, value: impl AsRef<str>) {
    if let (Ok(name), Ok(value)) = (
        HeaderName::try_from(name),
        HeaderValue::from_str(value.as_ref()),
    ) {
        headers.insert(name, value);
    }
}

fn request_session_id(headers: &HeaderMap) -> Option<String> {
    ["session_id", "session-id", "x-session-id", "x-session_id"]
        .iter()
        .find_map(|name| header_value(headers, name))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn valid_codex_session_id(value: String) -> Option<String> {
    let value = value.trim().to_owned();
    if value.is_empty() || value.len() > 200 {
        return None;
    }
    value
        .chars()
        .all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
        .then_some(value)
}

/// Return the stable Codex conversation/session identifier used for routing
/// affinity. `session_id` remains the provider conversation header; native
/// Codex clients commonly send `thread-id` or the forwarded session header
/// instead, so those must participate in affinity without being copied to an
/// upstream that does not understand them.
fn request_codex_session_id(headers: &HeaderMap) -> Option<String> {
    let direct = [
        "x-multivibe-codex-session-id",
        "thread-id",
        "session_id",
        "session-id",
        "x-session-id",
        "x-session_id",
    ]
    .iter()
    .find_map(|name| header_value(headers, name))
    .and_then(valid_codex_session_id);
    if direct.is_some() {
        return direct;
    }

    let metadata = header_value(headers, "x-codex-turn-metadata")?;
    let value = serde_json::from_str::<Value>(&metadata).ok()?;
    valid_codex_session_id(
        value
            .get("session_id")
            .or_else(|| value.get("thread_id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    )
}

fn trace_header_is_sensitive(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "authorization",
        "proxy-authorization",
        "api-key",
        "access-token",
        "refresh-token",
        "id-token",
        "token",
        "secret",
        "password",
        "credential",
        "cookie",
        "set-cookie",
        "session",
        "state",
        "nonce",
        "signature",
        "hmac",
        "attestation",
        "assertion",
        "proof",
    ]
    .iter()
    .any(|needle| {
        name == *needle
            || name.contains(&format!("-{needle}"))
            || name.contains(&format!("_{needle}"))
    })
}

fn sanitize_trace_headers(headers: &HeaderMap) -> Value {
    let mut values = HashMap::<String, String>::new();
    for (name, value) in headers {
        let name = name.as_str().to_ascii_lowercase();
        if name == "x-multivibe-trace-request-headers" {
            continue;
        }
        let Ok(value) = value.to_str() else { continue };
        let value = if trace_header_is_sensitive(&name) {
            "[REDACTED]".to_owned()
        } else {
            trace_string(value, 512)
        };
        values.insert(name, value);
    }
    let mut object = Map::new();
    let mut names = values.keys().cloned().collect::<Vec<_>>();
    names.sort();
    for name in names {
        if let Some(value) = values.remove(&name) {
            object.insert(name, Value::String(value));
        }
    }
    Value::Object(object)
}

fn trace_input_context(body: &Value) -> Option<Value> {
    let input = body.get("input").and_then(Value::as_array)?;
    let mut count = 0_u64;
    let mut latest = None;
    for (index, item) in input.iter().enumerate() {
        if item.get("type").and_then(Value::as_str) == Some("compaction") {
            count = count.saturating_add(1);
            latest = Some(index as u64);
        }
    }
    (count > 0).then(|| {
        json!({
            "compactionItemCount": count,
            "itemsBeforeLatestCompaction": latest.unwrap_or(0),
        })
    })
}

fn build_trace_context(
    state: &EdgeState,
    path: &str,
    headers: &HeaderMap,
    body: &Value,
    application: &str,
    client_request_id: &str,
    requested_model: &str,
    resolved_model: &str,
    account: Option<&Account>,
    stream: bool,
    started_at: u64,
    upstream_attempt: usize,
    provider_attempts: usize,
    trace_kind: &'static str,
) -> TraceContext {
    let confidential = state.config.cloud_privacy_mode == "confidential_verified"
        || header_value(headers, "x-multivibe-privacy").as_deref() == Some("confidential_verified")
        || account.is_some_and(account_is_confidential);
    let requested_model = (!requested_model.trim().is_empty()).then(|| requested_model.to_owned());
    let resolved_model = (!resolved_model.trim().is_empty()
        && resolved_model != requested_model.as_deref().unwrap_or_default())
    .then(|| resolved_model.to_owned());
    let model = Some(requested_model.clone().unwrap_or_else(|| {
        resolved_model
            .clone()
            .unwrap_or_else(|| "unknown".to_owned())
    }));
    TraceContext {
        id: Uuid::new_v4().to_string(),
        client_request_id: client_request_id.to_owned(),
        trace_kind,
        route: path.to_owned(),
        application: application.to_owned(),
        requested_model,
        resolved_model,
        model,
        account_id: account.map(|value| value.id.clone()),
        account_email: account.and_then(|value| value.email.clone()),
        provider: account.map(normalize_provider),
        stream,
        started_at,
        upstream_attempt,
        provider_attempts,
        recovered_retry: trace_kind == "client-request" && provider_attempts > 1,
        codex_session_id: request_codex_session_id(headers),
        project_root: header_value(headers, "x-multivibe-project-root"),
        project_host: header_value(headers, "x-multivibe-project-host"),
        priority: header_value(headers, "x-multivibe-priority"),
        routing_decision: account.map(|_| "cloud".to_owned()),
        execution_location: account.map(|value| {
            if value.location.as_deref() == Some("local") {
                "local".to_owned()
            } else {
                "cloud".to_owned()
            }
        }),
        capacity_version: Some(state.capacity_version.load(AtomicOrdering::Relaxed)),
        admission_wait_ms: Some(now_ms().saturating_sub(started_at)),
        latency_breakdown: None,
        account_selection: None,
        input_context: trace_input_context(body),
        request_body: (state.config.trace_include_body && !confidential).then(|| body.clone()),
        request_headers: state
            .config
            .trace_include_headers
            .then(|| sanitize_trace_headers(headers)),
    }
}

fn upstream_headers(
    account: &Account,
    incoming: &HeaderMap,
    url: &str,
    model: Option<&str>,
    config: &EdgeConfig,
) -> HeaderMap {
    let provider = normalize_provider(account);
    let mut headers = HeaderMap::new();
    set_header(&mut headers, "content-type", "application/json");
    set_header(&mut headers, "accept", "text/event-stream");
    let token = if provider == "ai-sdk" { config.internal_job_token.as_deref().unwrap_or("") }
        else { account_inference_token(account) };
    if !token.is_empty() && !is_local_runtime(account) {
        set_header(&mut headers, "authorization", format!("Bearer {token}"));
    }
    if provider == "openai" {
        set_header(&mut headers, "originator", "codex_cli_rs");
        set_header(
            &mut headers,
            "user-agent",
            format!("codex_cli_rs/{}", config.models_client_version),
        );
        set_header(&mut headers, "version", &config.models_client_version);
        set_header(&mut headers, "openai-beta", "responses=experimental");
        if let Some(account_id) = account.chatgpt_account_id.as_deref() {
            set_header(&mut headers, "chatgpt-account-id", account_id);
        }
    } else {
        set_header(&mut headers, "originator", "pi");
        set_header(&mut headers, "user-agent", "pi (multivibe rust edge)");
    }
    if provider == "xai" {
        set_header(&mut headers, "x-xai-token-auth", "xai-grok-cli");
        set_header(&mut headers, "x-grok-client-version", "0.2.114");
        set_header(&mut headers, "x-grok-client-identifier", "grok-pager");
        set_header(&mut headers, "user-agent", "grok-pager/0.2.114");
        if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
            set_header(&mut headers, "x-grok-model-override", model);
        }
        if let Some(session) = request_session_id(incoming) {
            set_header(&mut headers, "x-grok-conv-id", session);
        }
    }
    if provider == "opencode" {
        apply_opencode_headers(account, &mut headers);
    }
    if let Some(session) = request_session_id(incoming) {
        set_header(&mut headers, "session_id", session);
    }
    for name in [
        "openai-beta",
        "oai-client-version",
        "oai-device-id",
        "oai-language",
        "proof-token",
        "x-oai-attestation",
        "x-openai-attestation",
        "x-openai-browser-token",
        "x-openai-sentinel",
        "x-proof-token",
        "x-codex-turn-state",
        "x-multivibe-priority",
        "x-multivibe-execution",
    ] {
        if let Some(value) = header_value(incoming, name) {
            set_header(&mut headers, name, value);
        }
    }
    let _ = url;
    let _ = config;
    headers
}

fn filter_unsupported_tools(payload: &mut Value, provider: &str) {
    if provider != "openai-compatible" && provider != "opencode" {
        return;
    }
    let became_empty = payload
        .get_mut("tools")
        .and_then(Value::as_array_mut)
        .map(|tools| {
            tools.retain(|tool| tool.get("type").and_then(Value::as_str) == Some("function"));
            tools.is_empty()
        })
        .unwrap_or(false);
    if became_empty {
        if let Some(object) = payload.as_object_mut() {
            object.remove("tools");
            if matches!(
                object.get("tool_choice").and_then(Value::as_str),
                Some("auto" | "required")
            ) {
                object.remove("tool_choice");
            }
        }
    }
}

fn prepared_payload(
    body: &Value,
    path: &str,
    account: &Account,
    route: &RouteCandidate,
    session_id: Option<&str>,
    client_stream: bool,
    claude_code: bool,
    config: &EdgeConfig,
) -> Value {
    let chat_route = path.contains("chat/completions");
    let messages_route = path.ends_with("/messages");
    let compact = path.ends_with("/responses/compact");
    let sends_chat = resolve_upstream_mode(account, chat_route, compact);
    let mut payload = if sends_chat {
        if chat_route {
            let mut value = body.clone();
            if let Some(object) = value.as_object_mut() {
                object.insert("stream".to_owned(), Value::Bool(client_stream));
            }
            value
        } else {
            responses_to_chat_completions(body, client_stream)
        }
    } else if chat_route {
        chat_completions_to_responses(body, session_id)
    } else if messages_route {
        normalize_responses_payload(
            &anthropic_to_responses(body, claude_code, config),
            session_id,
        )
    } else {
        normalize_responses_payload(body, session_id)
    };
    if compact {
        if let Some(object) = payload.as_object_mut() {
            for key in [
                "store",
                "stream",
                "include",
                "tool_choice",
                "parallel_tool_calls",
            ] {
                object.remove(key);
            }
        }
    }
    if let Some(object) = payload.as_object_mut() {
        object.insert("model".to_owned(), Value::String(route.model.clone()));
    }
    filter_unsupported_tools(&mut payload, &normalize_provider(account));
    if sends_chat
        && (normalize_provider(account) == "openai-compatible"
            || normalize_provider(account) == "opencode")
    {
        payload = sanitize_generic_chat_payload(&payload);
    }
    payload
}

fn is_quota_error(status: StatusCode, body: &str) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS
        || body.to_ascii_lowercase().contains("quota")
        || body.to_ascii_lowercase().contains("rate limit")
        || body.to_ascii_lowercase().contains("usage limit")
        || body.to_ascii_lowercase().contains("capacity")
        || body.contains("1304")
        || body.contains("1305")
        || body.contains("1308")
        || body.contains("1309")
        || body.contains("1310")
        || body.contains("1312")
        || body.contains("1313")
}

fn should_retry_status(status: StatusCode, body: &str) -> bool {
    is_quota_error(status, body)
        || should_retry_same_account(status, body)
        || matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
}

fn should_retry_same_account(status: StatusCode, body: &str) -> bool {
    if is_quota_error(status, body) {
        return false;
    }
    matches!(
        status,
        StatusCode::INTERNAL_SERVER_ERROR
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
    ) || {
        let body = body.to_ascii_lowercase();
        body.contains("overloaded")
            || body.contains("service unavailable")
            || body.contains("service-unavailable")
            || body.contains("upstream connect")
            || body.contains("connection refused")
    }
}

fn retry_after_delay(headers: &HeaderMap) -> Option<Duration> {
    let raw = headers.get(header::RETRY_AFTER)?.to_str().ok()?.trim();
    if let Ok(seconds) = raw.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let retry_at = chrono::DateTime::parse_from_rfc2822(raw).ok()?;
    let remaining_ms = retry_at
        .timestamp_millis()
        .saturating_sub(chrono::Utc::now().timestamp_millis());
    Some(Duration::from_millis(remaining_ms.max(0) as u64))
}

fn upstream_retry_delay(headers: Option<&HeaderMap>, attempt: usize, base: Duration) -> Duration {
    let exponent = attempt.min(16) as u32;
    let backoff = base.checked_mul(1_u32 << exponent).unwrap_or(Duration::MAX);
    headers
        .and_then(retry_after_delay)
        .map(|retry_after| retry_after.max(backoff))
        .unwrap_or(backoff)
}

struct BufferedUpstreamError {
    status: StatusCode,
    headers: Vec<(String, String)>,
    content_type: String,
    body: Bytes,
}

enum UpstreamSendResult {
    Success(reqwest::Response),
    HttpError(BufferedUpstreamError),
}

#[derive(Debug)]
enum UpstreamSendError {
    Transport(String),
    Timeout,
}

async fn send_upstream_with_retry(
    state: &EdgeState,
    url: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<UpstreamSendResult, UpstreamSendError> {
    for retry in 0..=state.config.max_upstream_retries {
        let request = state
            .client
            .request(Method::POST, url)
            .headers(headers.clone())
            .body(body.to_vec());
        match timeout(state.config.upstream_timeout, request.send()).await {
            Ok(Ok(response)) if response.status().is_success() => {
                return Ok(UpstreamSendResult::Success(response));
            }
            Ok(Ok(response)) => {
                let status = response.status();
                let raw_headers = response.headers().clone();
                let headers = copy_public_headers(&raw_headers);
                let content_type = raw_headers
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_owned();
                let body = response.bytes().await.unwrap_or_default();
                let text = String::from_utf8_lossy(&body);
                if retry < state.config.max_upstream_retries
                    && should_retry_same_account(status, &text)
                {
                    tokio::time::sleep(upstream_retry_delay(
                        Some(&raw_headers),
                        retry,
                        state.config.upstream_retry_base_delay,
                    ))
                    .await;
                    continue;
                }
                return Ok(UpstreamSendResult::HttpError(BufferedUpstreamError {
                    status,
                    headers,
                    content_type,
                    body,
                }));
            }
            Ok(Err(error)) => {
                let message = error.to_string();
                if retry < state.config.max_upstream_retries
                    && !is_quota_error(StatusCode::BAD_GATEWAY, &message)
                {
                    tokio::time::sleep(upstream_retry_delay(
                        None,
                        retry,
                        state.config.upstream_retry_base_delay,
                    ))
                    .await;
                    continue;
                }
                return Err(UpstreamSendError::Transport(message));
            }
            Err(_) if retry < state.config.max_upstream_retries => {
                tokio::time::sleep(upstream_retry_delay(
                    None,
                    retry,
                    state.config.upstream_retry_base_delay,
                ))
                .await;
            }
            Err(_) => return Err(UpstreamSendError::Timeout),
        }
    }
    Err(UpstreamSendError::Timeout)
}

fn copy_public_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            let name = name.as_str().to_ascii_lowercase();
            if HOP_BY_HOP_HEADERS.contains(&name.as_str()) || name == "content-encoding" {
                return None;
            }
            Some((name, value.to_str().ok()?.to_owned()))
        })
        .collect()
}

fn response_from_buffer(reply: BufferedReply) -> Response {
    let mut builder = Response::builder().status(reply.status);
    for (name, value) in reply.headers {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(name), HeaderValue::from_str(&value)) {
            builder = builder.header(name, value);
        }
    }
    builder
        .body(Body::from(reply.body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn set_response_headers(
    mut builder: http::response::Builder,
    headers: &[(String, String)],
) -> http::response::Builder {
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (
            HeaderName::try_from(name.as_str()),
            HeaderValue::from_str(value),
        ) {
            builder = builder.header(name, value);
        }
    }
    builder
}

fn transform_for(
    path: &str,
    account: &Account,
    client_stream: bool,
    content_type: &str,
) -> StreamTransform {
    let client_chat = path.contains("chat/completions");
    let upstream_sse = content_type
        .to_ascii_lowercase()
        .contains("text/event-stream");
    // ChatGPT's Responses endpoint has returned a real SSE stream without a
    // Content-Type header. The chat-compatible route still needs conversion;
    // only the native Responses route can safely pass those bytes through.
    let headerless_openai_chat_stream =
        client_chat && normalize_provider(account) == "openai" && content_type.trim().is_empty();
    if !client_stream || (!upstream_sse && !headerless_openai_chat_stream) {
        return StreamTransform::None;
    }
    let messages = path.ends_with("/messages");
    let sends_chat =
        resolve_upstream_mode(account, client_chat, path.ends_with("/responses/compact"));
    if messages {
        return StreamTransform::ResponseToAnthropic;
    }
    if client_chat && !sends_chat {
        StreamTransform::ResponseToChat
    } else if !client_chat && sends_chat {
        StreamTransform::ChatToResponse
    } else {
        StreamTransform::None
    }
}

async fn proxy_inference(
    state: &EdgeState,
    path: &str,
    headers: &HeaderMap,
    body: &Value,
    application: &str,
    activity_kind: Option<ActivityKind>,
) -> Result<ProxyResult, Response> {
    let activity_lease = match activity_kind {
        Some(kind) => Some(state.drain.admit(kind).ok_or_else(draining_response)?),
        None => None,
    };
    let started_at = now_ms();
    let admission_started_at = Instant::now();
    let max_admission_wait = admission_wait(headers)?;
    let require_confidential = confidential_requested(&state.config, headers)?;
    if require_confidential && !confidential_path_supported(path) {
        return Err(privacy_error(
            StatusCode::CONFLICT,
            "confidential_surface_not_supported",
            "This request is not yet supported by verified confidential computing.",
        ));
    }
    let client_request_id = header_value(headers, "x-multivibe-trace-parent")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let store = state.store.snapshot().await.map_err(|error| {
        error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable")
    })?;
    let requested_model = value_string(body.get("model")).unwrap_or_default();
    let claude_code = is_claude_code_request(headers);
    let routing_model = claude_code_routing_model(&requested_model, claude_code);
    let default_model = state
        .config
        .proxy_models
        .first()
        .map(String::as_str)
        .unwrap_or("unknown");
    let catalog = exposed_models(state, &store, false).await;
    let routing_model = image_aware_routing_model(&store, &catalog, body, &routing_model);
    let routes = routes_for_model(&store, &routing_model, default_model, &catalog);
    let client_stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let session_id = request_session_id(headers);
    let codex_session_id = request_codex_session_id(headers);
    let prompt_cache_session_id = session_id.clone().or_else(|| codex_session_id.clone());
    let mut last_status = StatusCode::SERVICE_UNAVAILABLE;
    let mut last_error = "no eligible account configured".to_owned();
    let mut attempted = 0_usize;
    let mut had_account = false;
    let mut capacity_exhausted: bool;

    'admission: loop {
        capacity_exhausted = false;
        let mut saturated_accounts = Vec::new();
        for route in routes.clone() {
            if attempted >= state.config.max_account_retry_attempts {
                break;
            }
            let blocked = state.blocked.lock().await.clone();
            let selected = state.selected.lock().await.clone();
            let mut accounts = select_accounts(
                &store.accounts,
                &RouteCandidate {
                    requested_model: route.requested_model.clone(),
                    model: route.model.clone(),
                    provider: route.provider.clone(),
                    account_ids: route.account_ids.clone(),
                },
                &blocked,
                &selected,
            );
            if require_confidential {
                accounts.retain(account_is_confidential);
            }
            if accounts.is_empty() {
                continue;
            }
            let provider = route.provider.as_deref().unwrap_or_default();
            if state.config.session_affinity_enabled {
                if let Some(session_id) = codex_session_id.as_deref() {
                    let sticky_account_id = {
                        let mut affinity = state.session_affinity.lock().await;
                        affinity.get(application, session_id, provider, now_ms())
                    };
                    if let Some(sticky_account_id) = sticky_account_id {
                        if let Some(index) = accounts
                            .iter()
                            .position(|account| account.id == sticky_account_id)
                        {
                            let sticky_account = accounts.remove(index);
                            accounts.insert(0, sticky_account);
                        } else {
                            // The account may have become blocked, exceeded quota,
                            // or fallen outside an alias policy. Forget the stale
                            // mapping so the normal selector can fail over.
                            state.session_affinity.lock().await.forget(
                                application,
                                session_id,
                                provider,
                            );
                        }
                    }
                }
            }
            had_account = true;
            let eligible_account_count = accounts.len();
            while !accounts.is_empty() {
                if attempted >= state.config.max_account_retry_attempts {
                    break;
                }
                let Some((account_index, capacity_lease)) = state.admission.acquire_any(&accounts)
                else {
                    capacity_exhausted = true;
                    saturated_accounts.extend(accounts);
                    break;
                };
                let mut account = accounts.remove(account_index);
                attempted += 1;
                let provider = normalize_provider(&account);
                let mut trace_context = build_trace_context(
                    state,
                    path,
                    headers,
                    body,
                    application,
                    &client_request_id,
                    &requested_model,
                    &route.model,
                    Some(&account),
                    client_stream,
                    started_at,
                    attempted,
                    attempted,
                    "upstream-attempt",
                );
                let mut client_context = build_trace_context(
                    state,
                    path,
                    headers,
                    body,
                    application,
                    &client_request_id,
                    &requested_model,
                    &route.model,
                    None,
                    client_stream,
                    started_at,
                    0,
                    attempted,
                    "client-request",
                );
                if account_is_confidential(&account) {
                    trace_context.request_body = None;
                    client_context.request_body = None;
                }
                trace_context.account_selection = Some(json!({
                    "reason": "quota-headroom",
                    "provider": provider,
                    "candidateCount": eligible_account_count,
                    "eligibleCount": eligible_account_count,
                    "nearLimitCount": 0,
                    "rotated": attempted > 1,
                }));
                if state.config.session_affinity_enabled {
                    if let Some(session_id) = codex_session_id.as_deref() {
                        // Record the attempt before the upstream call. If this
                        // account fails and the loop rotates, the next attempt
                        // immediately replaces the mapping, matching Express.
                        state.session_affinity.lock().await.remember(
                            application,
                            session_id,
                            &provider,
                            &account.id,
                            now_ms(),
                        );
                    }
                }
                if token_refresh::TokenRefreshManager::needs_refresh(&account, now_ms()) {
                    match state
                        .token_refresh
                        .refresh(&state.webhook_client, &state.config, &state.store, &account, false)
                        .await
                    {
                        Ok(refreshed) => account = refreshed,
                        Err(error) => {
                            last_status = StatusCode::SERVICE_UNAVAILABLE;
                            last_error = error;
                            state
                                .trace
                                .record(
                                    &trace_context,
                                    TraceOutcome {
                                        status: last_status.as_u16(),
                                        completed_at: now_ms(),
                                        lifecycle_state: "completed",
                                        usage: None,
                                        error: Some(last_error.clone()),
                                        upstream_error: Some(last_error.clone()),
                                        upstream_content_type: None,
                                        upstream_empty_body: Some(true),
                                        ttft_ms: None,
                                        response_stream_diagnostics: None,
                                        assistant_empty_output: None,
                                        assistant_finish_reason: None,
                                        client_disconnected: Some(false),
                                    },
                                )
                                .await;
                            state
                                .mark_blocked(&account, &route.model, Duration::from_secs(60))
                                .await;
                            continue;
                        }
                    }
                }
                let sends_chat = resolve_upstream_mode(
                    &account,
                    path.contains("chat/completions"),
                    path.ends_with("/responses/compact"),
                );
                let (chat_body, chat_tools) = if sends_chat && path.ends_with("/responses") {
                    chat_tools::ChatTools::prepare(body).map_err(|message|
                        error_response(StatusCode::BAD_REQUEST, message, "unsupported_tool_contract"))?
                } else {
                    (body.clone(), chat_tools::ChatTools::default())
                };
                if sends_chat {
                    if let Err(message) = validate_chat_tool_contract(&chat_body) {
                        return Err(error_response(StatusCode::BAD_REQUEST, message, "unsupported_tool_contract"));
                    }
                }
                let mut payload = prepared_payload(
                    &chat_body,
                    path,
                    &account,
                    &route,
                    prompt_cache_session_id.as_deref(),
                    client_stream,
                    claude_code,
                    &state.config,
                );
                if provider == "openai" && account.chatgpt_account_id.is_some() {
                    default_chatgpt_reasoning_effort(&mut payload, sends_chat);
                }
                let url = upstream_url(
                    &account,
                    &state.config,
                    sends_chat,
                    path.ends_with("/responses/compact"),
                );
                let serialized = match serde_json::to_vec(&payload) {
                    Ok(value) => value,
                    Err(error) => {
                        return Err(error_response(
                            StatusCode::BAD_REQUEST,
                            error.to_string(),
                            "invalid_request_error",
                        ));
                    }
                };
                if account_is_confidential(&account) {
                    let confidential_started_at = now_ms();
                    let result = match state.confidential.as_ref() {
                        Some(client) => {
                            let upstream_path = if sends_chat {
                                "/v1/chat/completions"
                            } else {
                                "/v1/responses"
                            };
                            client
                                .execute(
                                    account.base_url.as_deref().unwrap_or_default(),
                                    &account.access_token,
                                    &route.model,
                                    upstream_path,
                                    &serialized,
                                )
                                .await
                        }
                        None => Err(confidential::ConfidentialError::not_sent(
                            "confidential_client_unavailable",
                            "Verified confidential computing is not configured. The message was not sent.",
                        )),
                    };
                    trace_context.latency_breakdown = Some(json!({
                        "preparationMs": confidential_started_at.saturating_sub(started_at),
                        "upstreamHeadersMs": now_ms().saturating_sub(confidential_started_at),
                    }));
                    let confidential_reply = match result {
                        Ok(reply) => reply,
                        Err(error) => {
                            let status = if error.disposition == "not_sent" {
                                StatusCode::SERVICE_UNAVAILABLE
                            } else {
                                StatusCode::BAD_GATEWAY
                            };
                            let completed_at = now_ms();
                            state
                                .trace
                                .record(
                                    &trace_context,
                                    TraceOutcome {
                                        status: status.as_u16(),
                                        completed_at,
                                        lifecycle_state: if error.disposition == "not_sent" {
                                            "completed"
                                        } else {
                                            "interrupted"
                                        },
                                        usage: None,
                                        error: Some(error.code.to_owned()),
                                        upstream_error: Some(error.code.to_owned()),
                                        upstream_content_type: None,
                                        upstream_empty_body: Some(true),
                                        ttft_ms: None,
                                        response_stream_diagnostics: None,
                                        assistant_empty_output: None,
                                        assistant_finish_reason: None,
                                        client_disconnected: Some(false),
                                    },
                                )
                                .await;
                            state
                                .trace
                                .record(
                                    &client_context,
                                    client_trace_outcome(
                                        status.as_u16(),
                                        completed_at,
                                        Some(error.code.to_owned()),
                                        Some(false),
                                    ),
                                )
                                .await;
                            return Err(confidential_error_response(&error));
                        }
                    };

                    let content_type = confidential_reply
                        .headers
                        .iter()
                        .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
                        .map(|(_, value)| value.clone())
                        .unwrap_or_default();
                    let upstream_empty_body = confidential_reply.body.is_empty();
                    let clear_body = Bytes::from(confidential_reply.body);
                    let reply = if confidential_reply.status.is_success() {
                        state
                            .selected
                            .lock()
                            .await
                            .insert(provider.clone(), account.id.clone());
                        render_buffered_success(
                            path,
                            &account,
                            client_stream,
                            &requested_model.clone().if_empty_then(default_model),
                            &content_type,
                            &clear_body,
                            confidential_reply.headers,
                            &chat_tools,
                        )
                    } else {
                        BufferedReply {
                            status: confidential_reply.status,
                            headers: confidential_reply.headers,
                            body: clear_body,
                        }
                    };
                    let outcome = if confidential_reply.status.is_success() {
                        buffered_trace_outcome(&reply, &content_type, upstream_empty_body)
                    } else {
                        transport_trace_outcome(
                            confidential_reply.status,
                            "confidential upstream returned an authenticated error".to_owned(),
                        )
                    };
                    let completed_at = outcome.completed_at;
                    let client_status = outcome.status;
                    let client_error = outcome.error.clone();
                    state.trace.record(&trace_context, outcome).await;
                    state
                        .trace
                        .record(
                            &client_context,
                            client_trace_outcome(
                                client_status,
                                completed_at,
                                client_error,
                                Some(false),
                            ),
                        )
                        .await;
                    return Ok(ProxyResult::Buffered(reply));
                }
                let upstream_started_at = now_ms();
                let mut retried_after_token_refresh = false;
                let response_result = loop {
                    let request_headers = upstream_headers(
                        &account,
                        headers,
                        &url,
                        Some(&route.model),
                        &state.config,
                    );
                    let result =
                        send_upstream_with_retry(state, &url, &request_headers, &serialized).await;
                    let unauthorized = matches!(
                        &result,
                        Ok(UpstreamSendResult::HttpError(error))
                            if error.status == StatusCode::UNAUTHORIZED
                    );
                    if unauthorized
                        && !retried_after_token_refresh
                        && token_refresh::TokenRefreshManager::can_refresh(&account)
                    {
                        match state
                            .token_refresh
                            .refresh(&state.webhook_client, &state.config, &state.store, &account, true)
                            .await
                        {
                            Ok(refreshed) if refreshed.access_token != account.access_token => {
                                account = refreshed;
                                retried_after_token_refresh = true;
                                continue;
                            }
                            _ => {}
                        }
                    }
                    break result;
                };
                let response = match response_result {
                    Ok(UpstreamSendResult::Success(response)) => response,
                    Ok(UpstreamSendResult::HttpError(error)) => {
                        trace_context.latency_breakdown = Some(json!({
                            "preparationMs": upstream_started_at.saturating_sub(started_at),
                            "upstreamHeadersMs": now_ms().saturating_sub(upstream_started_at),
                        }));
                        let BufferedUpstreamError {
                            status,
                            headers: response_headers,
                            content_type,
                            body: bytes,
                        } = error;
                        last_status = status;
                        let text = String::from_utf8_lossy(&bytes).to_string();
                        last_error = if text.is_empty() {
                            format!("upstream returned HTTP {status}")
                        } else {
                            text.chars().take(500).collect()
                        };
                        if should_retry_status(status, &text) {
                            state
                                .trace
                                .record(
                                    &trace_context,
                                    TraceOutcome {
                                        status: status.as_u16(),
                                        completed_at: now_ms(),
                                        lifecycle_state: "completed",
                                        usage: None,
                                        error: Some(last_error.clone()),
                                        upstream_error: Some(last_error.clone()),
                                        upstream_content_type: (!content_type.trim().is_empty())
                                            .then(|| content_type.clone()),
                                        upstream_empty_body: Some(bytes.is_empty()),
                                        ttft_ms: None,
                                        response_stream_diagnostics: None,
                                        assistant_empty_output: None,
                                        assistant_finish_reason: None,
                                        client_disconnected: Some(false),
                                    },
                                )
                                .await;
                            state
                                .mark_blocked(
                                    &account,
                                    &route.model,
                                    if is_quota_error(status, &text) {
                                        Duration::from_secs(60)
                                    } else {
                                        Duration::from_secs(5)
                                    },
                                )
                                .await;
                            continue;
                        }
                        let body = if path.ends_with("/messages") {
                            serde_json::to_vec(&anthropic_error_value(status, &text))
                                .unwrap_or_else(|_| b"{}".to_vec())
                        } else {
                            bytes.to_vec()
                        };
                        state
                            .trace
                            .record(
                                &trace_context,
                                TraceOutcome {
                                    status: status.as_u16(),
                                    completed_at: now_ms(),
                                    lifecycle_state: "completed",
                                    usage: None,
                                    error: Some(last_error.clone()),
                                    upstream_error: Some(last_error.clone()),
                                    upstream_content_type: (!content_type.trim().is_empty())
                                        .then(|| content_type.clone()),
                                    upstream_empty_body: Some(body.is_empty()),
                                    ttft_ms: None,
                                    response_stream_diagnostics: None,
                                    assistant_empty_output: None,
                                    assistant_finish_reason: None,
                                    client_disconnected: Some(false),
                                },
                            )
                            .await;
                        state
                            .trace
                            .record(
                                &client_context,
                                client_trace_outcome(
                                    status.as_u16(),
                                    now_ms(),
                                    Some(last_error.clone()),
                                    Some(false),
                                ),
                            )
                            .await;
                        return Ok(ProxyResult::Buffered(BufferedReply {
                            status,
                            headers: response_headers,
                            body: Bytes::from(body),
                        }));
                    }
                    Err(error) => {
                        trace_context.latency_breakdown = Some(json!({
                            "preparationMs": upstream_started_at.saturating_sub(started_at),
                            "upstreamHeadersMs": now_ms().saturating_sub(upstream_started_at),
                        }));
                        (last_status, last_error) = match error {
                            UpstreamSendError::Transport(message) => {
                                (StatusCode::BAD_GATEWAY, message)
                            }
                            UpstreamSendError::Timeout => (
                                StatusCode::GATEWAY_TIMEOUT,
                                "upstream request timed out".to_owned(),
                            ),
                        };
                        state
                            .trace
                            .record(
                                &trace_context,
                                TraceOutcome {
                                    status: last_status.as_u16(),
                                    completed_at: now_ms(),
                                    lifecycle_state: "completed",
                                    usage: None,
                                    error: Some(last_error.clone()),
                                    upstream_error: Some(last_error.clone()),
                                    upstream_content_type: None,
                                    upstream_empty_body: Some(true),
                                    ttft_ms: None,
                                    response_stream_diagnostics: None,
                                    assistant_empty_output: None,
                                    assistant_finish_reason: None,
                                    client_disconnected: Some(false),
                                },
                            )
                            .await;
                        state
                            .mark_blocked(&account, &route.model, Duration::from_secs(5))
                            .await;
                        continue;
                    }
                };
                trace_context.latency_breakdown = Some(json!({
                    "preparationMs": upstream_started_at.saturating_sub(started_at),
                    "upstreamHeadersMs": now_ms().saturating_sub(upstream_started_at),
                }));
                let status = response.status();
                let response_headers = copy_public_headers(response.headers());
                let content_type = response
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_owned();
                debug_assert!(status.is_success());
                state
                    .selected
                    .lock()
                    .await
                    .insert(provider.clone(), account.id.clone());
                let transform = transform_for(path, &account, client_stream, &content_type);
                let content_type_is_sse = content_type
                    .to_ascii_lowercase()
                    .contains("text/event-stream");
                // Preserve a real upstream stream even when no protocol
                // conversion is needed. ChatGPT and xAI have also returned SSE
                // for an explicit stream request without a Content-Type header;
                // their native edge path must not buffer those bytes into a
                // synthetic one-event response.
                let can_stream_without_content_type = client_stream
                    && content_type.trim().is_empty()
                    && matches!(provider.as_str(), "openai" | "xai");
                if transform != StreamTransform::None
                    || (client_stream && (content_type_is_sse || can_stream_without_content_type))
                {
                    let mut stream_headers = response_headers;
                    chat_tools.add_response_headers(&mut stream_headers);
                    if can_stream_without_content_type {
                        stream_headers.retain(|(name, _)| name != "content-type");
                        stream_headers
                            .push(("content-type".to_owned(), "text/event-stream".to_owned()));
                    }
                    let streaming_trace = StreamingTrace::new(
                        state.trace.clone(),
                        trace_context,
                        client_context,
                        (!content_type.trim().is_empty()).then(|| content_type.clone()),
                        response.status(),
                    );
                    return Ok(ProxyResult::Streaming(StreamingReply {
                        chat_tools,
                        status: response.status(),
                        headers: stream_headers,
                        upstream: response,
                        transform,
                        requested_model: requested_model.clone().if_empty_then(default_model),
                        trace: Some(streaming_trace),
                        capacity_lease,
                        activity_lease,
                    }));
                }
                let bytes = response.bytes().await.unwrap_or_default();
                let reply = render_buffered_success(
                    path,
                    &account,
                    client_stream,
                    &requested_model.clone().if_empty_then(default_model),
                    &content_type,
                    &bytes,
                    response_headers,
                    &chat_tools,
                );
                let outcome = buffered_trace_outcome(&reply, &content_type, bytes.is_empty());
                let completed_at = outcome.completed_at;
                let client_status = outcome.status;
                let client_error = outcome.error.clone();
                state.trace.record(&trace_context, outcome).await;
                state
                    .trace
                    .record(
                        &client_context,
                        client_trace_outcome(
                            client_status,
                            completed_at,
                            client_error,
                            Some(false),
                        ),
                    )
                    .await;
                return Ok(ProxyResult::Buffered(reply));
            }
        }
        if capacity_exhausted && attempted < state.config.max_account_retry_attempts {
            let remaining_wait = max_admission_wait.saturating_sub(admission_started_at.elapsed());
            if state
                .admission
                .wait_for_capacity(&saturated_accounts, remaining_wait)
                .await
            {
                continue 'admission;
            }
        }
        break;
    }
    let (status, final_error, error_code) = if capacity_exhausted {
        (
            StatusCode::TOO_MANY_REQUESTS,
            "No admissible capacity is currently available.".to_owned(),
            "capacity_unavailable",
        )
    } else if had_account {
        (last_status, last_error, "upstream_error")
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, last_error, "no_accounts")
    };
    let trace_model = requested_model.clone().if_empty_then(default_model);
    let no_account_context = build_trace_context(
        state,
        path,
        headers,
        body,
        application,
        &client_request_id,
        &requested_model,
        &trace_model,
        None,
        client_stream,
        started_at,
        0,
        attempted,
        "client-request",
    );
    state
        .trace
        .record(
            &no_account_context,
            client_trace_outcome(
                status.as_u16(),
                now_ms(),
                Some(final_error.clone()),
                Some(false),
            ),
        )
        .await;
    let mut response = error_response(status, final_error, error_code);
    if status == StatusCode::TOO_MANY_REQUESTS {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
    }
    Err(response)
}

trait EmptyStringFallback {
    fn if_empty_then<'a>(self, fallback: &'a str) -> String;
}

impl EmptyStringFallback for String {
    fn if_empty_then<'a>(self, fallback: &'a str) -> String {
        if self.trim().is_empty() {
            fallback.to_owned()
        } else {
            self
        }
    }
}

fn anthropic_error_value(status: StatusCode, message: &str) -> Value {
    let kind = if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        "authentication_error"
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        "rate_limit_error"
    } else if status == StatusCode::SERVICE_UNAVAILABLE || status.as_u16() == 529 {
        "overloaded_error"
    } else if status.is_client_error() {
        "invalid_request_error"
    } else {
        "api_error"
    };
    json!({"type": "error", "error": {"type": kind, "message": message}})
}

fn anthropic_stream_from_response(response: &Value, requested_model: &str) -> String {
    let message = responses_to_anthropic(response, requested_model);
    let mut output = String::new();
    output.push_str(&sse_frame(
        "message_start",
        &json!({"type": "message_start", "message": {
            "id": message.get("id"),
            "type": "message",
            "role": "assistant",
            "model": requested_model,
            "content": [],
            "stop_reason": Value::Null,
            "stop_sequence": Value::Null,
            "usage": {"input_tokens": message["usage"]["input_tokens"], "output_tokens": 0}
        }}),
    ));
    if let Some(content) = message.get("content").and_then(Value::as_array) {
        for (index, part) in content.iter().enumerate() {
            if part.get("type").and_then(Value::as_str) == Some("text") {
                output.push_str(&sse_frame(
                    "content_block_start",
                    &json!({"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}}),
                ));
                output.push_str(&sse_frame(
                    "content_block_delta",
                    &json!({"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": part.get("text")}}),
                ));
                output.push_str(&sse_frame(
                    "content_block_stop",
                    &json!({"type": "content_block_stop", "index": index}),
                ));
            } else if part.get("type").and_then(Value::as_str) == Some("tool_use") {
                output.push_str(&sse_frame(
                    "content_block_start",
                    &json!({"type": "content_block_start", "index": index, "content_block": {"type": "tool_use", "id": part.get("id"), "name": part.get("name"), "input": {}}}),
                ));
                output.push_str(&sse_frame(
                    "content_block_delta",
                    &json!({"type": "content_block_delta", "index": index, "delta": {"type": "input_json_delta", "partial_json": part.get("input").map(json_string).unwrap_or_else(|| "{}".to_owned())}}),
                ));
                output.push_str(&sse_frame(
                    "content_block_stop",
                    &json!({"type": "content_block_stop", "index": index}),
                ));
            }
        }
    }
    output.push_str(&sse_frame(
        "message_delta",
        &json!({"type": "message_delta", "delta": {"stop_reason": message.get("stop_reason"), "stop_sequence": Value::Null}, "usage": {"output_tokens": message["usage"]["output_tokens"]}}),
    ));
    output.push_str(&sse_frame("message_stop", &json!({"type": "message_stop"})));
    output
}

fn render_buffered_success(
    path: &str,
    _account: &Account,
    client_stream: bool,
    model: &str,
    content_type: &str,
    bytes: &Bytes,
    mut upstream_headers: Vec<(String, String)>,
    chat_tools: &chat_tools::ChatTools,
) -> BufferedReply {
    chat_tools.add_response_headers(&mut upstream_headers);
    let text = String::from_utf8_lossy(bytes).to_string();
    let is_sse = content_type
        .to_ascii_lowercase()
        .contains("text/event-stream")
        || text.contains("data:");
    let parsed = if is_sse {
        None
    } else {
        serde_json::from_slice::<Value>(bytes).ok()
    };
    let client_chat = path.contains("chat/completions");
    let messages = path.ends_with("/messages");
    let mut output = if client_chat {
        if let Some(value) = parsed.as_ref() {
            if value.get("object").and_then(Value::as_str) == Some("chat.completion") {
                sanitize_chat(value)
            } else if value.get("object").and_then(Value::as_str) == Some("response") {
                response_to_chat(value, model)
            } else {
                value.clone()
            }
        } else if is_sse && text.contains("chat.completion.chunk") {
            chat_from_sse(&text, model)
        } else if is_sse {
            response_to_chat(&response_from_sse(&text, model), model)
        } else {
            json!({"error": "upstream returned invalid JSON"})
        }
    } else if let Some(value) = parsed.as_ref() {
        if value.get("object").and_then(Value::as_str) == Some("response") {
            sanitize_response(value)
        } else if value.get("object").and_then(Value::as_str) == Some("chat.completion") {
            chat_to_response(value, model)
        } else {
            value.clone()
        }
    } else if is_sse && text.contains("chat.completion.chunk") {
        chat_to_response(&chat_from_sse(&text, model), model)
    } else if is_sse {
        response_from_sse(&text, model)
    } else {
        json!({"error": "upstream returned invalid JSON"})
    };

    if let Err(message) = chat_tools.restore_response(&mut output) {
        return BufferedReply {
            status: StatusCode::BAD_GATEWAY,
            headers: vec![("content-type".into(), "application/json".into())],
            body: Bytes::from(json!({"error": {"code": "invalid_tool_arguments", "message": message}}).to_string()),
        };
    }
    if messages {
        if parsed.is_none() && is_sse {
            output = response_from_sse(&text, model);
        }
        if client_stream {
            upstream_headers.retain(|(name, _)| name != "content-type");
            upstream_headers.push(("content-type".to_owned(), "text/event-stream".to_owned()));
            return BufferedReply {
                status: StatusCode::OK,
                headers: upstream_headers,
                body: Bytes::from(anthropic_stream_from_response(&output, model)),
            };
        }
        output = responses_to_anthropic(&output, model);
    } else if client_stream {
        upstream_headers.retain(|(name, _)| name != "content-type");
        upstream_headers.push(("content-type".to_owned(), "text/event-stream".to_owned()));
        if client_chat {
            output = sanitize_chat(&output);
            return BufferedReply {
                status: StatusCode::OK,
                headers: upstream_headers,
                body: Bytes::from(chat_completion_sse(&output)),
            };
        }
        return BufferedReply {
            status: StatusCode::OK,
            headers: upstream_headers,
            body: Bytes::from(response_completed_sse(&output)),
        };
    }
    upstream_headers.retain(|(name, _)| name != "content-type");
    upstream_headers.push(("content-type".to_owned(), "application/json".to_owned()));
    BufferedReply {
        status: StatusCode::OK,
        headers: upstream_headers,
        body: Bytes::from(serde_json::to_vec(&output).unwrap_or_else(|_| b"{}".to_vec())),
    }
}

#[derive(Default)]
struct ChatResponseStreamState {
    chat_tools: chat_tools::ChatTools,
    response_id: String,
    output_item_id: String,
    model: String,
    created: u64,
    content: String,
    created_sent: bool,
    content_started: bool,
    completed_sent: bool,
    tool_calls: Vec<Value>,
}

impl ChatResponseStreamState {
    fn new(model: &str) -> Self {
        Self {
            response_id: new_id("resp"),
            output_item_id: new_id("msg"),
            model: model.to_owned(),
            created: now_ms() / 1000,
            ..Default::default()
        }
    }

    fn created_frame(&mut self) -> String {
        if self.created_sent {
            return String::new();
        }
        self.created_sent = true;
        sse_frame(
            "response.created",
            &json!({"type": "response.created", "response": {"id": self.response_id, "object": "response", "created_at": self.created, "model": self.model, "status": "in_progress"}}),
        )
    }

    fn finish(&mut self) -> String {
        if self.completed_sent {
            return String::new();
        }
        self.completed_sent = true;
        let mut output = Vec::new();
        if !self.content.is_empty() {
            output.push(json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": self.content}]}));
        }
        for tool in &mut self.tool_calls {
            if let Err(message) = self.chat_tools.restore_item(tool) {
                return sse_frame("response.failed", &json!({"type": "response.failed", "response": {"id": self.response_id, "status": "failed", "error": {"code": "invalid_tool_arguments", "message": message}}}));
            }
        }
        output.extend(self.tool_calls.clone());
        if output.is_empty() {
            output.push(json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": ""}]}));
        }
        let response = json!({"id": self.response_id, "object": "response", "created_at": self.created, "model": self.model, "status": "completed", "output": output, "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}});
        let mut out = String::new();
        if self.content_started {
            out.push_str(&sse_frame("response.output_text.done", &json!({"type": "response.output_text.done", "item_id": self.output_item_id, "output_index": 0, "content_index": 0, "text": self.content})));
            out.push_str(&sse_frame("response.content_part.done", &json!({"type": "response.content_part.done", "item_id": self.output_item_id, "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": self.content}})));
            out.push_str(&sse_frame("response.output_item.done", &json!({"type": "response.output_item.done", "output_index": 0, "item": {"id": self.output_item_id, "type": "message", "status": "completed", "role": "assistant", "content": [{"type": "output_text", "text": self.content}]}})));
        }
        for (index, tool) in self.tool_calls.iter().enumerate() {
            let output_index = index + usize::from(!self.content.is_empty());
            let custom = tool["type"] == "custom_tool_call";
            let field = if custom { "input" } else { "arguments" };
            let event = if custom { "response.custom_tool_call_input.done" } else { "response.function_call_arguments.done" };
            let mut added = tool.clone();
            added[field] = json!("");
            added["status"] = json!("in_progress");
            out.push_str(&sse_frame("response.output_item.added", &json!({"type": "response.output_item.added", "output_index": output_index, "item": added})));
            let mut done = json!({"type": event, "item_id": tool["id"], "output_index": output_index});
            done[field] = tool[field].clone();
            out.push_str(&sse_frame(event, &done));
            let mut completed = tool.clone();
            completed["status"] = json!("completed");
            out.push_str(&sse_frame("response.output_item.done", &json!({"type": "response.output_item.done", "output_index": output_index, "item": completed})));
        }
        out.push_str(&response_completed_sse(&response));
        out
    }
}

#[derive(Default)]
struct ResponseChatToolState {
    item_id: Option<String>,
    call_id: Option<String>,
    output_index: Option<u64>,
    name: Option<String>,
    arguments: String,
    emitted: usize,
    introduced: bool,
}

#[derive(Default)]
struct ResponseChatStreamState {
    id: String,
    model: String,
    created: u64,
    role_sent: bool,
    content: String,
    finished: bool,
    tools: Vec<ResponseChatToolState>,
}

impl ResponseChatStreamState {
    fn new(model: &str) -> Self {
        Self {
            id: new_id("chatcmpl"),
            model: model.to_owned(),
            created: now_ms() / 1000,
            ..Default::default()
        }
    }

    fn chunk(&mut self, delta: Value, finish_reason: Option<&str>) -> String {
        let mut delta_object = object_value(&delta);
        if !self.role_sent {
            self.role_sent = true;
            delta_object.insert("role".to_owned(), Value::String("assistant".to_owned()));
        }
        let value = json!({"id": self.id, "object": "chat.completion.chunk", "created": self.created, "model": self.model, "choices": [{"index": 0, "delta": Value::Object(delta_object), "finish_reason": finish_reason}]});
        format!("data: {}\n\n", value)
    }

    fn tool_event(&mut self, event: &Value, complete: bool) -> String {
        let item = event.get("item").unwrap_or(event);
        let item_id = value_string(event.get("item_id")).or_else(|| value_string(item.get("id")));
        let call_id = value_string(item.get("call_id"));
        let output_index = event.get("output_index").and_then(Value::as_u64);
        let index = self.tools.iter().position(|tool| {
            (item_id.is_some() && tool.item_id == item_id)
                || (call_id.is_some() && tool.call_id == call_id)
                || (output_index.is_some() && tool.output_index == output_index)
        }).unwrap_or_else(|| {
            self.tools.push(ResponseChatToolState::default());
            self.tools.len() - 1
        });
        let tool = &mut self.tools[index];
        if item_id.is_some() { tool.item_id = item_id; }
        if call_id.is_some() && !tool.introduced { tool.call_id = call_id; }
        if output_index.is_some() { tool.output_index = output_index; }
        if let Some(name) = value_string(item.get("name")).filter(|name| !name.is_empty()) {
            tool.name = Some(name);
        }
        if let Some(delta) = event.get("delta").and_then(Value::as_str) {
            tool.arguments.push_str(delta);
        } else if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
            if tool.arguments.is_empty() || (complete && arguments.starts_with(&tool.arguments)) {
                tool.arguments = arguments.to_owned();
            }
        }
        // Argument events may precede metadata. Never expose an unnamed call.
        let mut deltas = Vec::new();
        if !tool.introduced && tool.name.is_some() && tool.call_id.is_some() {
            tool.introduced = true;
            deltas.push(json!({"tool_calls": [{"index": index, "id": tool.call_id, "type": "function", "function": {"name": tool.name, "arguments": ""}}]}));
        }
        if tool.introduced && tool.emitted < tool.arguments.len() {
            deltas.push(json!({"tool_calls": [{"index": index, "function": {"arguments": &tool.arguments[tool.emitted..]}}]}));
            tool.emitted = tool.arguments.len();
        }
        deltas.into_iter().map(|delta| self.chunk(delta, None)).collect()
    }

    fn finish(&mut self) -> String {
        if self.finished {
            return String::new();
        }
        self.finished = true;
        let reason = if self.tools.iter().any(|tool| tool.introduced) { "tool_calls" } else { "stop" };
        let mut out = self.chunk(json!({}), Some(reason));
        out.push_str("data: [DONE]\n\n");
        out
    }
}

#[derive(Default)]
struct AnthropicStreamState {
    started: bool,
    model: String,
    message_id: String,
    next_index: usize,
    blocks: HashMap<String, usize>,
    stopped: bool,
}

impl AnthropicStreamState {
    fn new(model: &str) -> Self {
        Self {
            model: model.to_owned(),
            message_id: new_id("msg"),
            ..Default::default()
        }
    }

    fn start(&mut self) -> String {
        if self.started {
            return String::new();
        }
        self.started = true;
        sse_frame(
            "message_start",
            &json!({"type": "message_start", "message": {"id": self.message_id, "type": "message", "role": "assistant", "model": self.model, "content": [], "stop_reason": Value::Null, "stop_sequence": Value::Null, "usage": {"input_tokens": 0, "output_tokens": 0}}}),
        )
    }

    fn stop(&mut self) -> String {
        if self.stopped {
            return String::new();
        }
        self.stopped = true;
        let mut out = String::new();
        out.push_str(&sse_frame("message_delta", &json!({"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": Value::Null}, "usage": {"output_tokens": 0}})));
        out.push_str(&sse_frame("message_stop", &json!({"type": "message_stop"})));
        out
    }
}

struct SseStreamTransformer {
    mode: StreamTransform,
    buffer: String,
    chat_response: ChatResponseStreamState,
    response_chat: ResponseChatStreamState,
    anthropic: AnthropicStreamState,
}

impl SseStreamTransformer {
    fn new(mode: StreamTransform, model: &str) -> Self {
        Self {
            mode,
            buffer: String::new(),
            chat_response: ChatResponseStreamState::new(model),
            response_chat: ResponseChatStreamState::new(model),
            anthropic: AnthropicStreamState::new(model),
        }
    }

    fn push(&mut self, bytes: &[u8]) -> String {
        self.buffer.push_str(&String::from_utf8_lossy(bytes));
        let mut output = String::new();
        while let Some(index) = self.buffer.find("\n\n") {
            let frame = self.buffer[..index].to_owned();
            self.buffer.drain(..index + 2);
            output.push_str(&self.transform_frame(&frame));
        }
        output
    }

    fn finish(&mut self) -> String {
        let mut output = String::new();
        if !self.buffer.trim().is_empty() {
            let frame = std::mem::take(&mut self.buffer);
            output.push_str(&self.transform_frame(&frame));
        }
        match self.mode {
            StreamTransform::ChatToResponse => output.push_str(&self.chat_response.finish()),
            StreamTransform::ResponseToChat => output.push_str(&self.response_chat.finish()),
            StreamTransform::ResponseToAnthropic => output.push_str(&self.anthropic.stop()),
            StreamTransform::None => {}
        }
        output
    }

    fn transform_frame(&mut self, frame: &str) -> String {
        let mut data = Vec::new();
        let normalized_frame = frame.replace('\r', "");
        for line in normalized_frame.lines() {
            if let Some(value) = line.strip_prefix("data:") {
                data.push(value.trim());
            }
        }
        if data.is_empty() {
            return String::new();
        }
        let payload = data.join("\n");
        if payload == "[DONE]" {
            return match self.mode {
                StreamTransform::ChatToResponse => self.chat_response.finish(),
                StreamTransform::ResponseToChat => self.response_chat.finish(),
                StreamTransform::ResponseToAnthropic => self.anthropic.stop(),
                StreamTransform::None => format!("{frame}\n\n"),
            };
        }
        let Ok(value) = serde_json::from_str::<Value>(&payload) else {
            return String::new();
        };
        match self.mode {
            StreamTransform::ChatToResponse => self.transform_chat_chunk(&value),
            StreamTransform::ResponseToChat => self.transform_response_event(&value),
            StreamTransform::ResponseToAnthropic => self.transform_anthropic_event(&value),
            StreamTransform::None => format!("{frame}\n\n"),
        }
    }

    fn transform_chat_chunk(&mut self, value: &Value) -> String {
        if value.get("object").and_then(Value::as_str) != Some("chat.completion.chunk") {
            return String::new();
        }
        let mut output = self.chat_response.created_frame();
        let choice = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first());
        let Some(choice) = choice else {
            return output;
        };
        if let Some(delta) = choice.get("delta") {
            if let Some(content) =
                raw_string(delta.get("content")).filter(|content| !content.is_empty())
            {
                if !self.chat_response.content_started {
                    self.chat_response.content_started = true;
                    output.push_str(&sse_frame("response.output_item.added", &json!({"type": "response.output_item.added", "output_index": 0, "item": {"id": self.chat_response.output_item_id, "type": "message", "status": "in_progress", "role": "assistant", "content": []}})));
                    output.push_str(&sse_frame("response.content_part.added", &json!({"type": "response.content_part.added", "item_id": self.chat_response.output_item_id, "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": ""}})));
                }
                self.chat_response.content.push_str(&content);
                output.push_str(&sse_frame("response.output_text.delta", &json!({"type": "response.output_text.delta", "item_id": self.chat_response.output_item_id, "output_index": 0, "content_index": 0, "delta": content})));
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let index = call
                        .get("index")
                        .and_then(Value::as_u64)
                        .unwrap_or(self.chat_response.tool_calls.len() as u64)
                        as usize;
                    while self.chat_response.tool_calls.len() <= index {
                        self.chat_response.tool_calls.push(json!({"type": "function_call", "id": new_id("call"), "call_id": new_id("call"), "name": "unknown", "arguments": ""}));
                    }
                    let state = &mut self.chat_response.tool_calls[index];
                    if let Some(id) = value_string(call.get("id")) {
                        state["id"] = Value::String(id.clone());
                        state["call_id"] = Value::String(id);
                    }
                    if let Some(function) = call.get("function") {
                        if let Some(name) = value_string(function.get("name")) {
                            state["name"] = Value::String(name);
                        }
                        if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                            let previous = state
                                .get("arguments")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned();
                            state["arguments"] = Value::String(format!("{previous}{arguments}"));

                        }
                    }
                }
            }
        }
        if let Some(reason) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| value_string(choice.get("finish_reason")))
        {
            if reason != "" {
                output.push_str(&self.chat_response.finish());
            }
        }
        if let Some(usage) = value.get("usage") {
            let _ = usage;
        }
        output
    }

    fn transform_response_event(&mut self, value: &Value) -> String {
        let event_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if event_type == "response.created" {
            if let Some(response) = value.get("response") {
                if let Some(id) = value_string(response.get("id")) {
                    self.response_chat.id = id;
                }
                if let Some(model) = value_string(response.get("model")) {
                    self.response_chat.model = model;
                }
                if let Some(created) = response.get("created_at").and_then(Value::as_u64) {
                    self.response_chat.created = created;
                }
            }
            return String::new();
        }
        if event_type == "response.output_text.delta" {
            let text = raw_string(value.get("delta")).unwrap_or_default();
            if text.is_empty() {
                return String::new();
            }
            self.response_chat.content.push_str(&text);
            return self.response_chat.chunk(json!({"content": text}), None);
        }
        if event_type == "response.output_text.done" && self.response_chat.content.is_empty() {
            if let Some(text) = raw_string(value.get("text")).filter(|text| !text.is_empty()) {
                self.response_chat.content.push_str(&text);
                return self.response_chat.chunk(json!({"content": text}), None);
            }
        }
        if matches!(event_type, "response.output_item.added" | "response.output_item.done")
            && value["item"]["type"] == "function_call"
        {
            return self.response_chat.tool_event(value, event_type == "response.output_item.done");
        }
        if matches!(event_type, "response.function_call_arguments.delta" | "response.function_call_arguments.done") {
            return self.response_chat.tool_event(value, event_type.ends_with(".done"));
        }
        if event_type == "response.completed" {
            let mut output = String::new();
            if let Some(items) = value["response"]["output"].as_array() {
                for (index, item) in items.iter().enumerate() {
                    if item["type"] == "function_call" {
                        output.push_str(&self.response_chat.tool_event(&json!({"output_index": index, "item": item}), true));
                    }
                }
            }
            output.push_str(&self.response_chat.finish());
            return output;
        }
        if matches!(
            event_type,
            "response.completed" | "response.failed" | "response.incomplete" | "error"
        ) {
            return self.response_chat.finish();
        }
        String::new()
    }

    fn transform_anthropic_event(&mut self, value: &Value) -> String {
        let mut output = self.anthropic.start();
        let event_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match event_type {
            "response.output_item.added" => {
                let item = value.get("item").unwrap_or(&Value::Null);
                let key = value_string(item.get("id"))
                    .or_else(|| value_string(value.get("item_id")))
                    .unwrap_or_else(|| format!("block-{}", self.anthropic.next_index));
                let index = self.anthropic.next_index;
                self.anthropic.next_index += 1;
                self.anthropic.blocks.insert(key, index);
                if item.get("type").and_then(Value::as_str) == Some("function_call") {
                    output.push_str(&sse_frame("content_block_start", &json!({"type": "content_block_start", "index": index, "content_block": {"type": "tool_use", "id": item.get("call_id").or_else(|| item.get("id")), "name": item.get("name"), "input": {}}})));
                } else {
                    output.push_str(&sse_frame("content_block_start", &json!({"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}})));
                }
            }
            "response.output_text.delta" => {
                let key =
                    value_string(value.get("item_id")).unwrap_or_else(|| "block-0".to_owned());
                let index = *self.anthropic.blocks.entry(key).or_insert(0);
                if let Some(text) = raw_string(value.get("delta")) {
                    output.push_str(&sse_frame("content_block_delta", &json!({"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": text}})));
                }
            }
            "response.function_call_arguments.delta" => {
                let key =
                    value_string(value.get("item_id")).unwrap_or_else(|| "block-0".to_owned());
                let index = *self.anthropic.blocks.entry(key).or_insert(0);
                if let Some(delta) = raw_string(value.get("delta")) {
                    output.push_str(&sse_frame("content_block_delta", &json!({"type": "content_block_delta", "index": index, "delta": {"type": "input_json_delta", "partial_json": delta}})));
                }
            }
            "response.output_item.done" => {
                let key = value_string(value.get("item_id"))
                    .or_else(|| {
                        value
                            .get("item")
                            .and_then(|item| value_string(item.get("id")))
                    })
                    .unwrap_or_else(|| "block-0".to_owned());
                if let Some(index) = self.anthropic.blocks.get(&key) {
                    output.push_str(&sse_frame(
                        "content_block_stop",
                        &json!({"type": "content_block_stop", "index": index}),
                    ));
                }
            }
            "response.completed" | "response.failed" | "response.incomplete" | "error" => {
                output.push_str(&self.anthropic.stop())
            }
            _ => {}
        }
        output
    }
}

fn streaming_response(reply: StreamingReply) -> Response {
    let mut builder = Response::builder().status(reply.status);
    let mut headers = reply.headers;
    if reply.transform != StreamTransform::None {
        headers.retain(|(name, _)| name != "content-type");
        headers.push(("content-type".to_owned(), "text/event-stream".to_owned()));
    }
    builder = set_response_headers(builder, &headers);
    let transform = reply.transform;
    let model = reply.requested_model;
    let chat_tools = reply.chat_tools;
    let status = reply.status.as_u16();
    let mut trace = reply.trace;
    let mut upstream = reply.upstream.bytes_stream();
    let capacity_lease = reply.capacity_lease;
    let activity_lease = reply.activity_lease;
    let body = stream! {
        // The lease lives for exactly as long as the response body. Dropping
        // the client body cancels this generator and releases the account.
        let _capacity_lease = capacity_lease;
        let _activity_lease = activity_lease;
        let mut stream_error: Option<String> = None;
        if transform == StreamTransform::None {
            while let Some(chunk) = upstream.next().await {
                match chunk {
                    Ok(chunk) => {
                        if let Some(trace) = trace.as_mut() { trace.observe(&chunk); }
                        yield Ok::<Bytes, Infallible>(chunk)
                    }
                    Err(error) => {
                        stream_error = Some(error.to_string());
                        break;
                    }
                }
            }
        } else {
            let mut converter = SseStreamTransformer::new(transform, &model);
            converter.chat_response.chat_tools = chat_tools;
            while let Some(chunk) = upstream.next().await {
                match chunk {
                    Ok(chunk) => {
                        if let Some(trace) = trace.as_mut() { trace.observe(&chunk); }
                        let output = converter.push(&chunk);
                        if !output.is_empty() { yield Ok::<Bytes, Infallible>(Bytes::from(output)); }
                    }
                    Err(error) => {
                        let message = error.to_string();
                        stream_error = Some(message.clone());
                        let output = if transform == StreamTransform::ResponseToAnthropic {
                            format!("event: error\ndata: {}\n\n", json!({"type": "error", "error": {"type": "api_error", "message": message}}))
                        } else {
                            format!("data: {}\n\ndata: [DONE]\n\n", json!({"error": {"message": message, "type": "upstream_error", "code": "stream_interrupted"}}))
                        };
                        yield Ok::<Bytes, Infallible>(Bytes::from(output));
                        break;
                    }
                }
            }
            let output = converter.finish();
            if !output.is_empty() { yield Ok::<Bytes, Infallible>(Bytes::from(output)); }
        }
        if let Some(trace) = trace.as_mut() {
            trace.finish(status, stream_error, Some(false)).await;
        }
    };
    builder
        .body(Body::from_stream(body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Job {
    id: String,
    application: String,
    route: String,
    #[serde(default)]
    request_headers: HashMap<String, String>,
    request_body: Value,
    status: String,
    priority: String,
    model: Option<String>,
    #[serde(default)]
    idempotency_key: Option<String>,
    #[serde(default)]
    webhook_id: Option<String>,
    created_at: u64,
    updated_at: u64,
    not_before: u64,
    deadline_at: Option<u64>,
    attempts: u32,
    #[serde(default = "default_job_max_attempts")]
    max_attempts: u32,
    response_status: Option<u16>,
    response_headers: Option<Vec<(String, String)>>,
    result: Option<Value>,
    error: Option<String>,
    consumed_at: Option<u64>,
    #[serde(default)]
    completed_at: Option<u64>,
    #[serde(default)]
    purge_after: Option<u64>,
    #[serde(default)]
    webhook_delivery: Option<WebhookDelivery>,
    #[serde(default)]
    events: Vec<JobEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WebhookDelivery {
    event_id: String,
    attempts: u32,
    next_attempt_at: u64,
    expires_at: u64,
    delivered_at: Option<u64>,
    last_error: Option<String>,
}

const JOB_RETRY_BASE_MS: u64 = 1_000;
const JOB_RETRY_MAX_MS: u64 = 60_000;
const JOB_CAPACITY_WAIT_MIN_MS: u64 = 100;
const JOB_CAPACITY_WAIT_MS: u64 = 1_000;

fn default_job_max_attempts() -> u32 {
    3
}

#[derive(Debug, Clone)]
struct SchedulingCandidate {
    id: String,
    application: String,
    priority: String,
    created_at: u64,
}

#[derive(Clone, Default)]
struct WeightedFairScheduler {
    priority_scores: HashMap<String, f64>,
    application_scores: HashMap<String, f64>,
}

fn job_priority_weight(priority: &str) -> f64 {
    match priority {
        "critical" => 16.0,
        "interactive" => 8.0,
        "standard" => 4.0,
        "batch" => 1.0,
        _ => 0.0,
    }
}

fn valid_job_priority(priority: &str) -> bool {
    job_priority_weight(priority) > 0.0
}

fn next_batch_window_at(now: u64) -> u64 {
    use chrono::{Datelike, TimeZone, Timelike};
    let Some(utc) = chrono::DateTime::from_timestamp_millis(now as i64) else {
        return now;
    };
    let paris = utc.with_timezone(&chrono_tz::Europe::Paris);
    if paris.hour() >= 22 || paris.hour() < 7 {
        return now;
    }
    chrono_tz::Europe::Paris
        .with_ymd_and_hms(paris.year(), paris.month(), paris.day(), 22, 0, 0)
        .single()
        .map(|start| start.with_timezone(&chrono::Utc).timestamp_millis().max(0) as u64)
        .unwrap_or_else(|| now.saturating_add(24 * 60 * 60 * 1_000))
}

fn eligible_job_not_before(priority: &str, requested_at: u64, now: u64) -> u64 {
    if priority != "batch" {
        return requested_at;
    }
    if requested_at <= now && next_batch_window_at(now) == now {
        return requested_at;
    }
    next_batch_window_at(requested_at.max(now))
}

impl WeightedFairScheduler {
    fn choose(
        &mut self,
        candidates: &[SchedulingCandidate],
        application_weights: &HashMap<String, f64>,
    ) -> Option<String> {
        if candidates.is_empty() {
            return None;
        }
        let priorities = ["critical", "interactive", "standard", "batch"]
            .into_iter()
            .filter(|priority| {
                candidates
                    .iter()
                    .any(|candidate| candidate.priority == *priority)
            })
            .collect::<Vec<_>>();
        let priority_total = priorities
            .iter()
            .map(|priority| job_priority_weight(priority))
            .sum::<f64>();
        let mut selected_priority = priorities.first().copied()?;
        let mut selected_score = f64::NEG_INFINITY;
        for priority in priorities {
            let score = self.priority_scores.entry(priority.to_owned()).or_default();
            *score += job_priority_weight(priority);
            if *score > selected_score {
                selected_score = *score;
                selected_priority = priority;
            }
        }
        *self
            .priority_scores
            .entry(selected_priority.to_owned())
            .or_default() -= priority_total;

        let mut applications = Vec::new();
        for candidate in candidates
            .iter()
            .filter(|candidate| candidate.priority == selected_priority)
        {
            if !applications.contains(&candidate.application) {
                applications.push(candidate.application.clone());
            }
        }
        let application_weight = |application: &str| {
            application_weights
                .get(application)
                .copied()
                .unwrap_or(1.0)
                .clamp(0.1, 100.0)
        };
        let application_total = applications
            .iter()
            .map(|application| application_weight(application))
            .sum::<f64>();
        let mut selected_application = applications.first()?.clone();
        let mut selected_score = f64::NEG_INFINITY;
        for application in applications {
            let key = format!("{selected_priority}:{application}");
            let score = self.application_scores.entry(key).or_default();
            *score += application_weight(&application);
            if *score > selected_score {
                selected_score = *score;
                selected_application = application;
            }
        }
        let key = format!("{selected_priority}:{selected_application}");
        *self.application_scores.entry(key).or_default() -= application_total;
        candidates
            .iter()
            .find(|candidate| {
                candidate.priority == selected_priority
                    && candidate.application == selected_application
            })
            .map(|candidate| candidate.id.clone())
    }
}

struct JobCreateResult {
    job: Job,
    created: bool,
}

#[derive(Debug)]
enum JobCreateError {
    InvalidPriority,
    InvalidDeadline,
    ExpiredDeadline,
    IdempotencyConflict,
    Persistence(String),
}

#[derive(Debug)]
enum JobCancelError {
    NotFound,
    Conflict,
    Persistence(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JobEvent {
    id: u64,
    #[serde(rename = "jobId")]
    job_id: String,
    application: String,
    r#type: String,
    data: Value,
    #[serde(default)]
    at: u64,
}

#[derive(Clone)]
struct JobState {
    jobs: HashMap<String, Job>,
    next_event_id: u64,
}

#[derive(Debug)]
enum JobPersistenceError {
    NotCommitted(String),
    CommitUncertain(String),
}

enum JobStateTransition<R> {
    Unchanged(R),
    Changed(R),
}

impl JobPersistenceError {
    fn message(&self) -> &str {
        match self {
            Self::NotCommitted(message) | Self::CommitUncertain(message) => message,
        }
    }

    fn is_uncertain(&self) -> bool {
        matches!(self, Self::CommitUncertain(_))
    }
}

#[cfg(test)]
#[derive(Clone)]
struct CommitTestGate {
    started: Arc<Notify>,
    release: Arc<Notify>,
}

pub struct JobManager {
    path: PathBuf,
    state: Arc<Mutex<JobState>>,
    persist_lock: Arc<Mutex<()>>,
    scheduler: Arc<Mutex<WeightedFairScheduler>>,
    changed: Arc<Notify>,
    webhooks_changed: Arc<Notify>,
    events: broadcast::Sender<JobEvent>,
    persistence_uncertain: Arc<AtomicBool>,
    #[cfg(test)]
    commit_test_gate: Arc<Mutex<Option<CommitTestGate>>>,
}

fn sqlite_json<T: serde::de::DeserializeOwned + Default>(raw: Option<String>) -> T {
    raw.and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

fn sqlite_response_headers(raw: Option<String>) -> Option<Vec<(String, String)>> {
    let value = raw.and_then(|value| serde_json::from_str::<Value>(&value).ok())?;
    Some(
        value
            .as_object()?
            .iter()
            .filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_owned())))
            .collect(),
    )
}

fn sqlite_u64(value: Option<i64>) -> Option<u64> {
    value.and_then(|value| value.try_into().ok())
}

fn import_legacy_jobs_blocking(path: &std::path::Path) -> Result<Vec<Job>, String> {
    use rusqlite::{Connection, OpenFlags, backup::Backup};
    if !path.exists() {
        return Ok(Vec::new());
    }
    let source = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("cannot open legacy job store {}: {error}", path.display()))?;
    let has_jobs = source
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'jobs'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    if !has_jobs {
        return Ok(Vec::new());
    }

    let backup_path = path.with_extension("pre-rust-backup.sqlite");
    if !backup_path.exists() {
        let mut destination = Connection::open(&backup_path).map_err(|error| {
            format!(
                "cannot create legacy job backup {}: {error}",
                backup_path.display()
            )
        })?;
        let backup = Backup::new(&source, &mut destination)
            .map_err(|error| format!("cannot initialize legacy job backup: {error}"))?;
        backup
            .run_to_completion(64, Duration::from_millis(10), None)
            .map_err(|error| format!("cannot back up legacy job store: {error}"))?;
        drop(backup);
        #[cfg(unix)]
        std::fs::set_permissions(&backup_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("cannot protect legacy job backup: {error}"))?;
    }

    let mut deliveries = HashMap::new();
    if let Ok(mut statement) = source.prepare(
        "SELECT event_id, job_id, attempts, next_attempt_at, expires_at, delivered_at, last_error FROM webhook_deliveries",
    ) {
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    WebhookDelivery {
                        event_id: row.get(0)?,
                        attempts: row.get::<_, i64>(2)?.max(0) as u32,
                        next_attempt_at: row.get::<_, i64>(3)?.max(0) as u64,
                        expires_at: row.get::<_, i64>(4)?.max(0) as u64,
                        delivered_at: sqlite_u64(row.get(5)?),
                        last_error: row.get(6)?,
                    },
                ))
            })
            .map_err(|error| format!("cannot read legacy webhook deliveries: {error}"))?;
        for row in rows {
            let (job_id, delivery) =
                row.map_err(|error| format!("invalid legacy webhook delivery: {error}"))?;
            deliveries.insert(job_id, delivery);
        }
    }

    let mut statement = source
        .prepare(
            "SELECT id, application, route, request_headers_json, request_json, status, priority, model, idempotency_key, webhook_id, deadline_at, not_before, attempts, max_attempts, response_status, response_headers_json, result_json, error, created_at, updated_at, completed_at, consumed_at, purge_after FROM jobs",
        )
        .map_err(|error| format!("cannot prepare legacy job import: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let id = row.get::<_, String>(0)?;
            Ok(Job {
                webhook_delivery: deliveries.get(&id).cloned(),
                events: Vec::new(),
                id,
                application: row.get(1)?,
                route: row.get(2)?,
                request_headers: sqlite_json(row.get(3)?),
                request_body: row
                    .get::<_, Option<String>>(4)?
                    .and_then(|value| serde_json::from_str(&value).ok())
                    .unwrap_or(Value::Null),
                status: row.get(5)?,
                priority: row.get(6)?,
                model: row.get(7)?,
                idempotency_key: row.get(8)?,
                webhook_id: row.get(9)?,
                deadline_at: sqlite_u64(row.get(10)?),
                not_before: row.get::<_, i64>(11)?.max(0) as u64,
                attempts: row.get::<_, i64>(12)?.max(0) as u32,
                max_attempts: row.get::<_, i64>(13)?.max(1) as u32,
                response_status: row
                    .get::<_, Option<i64>>(14)?
                    .and_then(|value| value.try_into().ok()),
                response_headers: sqlite_response_headers(row.get(15)?),
                result: row
                    .get::<_, Option<String>>(16)?
                    .and_then(|value| serde_json::from_str(&value).ok()),
                error: row.get(17)?,
                created_at: row.get::<_, i64>(18)?.max(0) as u64,
                updated_at: row.get::<_, i64>(19)?.max(0) as u64,
                completed_at: sqlite_u64(row.get(20)?),
                consumed_at: sqlite_u64(row.get(21)?),
                purge_after: sqlite_u64(row.get(22)?),
            })
        })
        .map_err(|error| format!("cannot read legacy jobs: {error}"))?;
    let mut jobs = rows
        .map(|row| row.map_err(|error| format!("invalid legacy job: {error}")))
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);

    if let Ok(mut events_statement) = source.prepare(
        "SELECT id, job_id, application, type, data_json, created_at FROM job_events ORDER BY id",
    ) {
        let rows = events_statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    JobEvent {
                        id: row.get::<_, i64>(0)?.max(0) as u64,
                        job_id: row.get(1)?,
                        application: row.get(2)?,
                        r#type: row.get(3)?,
                        data: row
                            .get::<_, Option<String>>(4)?
                            .and_then(|value| serde_json::from_str(&value).ok())
                            .unwrap_or_else(|| json!({})),
                        at: row.get::<_, i64>(5)?.max(0) as u64,
                    },
                ))
            })
            .map_err(|error| format!("cannot read legacy job events: {error}"))?;
        for row in rows {
            let (job_id, event) =
                row.map_err(|error| format!("invalid legacy job event: {error}"))?;
            if let Some(job) = jobs.iter_mut().find(|job| job.id == job_id) {
                job.events.push(event);
            }
        }
    }

    Ok(jobs)
}

async fn import_legacy_jobs(
    path: Option<PathBuf>,
    destination: &std::path::Path,
) -> Result<Vec<Job>, String> {
    let Some(path) = path.filter(|path| path.as_path() != destination) else {
        return Ok(Vec::new());
    };
    tokio::task::spawn_blocking(move || import_legacy_jobs_blocking(&path))
        .await
        .map_err(|error| format!("legacy job import task failed: {error}"))?
}

impl JobManager {
    #[cfg(test)]
    async fn new(path: PathBuf) -> Result<Self, String> {
        Self::new_with_legacy(path, None).await
    }

    async fn new_with_legacy(
        path: PathBuf,
        legacy_jobs_db_path: Option<PathBuf>,
    ) -> Result<Self, String> {
        Self::new_with_legacy_at(path, legacy_jobs_db_path, now_ms()).await
    }

    async fn new_with_legacy_at(
        path: PathBuf,
        legacy_jobs_db_path: Option<PathBuf>,
        now: u64,
    ) -> Result<Self, String> {
        let (events, _) = broadcast::channel(256);
        let mut jobs = match fs::read(&path).await {
            Ok(raw) => serde_json::from_slice::<Vec<Job>>(&raw)
                .map_err(|error| format!("invalid job store {}: {error}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                return Err(format!("cannot read job store {}: {error}", path.display()));
            }
        };
        let legacy_jobs = import_legacy_jobs(legacy_jobs_db_path, &path).await?;
        let mut imported = false;
        for legacy in legacy_jobs {
            let duplicate = jobs.iter().any(|job| {
                job.id == legacy.id
                    || (legacy.idempotency_key.is_some()
                        && job.application == legacy.application
                        && job.idempotency_key == legacy.idempotency_key)
            });
            if !duplicate {
                jobs.push(legacy);
                imported = true;
            }
        }
        let mut recovered = false;
        for job in &mut jobs {
            if matches!(job.status.as_str(), "queued" | "retry" | "running")
                && job.deadline_at.is_some_and(|deadline| deadline <= now)
            {
                job.status = "expired".to_owned();
                job.updated_at = now;
                job.completed_at = Some(now);
                job.error = Some("job deadline expired".to_owned());
                recovered = true;
            } else if job.status == "running" {
                if job.attempts >= job.max_attempts {
                    job.status = "failed".to_owned();
                    job.completed_at = Some(now);
                    job.error = Some("worker stopped after maximum attempts".to_owned());
                } else {
                    job.status = "queued".to_owned();
                    job.not_before = now;
                    job.error = Some("recovered after worker restart".to_owned());
                }
                job.updated_at = now;
                recovered = true;
            }
            if matches!(job.status.as_str(), "queued" | "retry") {
                let eligible = eligible_job_not_before(&job.priority, job.not_before, now);
                if eligible != job.not_before {
                    job.not_before = eligible;
                    job.updated_at = now;
                    recovered = true;
                }
            }
        }
        let mut next_event_id = jobs
            .iter()
            .flat_map(|job| job.events.iter().map(|event| event.id))
            .max()
            .unwrap_or(0)
            .saturating_add(1)
            .max(1);
        for job in &mut jobs {
            if job.events.is_empty() {
                job.events.push(JobEvent {
                    id: next_event_id,
                    job_id: job.id.clone(),
                    application: job.application.clone(),
                    r#type: "job.status".to_owned(),
                    data: json!({"status": job.status}),
                    at: job.updated_at,
                });
                next_event_id = next_event_id.saturating_add(1);
                recovered = true;
            }
        }
        let manager = Self {
            path,
            state: Arc::new(Mutex::new(JobState {
                jobs: jobs.into_iter().map(|job| (job.id.clone(), job)).collect(),
                next_event_id,
            })),
            persist_lock: Arc::new(Mutex::new(())),
            scheduler: Arc::new(Mutex::new(WeightedFairScheduler::default())),
            changed: Arc::new(Notify::new()),
            webhooks_changed: Arc::new(Notify::new()),
            events,
            persistence_uncertain: Arc::new(AtomicBool::new(false)),
            #[cfg(test)]
            commit_test_gate: Arc::new(Mutex::new(None)),
        };
        if recovered || imported {
            manager.persist().await?;
        }
        Ok(manager)
    }

    async fn persist(&self) -> Result<(), String> {
        let persist_guard = self.persist_lock.clone().lock_owned().await;
        if self.persistence_uncertain.load(AtomicOrdering::SeqCst) {
            return Err(
                "job store persistence is in an uncertain state; restart required".to_owned(),
            );
        }
        let state_guard = self.state.clone().lock_owned().await;
        let proposed = state_guard.clone();
        self.finish_commit(
            persist_guard,
            state_guard,
            proposed,
            None,
            "job store flush",
        )
        .await
    }

    fn serialize_snapshot(state: &JobState) -> Result<Vec<u8>, JobPersistenceError> {
        let jobs = state.jobs.values().cloned().collect::<Vec<_>>();
        serde_json::to_vec_pretty(&jobs).map_err(|error| {
            JobPersistenceError::NotCommitted(format!("cannot serialize job store: {error}"))
        })
    }

    async fn write_snapshot(path: PathBuf, raw: Vec<u8>) -> Result<(), JobPersistenceError> {
        let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4().simple()));
        tokio::task::spawn_blocking(move || {
            if let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                std::fs::create_dir_all(parent).map_err(|error| {
                    JobPersistenceError::NotCommitted(format!(
                        "cannot create job store directory {}: {error}",
                        parent.display()
                    ))
                })?;
            }
            let mut options = std::fs::OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            options.mode(0o600);
            let result = (|| -> Result<(), JobPersistenceError> {
                let mut file = options.open(&temporary).map_err(|error| {
                    JobPersistenceError::NotCommitted(format!(
                        "cannot create temporary job store {}: {error}",
                        temporary.display()
                    ))
                })?;
                file.write_all(&raw).map_err(|error| {
                    JobPersistenceError::NotCommitted(format!(
                        "cannot write job store {}: {error}",
                        temporary.display()
                    ))
                })?;
                file.sync_all().map_err(|error| {
                    JobPersistenceError::NotCommitted(format!(
                        "cannot sync job store {}: {error}",
                        temporary.display()
                    ))
                })?;
                drop(file);
                std::fs::rename(&temporary, &path).map_err(|error| {
                    JobPersistenceError::NotCommitted(format!(
                        "cannot replace job store {} with {}: {error}",
                        path.display(),
                        temporary.display()
                    ))
                })?;
                #[cfg(unix)]
                if let Some(parent) = path
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                {
                    std::fs::File::open(parent)
                        .and_then(|directory| directory.sync_all())
                        .map_err(|error| {
                            JobPersistenceError::CommitUncertain(format!(
                                "cannot sync job store directory {}: {error}",
                                parent.display()
                            ))
                        })?;
                }
                Ok(())
            })();
            if matches!(result, Err(JobPersistenceError::NotCommitted(_))) {
                let _ = std::fs::remove_file(&temporary);
            }
            result
        })
        .await
        .map_err(|error| {
            JobPersistenceError::CommitUncertain(format!(
                "job store persistence task failed: {error}"
            ))
        })?
    }

    async fn finish_commit(
        &self,
        persist_guard: tokio::sync::OwnedMutexGuard<()>,
        mut state_guard: tokio::sync::OwnedMutexGuard<JobState>,
        proposed: JobState,
        scheduler_commit: Option<(
            tokio::sync::OwnedMutexGuard<WeightedFairScheduler>,
            WeightedFairScheduler,
        )>,
        operation: &str,
    ) -> Result<(), String> {
        let first_new_event_id = state_guard.next_event_id;
        let mut events_to_publish = proposed
            .jobs
            .values()
            .flat_map(|job| job.events.iter())
            .filter(|event| event.id >= first_new_event_id)
            .cloned()
            .collect::<Vec<_>>();
        events_to_publish.sort_by_key(|event| event.id);
        let raw = Self::serialize_snapshot(&proposed).map_err(|error| {
            format!(
                "job store persistence failed during {operation}: {}",
                error.message()
            )
        })?;
        let path = self.path.clone();
        let persistence_uncertain = self.persistence_uncertain.clone();
        let event_sender = self.events.clone();
        let changed = self.changed.clone();
        let webhooks_changed = self.webhooks_changed.clone();
        #[cfg(test)]
        let commit_test_gate = self.commit_test_gate.lock().await.clone();
        let operation = operation.to_owned();
        let join_operation = operation.clone();
        let commit = tokio::spawn(async move {
            let _persist_guard = persist_guard;
            let mut scheduler_commit = scheduler_commit;
            #[cfg(test)]
            if let Some(gate) = commit_test_gate {
                gate.started.notify_one();
                gate.release.notified().await;
            }
            match Self::write_snapshot(path, raw).await {
                Ok(()) => {
                    *state_guard = proposed;
                    if let Some((scheduler, proposed_scheduler)) = scheduler_commit.as_mut() {
                        **scheduler = proposed_scheduler.clone();
                    }
                    for event in events_to_publish {
                        let _ = event_sender.send(event);
                    }
                    changed.notify_waiters();
                    changed.notify_one();
                    webhooks_changed.notify_waiters();
                    webhooks_changed.notify_one();
                    Ok(())
                }
                Err(error) if error.is_uncertain() => {
                    // rename already succeeded or the writer outcome is unknown.
                    // Publish the proposed snapshot so reads match the visible file,
                    // then freeze mutations until startup reconciles durable state.
                    *state_guard = proposed;
                    persistence_uncertain.store(true, AtomicOrdering::SeqCst);
                    for event in events_to_publish {
                        let _ = event_sender.send(event);
                    }
                    changed.notify_waiters();
                    changed.notify_one();
                    webhooks_changed.notify_waiters();
                    webhooks_changed.notify_one();
                    Err(format!(
                        "job store persistence became uncertain during {operation}: {}; restart required",
                        error.message()
                    ))
                }
                Err(error) => Err(format!(
                    "job store persistence failed during {operation}: {}",
                    error.message()
                )),
            }
        });
        commit.await.map_err(|error| {
            self.persistence_uncertain
                .store(true, AtomicOrdering::SeqCst);
            format!(
                "job store commit task failed during {join_operation}: {error}; restart required"
            )
        })?
    }

    async fn commit_transition<R, F>(&self, operation: &str, mutation: F) -> Result<R, String>
    where
        F: FnOnce(&mut JobState) -> JobStateTransition<R>,
    {
        let persist_guard = self.persist_lock.clone().lock_owned().await;
        if self.persistence_uncertain.load(AtomicOrdering::SeqCst) {
            return Err(
                "job store persistence is in an uncertain state; restart required".to_owned(),
            );
        }
        let state_guard = self.state.clone().lock_owned().await;
        let mut proposed = state_guard.clone();
        let result = match mutation(&mut proposed) {
            JobStateTransition::Unchanged(result) => return Ok(result),
            JobStateTransition::Changed(result) => result,
        };
        self.finish_commit(persist_guard, state_guard, proposed, None, operation)
            .await?;
        Ok(result)
    }

    async fn commit_fallible_transition<R, E, F>(
        &self,
        operation: &str,
        mutation: F,
    ) -> Result<Result<R, E>, String>
    where
        F: FnOnce(&mut JobState) -> Result<JobStateTransition<R>, E>,
    {
        let persist_guard = self.persist_lock.clone().lock_owned().await;
        if self.persistence_uncertain.load(AtomicOrdering::SeqCst) {
            return Err(
                "job store persistence is in an uncertain state; restart required".to_owned(),
            );
        }
        let state_guard = self.state.clone().lock_owned().await;
        let mut proposed = state_guard.clone();
        let result = match mutation(&mut proposed) {
            Err(error) => return Ok(Err(error)),
            Ok(JobStateTransition::Unchanged(result)) => return Ok(Ok(result)),
            Ok(JobStateTransition::Changed(result)) => result,
        };
        self.finish_commit(persist_guard, state_guard, proposed, None, operation)
            .await?;
        Ok(Ok(result))
    }

    fn append_event(state: &mut JobState, job: &Job, event_type: &str, data: Value) -> JobEvent {
        let event = JobEvent {
            id: state.next_event_id,
            job_id: job.id.clone(),
            application: job.application.clone(),
            r#type: event_type.to_owned(),
            data,
            at: now_ms(),
        };
        state.next_event_id = state.next_event_id.saturating_add(1).max(1);
        if let Some(stored) = state.jobs.get_mut(&job.id) {
            stored.events.push(event.clone());
            if stored.events.len() > 1_000 {
                stored.events.drain(..stored.events.len() - 1_000);
            }
        }
        event
    }

    fn persistence_requires_restart(&self) -> bool {
        self.persistence_uncertain.load(AtomicOrdering::SeqCst)
    }

    fn notify_changed(&self) {
        self.changed.notify_waiters();
        self.changed.notify_one();
        self.webhooks_changed.notify_waiters();
        self.webhooks_changed.notify_one();
    }

    async fn create(
        &self,
        application: &str,
        route: &str,
        headers: &HeaderMap,
        body: &Value,
        max_attempts: u32,
    ) -> Result<JobCreateResult, JobCreateError> {
        let now = now_ms();
        let priority =
            header_value(headers, "x-multivibe-priority").unwrap_or_else(|| "batch".to_owned());
        if !valid_job_priority(&priority) {
            return Err(JobCreateError::InvalidPriority);
        }
        let deadline_at = match header_value(headers, "x-multivibe-deadline") {
            Some(value) => Some(parse_rfc3339_ms(&value).ok_or(JobCreateError::InvalidDeadline)?),
            None => None,
        };
        if deadline_at.is_some_and(|deadline| deadline <= now) {
            return Err(JobCreateError::ExpiredDeadline);
        }
        let idempotency_key = header_value(headers, "x-multivibe-idempotency-key")
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let not_before = eligible_job_not_before(&priority, now, now);
        let job = Job {
            id: new_id("job"),
            application: application.to_owned(),
            route: route.to_owned(),
            request_headers: headers
                .iter()
                .filter_map(|(name, value)| {
                    Some((name.as_str().to_owned(), value.to_str().ok()?.to_owned()))
                })
                .collect(),
            request_body: body.clone(),
            status: "queued".to_owned(),
            priority,
            model: value_string(body.get("model")),
            idempotency_key: idempotency_key.clone(),
            webhook_id: header_value(headers, "x-multivibe-webhook")
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty()),
            created_at: now,
            updated_at: now,
            not_before,
            deadline_at,
            attempts: 0,
            max_attempts: max_attempts.max(1),
            response_status: None,
            response_headers: None,
            result: None,
            error: None,
            consumed_at: None,
            completed_at: None,
            purge_after: None,
            webhook_delivery: None,
            events: Vec::new(),
        };
        let committed = self
            .commit_fallible_transition("job creation", |state| {
                if let Some(key) = idempotency_key.as_deref()
                    && let Some(existing) = state.jobs.values().find(|candidate| {
                        candidate.application == application
                            && candidate.idempotency_key.as_deref() == Some(key)
                    })
                {
                    if existing.route != route || existing.request_body != *body {
                        return Err(JobCreateError::IdempotencyConflict);
                    }
                    return Ok(JobStateTransition::Unchanged(JobCreateResult {
                        job: existing.clone(),
                        created: false,
                    }));
                }
                state.jobs.insert(job.id.clone(), job.clone());
                Self::append_event(state, &job, "job.queued", json!({"status": "queued"}));
                Ok(JobStateTransition::Changed(JobCreateResult {
                    job: job.clone(),
                    created: true,
                }))
            })
            .await
            .map_err(JobCreateError::Persistence)??;
        Ok(committed)
    }

    async fn get_for(&self, application: &str, id: &str) -> Option<Job> {
        self.state
            .lock()
            .await
            .jobs
            .get(id)
            .filter(|job| job.application == application)
            .cloned()
    }

    async fn list_for(&self, application: &str, limit: usize) -> Vec<Job> {
        let mut jobs = self
            .state
            .lock()
            .await
            .jobs
            .values()
            .filter(|job| job.application == application)
            .cloned()
            .collect::<Vec<_>>();
        jobs.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        jobs.truncate(limit.clamp(1, 1000));
        jobs
    }

    async fn events_after(
        &self,
        application: &str,
        id: &str,
        after_id: u64,
    ) -> Option<Vec<JobEvent>> {
        let state = self.state.lock().await;
        let job = state
            .jobs
            .get(id)
            .filter(|job| job.application == application)?;
        Some(
            job.events
                .iter()
                .filter(|event| event.id > after_id)
                .take(1_000)
                .cloned()
                .collect(),
        )
    }

    fn subscribe_events(&self) -> broadcast::Receiver<JobEvent> {
        self.events.subscribe()
    }

    async fn acquire_next(
        &self,
        application_weights: &HashMap<String, f64>,
    ) -> Result<Option<Job>, String> {
        self.acquire_next_with_clock(application_weights, now_ms)
            .await
    }

    #[cfg(test)]
    async fn acquire_next_at(
        &self,
        application_weights: &HashMap<String, f64>,
        now: u64,
    ) -> Result<Option<Job>, String> {
        self.acquire_next_with_clock(application_weights, || now)
            .await
    }

    async fn acquire_next_with_clock<F>(
        &self,
        application_weights: &HashMap<String, f64>,
        clock: F,
    ) -> Result<Option<Job>, String>
    where
        F: FnOnce() -> u64,
    {
        let persist_guard = self.persist_lock.clone().lock_owned().await;
        if self.persistence_uncertain.load(AtomicOrdering::SeqCst) {
            return Err(
                "job store persistence is in an uncertain state; restart required".to_owned(),
            );
        }
        let state_guard = self.state.clone().lock_owned().await;
        let now = clock();
        let mut proposed = state_guard.clone();
        let mut terminal = Vec::new();
        let mut changed = false;
        for job in proposed.jobs.values_mut() {
            if matches!(job.status.as_str(), "queued" | "retry") && job.priority == "batch" {
                let eligible = eligible_job_not_before(&job.priority, job.not_before, now);
                if eligible != job.not_before {
                    job.not_before = eligible;
                    job.updated_at = now;
                    changed = true;
                }
            }
            if matches!(job.status.as_str(), "queued" | "retry")
                && job.deadline_at.is_some_and(|deadline| deadline <= now)
            {
                job.status = "expired".to_owned();
                job.updated_at = now;
                job.completed_at = Some(now);
                job.error = Some("job deadline expired".to_owned());
                terminal.push(job.clone());
                changed = true;
            } else if matches!(job.status.as_str(), "queued" | "retry")
                && job.attempts >= job.max_attempts
            {
                job.status = "failed".to_owned();
                job.updated_at = now;
                job.completed_at = Some(now);
                job.error = Some("maximum attempts reached".to_owned());
                terminal.push(job.clone());
                changed = true;
            }
        }
        let mut candidates = proposed
            .jobs
            .values()
            .filter(|job| {
                matches!(job.status.as_str(), "queued" | "retry")
                    && job.not_before <= now
                    && job.attempts < job.max_attempts
                    && job.deadline_at.is_none_or(|deadline| deadline > now)
                    && (job.priority != "batch" || next_batch_window_at(now) == now)
            })
            .map(|job| SchedulingCandidate {
                id: job.id.clone(),
                application: job.application.clone(),
                priority: job.priority.clone(),
                created_at: job.created_at,
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let scheduler_guard = self.scheduler.clone().lock_owned().await;
        let mut proposed_scheduler = scheduler_guard.clone();
        let selected = proposed_scheduler.choose(&candidates, application_weights);
        let job = selected
            .and_then(|id| proposed.jobs.get_mut(&id))
            .map(|job| {
                job.status = "running".to_owned();
                job.attempts += 1;
                job.updated_at = now;
                job.error = None;
                changed = true;
                job.clone()
            });
        for terminal_job in terminal {
            let event_type = if terminal_job.status == "expired" {
                "job.expired"
            } else {
                "job.failed"
            };
            Self::append_event(
                &mut proposed,
                &terminal_job,
                event_type,
                json!({"error": terminal_job.error}),
            );
        }
        if let Some(running) = job.as_ref() {
            Self::append_event(
                &mut proposed,
                running,
                "job.started",
                json!({"status": "running", "attempt": running.attempts}),
            );
        }
        if !changed {
            return Ok(None);
        }
        self.finish_commit(
            persist_guard,
            state_guard,
            proposed,
            Some((scheduler_guard, proposed_scheduler)),
            "job acquisition",
        )
        .await?;
        Ok(job)
    }

    async fn next_wakeup(&self) -> Duration {
        let now = now_ms();
        let next = self
            .state
            .lock()
            .await
            .jobs
            .values()
            .filter(|job| matches!(job.status.as_str(), "queued" | "retry"))
            .map(|job| {
                job.deadline_at
                    .map(|deadline| deadline.min(job.not_before))
                    .unwrap_or(job.not_before)
            })
            .min();
        Duration::from_millis(
            next.map(|at| at.saturating_sub(now))
                .unwrap_or(60_000)
                .clamp(1, 60_000),
        )
    }

    async fn succeed(&self, id: &str, reply: BufferedReply) -> Result<(), String> {
        let now = now_ms();
        let _event = self
            .commit_transition("job success", |state| {
                let Some(job) = state.jobs.get_mut(id) else {
                    return JobStateTransition::Unchanged(None);
                };
                if job.status != "running" {
                    return JobStateTransition::Unchanged(None);
                }
                if job.deadline_at.is_some_and(|deadline| deadline <= now) {
                    job.status = "expired".to_owned();
                    job.error = Some("job deadline expired while running".to_owned());
                } else {
                    job.status = "succeeded".to_owned();
                    job.response_status = Some(reply.status.as_u16());
                    job.response_headers = Some(reply.headers);
                    job.result = serde_json::from_slice(&reply.body).ok();
                    job.error = None;
                    if job.webhook_id.is_some() && job.webhook_delivery.is_none() {
                        job.webhook_delivery = Some(WebhookDelivery {
                            event_id: Uuid::new_v4().to_string(),
                            attempts: 0,
                            next_attempt_at: now,
                            expires_at: now.saturating_add(24 * 60 * 60 * 1_000),
                            delivered_at: None,
                            last_error: None,
                        });
                    }
                }
                job.updated_at = now;
                job.completed_at = Some(now);
                let job = job.clone();
                let event_type = if job.status == "expired" {
                    "job.expired"
                } else {
                    "job.succeeded"
                };
                JobStateTransition::Changed(Some(Self::append_event(
                    state,
                    &job,
                    event_type,
                    json!({"status": job.status}),
                )))
            })
            .await?;
        Ok(())
    }

    async fn fail(&self, id: &str, message: &str, transient: bool) -> Result<(), String> {
        self.fail_at(id, message, transient, now_ms()).await
    }

    async fn fail_at(
        &self,
        id: &str,
        message: &str,
        transient: bool,
        now: u64,
    ) -> Result<(), String> {
        let _event = self
            .commit_transition("job failure", |state| {
                let Some(job) = state.jobs.get_mut(id) else {
                    return JobStateTransition::Unchanged(None);
                };
                if job.status != "running" {
                    return JobStateTransition::Unchanged(None);
                }
                if job.deadline_at.is_some_and(|deadline| deadline <= now) {
                    job.status = "expired".to_owned();
                    job.completed_at = Some(now);
                } else if transient && job.attempts < job.max_attempts {
                    let exponent = job.attempts.saturating_sub(1).min(16);
                    let delay = JOB_RETRY_BASE_MS
                        .saturating_mul(1_u64 << exponent)
                        .min(JOB_RETRY_MAX_MS);
                    job.status = "retry".to_owned();
                    job.not_before =
                        eligible_job_not_before(&job.priority, now.saturating_add(delay), now);
                    job.completed_at = None;
                } else {
                    job.status = "failed".to_owned();
                    job.completed_at = Some(now);
                }
                job.updated_at = now;
                job.error = Some(message.to_owned());
                let job = job.clone();
                let event_type = match job.status.as_str() {
                    "retry" => "job.retry",
                    "expired" => "job.expired",
                    _ => "job.failed",
                };
                JobStateTransition::Changed(Some(Self::append_event(
                    state,
                    &job,
                    event_type,
                    json!({
                        "status": job.status,
                        "error": message,
                        "attempt": job.attempts,
                        "nextAttemptAt": (job.status == "retry").then_some(job.not_before),
                    }),
                )))
            })
            .await?;
        Ok(())
    }

    async fn release_for_drain(&self, id: &str) -> Result<(), String> {
        let now = now_ms();
        self.commit_transition("drain release", |state| {
            let Some(job) = state.jobs.get_mut(id) else {
                return JobStateTransition::Unchanged(false);
            };
            if job.status != "running" {
                return JobStateTransition::Unchanged(false);
            }
            job.status = "queued".to_owned();
            job.attempts = job.attempts.saturating_sub(1);
            job.not_before = eligible_job_not_before(&job.priority, now, now);
            job.updated_at = now;
            job.error = None;
            JobStateTransition::Changed(true)
        })
        .await?;
        Ok(())
    }

    async fn reschedule_for_capacity(&self, id: &str, delay_ms: u64) -> Result<(), String> {
        let now = now_ms();
        let delay = delay_ms.clamp(JOB_CAPACITY_WAIT_MIN_MS, JOB_RETRY_MAX_MS);
        let _event = self
            .commit_transition("capacity reschedule", |state| {
                let Some(job) = state.jobs.get_mut(id) else {
                    return JobStateTransition::Unchanged(None);
                };
                if job.status != "running" {
                    return JobStateTransition::Unchanged(None);
                }
                job.status = "queued".to_owned();
                job.attempts = job.attempts.saturating_sub(1);
                job.not_before =
                    eligible_job_not_before(&job.priority, now.saturating_add(delay), now);
                job.updated_at = now;
                job.completed_at = None;
                job.error = None;
                let job = job.clone();
                JobStateTransition::Changed(Some(Self::append_event(
                    state,
                    &job,
                    "job.capacity_wait",
                    json!({"nextAttemptAt": job.not_before}),
                )))
            })
            .await?;
        Ok(())
    }

    async fn cancel(&self, application: &str, id: &str) -> Result<(), JobCancelError> {
        let _committed = self
            .commit_fallible_transition("job cancellation", |state| {
                let Some(job) = state.jobs.get_mut(id) else {
                    return Err(JobCancelError::NotFound);
                };
                if job.application != application {
                    return Err(JobCancelError::NotFound);
                }
                if !matches!(job.status.as_str(), "queued" | "retry" | "running") {
                    return Err(JobCancelError::Conflict);
                }
                job.status = "cancelled".to_owned();
                let now = now_ms();
                job.updated_at = now;
                job.completed_at = Some(now);
                let job = job.clone();
                let event = Self::append_event(
                    state,
                    &job,
                    "job.cancelled",
                    json!({"status": "cancelled"}),
                );
                Ok(JobStateTransition::Changed(event))
            })
            .await
            .map_err(JobCancelError::Persistence)??;
        Ok(())
    }

    async fn consume_result(&self, application: &str, id: &str) -> Result<Option<Job>, String> {
        let committed = self
            .commit_transition("result consumption", |state| {
                let Some(job) = state.jobs.get_mut(id) else {
                    return JobStateTransition::Unchanged(None);
                };
                if job.application != application || job.status != "succeeded" {
                    return JobStateTransition::Unchanged(None);
                }
                let now = now_ms();
                job.consumed_at = Some(now);
                job.purge_after = Some(now.saturating_add(60 * 60 * 1_000));
                let job = job.clone();
                Self::append_event(state, &job, "job.consumed", json!({"status": job.status}));
                JobStateTransition::Changed(Some(job))
            })
            .await?;
        if let Some(job) = committed {
            Ok(Some(job))
        } else {
            Ok(None)
        }
    }

    async fn pending_webhook_deliveries(&self, now: u64) -> Vec<(Job, WebhookDelivery)> {
        self.state
            .lock()
            .await
            .jobs
            .values()
            .filter_map(|job| {
                let delivery = job.webhook_delivery.as_ref()?;
                (job.status == "succeeded"
                    && delivery.delivered_at.is_none()
                    && delivery.next_attempt_at <= now
                    && delivery.expires_at > now)
                    .then(|| (job.clone(), delivery.clone()))
            })
            .take(100)
            .collect()
    }

    async fn finish_webhook(
        &self,
        job_id: &str,
        event_id: &str,
        succeeded: bool,
        error: Option<String>,
    ) -> Result<(), String> {
        let now = now_ms();
        let _event = self
            .commit_transition("webhook completion", |state| {
                let Some(job) = state.jobs.get_mut(job_id) else {
                    return JobStateTransition::Unchanged(None);
                };
                let Some(delivery) = job.webhook_delivery.as_mut() else {
                    return JobStateTransition::Unchanged(None);
                };
                if delivery.event_id != event_id || delivery.delivered_at.is_some() {
                    return JobStateTransition::Unchanged(None);
                }
                delivery.attempts = delivery.attempts.saturating_add(1);
                if succeeded {
                    delivery.delivered_at = Some(now);
                    delivery.last_error = None;
                    job.purge_after = Some(now.saturating_add(60 * 60 * 1_000));
                } else {
                    let exponent = delivery.attempts.min(12);
                    let delay = 1_000_u64
                        .saturating_mul(1_u64 << exponent)
                        .min(60 * 60 * 1_000);
                    delivery.next_attempt_at = now.saturating_add(delay);
                    delivery.last_error = error
                        .as_deref()
                        .map(|message| message.chars().take(500).collect());
                }
                job.updated_at = now;
                let attempts = delivery.attempts;
                let last_error = delivery.last_error.clone();
                let job = job.clone();
                let event_type = if succeeded {
                    "webhook.delivered"
                } else {
                    "webhook.retry"
                };
                JobStateTransition::Changed(Some(Self::append_event(
                    state,
                    &job,
                    event_type,
                    json!({
                    "eventId": event_id,
                    "attempts": attempts,
                    "error": last_error,
                    }),
                )))
            })
            .await?;
        Ok(())
    }

    async fn purge_due(&self, now: u64) -> Result<(), String> {
        self.commit_transition("retention purge", |state| {
            let mut changed = false;
            for job in state.jobs.values_mut() {
                let event_count = job.events.len();
                job.events.retain(|event| {
                    event.at == 0 || event.at.saturating_add(30 * 24 * 60 * 60 * 1_000) > now
                });
                if job.events.len() != event_count {
                    changed = true;
                }
                let retention_expired = job
                    .purge_after
                    .is_some_and(|purge_after| purge_after <= now)
                    || job.created_at.saturating_add(30 * 24 * 60 * 60 * 1_000) <= now;
                if retention_expired
                    && (!job.request_body.is_null()
                        || job.result.is_some()
                        || !job.request_headers.is_empty()
                        || job.response_headers.is_some())
                {
                    job.request_body = Value::Null;
                    job.request_headers.clear();
                    job.result = None;
                    job.response_headers = None;
                    job.status = "expired".to_owned();
                    job.updated_at = now;
                    changed = true;
                }
            }
            if changed {
                JobStateTransition::Changed(true)
            } else {
                JobStateTransition::Unchanged(false)
            }
        })
        .await?;
        Ok(())
    }
}

fn parse_rfc3339_ms(value: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(value.trim())
        .ok()?
        .timestamp_millis()
        .try_into()
        .ok()
}

fn format_rfc3339_ms(value: u64) -> String {
    i64::try_from(value)
        .ok()
        .and_then(|millis| chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis))
        .map(|timestamp| timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned())
}

fn public_job(job: &Job) -> Value {
    let mut value = json!({
        "object": "multivibe.job",
        "id": job.id,
        "status": job.status,
        "priority": job.priority,
        "model": job.model,
        "attempts": job.attempts,
        "max_attempts": job.max_attempts,
        "created_at": format_rfc3339_ms(job.created_at),
        "updated_at": format_rfc3339_ms(job.updated_at),
        "not_before": format_rfc3339_ms(job.not_before),
        "result_url": format!("/v1/jobs/{}/result", job.id),
        "events_url": format!("/v1/jobs/{}/events", job.id),
        "error": job.error,
    });
    if let Some(deadline) = job.deadline_at {
        value["deadline"] = Value::String(format_rfc3339_ms(deadline));
    }
    value
}

fn application_fairness_weights(store: &StoreFile) -> HashMap<String, f64> {
    store
        .application_policies
        .iter()
        .map(|policy| {
            let weight = policy
                .fairness_weight
                .filter(|weight| weight.is_finite())
                .unwrap_or(1.0)
                .clamp(0.1, 100.0);
            (policy.application.clone(), weight)
        })
        .collect()
}

async fn job_dispatch_loop(state: EdgeState) {
    let slots = Arc::new(Semaphore::new(state.config.job_worker_concurrency.max(1)));
    loop {
        if state.drain.is_draining() {
            tokio::select! {
                _ = state.jobs.changed.notified() => {}
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
            continue;
        }
        let first_permit = slots
            .clone()
            .acquire_owned()
            .await
            .expect("job slot semaphore remains open");
        let weights = state
            .store
            .snapshot()
            .await
            .map(|store| application_fairness_weights(&store))
            .unwrap_or_default();
        let mut dispatched = false;
        let mut next_permit = Some(first_permit);
        while let Some(permit) = next_permit.take() {
            let Some(job_activity) = state.drain.admit(ActivityKind::Job) else {
                drop(permit);
                break;
            };
            let job = match state.jobs.acquire_next(&weights).await {
                Ok(Some(job)) => job,
                Ok(None) => {
                    drop(job_activity);
                    drop(permit);
                    break;
                }
                Err(error) => {
                    eprintln!("job acquisition paused: {error}");
                    drop(job_activity);
                    drop(permit);
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    break;
                }
            };
            dispatched = true;
            let job_state = state.clone();
            tokio::spawn(
                async move { run_claimed_job(job_state, job, permit, job_activity).await },
            );
            next_permit = slots.clone().try_acquire_owned().ok();
        }
        if dispatched {
            tokio::task::yield_now().await;
            continue;
        }
        let wake_after = state.jobs.next_wakeup().await;
        tokio::select! {
            _ = state.jobs.changed.notified() => {}
            _ = tokio::time::sleep(wake_after) => {}
        }
    }
}

async fn webhook_delivery_loop(state: EdgeState) {
    let mut last_purge_at = 0_u64;
    loop {
        if state.jobs.persistence_requires_restart() {
            return;
        }
        if state.drain.is_draining() {
            tokio::select! {
                _ = state.jobs.webhooks_changed.notified() => {}
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
            continue;
        }
        let now = now_ms();
        if now.saturating_sub(last_purge_at) >= 60_000 {
            match state.jobs.purge_due(now).await {
                Ok(()) => last_purge_at = now,
                Err(error) => {
                    eprintln!("job retention purge paused: {error}");
                    if state.jobs.persistence_requires_restart() {
                        return;
                    }
                }
            }
        }
        let deliveries = state.jobs.pending_webhook_deliveries(now).await;
        for (job, delivery) in deliveries {
            if state.jobs.persistence_requires_restart() {
                return;
            }
            let Some(_activity_lease) = state.drain.admit(ActivityKind::Job) else {
                break;
            };
            let webhook = state
                .store
                .snapshot()
                .await
                .ok()
                .and_then(|store| {
                    store
                        .application_policies
                        .into_iter()
                        .find(|policy| policy.application == job.application)
                })
                .and_then(|policy| {
                    policy.webhooks.into_iter().find(|webhook| {
                        webhook.enabled && Some(webhook.id.as_str()) == job.webhook_id.as_deref()
                    })
                });
            let Some(webhook) = webhook else {
                while let Err(error) = state
                    .jobs
                    .finish_webhook(
                        &job.id,
                        &delivery.event_id,
                        false,
                        Some("webhook is not registered or enabled".to_owned()),
                    )
                    .await
                {
                    eprintln!("webhook state persistence paused: {error}");
                    if state.jobs.persistence_requires_restart() {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                continue;
            };
            let payload = serde_json::to_vec(&json!({
                "id": delivery.event_id,
                "type": "job.completed",
                "createdAt": chrono::Utc::now().to_rfc3339(),
                "data": {"job": public_job(&job), "result": job.result},
            }))
            .unwrap_or_else(|_| b"{}".to_vec());
            let mut signer = <HmacSha256 as Mac>::new_from_slice(webhook.secret.as_bytes())
                .expect("HMAC accepts keys of every size");
            signer.update(&payload);
            let signature = format!("sha256={}", hex_bytes(&signer.finalize().into_bytes()));
            let result = timeout(
                Duration::from_secs(10),
                state
                    .webhook_client
                    .post(&webhook.url)
                    .header(header::CONTENT_TYPE, "application/json")
                    .header("x-multivibe-event-id", &delivery.event_id)
                    .header("x-multivibe-signature", signature)
                    .body(payload)
                    .send(),
            )
            .await;
            let (succeeded, error) = match result {
                Ok(Ok(response)) if response.status().is_success() => (true, None),
                Ok(Ok(response)) => (
                    false,
                    Some(format!("webhook returned {}", response.status())),
                ),
                Ok(Err(error)) => (false, Some(error.to_string())),
                Err(_) => (false, Some("webhook request timed out".to_owned())),
            };
            while let Err(persist_error) = state
                .jobs
                .finish_webhook(&job.id, &delivery.event_id, succeeded, error.clone())
                .await
            {
                eprintln!("webhook completion persistence paused: {persist_error}");
                if state.jobs.persistence_requires_restart() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
        tokio::select! {
            _ = state.jobs.webhooks_changed.notified() => {}
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
    }
}

async fn run_claimed_job(
    state: EdgeState,
    running: Job,
    permit: tokio::sync::OwnedSemaphorePermit,
    _job_activity: ActivityLease,
) {
    if state.drain.is_draining() {
        while let Err(error) = state.jobs.release_for_drain(&running.id).await {
            eprintln!("job drain release paused: {error}");
            if state.jobs.persistence_requires_restart() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        release_job_slot(permit, &state.jobs);
        return;
    }
    let headers = running
        .request_headers
        .iter()
        .filter_map(|(name, value)| {
            Some((
                HeaderName::try_from(name).ok()?,
                HeaderValue::from_str(value).ok()?,
            ))
        })
        .collect::<HeaderMap>();
    let execution = proxy_inference(
        &state,
        &running.route,
        &headers,
        &running.request_body,
        &running.application,
        None,
    );
    let result = if let Some(deadline) = running.deadline_at {
        match timeout(
            Duration::from_millis(deadline.saturating_sub(now_ms()).max(1)),
            execution,
        )
        .await
        {
            Ok(result) => result,
            Err(_) => {
                while let Err(error) = state
                    .jobs
                    .fail(&running.id, "job deadline expired while running", false)
                    .await
                {
                    eprintln!("job deadline persistence paused: {error}");
                    if state.jobs.persistence_requires_restart() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                release_job_slot(permit, &state.jobs);
                return;
            }
        }
    } else {
        execution.await
    };
    match result {
        Ok(ProxyResult::Buffered(reply)) if reply.status.is_success() => {
            while let Err(error) = state.jobs.succeed(&running.id, reply.clone()).await {
                eprintln!("job success persistence paused: {error}");
                if state.jobs.persistence_requires_restart() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
        Ok(ProxyResult::Buffered(reply)) => {
            let status = reply.status;
            let message = serde_json::from_slice::<Value>(&reply.body)
                .ok()
                .and_then(|body| {
                    value_string(body.get("error").and_then(|error| error.get("message")))
                        .or_else(|| value_string(body.get("error")))
                })
                .unwrap_or_else(|| format!("deferred upstream returned {status}"));
            while let Err(error) = state
                .jobs
                .fail(
                    &running.id,
                    &message,
                    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error(),
                )
                .await
            {
                eprintln!("job failure persistence paused: {error}");
                if state.jobs.persistence_requires_restart() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
        Ok(ProxyResult::Streaming(_)) => {
            while let Err(error) = state
                .jobs
                .fail(&running.id, "deferred jobs cannot return a stream", false)
                .await
            {
                eprintln!("job stream failure persistence paused: {error}");
                if state.jobs.persistence_requires_restart() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
        Err(error) => {
            let status = error.status();
            let bytes = to_bytes(error.into_body(), 1024 * 1024)
                .await
                .unwrap_or_default();
            let parsed = serde_json::from_slice::<Value>(&bytes).ok();
            let error_code = parsed
                .as_ref()
                .and_then(|body| body.get("error"))
                .and_then(|error| error.get("code"))
                .and_then(Value::as_str);
            if error_code == Some("host_update_draining") {
                while let Err(error) = state.jobs.release_for_drain(&running.id).await {
                    eprintln!("job drain release paused: {error}");
                    if state.jobs.persistence_requires_restart() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                release_job_slot(permit, &state.jobs);
                return;
            }
            if error_code == Some("capacity_unavailable") {
                while let Err(error) = state
                    .jobs
                    .reschedule_for_capacity(&running.id, JOB_CAPACITY_WAIT_MS)
                    .await
                {
                    eprintln!("job capacity persistence paused: {error}");
                    if state.jobs.persistence_requires_restart() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                release_job_slot(permit, &state.jobs);
                return;
            }
            let message = parsed
                .and_then(|body| {
                    value_string(body.get("error").and_then(|error| error.get("message")))
                })
                .unwrap_or_else(|| format!("deferred inference failed with {status}"));
            while let Err(error) = state
                .jobs
                .fail(
                    &running.id,
                    &message,
                    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error(),
                )
                .await
            {
                eprintln!("job failure persistence paused: {error}");
                if state.jobs.persistence_requires_restart() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
    release_job_slot(permit, &state.jobs);
}

fn release_job_slot(permit: tokio::sync::OwnedSemaphorePermit, jobs: &JobManager) {
    drop(permit);
    jobs.notify_changed();
}

fn set_idempotency_status(headers: &mut Vec<(String, String)>, status: &str) {
    headers.retain(|(name, _)| !name.eq_ignore_ascii_case(idempotency::STATUS_HEADER));
    headers.push((idempotency::STATUS_HEADER.to_owned(), status.to_owned()));
}

fn set_response_idempotency_status(response: &mut Response, status: &str) {
    if let Ok(value) = HeaderValue::from_str(status) {
        response
            .headers_mut()
            .insert(HeaderName::from_static(idempotency::STATUS_HEADER), value);
    }
}

fn response_from_idempotency(response: idempotency::StoredResponse, status: &str) -> Response {
    let mut reply = BufferedReply {
        status: response.status,
        headers: response.headers,
        body: response.body,
    };
    set_idempotency_status(&mut reply.headers, status);
    response_from_buffer(reply)
}

fn idempotency_error(path: &str, status: StatusCode, code: &str, message: &str) -> Response {
    if idempotency::normalized_route(path) == Some("/messages") {
        json_response(
            status,
            json!({
                "type": "error",
                "error": {"type": "invalid_request_error", "message": message},
            }),
        )
    } else {
        json_response(
            status,
            json!({
                "error": {
                    "message": message,
                    "type": "invalid_request_error",
                    "code": code,
                },
            }),
        )
    }
}

fn safe_job_headers(headers: &HeaderMap) -> HeaderMap {
    let mut result = HeaderMap::new();
    for (name, value) in headers {
        let normalized = name.as_str();
        if matches!(
            normalized,
            "authorization" | "x-api-key" | "api-key" | "cookie" | "host" | "content-length"
        ) {
            continue;
        }
        if normalized.starts_with("x-multivibe-internal") {
            continue;
        }
        result.insert(name.clone(), value.clone());
    }
    result
}

fn add_decision_headers(reply: &mut BufferedReply, priority: Option<&str>, model: &str) {
    reply.headers.retain(|(name, _)| {
        !matches!(
            name.as_str(),
            "x-multivibe-decision" | "x-multivibe-priority" | "x-multivibe-resolved-model"
        )
    });
    reply
        .headers
        .push(("x-multivibe-decision".to_owned(), "cloud".to_owned()));
    reply.headers.push((
        "x-multivibe-priority".to_owned(),
        priority.unwrap_or("standard").to_owned(),
    ));
    if !model.is_empty() {
        reply
            .headers
            .push(("x-multivibe-resolved-model".to_owned(), model.to_owned()));
    }
}

async fn inference_handler(State(state): State<EdgeState>, req: Request<Body>) -> Response {
    let path = req.uri().path().to_owned();
    let request_headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    let auth = match authorize(&request_headers, &path, &store, &state.config) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let (mut headers, body, _) = match read_json_body(
        req,
        if path.ends_with("/messages") {
            state.config.request_body_limit.min(100 * 1024 * 1024)
        } else {
            state.config.request_body_limit
        },
        path.ends_with("/messages"),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    let model = value_string(body.get("model")).unwrap_or_else(|| {
        state
            .config
            .proxy_models
            .first()
            .cloned()
            .unwrap_or_default()
    });
    apply_alias_defaults(&mut headers, &store, &model);
    if let Err(response) = validate_routing_headers(&headers, &store, &auth.application) {
        return response;
    }
    let client_stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let raw_execution = header_value(&headers, "x-multivibe-execution");
    if client_stream && raw_execution.as_deref() == Some("defer") {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Streaming, WebSocket and Realtime requests cannot be deferred.",
            "stream_cannot_be_deferred",
        );
    }
    let confidential = match confidential_requested(&state.config, &headers) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if confidential && !confidential_path_supported(&path) {
        return privacy_error(
            StatusCode::CONFLICT,
            "confidential_surface_not_supported",
            "This request is not yet supported by verified confidential computing.",
        );
    }
    if confidential && raw_execution.as_deref() == Some("defer") {
        return privacy_error(
            StatusCode::CONFLICT,
            "confidential_surface_not_supported",
            "Verified confidential requests cannot be stored as deferred jobs.",
        );
    }
    let route = idempotency::normalized_route(&path);
    let request_idempotency = header_value(&headers, "x-multivibe-idempotency-key")
        .map(|key| key.trim().to_owned())
        .filter(|key| !key.is_empty());
    if route.is_some()
        && request_idempotency
            .as_ref()
            .is_some_and(|key| key.len() > 200)
    {
        return idempotency_error(
            &path,
            StatusCode::BAD_REQUEST,
            "invalid_idempotency_key",
            "X-MultiVibe-Idempotency-Key is too long",
        );
    }

    let skip_idempotency = raw_execution.as_deref() == Some("defer")
        || header_value(&headers, "x-multivibe-internal-job").as_deref() == Some("1");
    let mut idempotency_leader = None;
    let mut idempotency_status = confidential.then_some("bypass");
    if !confidential
        && !skip_idempotency
        && let (Some(route), Some(key)) = (route, request_idempotency.as_deref())
    {
        if !idempotency::is_eligible_body(&body) {
            idempotency_status = Some("bypass");
        } else {
            let scope = idempotency::scope(&auth.application, route, key);
            let request_hash = idempotency::request_hash(&body, &headers);
            loop {
                match state
                    .idempotency
                    .claim(scope.clone(), request_hash.clone())
                    .await
                {
                    idempotency::Claim::Leader(leader) => {
                        idempotency_leader = Some(leader);
                        idempotency_status = Some("created");
                        break;
                    }
                    idempotency::Claim::Follower(follower) => {
                        if let Some(response) = follower.wait().await {
                            return response_from_idempotency(response, "coalesced");
                        }
                    }
                    idempotency::Claim::Replay(response) => {
                        return response_from_idempotency(response, "replayed");
                    }
                    idempotency::Claim::Conflict => {
                        return idempotency_error(
                            &path,
                            StatusCode::CONFLICT,
                            "idempotency_key_reused",
                            "This idempotency key was already used with a different request payload.",
                        );
                    }
                    idempotency::Claim::Bypass => {
                        idempotency_status = Some("bypass");
                        break;
                    }
                }
            }
        }
    }
    if raw_execution.as_deref() == Some("defer") {
        let job_headers = safe_job_headers(&headers);
        let created = match state
            .jobs
            .create(
                &auth.application,
                &path,
                &job_headers,
                &body,
                default_job_max_attempts(),
            )
            .await
        {
            Ok(created) => created,
            Err(JobCreateError::InvalidPriority) => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "X-MultiVibe-Priority must be critical, interactive, standard, or batch",
                    "invalid_priority",
                );
            }
            Err(JobCreateError::InvalidDeadline) => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "X-MultiVibe-Deadline must be RFC 3339",
                    "invalid_deadline",
                );
            }
            Err(JobCreateError::ExpiredDeadline) => {
                return error_response(
                    StatusCode::REQUEST_TIMEOUT,
                    "deadline already expired",
                    "deadline_expired",
                );
            }
            Err(JobCreateError::IdempotencyConflict) => {
                return idempotency_error(
                    &path,
                    StatusCode::CONFLICT,
                    "idempotency_key_reused",
                    "This idempotency key was already used with a different deferred request payload.",
                );
            }
            Err(JobCreateError::Persistence(error)) => {
                return error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    error,
                    "job_store_unavailable",
                );
            }
        };
        let mut response = json_response(StatusCode::ACCEPTED, public_job(&created.job));
        if let Ok(location) = HeaderValue::from_str(&format!("/v1/jobs/{}", created.job.id)) {
            response.headers_mut().insert(header::LOCATION, location);
        }
        response.headers_mut().insert(
            HeaderName::from_static("x-multivibe-decision"),
            HeaderValue::from_static("queued"),
        );
        if let Ok(priority) = HeaderValue::from_str(&created.job.priority) {
            response
                .headers_mut()
                .insert(HeaderName::from_static("x-multivibe-priority"), priority);
        }
        set_response_idempotency_status(
            &mut response,
            if created.created {
                "created"
            } else {
                "replayed"
            },
        );
        return response;
    }
    match proxy_inference(
        &state,
        &path,
        &headers,
        &body,
        &auth.application,
        Some(ActivityKind::Request),
    )
    .await
    {
        Ok(ProxyResult::Buffered(mut reply)) => {
            add_decision_headers(
                &mut reply,
                header_value(&headers, "x-multivibe-priority").as_deref(),
                &model,
            );
            if let Some(status) = idempotency_status {
                set_idempotency_status(&mut reply.headers, status);
            }
            if let Some(leader) = idempotency_leader {
                let stored = idempotency::StoredResponse::new(
                    reply.status,
                    &reply.headers,
                    reply.body.clone(),
                );
                leader.complete(stored).await;
            }
            response_from_buffer(reply)
        }
        Ok(ProxyResult::Streaming(mut reply)) => {
            // Decision headers are added before the streaming body is exposed.
            reply.headers.retain(|(name, _)| {
                !matches!(
                    name.as_str(),
                    "x-multivibe-decision" | "x-multivibe-priority" | "x-multivibe-resolved-model"
                )
            });
            reply
                .headers
                .push(("x-multivibe-decision".to_owned(), "cloud".to_owned()));
            reply.headers.push((
                "x-multivibe-priority".to_owned(),
                header_value(&headers, "x-multivibe-priority")
                    .unwrap_or_else(|| "standard".to_owned()),
            ));
            if !model.is_empty() {
                reply
                    .headers
                    .push(("x-multivibe-resolved-model".to_owned(), model));
            }
            if let Some(status) = idempotency_status {
                set_idempotency_status(&mut reply.headers, status);
            }
            streaming_response(reply)
        }
        Err(mut response) => {
            if let Some(status) = idempotency_status {
                set_response_idempotency_status(&mut response, status);
            }
            if let Some(leader) = idempotency_leader {
                leader.fail().await;
            }
            response
        }
    }
}

async fn method_not_allowed() -> Response {
    error_response(
        StatusCode::METHOD_NOT_ALLOWED,
        "This endpoint only accepts POST requests",
        "method_not_allowed",
    )
}

fn model_entry(
    id: &str,
    provider: &str,
    account_ids: Vec<String>,
    alias: bool,
    alias_targets: Vec<String>,
) -> Value {
    let mut metadata = json!({
        "provider": provider,
        "provider_candidates": [provider],
        "account_ids": account_ids,
        "context_window": Value::Null,
        "max_output_tokens": Value::Null,
        "supports_reasoning": provider == "openai",
        "supports_tools": true,
        "supported_tool_types": ["function"],
    });
    if alias {
        metadata["is_alias"] = Value::Bool(true);
        metadata["alias_targets"] =
            Value::Array(alias_targets.into_iter().map(Value::String).collect());
    }
    json!({"id": id, "object": "model", "created": 0, "owned_by": provider, "metadata": metadata})
}

fn model_entry_from_upstream(
    id: &str,
    provider: &str,
    account_id: &str,
    upstream: &Value,
) -> Value {
    let mut entry = model_entry(id, provider, vec![account_id.to_owned()], false, Vec::new());
    let metadata = entry
        .get_mut("metadata")
        .and_then(Value::as_object_mut)
        .expect("model_entry always creates metadata");
    for (destination, alternatives) in [
        (
            "context_window",
            &[
                "context_window",
                "contextWindow",
                "context_length",
                "max_context_tokens",
                "max_input_tokens",
            ][..],
        ),
        (
            "max_output_tokens",
            &[
                "max_output_tokens",
                "maxOutputTokens",
                "max_completion_tokens",
            ][..],
        ),
    ] {
        if let Some(value) = alternatives.iter().find_map(|key| upstream.get(*key)) {
            if value.is_number() {
                metadata.insert(destination.to_owned(), value.clone());
            }
        }
    }
    for (destination, source) in [
        ("supports_reasoning", "supports_reasoning"),
        ("supports_tools", "supports_tools"),
    ] {
        if let Some(value) = upstream.get(source).and_then(Value::as_bool) {
            metadata.insert(destination.to_owned(), Value::Bool(value));
        }
    }
    if let Some(types) = upstream
        .get("supported_tool_types")
        .or_else(|| upstream.get("supportedToolTypes"))
        .or_else(|| upstream.get("tool_types"))
        .and_then(Value::as_array)
    {
        let types = types
            .iter()
            .filter_map(Value::as_str)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        if !types.is_empty() {
            metadata.insert("supported_tool_types".to_owned(), json!(types));
        }
    }
    if provider == "ai-sdk" {
        for key in ["catalog_source", "catalog_fetched_at", "pricing", "input_modalities"] {
            if let Some(value) = upstream.get(key) { metadata.insert(key.to_owned(), value.clone()); }
        }
        if let Some(value) = upstream.get("owned_by") { metadata.insert("sdk_provider".to_owned(), value.clone()); }
    }
    if provider == "openai" && upstream.is_object() {
        entry["codexModelInfo"] = upstream.clone();
    }
    entry
}

fn merge_model_entry(existing: &mut Value, next: Value) {
    let Some(existing_metadata) = existing.get_mut("metadata").and_then(Value::as_object_mut)
    else {
        *existing = next;
        return;
    };
    let Some(next_metadata) = next.get("metadata").and_then(Value::as_object) else {
        return;
    };
    for key in ["provider_candidates", "account_ids"] {
        let mut values = existing_metadata
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(next_values) = next_metadata.get(key).and_then(Value::as_array) {
            for value in next_values {
                if !values.contains(value) {
                    values.push(value.clone());
                }
            }
        }
        existing_metadata.insert(key.to_owned(), Value::Array(values));
    }
    for key in [
        "context_window",
        "max_output_tokens",
        "supports_reasoning",
        "supports_tools",
        "supported_tool_types",
    ] {
        if existing_metadata.get(key).is_none_or(Value::is_null)
            && let Some(value) = next_metadata.get(key)
        {
            existing_metadata.insert(key.to_owned(), value.clone());
        }
    }
    if existing.get("codexModelInfo").is_none()
        && let Some(value) = next.get("codexModelInfo")
    {
        existing["codexModelInfo"] = value.clone();
    }
}

fn upsert_model(models: &mut Vec<Value>, next: Value) {
    let Some(id) = next.get("id").and_then(Value::as_str) else {
        return;
    };
    if let Some(existing) = models.iter_mut().find(|entry| {
        entry
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|value| normalize_model_key(value) == normalize_model_key(id))
    }) {
        merge_model_entry(existing, next);
    } else {
        models.push(next);
    }
}

fn static_exposed_models(store: &StoreFile, config: &EdgeConfig) -> Vec<Value> {
    let mut models = Vec::new();
    for model in &config.proxy_models {
        upsert_model(
            &mut models,
            model_entry(model, &infer_provider(model), Vec::new(), false, Vec::new()),
        );
    }
    for account in &store.accounts {
        if !account.enabled {
            continue;
        }
        if let Some(runtime) = account.local_runtime.as_ref() {
            for model in &runtime.confirmed_model_ids {
                upsert_model(
                    &mut models,
                    model_entry(
                        model,
                        &normalize_provider(account),
                        vec![account.id.clone()],
                        false,
                        Vec::new(),
                    ),
                );
            }
        }
    }
    for alias in store.model_aliases.iter().filter(|alias| alias.enabled) {
        let targets = alias
            .rules
            .iter()
            .flat_map(|rule| {
                rule.candidates
                    .iter()
                    .map(|candidate| candidate.model.clone())
            })
            .collect::<Vec<_>>();
        if targets.is_empty() {
            continue;
        }
        upsert_model(
            &mut models,
            model_entry(
                &alias.id,
                &infer_provider(&targets[0]),
                Vec::new(),
                true,
                targets,
            ),
        );
    }
    models
}

fn catalog_signature(store: &StoreFile, config: &EdgeConfig) -> String {
    let account_configuration = store
        .accounts
        .iter()
        .map(|account| {
            json!({
                "id": account.id,
                "provider": account.provider,
                "sdk_provider": account.sdk_provider,
                "sdk_models": account.sdk_models,
                "upstream_mode": account.upstream_mode,
                "compatibility_mode": account.compatibility_mode,
                "base_url": account.base_url,
                "enabled": account.enabled,
                "location": account.location,
                "chatgpt_account_id": account.chatgpt_account_id,
                "access_token": secret_signature(Some(&account.access_token)),
                "opencode_api_key": secret_signature(account.opencode_api_key.as_deref()),
                "opencode_headers": account.opencode_headers,
                "opencode_org_id": account.opencode_org_id,
                "local_runtime": account.local_runtime,
            })
        })
        .collect::<Vec<_>>();
    let value = json!({
        "proxy_models": config.proxy_models,
        "accounts": account_configuration,
        "model_aliases": store.model_aliases,
    });
    let digest = Sha256::digest(serde_json::to_vec(&value).unwrap_or_default());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn account_model_source_signature(account: &Account, config: &EdgeConfig) -> String {
    let value = json!({
        "id": account.id,
        "provider": account.provider,
        "discovery_url": model_discovery_url(account, config),
        "sdk_provider": account.sdk_provider,
        "sdk_models": account.sdk_models,
        "chatgpt_account_id": account.chatgpt_account_id,
        "opencode_headers": account.opencode_headers,
        "opencode_org_id": account.opencode_org_id,
        "local_runtime": account.local_runtime,
        "models_client_version": config.models_client_version,
        "zai_models_path": config.zai_models_path,
        "xai_models_path": config.xai_models_path,
    });
    let digest = Sha256::digest(serde_json::to_vec(&value).unwrap_or_default());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn secret_signature(value: Option<&str>) -> Option<String> {
    let value = value.filter(|value| !value.is_empty())?;
    Some(
        Sha256::digest(value.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

fn model_discovery_url(account: &Account, config: &EdgeConfig) -> String {
    let provider = normalize_provider(account);
    let base = if provider == "openai-compatible" {
        account.base_url.clone().unwrap_or_default()
    } else if provider == "opencode" {
        let configured = account
            .base_url
            .clone()
            .unwrap_or_else(|| "https://opencode.ai/zen".to_owned());
        if configured.eq_ignore_ascii_case("https://opencode.ai/inference/openai") {
            "https://opencode.ai/zen".to_owned()
        } else {
            configured
        }
    } else {
        account_base_url(account, config)
    };
    if provider == "openai" {
        return format!(
            "{}/backend-api/codex/models?client_version={}",
            trim_slashes(&base),
            config.models_client_version
        );
    }
    if provider == "xai" {
        return format!("{}{}", trim_slashes(&base), config.xai_models_path.as_str());
    }
    if provider == "zai" {
        return format!("{}{}", trim_slashes(&base), config.zai_models_path.as_str());
    }
    let path = "/v1/models";
    if base.ends_with("/v1") {
        format!("{}{}", trim_slashes(&base), &path[3..])
    } else {
        format!("{}{}", trim_slashes(&base), path)
    }
}

fn model_discovery_headers(account: &Account, config: &EdgeConfig) -> HeaderMap {
    let provider = normalize_provider(account);
    let mut headers = HeaderMap::new();
    set_header(&mut headers, "accept", "application/json");
    let token = if provider == "ai-sdk" { config.internal_job_token.as_deref().unwrap_or("") }
        else { account_inference_token(account) };
    if !token.is_empty() && !is_local_runtime(account) {
        set_header(&mut headers, "authorization", format!("Bearer {token}"));
    }
    if provider == "openai"
        && let Some(account_id) = account.chatgpt_account_id.as_deref()
    {
        set_header(&mut headers, "chatgpt-account-id", account_id);
    }
    if provider == "xai" {
        set_header(&mut headers, "x-xai-token-auth", "xai-grok-cli");
        set_header(&mut headers, "x-grok-client-version", "0.2.114");
        set_header(&mut headers, "x-grok-client-identifier", "grok-pager");
        set_header(&mut headers, "user-agent", "grok-pager/0.2.114");
    }
    if provider == "opencode" {
        apply_opencode_headers(account, &mut headers);
    }
    headers
}

fn upstream_model_entries(provider: &str, value: &Value) -> Vec<(String, Value)> {
    if provider == "openai" {
        return value
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                let id = entry.get("slug").and_then(Value::as_str)?.trim();
                (!id.is_empty()).then(|| (id.to_owned(), entry.clone()))
            })
            .collect();
    }
    if let Some(entries) = value.as_array() {
        return entries
            .iter()
            .filter_map(|entry| {
                let id = entry
                    .get("id")
                    .or_else(|| entry.get("name"))
                    .and_then(Value::as_str)?
                    .trim();
                (!id.is_empty()).then(|| (id.to_owned(), entry.clone()))
            })
            .collect();
    }
    if let Some(entries) = value.get("data").and_then(Value::as_array) {
        return entries
            .iter()
            .filter_map(|entry| {
                let id = entry
                    .get("id")
                    .or_else(|| entry.get("name"))
                    .and_then(Value::as_str)?
                    .trim();
                (!id.is_empty()).then(|| (id.to_owned(), entry.clone()))
            })
            .collect();
    }
    value
        .get("models")
        .and_then(Value::as_object)
        .map(|entries| {
            entries
                .iter()
                .map(|(id, entry)| (id.clone(), entry.clone()))
                .collect()
        })
        .unwrap_or_default()
}

async fn discover_account_models(
    state: &EdgeState,
    account: &Account,
) -> Result<Vec<Value>, String> {
    let provider = normalize_provider(&account);
    let url = model_discovery_url(&account, &state.config);
    let response = match timeout(
        Duration::from_secs(3),
        state
            .client
            .get(url)
            .headers(model_discovery_headers(&account, &state.config))
            .send(),
    )
    .await
    {
        Ok(Ok(response)) if response.status().is_success() => response,
        Ok(Ok(response)) => {
            return Err(format!(
                "model discovery returned HTTP {}",
                response.status().as_u16()
            ));
        }
        Ok(Err(error)) => return Err(format!("model discovery request failed: {error}")),
        Err(_) => return Err("model discovery request timed out".to_owned()),
    };
    let bytes = match timeout(Duration::from_secs(3), response.bytes()).await {
        Ok(Ok(bytes)) if bytes.len() <= 4 * 1024 * 1024 => bytes,
        Ok(Ok(_)) => return Err("model discovery response exceeded 4 MiB".to_owned()),
        Ok(Err(error)) => return Err(format!("model discovery response failed: {error}")),
        Err(_) => return Err("model discovery response timed out".to_owned()),
    };
    let value = match serde_json::from_slice::<Value>(&bytes) {
        Ok(value) => value,
        Err(error) => return Err(format!("model discovery returned invalid JSON: {error}")),
    };
    let models = upstream_model_entries(&provider, &value)
        .into_iter()
        .map(|(id, entry)| model_entry_from_upstream(&id, &provider, &account.id, &entry))
        .collect::<Vec<_>>();
    if models.is_empty() {
        Err("model discovery returned no models".to_owned())
    } else {
        Ok(models)
    }
}

fn model_catalog_retry_delay(ttl: Duration, consecutive_failures: u32) -> Duration {
    let exponent = consecutive_failures.saturating_sub(1).min(4);
    let seconds = 60_u64.saturating_mul(1_u64 << exponent);
    Duration::from_secs(seconds).min(ttl.max(Duration::from_secs(1)))
}

async fn exposed_models(state: &EdgeState, store: &StoreFile, force: bool) -> Vec<Value> {
    let _refresh_guard = state.model_catalog_refresh.lock().await;
    let signature = catalog_signature(store, &state.config);
    let now = now_ms();
    {
        let cache = state.model_catalog.lock().await;
        if !force
            && cache.signature == signature
            && cache.next_refresh_at > now
            && !cache.models.is_empty()
        {
            return cache.models.clone();
        }
    }

    let mut models = static_exposed_models(store, &state.config);
    let active_accounts = store
        .accounts
        .iter()
        .filter(|account| {
            account.enabled
                && (!account_inference_token(account).is_empty() || is_local_runtime(account))
        })
        .cloned()
        .collect::<Vec<_>>();
    let discovered = join_all(
        active_accounts
            .iter()
            .map(|account| discover_account_models(state, account)),
    )
    .await;

    let active_ids = active_accounts
        .iter()
        .map(|account| account.id.clone())
        .collect::<HashSet<_>>();
    let mut cache = state.model_catalog.lock().await;
    cache
        .accounts
        .retain(|account_id, _| active_ids.contains(account_id));
    let mut failed = 0_u32;
    for (account, discovery) in active_accounts.iter().zip(discovered) {
        let source_signature = account_model_source_signature(account, &state.config);
        let account_cache = cache.accounts.entry(account.id.clone()).or_default();
        if account_cache.source_signature != source_signature {
            *account_cache = AccountModelCatalogCache {
                source_signature: source_signature.clone(),
                ..AccountModelCatalogCache::default()
            };
        }
        account_cache.last_attempt_at = now;
        let entries = match discovery {
            Ok(entries) => {
                account_cache.last_success_at = now;
                account_cache.models = entries.clone();
                account_cache.last_error = None;
                entries
            }
            Err(error) => {
                failed += 1;
                account_cache.last_error = Some(error);
                account_cache.models.clone()
            }
        };
        for entry in entries {
            upsert_model(&mut models, entry);
        }
    }

    cache.signature = signature;
    cache.last_attempt_at = now;
    if failed == 0 {
        cache.fetched_at = now;
        cache.consecutive_failures = 0;
        cache.next_refresh_at =
            now.saturating_add(state.config.models_cache_ttl.as_millis() as u64);
    } else {
        cache.consecutive_failures = cache.consecutive_failures.saturating_add(1);
        cache.next_refresh_at = now.saturating_add(
            model_catalog_retry_delay(state.config.models_cache_ttl, cache.consecutive_failures)
                .as_millis() as u64,
        );
    }
    cache.models = models.clone();
    models
}

async fn model_catalog_metadata(state: &EdgeState) -> Value {
    let cache = state.model_catalog.lock().await;
    let mut accounts = cache
        .accounts
        .iter()
        .map(|(account_id, account)| {
            json!({
                "accountId": account_id,
                "modelCount": account.models.len(),
                "lastSuccessAt": (account.last_success_at > 0).then_some(account.last_success_at),
                "lastAttemptAt": (account.last_attempt_at > 0).then_some(account.last_attempt_at),
                "lastError": account.last_error,
            })
        })
        .collect::<Vec<_>>();
    accounts.sort_by(|left, right| {
        left.get("accountId")
            .and_then(Value::as_str)
            .cmp(&right.get("accountId").and_then(Value::as_str))
    });
    json!({
        "refreshedAt": (cache.fetched_at > 0).then_some(cache.fetched_at),
        "lastAttemptAt": (cache.last_attempt_at > 0).then_some(cache.last_attempt_at),
        "nextRefreshAt": (cache.next_refresh_at > 0).then_some(cache.next_refresh_at),
        "stale": cache.consecutive_failures > 0,
        "accounts": accounts,
    })
}

impl EdgeState {
    pub fn start_model_catalog_monitor(&self) -> tokio::task::JoinHandle<()> {
        let state = self.clone();
        tokio::spawn(async move {
            let poll_interval = state
                .config
                .models_cache_ttl
                .min(Duration::from_secs(60))
                .max(Duration::from_secs(1));
            let mut timer = tokio::time::interval(poll_interval);
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                timer.tick().await;
                match state.store.snapshot().await {
                    Ok(store) => {
                        let _ = exposed_models(&state, &store, false).await;
                    }
                    Err(error) => eprintln!("[model-cache] failed to read store: {error}"),
                }
            }
        })
    }
}

fn openai_model_shape(model: &Value) -> Value {
    let mut value = model.clone();
    if let Some(object) = value.as_object_mut() {
        object.remove("codexModelInfo");
    }
    value
}

fn codex_model_shape(model: &Value) -> Option<Value> {
    if let Some(value) = model.get("codexModelInfo") {
        return Some(value.clone());
    }
    let metadata = model.get("metadata")?;
    let provider = metadata.get("provider")?.as_str()?;
    let is_text_capable_ai_sdk_model = provider == "ai-sdk"
        && metadata
            .get("input_modalities")
            .and_then(Value::as_array)
            .is_some_and(|modalities| modalities.iter().any(|value| value.as_str() == Some("text")));
    if provider != "zai" && provider != "openai-compatible" && !is_text_capable_ai_sdk_model {
        return None;
    }
    let id = model.get("id").and_then(Value::as_str)?;
    // Non-chat runtimes share the OpenAI-compatible model endpoint.
    if id.to_ascii_lowercase().split(['-', '_', '/']).any(|part| {
        matches!(part, "tts" | "asr" | "whisper" | "kokoro" | "embed" | "embedding" | "rerank" | "reranker")
    }) {
        return None;
    }
    let provider_name = match provider {
        "zai" => "z.ai",
        "ai-sdk" => "AI SDK",
        _ => "OpenAI-compatible",
    };
    Some(json!({
        "slug": id,
        "display_name": id,
        "description": format!("{provider_name} model {id}"),
        "base_instructions": "",
        "supported_reasoning_levels": [],
        "shell_type": "shell_command",
        "visibility": "list",
        "supported_in_api": true,
        "priority": 100,
        "support_verbosity": false,
        "truncation_policy": {"mode": "tokens", "limit": 10000},
        "experimental_supported_tools": [],
    }))
}

fn models_list_response(models: &[Value], catalog: Value) -> Value {
    let data = models.iter().map(openai_model_shape).collect::<Vec<_>>();
    let native = models
        .iter()
        .filter_map(codex_model_shape)
        .collect::<Vec<_>>();
    json!({"object": "list", "data": data, "models": native, "catalog": catalog})
}

#[derive(Debug, Deserialize)]
struct ModelsQuery {
    refresh: Option<bool>,
}

async fn list_models_handler(
    State(state): State<EdgeState>,
    Query(query): Query<ModelsQuery>,
    req: Request<Body>,
) -> Response {
    let headers = req.headers().clone();
    let path = req.uri().path();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    if let Err(response) = authorize(&headers, path, &store, &state.config) {
        return response;
    }
    if is_claude_code_request(&headers) {
        return json_response(
            StatusCode::OK,
            json!({"object": "list", "data": [
                {"id": "claude-opus-4-1", "object": "model", "created": 0, "owned_by": "anthropic"},
                {"id": "claude-sonnet-4-5", "object": "model", "created": 0, "owned_by": "anthropic"},
                {"id": "claude-haiku-4-5", "object": "model", "created": 0, "owned_by": "anthropic"}
            ]}),
        );
    }
    let models = exposed_models(&state, &store, query.refresh.unwrap_or(false)).await;
    let catalog = model_catalog_metadata(&state).await;
    json_response(StatusCode::OK, models_list_response(&models, catalog))
}

async fn get_model_handler(
    State(state): State<EdgeState>,
    Path(id): Path<String>,
    req: Request<Body>,
) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    if let Err(response) = authorize(&headers, req.uri().path(), &store, &state.config) {
        return response;
    }
    let models = exposed_models(&state, &store, false).await;
    let model = models.into_iter().find(|model| {
        model
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|value| value == id)
    });
    match model {
        Some(model) => json_response(StatusCode::OK, openai_model_shape(&model)),
        None => json_response(
            StatusCode::NOT_FOUND,
            json!({"error": {"message": format!("The model '{id}' does not exist"), "type": "invalid_request_error"}}),
        ),
    }
}

async fn ollama_tags_handler(State(state): State<EdgeState>, req: Request<Body>) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    if let Err(response) = authorize(&headers, req.uri().path(), &store, &state.config) {
        return response;
    }
    let models = exposed_models(&state, &store, false)
        .await
        .into_iter()
        .filter_map(|model| {
            let id = model.get("id")?.as_str()?.to_owned();
            let provider = model
                .get("metadata")
                .and_then(|metadata| metadata.get("provider"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            Some(json!({
                "name": id,
                "model": id,
                "modified_at": "1970-01-01T00:00:00.000Z",
                "size": 0,
                "digest": id,
                "details": {
                    "family": provider,
                    "parameter_size": "unknown",
                    "quantization_level": "unknown",
                },
            }))
        })
        .collect::<Vec<_>>();
    json_response(StatusCode::OK, json!({"models": models}))
}

async fn version_handler(State(state): State<EdgeState>, req: Request<Body>) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    if let Err(response) = authorize(&headers, req.uri().path(), &store, &state.config) {
        return response;
    }
    json_response(StatusCode::OK, json!({"version": state.config.app_version}))
}

async fn props_handler(State(state): State<EdgeState>, req: Request<Body>) -> Response {
    let headers = req.headers().clone();
    let path = req.uri().path().to_owned();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    if let Err(response) = authorize(&headers, &path, &store, &state.config) {
        return response;
    }
    json_response(
        StatusCode::OK,
        json!({
            "default_model": state.config.proxy_models.first(),
            "models_url": "/v1/models",
        }),
    )
}

#[derive(Debug, Deserialize)]
struct CapacityQuery {
    model: Option<String>,
    priority: Option<String>,
}

async fn capacity_handler(
    State(state): State<EdgeState>,
    Query(query): Query<CapacityQuery>,
    req: Request<Body>,
) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    let auth = match authorize(&headers, req.uri().path(), &store, &state.config) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let Some(model) = query.model.filter(|value| !value.trim().is_empty()) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "model query parameter is required"}),
        );
    };
    let priority = query.priority.unwrap_or_else(|| "standard".to_owned());
    if !matches!(
        priority.as_str(),
        "critical" | "interactive" | "standard" | "batch"
    ) {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "invalid priority"}),
        );
    }
    let catalog = exposed_models(&state, &store, false).await;
    let route = routes_for_model(&store, &model, &model, &catalog)
        .into_iter()
        .next()
        .unwrap_or(RouteCandidate {
            requested_model: model.clone(),
            model: model.clone(),
            provider: Some(infer_provider(&model)),
            account_ids: Vec::new(),
        });
    let blocked = state.blocked.lock().await.clone();
    let selected = state.selected.lock().await.clone();
    let accounts = select_accounts(&store.accounts, &route, &blocked, &selected);
    let (free_slots, queue_depth) = state.admission.snapshot(&accounts);
    let state_name = if accounts.is_empty() {
        "unavailable"
    } else if free_slots > 0 {
        "ready"
    } else {
        "degraded"
    };
    json_response(
        StatusCode::OK,
        json!({
            "object": "multivibe.capacity",
            "model": model,
            "application": auth.application,
            "priority": priority,
            "state": state_name,
            "decision": accounts.first().and_then(|account| account.location.as_deref()).unwrap_or("cloud"),
            "admissibleLocations": accounts.iter().filter_map(|account| account.location.clone()).collect::<Vec<_>>(),
            "freeSlots": free_slots,
            "queueDepth": queue_depth,
            "recommendation": if free_slots > 0 { "sync" } else { "defer" },
            "version": state.capacity_version.load(AtomicOrdering::Relaxed),
            "generatedAt": now_ms(),
            "confidence": "declared"
        }),
    )
}

async fn capacity_events_handler(
    State(state): State<EdgeState>,
    Query(query): Query<HashMap<String, String>>,
    req: Request<Body>,
) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    if let Err(response) = authorize(&headers, req.uri().path(), &store, &state.config) {
        return response;
    }
    let after = header_value(&headers, "last-event-id")
        .or_else(|| query.get("after").cloned())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let body = stream! {
        let mut last_version = after;
        let current = state.capacity_version.load(AtomicOrdering::Relaxed);
        if current != last_version {
            last_version = current;
            yield Ok::<Bytes, Infallible>(Bytes::from(format!(
                "id: {current}\nevent: capacity.changed\ndata: {}\n\n",
                json!({"version": current}),
            )));
        }
        let mut changes = tokio::time::interval(Duration::from_millis(250));
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        changes.tick().await;
        heartbeat.tick().await;
        loop {
            tokio::select! {
                _ = changes.tick() => {
                    let current = state.capacity_version.load(AtomicOrdering::Relaxed);
                    if current == last_version { continue; }
                    last_version = current;
                    yield Ok::<Bytes, Infallible>(Bytes::from(format!(
                        "id: {current}\nevent: capacity.changed\ndata: {}\n\n",
                        json!({"version": current}),
                    )));
                }
                _ = heartbeat.tick() => {
                    yield Ok::<Bytes, Infallible>(Bytes::from(": heartbeat\n\n"));
                }
            }
        }
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

async fn list_jobs_handler(
    State(state): State<EdgeState>,
    Query(query): Query<HashMap<String, String>>,
    req: Request<Body>,
) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    let auth = match authorize(&headers, req.uri().path(), &store, &state.config) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(100);
    let jobs = state.jobs.list_for(&auth.application, limit).await;
    json_response(
        StatusCode::OK,
        json!({"object": "list", "data": jobs.iter().map(public_job).collect::<Vec<_>>() }),
    )
}

async fn get_job_handler(
    State(state): State<EdgeState>,
    Path(id): Path<String>,
    req: Request<Body>,
) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    let auth = match authorize(&headers, req.uri().path(), &store, &state.config) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    match state.jobs.get_for(&auth.application, &id).await {
        Some(job) => json_response(StatusCode::OK, public_job(&job)),
        None => json_response(StatusCode::NOT_FOUND, json!({"error": "not found"})),
    }
}

async fn get_job_result_handler(
    State(state): State<EdgeState>,
    Path(id): Path<String>,
    req: Request<Body>,
) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    let auth = match authorize(&headers, req.uri().path(), &store, &state.config) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let Some(job) = state.jobs.get_for(&auth.application, &id).await else {
        return json_response(StatusCode::NOT_FOUND, json!({"error": "not found"}));
    };
    if job.status != "succeeded" {
        if matches!(job.status.as_str(), "failed" | "cancelled" | "expired") {
            return json_response(
                StatusCode::GONE,
                json!({"error": job.error.unwrap_or_else(|| format!("job {}", job.status))}),
            );
        }
        return json_response(
            StatusCode::CONFLICT,
            json!({"error": "result is not ready", "job": public_job(&job)}),
        );
    }
    let consumed = match state.jobs.consume_result(&auth.application, &id).await {
        Ok(Some(job)) => job,
        Ok(None) => {
            return json_response(
                StatusCode::CONFLICT,
                json!({"error": "result is not ready"}),
            );
        }
        Err(error) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                error,
                "job_store_unavailable",
            );
        }
    };
    let mut reply = BufferedReply {
        status: StatusCode::OK,
        headers: consumed.response_headers.unwrap_or_default(),
        body: Bytes::from(
            serde_json::to_vec(&consumed.result.unwrap_or(Value::Null))
                .unwrap_or_else(|_| b"null".to_vec()),
        ),
    };
    reply
        .headers
        .retain(|(name, _)| PUBLIC_RESPONSE_HEADERS.contains(&name.as_str()));
    response_from_buffer(reply)
}

async fn get_job_events_handler(
    State(state): State<EdgeState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    req: Request<Body>,
) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    let auth = match authorize(&headers, req.uri().path(), &store, &state.config) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let after = header_value(&headers, "last-event-id")
        .or_else(|| query.get("after").cloned())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);
    // Subscribe before reading history so an event emitted concurrently is
    // either in the replay or queued by broadcast. The id filter removes the
    // possible overlap.
    let mut receiver = state.jobs.subscribe_events();
    let Some(initial) = state.jobs.events_after(&auth.application, &id, after).await else {
        return json_response(StatusCode::NOT_FOUND, json!({"error": "not found"}));
    };
    let jobs = state.jobs.clone();
    let application = auth.application;
    let body = stream! {
        let mut last_id = after;
        for event in initial {
            if event.id <= last_id { continue; }
            last_id = event.id;
            yield Ok::<Bytes, Infallible>(Bytes::from(format!(
                "id: {}\nevent: {}\ndata: {}\n\n",
                event.id,
                event.r#type,
                event.data,
            )));
        }
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        heartbeat.tick().await;
        loop {
            tokio::select! {
                received = receiver.recv() => match received {
                    Ok(event) => {
                        if event.job_id != id || event.application != application || event.id <= last_id {
                            continue;
                        }
                        last_id = event.id;
                        yield Ok::<Bytes, Infallible>(Bytes::from(format!(
                            "id: {}\nevent: {}\ndata: {}\n\n",
                            event.id,
                            event.r#type,
                            event.data,
                        )));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if let Some(replay) = jobs.events_after(&application, &id, last_id).await {
                            for event in replay {
                                if event.id <= last_id { continue; }
                                last_id = event.id;
                                yield Ok::<Bytes, Infallible>(Bytes::from(format!(
                                    "id: {}\nevent: {}\ndata: {}\n\n",
                                    event.id,
                                    event.r#type,
                                    event.data,
                                )));
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                _ = heartbeat.tick() => {
                    yield Ok::<Bytes, Infallible>(Bytes::from(": heartbeat\n\n"));
                }
            }
        }
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

async fn delete_job_handler(
    State(state): State<EdgeState>,
    Path(id): Path<String>,
    req: Request<Body>,
) -> Response {
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    let auth = match authorize(&headers, req.uri().path(), &store, &state.config) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    match state.jobs.cancel(&auth.application, &id).await {
        Ok(()) => Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty())),
        Err(JobCancelError::NotFound) => {
            json_response(StatusCode::NOT_FOUND, json!({"error": "not found"}))
        }
        Err(JobCancelError::Conflict) => json_response(
            StatusCode::CONFLICT,
            json!({"error": "job can no longer be cancelled"}),
        ),
        Err(JobCancelError::Persistence(error)) => error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            error,
            "job_store_unavailable",
        ),
    }
}

fn realtime_url(account: &Account, config: &EdgeConfig) -> Result<String, String> {
    if let Some(url) = config.realtime_webrtc_call_url.as_deref() {
        return Ok(url.to_owned());
    }
    if config.realtime_provider == "openai-compatible" {
        return account
            .base_url
            .as_deref()
            .map(|url| format!("{}/realtime/calls", trim_slashes(url)))
            .ok_or_else(|| {
                "Realtime OpenAI-compatible account requires a baseUrl or REALTIME_WEBRTC_CALL_URL"
                    .to_owned()
            });
    }
    Ok(format!(
        "{}/backend-api/realtime/calls",
        trim_slashes(&config.chatgpt_base_url)
    ))
}

fn realtime_account_selection(provider: &str, candidate_count: usize, rotated: bool) -> Value {
    json!({
        "reason": "quota-headroom",
        "provider": provider,
        "candidateCount": candidate_count,
        "eligibleCount": candidate_count,
        "nearLimitCount": 0,
        "rotated": rotated,
    })
}

async fn realtime_call_handler(State(state): State<EdgeState>, req: Request<Body>) -> Response {
    let started_at = now_ms();
    let path = req.uri().path().to_owned();
    let headers = req.headers().clone();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    let auth = match authorize(&headers, &path, &store, &state.config) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let _activity_lease = match state.drain.admit(ActivityKind::Request) {
        Some(lease) => lease,
        None => return draining_response(),
    };
    let content_type = header_value(&headers, "content-type")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !(content_type.starts_with("multipart/form-data;")
        || content_type.starts_with("application/sdp"))
    {
        return error_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Realtime call Content-Type must be application/sdp or multipart/form-data",
            "unsupported_media_type",
        );
    }
    let body = match to_bytes(req.into_body(), state.config.realtime_body_limit).await {
        Ok(body) if !body.is_empty() => body,
        Ok(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "Realtime call requires an SDP or multipart body",
                "missing_realtime_body",
            );
        }
        Err(_) => {
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Realtime call body is too large",
                "payload_too_large",
            );
        }
    };
    let route = RouteCandidate {
        requested_model: "realtime".to_owned(),
        model: "realtime".to_owned(),
        provider: Some(state.config.realtime_provider.clone()),
        account_ids: Vec::new(),
    };
    let blocked = state.blocked.lock().await.clone();
    let selected = state.selected.lock().await.clone();
    let accounts = select_accounts(&store.accounts, &route, &blocked, &selected);
    let candidate_count = accounts.len();
    let trace_provider = route.provider.as_deref().unwrap_or("openai");
    let trace_body = json!({"contentType": content_type, "byteLength": body.len()});
    let client_request_id = header_value(&headers, "x-multivibe-trace-parent")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let mut last_error = "no eligible realtime account configured".to_owned();
    let mut provider_attempts = 0_usize;

    'accounts: for mut account in accounts {
        provider_attempts += 1;
        let selection =
            realtime_account_selection(trace_provider, candidate_count, provider_attempts > 1);
        let mut trace_context = build_trace_context(
            &state,
            &path,
            &headers,
            &trace_body,
            &auth.application,
            &client_request_id,
            "realtime",
            "realtime",
            Some(&account),
            false,
            started_at,
            provider_attempts,
            provider_attempts,
            "upstream-attempt",
        );
        trace_context.request_body = state.config.trace_include_body.then(|| trace_body.clone());
        trace_context.account_selection = Some(selection.clone());

        if token_refresh::TokenRefreshManager::needs_refresh(&account, now_ms()) {
            match state
                .token_refresh
                .refresh(&state.webhook_client, &state.config, &state.store, &account, false)
                .await
            {
                Ok(refreshed) => account = refreshed,
                Err(error) => {
                    last_error = error;
                    state
                        .trace
                        .record(
                            &trace_context,
                            transport_trace_outcome(
                                StatusCode::SERVICE_UNAVAILABLE,
                                last_error.clone(),
                            ),
                        )
                        .await;
                    state
                        .mark_blocked(&account, "realtime", Duration::from_secs(60))
                        .await;
                    continue;
                }
            }
        }

        let url = match realtime_url(&account, &state.config) {
            Ok(url) => url,
            Err(error) => {
                last_error = error;
                trace_context.latency_breakdown = Some(json!({
                    "preparationMs": now_ms().saturating_sub(started_at),
                    "upstreamHeadersMs": 0,
                }));
                state
                    .trace
                    .record(
                        &trace_context,
                        transport_trace_outcome(StatusCode::BAD_GATEWAY, last_error.clone()),
                    )
                    .await;
                continue;
            }
        };
        let upstream_started_at = now_ms();
        let mut retried_after_token_refresh = false;
        let response = loop {
            let mut upstream_headers =
                upstream_headers(&account, &headers, &url, None, &state.config);
            set_header(&mut upstream_headers, "content-type", &content_type);
            set_header(
                &mut upstream_headers,
                "accept",
                "application/sdp, application/json",
            );
            let response = match timeout(
                state.config.upstream_timeout,
                state
                    .client
                    .post(&url)
                    .headers(upstream_headers)
                    .body(body.clone())
                    .send(),
            )
            .await
            {
                Ok(Ok(response)) => response,
                Ok(Err(error)) => {
                    last_error = error.to_string();
                    trace_context.latency_breakdown = Some(json!({
                        "preparationMs": upstream_started_at.saturating_sub(started_at),
                        "upstreamHeadersMs": now_ms().saturating_sub(upstream_started_at),
                    }));
                    state
                        .trace
                        .record(
                            &trace_context,
                            transport_trace_outcome(StatusCode::BAD_GATEWAY, last_error.clone()),
                        )
                        .await;
                    continue 'accounts;
                }
                Err(_) => {
                    last_error = "realtime upstream request timed out".to_owned();
                    trace_context.latency_breakdown = Some(json!({
                        "preparationMs": upstream_started_at.saturating_sub(started_at),
                        "upstreamHeadersMs": now_ms().saturating_sub(upstream_started_at),
                    }));
                    state
                        .trace
                        .record(
                            &trace_context,
                            transport_trace_outcome(
                                StatusCode::GATEWAY_TIMEOUT,
                                last_error.clone(),
                            ),
                        )
                        .await;
                    continue 'accounts;
                }
            };
            if response.status() == StatusCode::UNAUTHORIZED
                && !retried_after_token_refresh
                && token_refresh::TokenRefreshManager::can_refresh(&account)
            {
                match state
                    .token_refresh
                    .refresh(&state.webhook_client, &state.config, &state.store, &account, true)
                    .await
                {
                    Ok(refreshed) if refreshed.access_token != account.access_token => {
                        account = refreshed;
                        retried_after_token_refresh = true;
                        continue;
                    }
                    _ => {}
                }
            }
            break response;
        };
        let status = response.status();
        let response_headers = copy_public_headers(response.headers());
        let response_content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let response_body = response.bytes().await.unwrap_or_default();
        trace_context.latency_breakdown = Some(json!({
            "preparationMs": upstream_started_at.saturating_sub(started_at),
            "upstreamHeadersMs": now_ms().saturating_sub(upstream_started_at),
        }));
        let reply = BufferedReply {
            status,
            headers: response_headers,
            body: response_body,
        };
        let outcome = opaque_trace_outcome(&reply, &response_content_type, reply.body.is_empty());
        let completed_at = outcome.completed_at;
        let response_error = outcome.error.clone();
        state.trace.record(&trace_context, outcome).await;
        if !status.is_success() && is_quota_error(status, &String::from_utf8_lossy(&reply.body)) {
            state
                .mark_blocked(&account, "realtime", Duration::from_secs(60))
                .await;
            last_error = response_error
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "realtime upstream quota response".to_owned());
            continue;
        }
        if !status.is_success()
            && matches!(
                status,
                StatusCode::UNAUTHORIZED
                    | StatusCode::FORBIDDEN
                    | StatusCode::BAD_GATEWAY
                    | StatusCode::SERVICE_UNAVAILABLE
                    | StatusCode::GATEWAY_TIMEOUT
            )
        {
            last_error = response_error
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| format!("Realtime upstream returned {status}"));
            continue;
        }
        let mut client_context = build_trace_context(
            &state,
            &path,
            &headers,
            &Value::Null,
            &auth.application,
            &client_request_id,
            "realtime",
            "realtime",
            None,
            false,
            started_at,
            0,
            provider_attempts,
            "client-request",
        );
        client_context.request_body = None;
        client_context.account_selection = Some(selection);
        state
            .trace
            .record(
                &client_context,
                client_trace_outcome(status.as_u16(), completed_at, response_error, Some(false)),
            )
            .await;
        return response_from_buffer(reply);
    }

    let mut client_context = build_trace_context(
        &state,
        &path,
        &headers,
        &Value::Null,
        &auth.application,
        &client_request_id,
        "realtime",
        "realtime",
        None,
        false,
        started_at,
        0,
        provider_attempts,
        "client-request",
    );
    client_context.request_body = None;
    client_context.account_selection = Some(realtime_account_selection(
        trace_provider,
        candidate_count,
        provider_attempts > 1,
    ));
    state
        .trace
        .record(
            &client_context,
            client_trace_outcome(
                StatusCode::BAD_GATEWAY.as_u16(),
                now_ms(),
                Some(last_error.clone()),
                Some(false),
            ),
        )
        .await;
    json_response(
        StatusCode::BAD_GATEWAY,
        json!({"error": {"message": last_error, "type": "upstream_error", "code": "realtime_upstream_error", "application": auth.application}}),
    )
}

async fn realtime_voices_handler(State(state): State<EdgeState>, req: Request<Body>) -> Response {
    let started_at = now_ms();
    let headers = req.headers().clone();
    let path = req.uri().path().to_owned();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(error) => {
            return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
        }
    };
    let auth = match authorize(&headers, &path, &store, &state.config) {
        Ok(auth) => auth,
        Err(response) => return response,
    };
    let _activity_lease = match state.drain.admit(ActivityKind::Request) {
        Some(lease) => lease,
        None => return draining_response(),
    };
    let route = RouteCandidate {
        requested_model: "realtime-voices".to_owned(),
        model: "realtime-voices".to_owned(),
        provider: Some("openai".to_owned()),
        account_ids: Vec::new(),
    };
    let blocked = state.blocked.lock().await.clone();
    let selected = state.selected.lock().await.clone();
    let accounts = select_accounts(&store.accounts, &route, &blocked, &selected);
    let candidate_count = accounts.len();
    let trace_provider = route.provider.as_deref().unwrap_or("openai");
    let client_request_id = header_value(&headers, "x-multivibe-trace-parent")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let selection = realtime_account_selection(trace_provider, candidate_count, false);
    let Some(mut account) = accounts.into_iter().next() else {
        let mut client_context = build_trace_context(
            &state,
            &path,
            &headers,
            &Value::Null,
            &auth.application,
            &client_request_id,
            "realtime-voices",
            "realtime-voices",
            None,
            false,
            started_at,
            0,
            0,
            "client-request",
        );
        client_context.request_body = None;
        client_context.account_selection = Some(selection);
        state
            .trace
            .record(
                &client_context,
                client_trace_outcome(
                    StatusCode::SERVICE_UNAVAILABLE.as_u16(),
                    now_ms(),
                    Some("no eligible ChatGPT account configured for voice discovery".to_owned()),
                    Some(false),
                ),
            )
            .await;
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error": {"message": "no eligible ChatGPT account configured for voice discovery", "type": "service_unavailable", "code": "voice_account_unavailable"}}),
        );
    };
    let mut trace_context = build_trace_context(
        &state,
        &path,
        &headers,
        &Value::Null,
        &auth.application,
        &client_request_id,
        "realtime-voices",
        "realtime-voices",
        Some(&account),
        false,
        started_at,
        1,
        1,
        "upstream-attempt",
    );
    trace_context.request_body = None;
    trace_context.account_selection = Some(selection.clone());
    if token_refresh::TokenRefreshManager::needs_refresh(&account, now_ms()) {
        match state
            .token_refresh
            .refresh(&state.webhook_client, &state.config, &state.store, &account, false)
            .await
        {
            Ok(refreshed) => account = refreshed,
            Err(error) => {
                state
                    .trace
                    .record(
                        &trace_context,
                        transport_trace_outcome(StatusCode::SERVICE_UNAVAILABLE, error.clone()),
                    )
                    .await;
                return json_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({"error": {"message": error, "type": "service_unavailable", "code": "voice_account_unavailable"}}),
                );
            }
        }
    }
    let mut url = format!(
        "{}/backend-api/settings/voices",
        trim_slashes(&state.config.chatgpt_base_url)
    );
    if let Some(query) = req.uri().query().filter(|query| !query.is_empty()) {
        url.push('?');
        url.push_str(query);
    }
    if !url.contains("voice_mode=") {
        url.push(if url.contains('?') { '&' } else { '?' });
        url.push_str("voice_mode=advanced");
    }
    let upstream_started_at = now_ms();
    let mut retried_after_token_refresh = false;
    let response = loop {
        let response = match timeout(
            state.config.upstream_timeout,
            state
                .client
                .get(&url)
                .headers(upstream_headers(
                    &account,
                    &headers,
                    &url,
                    None,
                    &state.config,
                ))
                .send(),
        )
        .await
        {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                let message = error.to_string();
                trace_context.latency_breakdown = Some(json!({
                    "preparationMs": upstream_started_at.saturating_sub(started_at),
                    "upstreamHeadersMs": now_ms().saturating_sub(upstream_started_at),
                }));
                state
                    .trace
                    .record(
                        &trace_context,
                        transport_trace_outcome(StatusCode::BAD_GATEWAY, message.clone()),
                    )
                    .await;
                let mut client_context = build_trace_context(
                    &state,
                    &path,
                    &headers,
                    &Value::Null,
                    &auth.application,
                    &client_request_id,
                    "realtime-voices",
                    "realtime-voices",
                    None,
                    false,
                    started_at,
                    0,
                    1,
                    "client-request",
                );
                client_context.request_body = None;
                client_context.account_selection = Some(selection.clone());
                state
                    .trace
                    .record(
                        &client_context,
                        client_trace_outcome(
                            StatusCode::BAD_GATEWAY.as_u16(),
                            now_ms(),
                            Some(message.clone()),
                            Some(false),
                        ),
                    )
                    .await;
                return json_response(
                    StatusCode::BAD_GATEWAY,
                    json!({"error": {"message": message, "type": "upstream_error", "code": "voice_discovery_upstream_error"}}),
                );
            }
            Err(_) => {
                let message = "voice discovery upstream request timed out".to_owned();
                trace_context.latency_breakdown = Some(json!({
                    "preparationMs": upstream_started_at.saturating_sub(started_at),
                    "upstreamHeadersMs": now_ms().saturating_sub(upstream_started_at),
                }));
                state
                    .trace
                    .record(
                        &trace_context,
                        transport_trace_outcome(StatusCode::GATEWAY_TIMEOUT, message.clone()),
                    )
                    .await;
                let mut client_context = build_trace_context(
                    &state,
                    &path,
                    &headers,
                    &Value::Null,
                    &auth.application,
                    &client_request_id,
                    "realtime-voices",
                    "realtime-voices",
                    None,
                    false,
                    started_at,
                    0,
                    1,
                    "client-request",
                );
                client_context.request_body = None;
                client_context.account_selection = Some(selection.clone());
                state
                    .trace
                    .record(
                        &client_context,
                        client_trace_outcome(
                            StatusCode::GATEWAY_TIMEOUT.as_u16(),
                            now_ms(),
                            Some(message.clone()),
                            Some(false),
                        ),
                    )
                    .await;
                return json_response(
                    StatusCode::GATEWAY_TIMEOUT,
                    json!({"error": {"message": message, "type": "upstream_error", "code": "voice_discovery_upstream_error"}}),
                );
            }
        };
        if response.status() == StatusCode::UNAUTHORIZED
            && !retried_after_token_refresh
            && token_refresh::TokenRefreshManager::can_refresh(&account)
        {
            match state
                .token_refresh
                .refresh(&state.webhook_client, &state.config, &state.store, &account, true)
                .await
            {
                Ok(refreshed) if refreshed.access_token != account.access_token => {
                    account = refreshed;
                    retried_after_token_refresh = true;
                    continue;
                }
                _ => {}
            }
        }
        break response;
    };
    let status = response.status();
    let response_headers = copy_public_headers(response.headers());
    let response_content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let response_body = response.bytes().await.unwrap_or_default();
    trace_context.latency_breakdown = Some(json!({
        "preparationMs": upstream_started_at.saturating_sub(started_at),
        "upstreamHeadersMs": now_ms().saturating_sub(upstream_started_at),
    }));
    let reply = BufferedReply {
        status,
        headers: response_headers,
        body: response_body,
    };
    let outcome = opaque_trace_outcome(&reply, &response_content_type, reply.body.is_empty());
    let completed_at = outcome.completed_at;
    let response_error = outcome.error.clone();
    state.trace.record(&trace_context, outcome).await;
    let mut client_context = build_trace_context(
        &state,
        &path,
        &headers,
        &Value::Null,
        &auth.application,
        &client_request_id,
        "realtime-voices",
        "realtime-voices",
        None,
        false,
        started_at,
        0,
        1,
        "client-request",
    );
    client_context.request_body = None;
    client_context.account_selection = Some(selection);
    state
        .trace
        .record(
            &client_context,
            client_trace_outcome(status.as_u16(), completed_at, response_error, Some(false)),
        )
        .await;
    response_from_buffer(reply)
}

async fn websocket_handler(
    State(state): State<EdgeState>,
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let path = uri.path().to_owned();
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::SERVICE_UNAVAILABLE)
                .body(Body::empty())
                .unwrap_or_else(|_| Response::new(Body::empty()));
        }
    };
    let auth = match authorize(&headers, &path, &store, &state.config) {
        Ok(auth) => auth,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::UNAUTHORIZED)
                .body(Body::empty())
                .unwrap_or_else(|_| Response::new(Body::empty()));
        }
    };
    if state.drain.is_draining() {
        return draining_response();
    }
    ws.on_upgrade(move |socket| handle_websocket(socket, state, headers, auth.application, path))
}

async fn ws_send_json(socket: &mut WebSocket, value: Value) -> bool {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .is_ok()
}

async fn handle_websocket(
    mut socket: WebSocket,
    state: EdgeState,
    headers: HeaderMap,
    application: String,
    path: String,
) {
    while let Some(Ok(message)) = socket.next().await {
        match message {
            Message::Text(text) => {
                let Ok(mut frame) = serde_json::from_str::<Value>(&text) else {
                    if !ws_send_json(&mut socket, json!({"type": "error", "status": 400, "error": {"type": "invalid_request_error", "code": "invalid_json", "message": "expected a JSON text frame with type='response.create'"}})).await { break; }
                    continue;
                };
                if frame.get("type").and_then(Value::as_str) != Some("response.create") {
                    if !ws_send_json(&mut socket, json!({"type": "error", "status": 400, "error": {"type": "invalid_request_error", "message": "expected a JSON text frame with type='response.create'"}})).await { break; }
                    continue;
                }
                if state.drain.is_draining() {
                    if !ws_send_json(&mut socket, json!({
                        "type": "error",
                        "status": StatusCode::SERVICE_UNAVAILABLE.as_u16(),
                        "error": {
                            "type": "service_unavailable",
                            "code": "host_update_draining",
                            "message": "MultiVibe Host is draining for a verified update",
                        }
                    })).await { break; }
                    continue;
                }
                if frame.get("generate").and_then(Value::as_bool) == Some(false) {
                    let id = new_id("resp");
                    let model = value_string(frame.get("model")).unwrap_or_else(|| "unknown".to_owned());
                    if !ws_send_json(&mut socket, json!({"type": "response.created", "response": {"id": id, "object": "response", "model": model, "status": "in_progress"}})).await { break; }
                    if !ws_send_json(&mut socket, json!({"type": "response.completed", "response": {"id": id, "object": "response", "model": model, "status": "completed", "output": [], "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}})).await { break; }
                    continue;
                }
                if let Some(object) = frame.as_object_mut() {
                    object.remove("type");
                    object.remove("previous_response_id");
                    object.insert("stream".to_owned(), Value::Bool(true));
                }
                match proxy_inference(
                    &state,
                    &path,
                    &headers,
                    &frame,
                    &application,
                    Some(ActivityKind::WebsocketTurn),
                )
                .await
                {
                    Ok(ProxyResult::Buffered(reply)) => {
                        if reply.status.is_success() {
                            let text = String::from_utf8_lossy(&reply.body);
                            if text.contains("data:") {
                                for (_, event) in parse_sse_events(&text) {
                                    if event.as_str() != Some("[DONE]") && !ws_send_json(&mut socket, event).await { return; }
                                }
                            } else if let Ok(response) = serde_json::from_slice::<Value>(&reply.body) {
                                let id = value_string(response.get("id")).unwrap_or_else(|| new_id("resp"));
                                if !ws_send_json(&mut socket, json!({"type": "response.created", "response": {"id": id, "object": "response", "model": response.get("model"), "status": "in_progress"}})).await { return; }
                                if !ws_send_json(&mut socket, json!({"type": "response.completed", "response": response})).await { return; }
                            }
                        } else if !ws_send_json(&mut socket, json!({"type": "error", "status": reply.status.as_u16(), "error": {"type": "upstream_error", "message": String::from_utf8_lossy(&reply.body)}})).await { return; }
                    }
                    Ok(ProxyResult::Streaming(reply)) => {
                        let status = reply.status.as_u16();
                        let mut trace = reply.trace;
                        let mut upstream = reply.upstream.bytes_stream();
                        let _capacity_lease = reply.capacity_lease;
                        let _activity_lease = reply.activity_lease;
                        let mut buffer = String::new();
                        while let Some(Ok(chunk)) = upstream.next().await {
                            if let Some(trace) = trace.as_mut() {
                                trace.observe(&chunk);
                            }
                            buffer.push_str(&String::from_utf8_lossy(&chunk));
                            while let Some(index) = buffer.find("\n\n") {
                                let frame = buffer[..index].to_owned();
                                buffer.drain(..index + 2);
                                for (_, event) in parse_sse_events(&format!("{frame}\n\n")) {
                                    if event.as_str() != Some("[DONE]") && !ws_send_json(&mut socket, event).await { return; }
                                }
                            }
                        }
                        if !buffer.trim().is_empty() {
                            for (_, event) in parse_sse_events(&format!("{buffer}\n\n")) {
                                if event.as_str() != Some("[DONE]") && !ws_send_json(&mut socket, event).await { return; }
                            }
                        }
                        if let Some(trace) = trace.as_mut() {
                            trace.finish(status, None, Some(false)).await;
                        }
                    }
                    Err(error) => {
                        let status = error.status();
                        let bytes = to_bytes(error.into_body(), 1024 * 1024)
                            .await
                            .unwrap_or_default();
                        let parsed = serde_json::from_slice::<Value>(&bytes).ok();
                        let error = parsed
                            .as_ref()
                            .and_then(|body| body.get("error"))
                            .cloned()
                            .unwrap_or_else(|| json!({
                                "type": "upstream_error",
                                "message": "upstream request failed",
                            }));
                        if !ws_send_json(&mut socket, json!({
                            "type": "error",
                            "status": status.as_u16(),
                            "error": error,
                        })).await { return; }
                    }
                }
            }
            Message::Binary(_) => {
                if !ws_send_json(&mut socket, json!({"type": "error", "status": 400, "error": {"type": "invalid_request_error", "message": "binary websocket frames are not supported"}})).await { break; }
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => {}
        }
    }
}

async fn fallback_handler(State(state): State<EdgeState>, req: Request<Body>) -> Response {
    let path = req.uri().path().to_owned();
    if path == "/internal/ai-sdk" || path.starts_with("/internal/ai-sdk/") {
        return error_response(StatusCode::NOT_FOUND, "Not found", "not_found");
    }
    if path == "/v1" || path.starts_with("/v1/") {
        let headers = req.headers().clone();
        let store = match state.store.snapshot().await {
            Ok(store) => store,
            Err(error) => {
                return error_response(StatusCode::SERVICE_UNAVAILABLE, error, "store_unavailable");
            }
        };
        if let Err(response) = authorize(&headers, &path, &store, &state.config) {
            return response;
        }
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"error": {"message": "Unknown /v1 endpoint", "type": "invalid_request_error", "code": "not_found"}}),
        );
    }
    if dashboard::path_requires_session(&path)
        && !dashboard::request_authorized(req.headers(), &state.config)
    {
        return json_response(StatusCode::UNAUTHORIZED, json!({"error": "unauthorized"}));
    }
    if req.method() == Method::GET {
        match path.as_str() {
            "/admin/proxy-api-keys" => return dashboard::proxy_api_keys(&state).await,
            "/admin/application-policies" => {
                return dashboard::application_policies(&state).await;
            }
            _ => {}
        }
    }
    let target = format!(
        "{}{}",
        trim_slashes(&state.config.node_control_plane_url),
        req.uri()
            .path_and_query()
            .map(|value| value.to_string())
            .unwrap_or_else(|| path.clone()),
    );
    let method = req.method().clone();
    let incoming_headers = req.headers().clone();
    let body = match to_bytes(req.into_body(), state.config.request_body_limit).await {
        Ok(body) => body,
        Err(_) => {
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Request body is too large",
                "payload_too_large",
            );
        }
    };
    let mut headers = HeaderMap::new();
    for (name, value) in &incoming_headers {
        if HOP_BY_HOP_HEADERS.contains(&name.as_str()) {
            continue;
        }
        headers.insert(name.clone(), value.clone());
    }
    let upstream = match timeout(
        state.config.upstream_timeout,
        state
            .control_plane_client
            .request(method, target)
            .headers(headers)
            .body(body)
            .send(),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return json_response(
                StatusCode::BAD_GATEWAY,
                json!({"error": {"message": format!("control-plane unavailable: {error}"), "type": "upstream_error"}}),
            );
        }
        Err(_) => {
            return json_response(
                StatusCode::GATEWAY_TIMEOUT,
                json!({"error": {"message": "control-plane request timed out", "type": "upstream_error"}}),
            );
        }
    };
    let status = upstream.status();
    let mut response_builder = Response::builder().status(status);
    for (name, value) in upstream.headers() {
        if HOP_BY_HOP_HEADERS.contains(&name.as_str()) {
            continue;
        }
        response_builder = response_builder.header(name, value);
    }
    let mut body_stream = upstream.bytes_stream();
    let body = stream! {
        while let Some(chunk) = body_stream.next().await {
            if let Ok(chunk) = chunk { yield Ok::<Bytes, Infallible>(chunk); }
        }
    };
    response_builder
        .body(Body::from_stream(body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn internal_control_authorized(headers: &HeaderMap, config: &EdgeConfig) -> bool {
    config
        .internal_job_token
        .as_deref()
        .is_some_and(|expected| {
            header_value(headers, "x-multivibe-internal-token")
                .is_some_and(|actual| constant_time_equal(&actual, expected))
        })
}

fn drain_status_response(state: &EdgeState) -> Response {
    let (draining, active_requests, active_websocket_turns, active_jobs) = state.drain.snapshot();
    json_response(
        StatusCode::OK,
        json!({
            "draining": draining,
            "ready": draining
                && active_requests == 0
                && active_websocket_turns == 0
                && active_jobs == 0,
            "active_requests": active_requests,
            "active_websocket_turns": active_websocket_turns,
            "active_jobs": active_jobs,
        }),
    )
}

async fn drain_status_handler(State(state): State<EdgeState>, headers: HeaderMap) -> Response {
    if !internal_control_authorized(&headers, &state.config) {
        return json_response(StatusCode::UNAUTHORIZED, json!({"error": "unauthorized"}));
    }
    drain_status_response(&state)
}

async fn drain_begin_handler(State(state): State<EdgeState>, headers: HeaderMap) -> Response {
    if !internal_control_authorized(&headers, &state.config) {
        return json_response(StatusCode::UNAUTHORIZED, json!({"error": "unauthorized"}));
    }
    state.drain.begin();
    state.jobs.notify_changed();
    drain_status_response(&state)
}

async fn drain_resume_handler(State(state): State<EdgeState>, headers: HeaderMap) -> Response {
    if !internal_control_authorized(&headers, &state.config) {
        return json_response(StatusCode::UNAUTHORIZED, json!({"error": "unauthorized"}));
    }
    state.drain.resume();
    state.jobs.notify_changed();
    drain_status_response(&state)
}

pub fn build_router(state: EdgeState) -> Router {
    Router::new()
        // Rust owns the dashboard REST boundary incrementally. Session
        // establishment and access control terminate here; authenticated
        // resource routes still fall back to the loopback control plane until
        // their business logic is migrated.
        .route("/health", get(dashboard::health))
        .route(
            "/admin/session",
            get(dashboard::session_status)
                .post(dashboard::session_create)
                .delete(dashboard::session_delete),
        )
        .route(
            "/admin/desktop-session",
            post(dashboard::desktop_session_create),
        )
        .route("/desktop/session", get(dashboard::desktop_session_consume))
        // Every inference route, both the canonical `/v1` surface and its
        // historical root aliases, terminates in this native edge. Node
        // remains a control-plane peer and hosts the internal adapter for SDK
        // providers; public routing and protocol conversion stay in this edge.
        .route("/models", get(list_models_handler).post(method_not_allowed))
        .route(
            "/models/{id}",
            get(get_model_handler).post(method_not_allowed),
        )
        .route(
            "/api/v1/models",
            get(list_models_handler).post(method_not_allowed),
        )
        .route(
            "/api/v1/models/{id}",
            get(get_model_handler).post(method_not_allowed),
        )
        .route("/api/tags", get(ollama_tags_handler))
        .route("/version", get(version_handler))
        .route("/props", get(props_handler))
        .route("/responses", get(websocket_handler).post(inference_handler))
        .route("/responses/compact", post(inference_handler))
        .route("/chat/completions", post(inference_handler))
        .route("/messages", post(inference_handler))
        .route("/realtime/calls", post(realtime_call_handler))
        .route("/realtime/voices", get(realtime_voices_handler))
        .route("/settings/voices", get(realtime_voices_handler))
        .route(
            "/v1/models",
            get(list_models_handler).post(method_not_allowed),
        )
        .route(
            "/v1/models/{id}",
            get(get_model_handler).post(method_not_allowed),
        )
        .route("/v1/props", get(props_handler))
        .route(
            "/v1/responses",
            get(websocket_handler).post(inference_handler),
        )
        .route("/v1/responses/compact", post(inference_handler))
        .route("/v1/chat/completions", post(inference_handler))
        .route("/v1/messages", post(inference_handler))
        .route("/v1/realtime/calls", post(realtime_call_handler))
        .route("/v1/realtime/voices", get(realtime_voices_handler))
        .route("/v1/settings/voices", get(realtime_voices_handler))
        .route("/v1/capacity", get(capacity_handler))
        .route("/v1/capacity/events", get(capacity_events_handler))
        .route("/v1/jobs", get(list_jobs_handler))
        .route(
            "/v1/jobs/{id}",
            get(get_job_handler).delete(delete_job_handler),
        )
        .route("/v1/jobs/{id}/result", get(get_job_result_handler))
        .route("/v1/jobs/{id}/events", get(get_job_events_handler))
        .route("/internal/v1-edge/drain/status", get(drain_status_handler))
        .route("/internal/v1-edge/drain/begin", post(drain_begin_handler))
        .route("/internal/v1-edge/drain/resume", post(drain_resume_handler))
        .fallback(fallback_handler)
        .with_state(state)
}

#[cfg(test)]
mod tests {
    #[test]
    fn opencode_headers_resolve_current_token_and_workspace_for_inference_and_discovery() {
        let mut account: Account = serde_json::from_value(serde_json::json!({
            "id": "console", "provider": "opencode", "enabled": true,
            "accessToken": "old-session", "opencodeApiKey": "{env:OPENCODE_CONSOLE_TOKEN}",
            "opencodeOrgId": "org_selected",
            "opencodeHeaders": {"x-opencode-org-id": "org_selected", "Authorization": "Bearer stale"}
        }))
        .unwrap();
        account.access_token = "refreshed-session".to_owned();
        let inference = upstream_headers(
            &account,
            &HeaderMap::new(),
            "https://opencode.ai/inference/openai/v1/responses",
            None,
            &EdgeConfig::default(),
        );
        let discovery = model_discovery_headers(&account, &EdgeConfig::default());
        for headers in [&inference, &discovery] {
            assert_eq!(headers["authorization"], "Bearer refreshed-session");
            assert_eq!(headers["x-org-id"], "org_selected");
            assert_eq!(headers["x-opencode-org-id"], "org_selected");
        }
        account.opencode_api_key = Some("inference-key".to_owned());
        assert_eq!(
            model_discovery_headers(&account, &EdgeConfig::default())["authorization"],
            "Bearer inference-key"
        );
        account.opencode_api_key = Some("{env:UNRELATED_SECRET}".to_owned());
        assert!(!account_usable(&account, "test", &HashMap::new()));
        assert!(!model_discovery_headers(&account, &EdgeConfig::default()).contains_key("authorization"));
    }

    use super::*;
    use axum::{
        Json,
        routing::{get, post},
    };
    use futures_util::SinkExt;
    use std::io::Cursor;
    use std::sync::atomic::AtomicUsize;
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;
    use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest};

    fn temporary_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "multivibe-v1-edge-{label}-{}",
            Uuid::new_v4().simple()
        ))
    }

    #[test]
    fn cloud_policy_selectors_preserve_model_and_restrict_accounts() {
        let mut cloud = account("cloud");
        cloud.provider = Some("openai-compatible".to_owned());
        cloud.multivibe_cloud = Some(true);
        let mut ordinary = cloud.clone();
        ordinary.id = "unrelated".to_owned();
        ordinary.multivibe_cloud = None;
        let store = StoreFile::default();
        for model in ["multivibe/model", "multivibe/secured_preferred/model", "multivibe/secured_guaranteed/model", "multivibe/green_guaranteed/model"] {
            let routes = routes_for_model(&store, model, "default", &[]);
            assert_eq!(routes.len(), 1);
            assert_eq!(routes[0].model, model);
            let accounts = select_accounts(&[ordinary.clone(), cloud.clone()], &routes[0], &HashMap::new(), &HashMap::new());
            assert_eq!(accounts.len(), 1);
            assert_eq!(accounts[0].id, "cloud");
        }
        assert_eq!(claude_code_routing_model("multivibe/secured_guaranteed/claude-model", true), "multivibe/secured_guaranteed/claude-model");
    }

    fn account(id: &str) -> Account {
        Account {
            id: id.to_owned(),
            provider: Some("openai".to_owned()),
            access_token: "upstream-token".to_owned(),
            enabled: true,
            ..Default::default()
        }
    }

    fn store_with_accounts(accounts: Vec<Account>) -> StoreFile {
        StoreFile {
            accounts,
            ..Default::default()
        }
    }

    async fn start_server(router: Router) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        tokio::task::yield_now().await;
        (format!("http://{address}"), task)
    }

    #[test]
    fn codex_catalog_includes_local_chat_but_not_audio_models() {
        let models = ["Qwen3.8-27B-4bit", "Kokoro-82M-bf16", "Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16", "whisper-large-v3-turbo-asr-4bit"]
            .map(|id| json!({"id": id, "metadata": {"provider": "openai-compatible"}}));
        let response = models_list_response(&models, json!({}));
        assert_eq!(response["data"].as_array().unwrap().len(), 4);
        let native = response["models"].as_array().unwrap();
        assert_eq!(native.len(), 1);
        assert_eq!(native[0]["slug"], "Qwen3.8-27B-4bit");
        assert_eq!(native[0]["visibility"], "list");
    }

    #[test]
    fn codex_catalog_includes_text_ai_sdk_models_but_not_utility_models() {
        let models = [
            json!({"id": "deepseek/deepseek-v4-flash", "metadata": {"provider": "ai-sdk", "input_modalities": ["text"]}}),
            json!({"id": "deepseek/deepseek-v4-flash-vision-exp", "metadata": {"provider": "ai-sdk", "input_modalities": ["text", "image"]}}),
            json!({"id": "deepseek/deepseek-v4-pro", "metadata": {"provider": "ai-sdk", "input_modalities": ["text"]}}),
            json!({"id": "image-generator", "metadata": {"provider": "ai-sdk", "input_modalities": ["image"]}}),
            json!({"id": "speech/tts-1", "metadata": {"provider": "ai-sdk", "input_modalities": ["text"]}}),
            json!({"id": "openai/text-embedding-3-small", "metadata": {"provider": "ai-sdk", "input_modalities": ["text"]}}),
            json!({"id": "cohere/rerank-v3.5", "metadata": {"provider": "ai-sdk", "input_modalities": ["text"]}}),
        ];
        let response = models_list_response(&models, json!({}));
        assert_eq!(response["data"].as_array().unwrap().len(), models.len());
        let slugs = response["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|model| model["slug"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(slugs, [
            "deepseek/deepseek-v4-flash",
            "deepseek/deepseek-v4-flash-vision-exp",
            "deepseek/deepseek-v4-pro",
        ]);
    }

    #[tokio::test]
    async fn ai_sdk_routes_discovery_and_inference_through_authenticated_adapter() {
        use axum::response::IntoResponse;
        let adapter = Router::new()
            .route("/internal/ai-sdk/sdk-account/v1/models", get(|headers: HeaderMap| async move {
                assert_eq!(headers["authorization"], "Bearer adapter-secret");
                Json(json!({"data": [{"id": "anthropic/test", "owned_by": "anthropic", "context_window": 200000,
                    "catalog_source": "https://models.dev/api.json", "pricing": {"input": 3}, "supports_tools": true}]}))
            }))
            .route("/internal/ai-sdk/sdk-account/v1/chat/completions", post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                assert_eq!(headers["authorization"], "Bearer adapter-secret");
                assert_eq!(body["model"], "anthropic/test");
                assert!(body["messages"].is_array());
                if body["stream"] == true {
                    return ([("content-type", "text/event-stream")],
                        "data: {\"id\":\"chat-sdk\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hi\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chat-sdk\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n").into_response();
                }
                Json(json!({"id": "chat-sdk", "object": "chat.completion", "model": "anthropic/test", "created": 1,
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hi"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})).into_response()
            }));
        let (adapter_url, adapter_task) = start_server(adapter).await;
        let store_path = temporary_path("sdk-store");
        let jobs_path = temporary_path("sdk-jobs");
        let mut sdk = account("sdk-account");
        sdk.provider = Some("ai-sdk".to_owned());
        sdk.sdk_provider = Some("anthropic".to_owned());
        sdk.access_token = "provider-secret-never-sent-to-adapter".to_owned();
        fs::write(&store_path, serde_json::to_vec(&store_with_accounts(vec![sdk])).unwrap()).await.unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone(); config.jobs_path = jobs_path.clone();
        config.node_control_plane_url = adapter_url; config.internal_job_token = Some("adapter-secret".to_owned());
        config.configured_api_keys = vec![("test".to_owned(), "proxy-secret".to_owned())];
        let state = EdgeState::new(config).await.unwrap();
        let (edge_url, edge_task) = start_server(build_router(state)).await;
        let client = reqwest::Client::new();
        let catalog: Value = client.get(format!("{edge_url}/v1/models")).bearer_auth("proxy-secret").send().await.unwrap().json().await.unwrap();
        let model = catalog["data"].as_array().unwrap().iter().find(|model| model["id"] == "anthropic/test").unwrap();
        assert_eq!(model["metadata"]["provider"], "ai-sdk");
        assert_eq!(model["metadata"]["sdk_provider"], "anthropic");
        assert_eq!(model["metadata"]["context_window"], 200000);
        assert_eq!(model["metadata"]["pricing"]["input"], 3);
        for (path, payload) in [
            ("/v1/chat/completions", json!({"model": "anthropic/test", "messages": [{"role": "user", "content": "Hello"}]})),
            ("/v1/responses", json!({"model": "anthropic/test", "input": "Hello"})),
            ("/v1/responses", json!({"model": "anthropic/test", "input": "Hello", "stream": true})),
            ("/v1/messages", json!({"model": "anthropic/test", "messages": [{"role": "user", "content": "Hello"}], "max_tokens": 50})),
        ] {
            let response = client.post(format!("{edge_url}{path}")).bearer_auth("proxy-secret").json(&payload).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert!(response.text().await.unwrap().contains("Hi"), "{path}");
        }
        assert_eq!(client.get(format!("{edge_url}/internal/ai-sdk/sdk-account/v1/models")).bearer_auth("adapter-secret").send().await.unwrap().status(), StatusCode::NOT_FOUND);
        edge_task.abort(); adapter_task.abort();
        let _ = fs::remove_file(store_path).await; let _ = fs::remove_file(jobs_path).await;
    }

    #[test]
    fn api_key_authentication_is_constant_time_and_application_scoped() {
        assert!(constant_time_equal("same-key", "same-key"));
        assert!(!constant_time_equal("same-key", "other-key"));

        let mut config = EdgeConfig::default();
        config.configured_api_keys = vec![("interactive".to_owned(), "secret".to_owned())];
        let store = StoreFile::default();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer secret"),
        );

        let auth = authorize(&headers, "/v1/responses", &store, &config).unwrap();
        assert_eq!(auth.application, "interactive");

        headers.remove(header::AUTHORIZATION);
        let error = authorize(&headers, "/v1/messages", &store, &config).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn codex_session_headers_are_distinguished_from_provider_session_headers() {
        let mut headers = HeaderMap::new();
        headers.insert("thread-id", HeaderValue::from_static("thread-123"));
        assert_eq!(
            request_codex_session_id(&headers).as_deref(),
            Some("thread-123")
        );
        assert_eq!(request_session_id(&headers), None);

        headers.insert("session_id", HeaderValue::from_static("provider-123"));
        assert_eq!(
            request_session_id(&headers).as_deref(),
            Some("provider-123")
        );
        // The explicit native Codex id remains authoritative for affinity.
        assert_eq!(
            request_codex_session_id(&headers).as_deref(),
            Some("thread-123")
        );

        headers.remove("thread-id");
        headers.remove("session_id");
        headers.insert(
            "x-codex-turn-metadata",
            HeaderValue::from_static(r#"{"session_id":"metadata-123"}"#),
        );
        assert_eq!(
            request_codex_session_id(&headers).as_deref(),
            Some("metadata-123")
        );
    }

    #[test]
    fn configured_keys_reject_duplicates() {
        let error = parse_configured_api_keys("legacy", r#"{"batch":"legacy"}"#).unwrap_err();
        assert!(error.contains("unique"));

        let parsed = parse_configured_api_keys("", r#"{"batch":"batch-key"}"#).unwrap();
        assert_eq!(parsed, vec![("batch".to_owned(), "batch-key".to_owned())]);
    }

    #[test]
    fn zstd_decompression_is_bounded() {
        let source = br#"{"input":"hello"}"#;
        let compressed = zstd::stream::encode_all(Cursor::new(source), 1).unwrap();
        assert_eq!(
            decompress_zstd(&compressed, source.len()).unwrap().as_ref(),
            source.as_slice()
        );
        assert!(decompress_zstd(&compressed, source.len() - 1).is_err());
    }

    #[test]
    fn account_selection_respects_subscription_credits() {
        let mut high = account("high");
        high.usage = Some(serde_json::from_value(json!({
            "credits": { "usedPercent": 10 },
            "tools": { "usedPercent": 100 }
        })).unwrap());
        let mut low = account("low");
        low.usage = Some(serde_json::from_value(json!({
            "credits": { "usedPercent": 90 }
        })).unwrap());
        let mut exhausted = account("exhausted");
        exhausted.usage = Some(serde_json::from_value(json!({
            "monthly": { "usedPercent": 100 }
        })).unwrap());
        let route = RouteCandidate {
            requested_model: "test".to_owned(),
            model: "test".to_owned(),
            provider: Some("openai".to_owned()),
            account_ids: Vec::new(),
        };
        assert_eq!(account_headroom(&high), Some(90.0));
        let ordered = select_accounts(
            &[high, low, exhausted], &route, &HashMap::new(),
            &HashMap::from([("openai".to_owned(), "high".to_owned())]),
        );
        assert_eq!(ordered.first().map(|value| value.id.as_str()), Some("high"));
        assert_eq!(ordered.len(), 2);
    }

    #[test]
    fn account_selection_balances_usage_and_rotates_ties() {
        let mut first = account("a");
        first.usage = Some(UsageSnapshot {
            secondary: Some(UsageWindow {
                used_percent: Some(70.0),
                ..Default::default()
            }),
            ..Default::default()
        });
        let mut second = account("b");
        second.usage = Some(UsageSnapshot {
            secondary: Some(UsageWindow {
                used_percent: Some(10.0),
                ..Default::default()
            }),
            ..Default::default()
        });
        let route = RouteCandidate {
            requested_model: "gpt-5.3-codex".to_owned(),
            model: "gpt-5.3-codex".to_owned(),
            provider: Some("openai".to_owned()),
            account_ids: Vec::new(),
        };
        let accounts = vec![first, second];
        let empty = HashMap::new();
        let selected = HashMap::new();
        let ordered = select_accounts(&accounts, &route, &empty, &selected);
        assert_eq!(ordered.first().map(|value| value.id.as_str()), Some("b"));

        let selected = HashMap::from([(String::from("openai"), String::from("b"))]);
        let rotated = select_accounts(&accounts, &route, &empty, &selected);
        assert_eq!(rotated.first().map(|value| value.id.as_str()), Some("a"));

        let mut blocked = account("blocked");
        blocked.state = Some(AccountState {
            auth_blocked_until: Some(now_ms() + 60_000),
            ..Default::default()
        });
        let accounts = vec![blocked];
        assert!(select_accounts(&accounts, &route, &empty, &HashMap::new()).is_empty());
    }

    #[test]
    fn image_override_requires_an_image_and_an_exposed_model_or_alias() {
        let image = json!({
            "messages": [{
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": "https://example.test/image.png"}}]
            }]
        });
        let text = json!({"input": [{"role": "user", "content": [{"type": "input_text", "text": "hello"}]}]});
        let catalog = vec![json!({"id": "openai/gpt-vision"})];
        let mut store = StoreFile::default();
        store.settings.image_request_model_override = Some("gpt-vision".to_owned());

        assert!(payload_has_image(&image));
        assert!(!payload_has_image(&text));
        assert_eq!(
            image_aware_routing_model(&store, &catalog, &image, "gpt-text"),
            "gpt-vision"
        );
        assert_eq!(
            image_aware_routing_model(&store, &catalog, &text, "gpt-text"),
            "gpt-text"
        );

        store.settings.image_request_model_override = Some("vision-alias".to_owned());
        store.model_aliases.push(ModelAlias {
            id: "vision-alias".to_owned(),
            enabled: true,
            defaults: Some(json!({"priority": "interactive", "executionMode": "auto"})),
            ..Default::default()
        });
        assert_eq!(
            image_aware_routing_model(&store, &catalog, &image, "gpt-text"),
            "vision-alias"
        );
        assert_eq!(
            alias_default(&store, "vision-alias", "priority").as_deref(),
            Some("interactive")
        );

        store.settings.image_request_model_override = Some("missing-model".to_owned());
        assert_eq!(
            image_aware_routing_model(&store, &catalog, &image, "gpt-text"),
            "gpt-text"
        );
    }

    #[test]
    fn same_account_retry_honors_transient_status_retry_after_and_quota_rotation() {
        assert!(should_retry_same_account(
            StatusCode::SERVICE_UNAVAILABLE,
            "temporarily unavailable"
        ));
        assert!(should_retry_same_account(
            StatusCode::BAD_REQUEST,
            "upstream connection refused"
        ));
        assert!(!should_retry_same_account(
            StatusCode::TOO_MANY_REQUESTS,
            "rate limit"
        ));
        assert!(!should_retry_same_account(
            StatusCode::SERVICE_UNAVAILABLE,
            "provider capacity quota exhausted"
        ));

        let mut headers = HeaderMap::new();
        headers.insert(header::RETRY_AFTER, HeaderValue::from_static("7"));
        assert_eq!(
            upstream_retry_delay(Some(&headers), 0, Duration::from_secs(2)),
            Duration::from_secs(7)
        );
        assert_eq!(
            upstream_retry_delay(None, 2, Duration::from_secs(2)),
            Duration::from_secs(8)
        );
    }

    #[tokio::test]
    async fn upstream_sender_retries_transient_errors_but_not_quota() {
        let transient_attempts = Arc::new(AtomicUsize::new(0));
        let quota_attempts = Arc::new(AtomicUsize::new(0));
        let transient_counter = transient_attempts.clone();
        let quota_counter = quota_attempts.clone();
        let upstream = Router::new()
            .route(
                "/transient",
                post(move || {
                    let counter = transient_counter.clone();
                    async move {
                        if counter.fetch_add(1, AtomicOrdering::Relaxed) == 0 {
                            json_response(
                                StatusCode::SERVICE_UNAVAILABLE,
                                json!({"error": "temporarily unavailable"}),
                            )
                        } else {
                            json_response(StatusCode::OK, json!({"id": "retry-success"}))
                        }
                    }
                }),
            )
            .route(
                "/quota",
                post(move || {
                    let counter = quota_counter.clone();
                    async move {
                        counter.fetch_add(1, AtomicOrdering::Relaxed);
                        json_response(
                            StatusCode::TOO_MANY_REQUESTS,
                            json!({"error": "rate limit"}),
                        )
                    }
                }),
            );
        let (upstream_url, upstream_task) = start_server(upstream).await;

        let store_path = temporary_path("upstream-retry-store");
        let jobs_path = temporary_path("upstream-retry-jobs");
        fs::write(&store_path, b"{}".as_slice()).await.unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.max_upstream_retries = 3;
        config.upstream_retry_base_delay = Duration::from_millis(1);
        let state = EdgeState::new(config).await.unwrap();

        let retry_result = send_upstream_with_retry(
            &state,
            &format!("{upstream_url}/transient"),
            &HeaderMap::new(),
            b"{}",
        )
        .await
        .unwrap();
        assert!(matches!(retry_result, UpstreamSendResult::Success(_)));
        assert_eq!(transient_attempts.load(AtomicOrdering::Relaxed), 2);

        let quota_result = send_upstream_with_retry(
            &state,
            &format!("{upstream_url}/quota"),
            &HeaderMap::new(),
            b"{}",
        )
        .await
        .unwrap();
        assert!(matches!(quota_result, UpstreamSendResult::HttpError(_)));
        assert_eq!(quota_attempts.load(AtomicOrdering::Relaxed), 1);

        upstream_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }

    #[tokio::test]
    async fn credential_transport_returns_redirects_without_following_them() {
        let destination_calls = Arc::new(AtomicUsize::new(0));
        let counter = destination_calls.clone();
        let routes = Router::new()
            .route("/redirect", post(|| async { axum::response::Redirect::temporary("/done") }))
            .route("/done", post(move || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, AtomicOrdering::SeqCst);
                    StatusCode::NO_CONTENT
                }
            }));
        let (url, task) = start_server(routes).await;
        let mut config = EdgeConfig::default();
        config.store_path = temporary_path("redirect-accounts");
        config.jobs_path = temporary_path("redirect-jobs");
        config.legacy_jobs_db_path = None;
        let state = EdgeState::new(config).await.unwrap();
        let response = state.webhook_client.post(format!("{url}/redirect"))
            .body("request").send().await.unwrap();
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(destination_calls.load(AtomicOrdering::SeqCst), 0);
        task.abort();
    }

    #[tokio::test]
    async fn native_token_refresh_is_single_flight_and_persisted_through_control_plane() {
        let store_path = temporary_path("token-refresh-accounts");
        let jobs_path = temporary_path("token-refresh-jobs");
        let mut expired = account("refresh-account");
        expired.access_token = "expired-access".to_owned();
        expired.refresh_token = Some("rotating-refresh".to_owned());
        expired.expires_at = Some(1);
        fs::write(
            &store_path,
            serde_json::to_vec(&store_with_accounts(vec![expired.clone()])).unwrap(),
        )
        .await
        .unwrap();

        let oauth_calls = Arc::new(AtomicUsize::new(0));
        let persistence_calls = Arc::new(AtomicUsize::new(0));
        let oauth_counter = oauth_calls.clone();
        let persistence_counter = persistence_calls.clone();
        let persisted_store_path = store_path.clone();
        let control_plane = Router::new()
            .route(
                "/oauth/token",
                post(move || {
                    let counter = oauth_counter.clone();
                    async move {
                        counter.fetch_add(1, AtomicOrdering::SeqCst);
                        Json(json!({
                            "access_token": "fresh-access",
                            "refresh_token": "fresh-refresh",
                            "expires_in": 3600
                        }))
                    }
                }),
            )
            .route(
                "/internal/v1-edge/accounts/{id}/token",
                post(move |Path(id): Path<String>, Json(payload): Json<Value>| {
                    let counter = persistence_counter.clone();
                    let path = persisted_store_path.clone();
                    async move {
                        counter.fetch_add(1, AtomicOrdering::SeqCst);
                        let mut store: StoreFile =
                            serde_json::from_slice(&fs::read(&path).await.unwrap()).unwrap();
                        let account = store
                            .accounts
                            .iter_mut()
                            .find(|account| account.id == id)
                            .unwrap();
                        assert_eq!(payload["expectedAccessToken"], account.access_token);
                        account.access_token = payload["accessToken"].as_str().unwrap().to_owned();
                        account.refresh_token = value_string(payload.get("refreshToken"));
                        account.expires_at = payload.get("expiresAt").and_then(Value::as_u64);
                        fs::write(&path, serde_json::to_vec(&store).unwrap())
                            .await
                            .unwrap();
                        Json(json!({"ok": true}))
                    }
                }),
            );
        let (control_plane_url, control_plane_task) = start_server(control_plane).await;
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.legacy_jobs_db_path = None;
        config.node_control_plane_url = control_plane_url.clone();
        config.oauth_token_url = format!("{control_plane_url}/oauth/token");
        config.internal_job_token = Some("refresh-internal".to_owned());
        let state = EdgeState::new(config).await.unwrap();
        let selected = state.store.snapshot().await.unwrap().accounts.remove(0);

        let first = state.token_refresh.refresh(
            &state.webhook_client,
            &state.config,
            &state.store,
            &selected,
            false,
        );
        let second = state.token_refresh.refresh(
            &state.webhook_client,
            &state.config,
            &state.store,
            &selected,
            false,
        );
        let (first, second) = tokio::join!(first, second);
        assert_eq!(first.unwrap().access_token, "fresh-access");
        assert_eq!(second.unwrap().access_token, "fresh-access");
        assert_eq!(oauth_calls.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(persistence_calls.load(AtomicOrdering::SeqCst), 1);

        control_plane_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }

    #[tokio::test]
    async fn native_drain_rejects_new_inference_and_reports_active_work() {
        let controller = DrainController::default();
        let request = controller.admit(ActivityKind::Request).unwrap();
        let websocket = controller.admit(ActivityKind::WebsocketTurn).unwrap();
        controller.begin();
        assert!(controller.admit(ActivityKind::Job).is_none());
        assert_eq!(controller.snapshot(), (true, 1, 1, 0));
        drop(request);
        drop(websocket);
        assert_eq!(controller.snapshot(), (true, 0, 0, 0));

        let store_path = temporary_path("drain-accounts");
        let jobs_path = temporary_path("drain-jobs");
        fs::write(&store_path, b"{}".as_slice()).await.unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.legacy_jobs_db_path = None;
        config.internal_job_token = Some("drain-internal".to_owned());
        config.configured_api_keys = vec![("drain-app".to_owned(), "drain-key".to_owned())];
        let state = EdgeState::new(config).await.unwrap();
        let (edge_url, edge_task) = start_server(build_router(state)).await;
        let client = reqwest::Client::new();

        assert_eq!(
            client
                .get(format!("{edge_url}/internal/v1-edge/drain/status"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let status: Value = client
            .post(format!("{edge_url}/internal/v1-edge/drain/begin"))
            .header("x-multivibe-internal-token", "drain-internal")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(status["ready"], true);
        let rejected: Value = client
            .post(format!("{edge_url}/v1/responses"))
            .header(header::AUTHORIZATION, "Bearer drain-key")
            .json(&json!({"model": "gpt-drain", "input": "hello"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(rejected["error"]["code"], "host_update_draining");

        let resumed: Value = client
            .post(format!("{edge_url}/internal/v1-edge/drain/resume"))
            .header("x-multivibe-internal-token", "drain-internal")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(resumed["draining"], false);

        edge_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }

    #[tokio::test]
    async fn native_drain_tracks_a_job_until_its_result_is_durable() {
        let upstream_responded = Arc::new(AtomicBool::new(false));
        let response_flag = upstream_responded.clone();
        let upstream = Router::new()
            .route(
                "/backend-api/codex/models",
                get(|| async { Json(json!({"models": [{"slug": "gpt-job"}]})) }),
            )
            .route(
                "/backend-api/codex/responses",
                post(move || {
                    let responded = response_flag.clone();
                    async move {
                        responded.store(true, AtomicOrdering::SeqCst);
                        Json(json!({
                            "id": "resp-durable",
                            "object": "response",
                            "model": "gpt-job",
                            "status": "completed",
                            "output": [],
                            "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
                        }))
                    }
                }),
            );
        let (upstream_url, upstream_task) = start_server(upstream).await;
        let store_path = temporary_path("drain-durable-accounts");
        let jobs_path = temporary_path("drain-durable-jobs");
        fs::write(
            &store_path,
            serde_json::to_vec(&store_with_accounts(vec![account("drain-job-account")])).unwrap(),
        )
        .await
        .unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.legacy_jobs_db_path = None;
        config.chatgpt_base_url = upstream_url;
        let state = EdgeState::new(config).await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-multivibe-priority", HeaderValue::from_static("standard"));
        let job = state
            .jobs
            .create(
                "drain-app",
                "/v1/responses",
                &headers,
                &json!({"model": "gpt-job", "input": "hello"}),
                3,
            )
            .await
            .unwrap()
            .job;
        let running = state
            .jobs
            .acquire_next(&HashMap::new())
            .await
            .unwrap()
            .unwrap();
        let persistence_guard = state.jobs.persist_lock.lock().await;
        let activity = state.drain.admit(ActivityKind::Job).unwrap();
        let permit = Arc::new(Semaphore::new(1)).acquire_owned().await.unwrap();
        let job_state = state.clone();
        let worker = tokio::spawn(async move {
            run_claimed_job(job_state, running, permit, activity).await;
        });
        timeout(Duration::from_secs(2), async {
            while !upstream_responded.load(AtomicOrdering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::task::yield_now().await;
        assert!(!worker.is_finished());

        state.drain.begin();
        assert_eq!(state.drain.snapshot(), (true, 0, 0, 1));
        drop(persistence_guard);
        timeout(Duration::from_secs(2), worker)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(state.drain.snapshot(), (true, 0, 0, 0));
        let reloaded = JobManager::new(jobs_path.clone()).await.unwrap();
        let persisted = reloaded.get_for("drain-app", &job.id).await.unwrap();
        assert_eq!(persisted.status, "succeeded");
        assert_eq!(persisted.result.as_ref().unwrap()["id"], "resp-durable");

        upstream_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }

    #[tokio::test]
    async fn native_runner_closes_the_claim_and_drain_race_durably() {
        let store_path = temporary_path("drain-claim-accounts");
        let jobs_path = temporary_path("drain-claim-jobs");
        fs::write(&store_path, b"{}").await.unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.legacy_jobs_db_path = None;
        let state = EdgeState::new(config).await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-multivibe-priority", HeaderValue::from_static("standard"));
        let job = state
            .jobs
            .create(
                "drain-app",
                "/v1/responses",
                &headers,
                &json!({"model": "gpt-job", "input": "hello"}),
                3,
            )
            .await
            .unwrap()
            .job;
        let persistence_guard = state.jobs.persist_lock.lock().await;
        let runner = state.start_job_runner().unwrap();
        timeout(Duration::from_secs(2), async {
            while state.drain.snapshot().3 != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        state.drain.begin();
        assert_eq!(state.drain.snapshot(), (true, 0, 0, 1));
        drop(persistence_guard);
        timeout(Duration::from_secs(2), async {
            while state.drain.snapshot().3 != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let persisted = JobManager::new(jobs_path.clone())
            .await
            .unwrap()
            .get_for("drain-app", &job.id)
            .await
            .unwrap();
        assert_eq!(persisted.status, "queued");
        assert_eq!(persisted.attempts, 0);

        runner.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }

    #[tokio::test]
    async fn admission_leases_are_atomic_and_reflected_in_capacity() {
        let version = Arc::new(AtomicU64::new(1));
        let admission = Arc::new(AdmissionController::new(version.clone()));
        let mut target = account("capacity-one");
        target.capacity_profile = Some(CapacityProfile {
            max_concurrent: Some(1),
            ..Default::default()
        });
        let barrier = Arc::new(tokio::sync::Barrier::new(3));
        let mut tasks = Vec::new();
        for _ in 0..2 {
            let admission = admission.clone();
            let barrier = barrier.clone();
            let target = target.clone();
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                admission.acquire_any(&[target]).map(|(_, lease)| lease)
            }));
        }
        barrier.wait().await;
        let mut leases = Vec::new();
        for task in tasks {
            if let Some(lease) = task.await.unwrap() {
                leases.push(lease);
            }
        }

        assert_eq!(leases.len(), 1, "only one concurrent lease may be issued");
        assert_eq!(admission.snapshot(&[target.clone()]), (0, 0));
        assert!(version.load(AtomicOrdering::Relaxed) > 1);

        drop(leases);
        assert_eq!(admission.snapshot(&[target]), (1, 0));
    }

    #[test]
    fn admission_uses_cloud_capacity_default_without_relaxing_local_capacity() {
        let mut cloud = account("cloud-capacity");
        cloud.location = Some("cloud".to_owned());
        assert_eq!(account_max_concurrent(&cloud), 32);

        let mut local = account("local-capacity");
        local.location = Some("local".to_owned());
        assert_eq!(account_max_concurrent(&local), 1);

        cloud.capacity_profile = Some(CapacityProfile {
            max_concurrent: Some(3),
            ..Default::default()
        });
        assert_eq!(account_max_concurrent(&cloud), 3);
    }

    #[tokio::test]
    async fn admission_wait_is_bounded_queued_and_released_on_drop() {
        let admission = Arc::new(AdmissionController::new(Arc::new(AtomicU64::new(1))));
        let mut target = account("capacity-wait");
        target.capacity_profile = Some(CapacityProfile {
            max_concurrent: Some(1),
            ..Default::default()
        });
        let (_, first_lease) = admission.acquire_any(&[target.clone()]).unwrap();

        let waiting_admission = admission.clone();
        let waiting_target = target.clone();
        let waiter = tokio::spawn(async move {
            let accounts = [waiting_target];
            if waiting_admission
                .wait_for_capacity(&accounts, Duration::from_secs(1))
                .await
            {
                waiting_admission
                    .acquire_any(&accounts)
                    .map(|(_, lease)| lease)
            } else {
                None
            }
        });
        timeout(Duration::from_secs(1), async {
            while admission.snapshot(&[target.clone()]).1 != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(admission.snapshot(&[target.clone()]), (0, 1));

        drop(first_lease);
        let second_lease = timeout(Duration::from_secs(1), waiter)
            .await
            .unwrap()
            .unwrap()
            .expect("the queued request should acquire the released slot");
        assert_eq!(admission.snapshot(&[target.clone()]), (0, 0));
        drop(second_lease);
        assert_eq!(admission.snapshot(&[target.clone()]), (1, 0));

        let (_, held_lease) = admission.acquire_any(&[target.clone()]).unwrap();
        let timed_out = admission
            .wait_for_capacity(&[target.clone()], Duration::from_millis(10))
            .await;
        assert!(!timed_out);
        assert_eq!(admission.snapshot(&[target.clone()]), (0, 0));
        drop(held_lease);
    }

    #[test]
    fn admission_wait_header_is_validated_and_capped() {
        let mut headers = HeaderMap::new();
        assert_eq!(admission_wait(&headers).unwrap(), Duration::ZERO);
        headers.insert(
            "x-multivibe-max-wait-ms",
            HeaderValue::from_static("invalid"),
        );
        assert_eq!(
            admission_wait(&headers).unwrap_err().status(),
            StatusCode::BAD_REQUEST
        );
        headers.insert(
            "x-multivibe-max-wait-ms",
            HeaderValue::from_static("999999999999999999999999"),
        );
        assert_eq!(
            admission_wait(&headers).unwrap(),
            Duration::from_millis(MAX_ADMISSION_WAIT_MS)
        );
    }

    #[tokio::test]
    async fn streaming_response_holds_capacity_until_the_client_drops_it() {
        let upstream = Router::new()
            .route(
                "/backend-api/codex/models",
                get(|| async { Json(json!({"models": [{"slug": "gpt-capacity"}]})) }),
            )
            .route(
                "/backend-api/codex/responses",
                post(|| async {
                    let body = stream! {
                        yield Ok::<Bytes, Infallible>(Bytes::from_static(
                            b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"held\"}\n\n",
                        ));
                        std::future::pending::<()>().await;
                    };
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "text/event-stream")
                        .body(Body::from_stream(body))
                        .unwrap()
                }),
            );
        let (upstream_url, upstream_task) = start_server(upstream).await;

        let store_path = temporary_path("stream-capacity");
        let jobs_path = temporary_path("stream-capacity-jobs");
        let trace_path = temporary_path("stream-capacity-trace");
        let mut target = account("capacity-stream");
        target.capacity_profile = Some(CapacityProfile {
            max_concurrent: Some(1),
            ..Default::default()
        });
        fs::write(
            &store_path,
            serde_json::to_vec(&store_with_accounts(vec![target])).unwrap(),
        )
        .await
        .unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.chatgpt_base_url = upstream_url;
        config.configured_api_keys = vec![("capacity-app".to_owned(), "edge-secret".to_owned())];
        config.models_cache_ttl = Duration::from_secs(60);
        config.upstream_timeout = Duration::from_secs(5);
        config.trace_path = Some(trace_path.clone());

        let state = EdgeState::new(config).await.unwrap();
        let (edge_url, edge_task) = start_server(build_router(state)).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("{edge_url}/v1/responses"))
            .header("authorization", "Bearer edge-secret")
            .json(&json!({
                "model": "gpt-capacity",
                "input": "hello",
                "stream": true
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let capacity: Value = client
            .get(format!(
                "{edge_url}/v1/capacity?model=gpt-capacity&priority=standard"
            ))
            .header("authorization", "Bearer edge-secret")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(capacity["freeSlots"], 0);

        drop(response);
        timeout(Duration::from_secs(2), async {
            loop {
                let capacity: Value = client
                    .get(format!(
                        "{edge_url}/v1/capacity?model=gpt-capacity&priority=standard"
                    ))
                    .header("authorization", "Bearer edge-secret")
                    .send()
                    .await
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
                if capacity["freeSlots"] == 1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("dropping the client stream should release its capacity lease");

        timeout(Duration::from_secs(2), async {
            loop {
                if fs::read_to_string(&trace_path)
                    .await
                    .is_ok_and(|contents| contents.lines().any(|line| {
                        serde_json::from_str::<Value>(line).is_ok_and(|trace| {
                            trace["traceKind"] == "client-request" && trace["status"] == 499
                        })
                    }))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("a pre-terminal client disconnect should remain a 499");

        edge_task.abort();
        upstream_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
        let _ = fs::remove_file(trace_path).await;
    }

    #[tokio::test]
    async fn completed_sse_is_not_traced_as_499_when_client_drops_before_eof() {
        let upstream = Router::new()
            .route(
                "/backend-api/codex/models",
                get(|| async { Json(json!({"models": [{"slug": "gpt-completed"}]})) }),
            )
            .route(
                "/backend-api/codex/responses",
                post(|| async {
                    let body = stream! {
                        yield Ok::<Bytes, Infallible>(Bytes::from_static(
                            b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"total_tokens\":5}}}\n\n",
                        ));
                        std::future::pending::<()>().await;
                    };
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "text/event-stream")
                        .body(Body::from_stream(body))
                        .unwrap()
                }),
            );
        let (upstream_url, upstream_task) = start_server(upstream).await;

        let store_path = temporary_path("completed-drop-store");
        let jobs_path = temporary_path("completed-drop-jobs");
        let trace_path = temporary_path("completed-drop-trace");
        fs::write(
            &store_path,
            serde_json::to_vec(&store_with_accounts(vec![account("completed-drop")])).unwrap(),
        )
        .await
        .unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.chatgpt_base_url = upstream_url;
        config.configured_api_keys = vec![("completed-app".to_owned(), "edge-secret".to_owned())];
        config.models_cache_ttl = Duration::from_secs(60);
        config.upstream_timeout = Duration::from_secs(5);
        config.trace_path = Some(trace_path.clone());

        let state = EdgeState::new(config).await.unwrap();
        let (edge_url, edge_task) = start_server(build_router(state)).await;
        let mut response = reqwest::Client::new()
            .post(format!("{edge_url}/v1/responses"))
            .header("authorization", "Bearer edge-secret")
            .json(&json!({
                "model": "gpt-completed",
                "input": "hello",
                "stream": true
            }))
            .send()
            .await
            .unwrap();
        let chunk = response.chunk().await.unwrap().unwrap();
        assert!(String::from_utf8_lossy(&chunk).contains("response.completed"));
        drop(response);

        let traces = timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(contents) = fs::read_to_string(&trace_path).await {
                    let traces = contents
                        .lines()
                        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                        .collect::<Vec<_>>();
                    if traces.iter().any(|trace| trace["traceKind"] == "client-request") {
                        break traces;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("dropping after response.completed should finalize the trace");
        for trace in traces.iter().filter(|trace| {
            matches!(
                trace["traceKind"].as_str(),
                Some("client-request" | "upstream-attempt")
            )
        }) {
            assert_eq!(trace["status"], 200);
            assert_eq!(trace["isError"], false);
            assert_eq!(trace["lifecycleState"], "completed");
            assert_eq!(trace["clientDisconnected"], true);
            assert!(trace.get("error").is_none());
        }

        edge_task.abort();
        upstream_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
        let _ = fs::remove_file(trace_path).await;
    }

    #[test]
    fn session_affinity_is_scoped_expiring_and_lru_bounded() {
        let mut cache = SessionAffinityCache::new(Duration::from_millis(100), 2);
        cache.remember("app-one", "thread", "openai", "account-one", 1_000);
        cache.remember("app-two", "thread", "openai", "account-two", 1_000);

        assert_eq!(
            cache.peek("app-one", "thread", "openai", 1_050),
            Some("account-one".to_owned())
        );
        assert_eq!(
            cache.peek("app-two", "thread", "openai", 1_050),
            Some("account-two".to_owned())
        );
        assert_eq!(cache.peek("app-one", "thread", "xai", 1_050), None);

        // A read makes app-one the most recently used entry without extending
        // its TTL. The new entry therefore evicts app-two.
        assert_eq!(
            cache.get("app-one", "thread", "openai", 1_050),
            Some("account-one".to_owned())
        );
        cache.remember("app-three", "thread", "openai", "account-three", 1_050);
        assert_eq!(
            cache.get("app-one", "thread", "openai", 1_099),
            Some("account-one".to_owned())
        );
        assert_eq!(cache.get("app-two", "thread", "openai", 1_099), None);
        assert_eq!(
            cache.get("app-three", "thread", "openai", 1_099),
            Some("account-three".to_owned())
        );

        // Reads do not renew the TTL: app-one was inserted at 1,000 and is
        // expired at 1,100 even though it was recently read.
        assert_eq!(cache.get("app-one", "thread", "openai", 1_100), None);
    }

    #[test]
    fn protocol_conversions_preserve_tools_images_and_session_defaults() {
        let chat = json!({
            "model": "gpt-5.3-codex",
            "messages": [
                {"role": "system", "content": "Be concise"},
                {"role": "user", "content": [
                    {"type": "text", "text": "Describe this"},
                    {"type": "image_url", "image_url": {"url": "https://example.test/image.png"}}
                ]},
                {"role": "assistant", "content": "", "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "lookup", "arguments": "{\"q\":\"rust\"}"}}]},
                {"role": "tool", "tool_call_id": "call-1", "content": "result"}
            ],
            "tools": [{"type": "function", "function": {"name": "lookup", "parameters": {"type": "object"}}}]
        });
        let responses = chat_completions_to_responses(&chat, Some("session-1"));
        assert_eq!(responses["store"], false);
        assert_eq!(responses["stream"], true);
        assert_eq!(responses["prompt_cache_key"], "session-1");
        assert_eq!(responses["instructions"], "Be concise");
        assert!(responses["input"].as_array().unwrap().iter().any(|item| {
            item["content"]
                .as_array()
                .unwrap()
                .iter()
                .any(|part| part["type"] == "input_image")
        }));
        assert!(
            responses["input"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| { item["type"] == "function_call_output" })
        );

        let chat_again = response_to_chat(
            &json!({
                "id": "resp-1",
                "object": "response",
                "model": "gpt-5.3-codex",
                "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "done"}]}],
                "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5}
            }),
            "gpt-5.3-codex",
        );
        assert_eq!(chat_again["object"], "chat.completion");
        assert_eq!(chat_again["choices"][0]["message"]["content"], "done");

        let anthropic = anthropic_to_responses(
            &json!({
                "model": "claude-sonnet-4-5",
                "system": "You are helpful",
                "messages": [{"role": "user", "content": [{"type": "text", "text": "Hello"}]}]
            }),
            true,
            &EdgeConfig::default(),
        );
        assert!(!anthropic["model"].as_str().unwrap().contains("claude"));
        assert_eq!(anthropic["instructions"], "You are helpful");
    }

    #[test]
    fn responses_to_chat_drops_builtin_tools_and_normalizes_function_tools() {
        let converted = responses_to_chat_completions(
            &json!({
                "model": "Qwen3.8-27B-4bit",
                "input": [{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}],
                "tools": [
                    {"type": "web_search_preview"},
                    {"type": "function", "name": "lookup", "description": "Look something up", "parameters": {"type": "object"}},
                    {"type": "computer_use_preview"}
                ],
                "tool_choice": {"type": "function", "name": "lookup"}
            }),
            false,
        );

        assert_eq!(
            converted["tools"],
            json!([{"type": "function", "function": {"name": "lookup", "description": "Look something up", "parameters": {"type": "object"}}}])
        );
        assert_eq!(
            converted["tool_choice"],
            json!({"type": "function", "function": {"name": "lookup"}})
        );
    }

    #[test]
    fn custom_tool_stream_restores_split_json_and_emits_item_lifecycle() {
        let (_, adapter) = chat_tools::ChatTools::prepare(&json!({"tools": [{"type": "custom", "name": "exec"}]})).unwrap();
        let mut converter = SseStreamTransformer::new(StreamTransform::ChatToResponse, "glm-test");
        converter.chat_response.chat_tools = adapter;
        let mut stream = String::new();
        for chunk in [
            json!({"index": 0, "id": "call_exec", "function": {"name": "mv_tool_0", "arguments": "{\"input\":\"print("}}),
            json!({"index": 0, "function": {"arguments": " "}}),
            json!({"index": 0, "function": {"arguments": "42)\"}"}}),
        ] {
            stream.push_str(&converter.transform_chat_chunk(&json!({"object": "chat.completion.chunk", "choices": [{"delta": {"tool_calls": [chunk]}, "finish_reason": null}]})));
        }
        stream.push_str(&converter.finish());
        assert!(stream.contains("response.output_item.added"));
        assert!(stream.contains("response.custom_tool_call_input.done"));
        assert!(stream.contains("response.output_item.done"));
        assert!(!stream.contains("mv_tool_0"));
        assert!(!stream.contains("response.function_call_arguments.delta"));
        let result = response_from_sse(&stream, "glm-test");
        assert_eq!(result["output"][0]["type"], "custom_tool_call");
        assert_eq!(result["output"][0]["input"], "print( 42)");
        assert_eq!(result["output"][0]["call_id"], "call_exec");
    }

    #[test]
    fn chat_tool_contract_preserves_requirements() {
        for body in [
            json!({"tools": [{"type": "custom", "name": "exec"}]}),
            json!({"tools": [{"type": "web_search_preview"}]}),
            json!({"tools": [], "tool_choice": "required"}),
            json!({"tools": [{"type": "function", "name": "lookup"}], "tool_choice": {"type": "function", "name": "missing"}}),
        ] {
            assert!(validate_chat_tool_contract(&body).is_err());
        }
        let body = json!({"tools": [{"type": "function", "name": "lookup", "parameters": {"type": "object"}}], "tool_choice": "required",
            "input": [{"type": "function_call", "call_id": "call_1", "name": "lookup", "arguments": "{}"}, {"type": "function_call_output", "call_id": "call_1", "output": "result"}]});
        assert!(validate_chat_tool_contract(&body).is_ok());
        let converted = responses_to_chat_completions(&body, false);
        assert_eq!(converted["tool_choice"], "required");
        assert_eq!(converted["messages"][0]["tool_calls"][0]["id"], converted["messages"][1]["tool_call_id"]);
        assert_eq!(converted["messages"][1]["content"], "result");
    }

    #[tokio::test]
    async fn native_chat_tool_round_trip_and_unsupported_rejection() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let upstream = Router::new()
            .route("/v1/models", get(|| async { Json(json!({"data": [{"id": "glm-test"}]})) }))
            .route("/v1/chat/completions", post(move |Json(body): Json<Value>| {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, AtomicOrdering::SeqCst);
                    assert_eq!(body["tools"][0]["type"], "function");
                    assert_eq!(body["tools"][0]["function"]["name"], "lookup");
                    assert!(body["tools"][0].get("name").is_none());
                    let returned = body["messages"].as_array().unwrap().iter().any(|m| m["role"] == "tool");
                    let message = if returned {
                        let messages = body["messages"].as_array().unwrap();
                        assert!(messages.iter().any(|m| m["tool_call_id"] == "call_lookup" && m["content"] == "42"));
                        json!({"role": "assistant", "content": "The result is 42."})
                    } else {
                        json!({"role": "assistant", "content": null, "tool_calls": [{"id": "call_lookup", "type": "function", "function": {"name": "lookup", "arguments": "{}"}}]})
                    };
                    Json(json!({"id": "chat_test", "object": "chat.completion", "model": "glm-test", "created": 1,
                        "choices": [{"index": 0, "message": message, "finish_reason": if returned { "stop" } else { "tool_calls" }}],
                        "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10}}))
                }
            }));
        let (url, upstream_task) = start_server(upstream).await;
        let store_path = temporary_path("tool-roundtrip-store");
        let jobs_path = temporary_path("tool-roundtrip-jobs");
        let mut provider = account("strict-chat");
        provider.provider = Some("openai-compatible".to_owned());
        provider.base_url = Some(url);
        provider.upstream_mode = Some("chat/completions".to_owned());
        fs::write(&store_path, serde_json::to_vec(&store_with_accounts(vec![provider])).unwrap()).await.unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.legacy_jobs_db_path = None;
        config.configured_api_keys = vec![("test".to_owned(), "test-key".to_owned())];
        let state = EdgeState::new(config).await.unwrap();
        let (edge_url, edge_task) = start_server(build_router(state)).await;
        let client = reqwest::Client::new();
        let mut input = json!([{"role": "user", "content": "Look up the result"}]);
        for turn in 0..2 {
            let response = client.post(format!("{edge_url}/v1/responses")).bearer_auth("test-key")
                .json(&json!({"model": "glm-test", "stream": false, "input": input,
                    "tools": [{"type": "function", "name": "lookup", "parameters": {"type": "object", "properties": {}}}]}))
                .send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let result: Value = response.json().await.unwrap();
            if turn == 0 {
                let call = result["output"].as_array().unwrap().iter().find(|v| v["type"] == "function_call").unwrap();
                assert_eq!(call["call_id"], "call_lookup");
                input.as_array_mut().unwrap().push(call.clone());
                input.as_array_mut().unwrap().push(json!({"type": "function_call_output", "call_id": "call_lookup", "output": "42"}));
            } else {
                assert!(result.to_string().contains("The result is 42."));
            }
        }
        let rejected = client.post(format!("{edge_url}/v1/responses")).bearer_auth("test-key")
            .json(&json!({"model": "glm-test", "input": "test", "tools": [{"type": "file_search"}]}))
            .send().await.unwrap();
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 2);
        edge_task.abort();
        upstream_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }

    #[tokio::test]
    async fn zai_custom_tool_round_trip() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let upstream = Router::new()
            .route("/v1/models", get(|| async { Json(json!({"data": [{"id": "glm-test"}]})) }))
            .route("/v1/chat/completions", post(move |Json(body): Json<Value>| {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, AtomicOrdering::SeqCst);
                    assert_eq!(body["tools"].as_array().unwrap().len(), 1);
                    assert!(body["messages"][0]["content"].as_str().unwrap().contains("web_search tool is unavailable"));
                    assert_eq!(body["tools"][0]["type"], "function");
                    assert_eq!(body["tools"][0]["function"]["name"], "mv_tool_0");
                    assert!(body["tools"][0].get("name").is_none());
                    let returned = body["messages"].as_array().unwrap().iter().any(|m| m["role"] == "tool");
                    let message = if returned {
                        let messages = body["messages"].as_array().unwrap();
                        assert!(messages.iter().any(|m| m["tool_call_id"] == "call_lookup" && m["content"] == "42"));
                        json!({"role": "assistant", "content": "The result is 42."})
                    } else {
                        json!({"role": "assistant", "content": null, "tool_calls": [{"id": "call_lookup", "type": "function", "function": {"name": "mv_tool_0", "arguments": "{\"input\":\"print(42)\"}"}}]})
                    };
                    Json(json!({"id": "chat_test", "object": "chat.completion", "model": "glm-test", "created": 1,
                        "choices": [{"index": 0, "message": message, "finish_reason": if returned { "stop" } else { "tool_calls" }}],
                        "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10}}))
                }
            }));
        let (url, upstream_task) = start_server(upstream).await;
        let store_path = temporary_path("tool-roundtrip-store");
        let jobs_path = temporary_path("tool-roundtrip-jobs");
        let mut provider = account("strict-chat");
        provider.provider = Some("zai".to_owned());
        let provider_url = url.clone();
        provider.base_url = Some(url);
        provider.upstream_mode = Some("chat/completions".to_owned());
        fs::write(&store_path, serde_json::to_vec(&store_with_accounts(vec![provider])).unwrap()).await.unwrap();
        let mut config = EdgeConfig::default();
        config.zai_base_url = provider_url;
        config.zai_upstream_path = "/v1/chat/completions".to_owned();
        config.zai_models_path = "/v1/models".to_owned();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.legacy_jobs_db_path = None;
        config.configured_api_keys = vec![("test".to_owned(), "test-key".to_owned())];
        let state = EdgeState::new(config).await.unwrap();
        let (edge_url, edge_task) = start_server(build_router(state)).await;
        let client = reqwest::Client::new();
        let mut input = json!([{"role": "user", "content": "Look up the result"}]);
        for turn in 0..2 {
            let response = client.post(format!("{edge_url}/v1/responses")).bearer_auth("test-key")
                .json(&json!({"model": "glm-test", "stream": false, "input": input,
                    "tools": [{"type": "custom", "name": "lookup", "format": {"type": "text"}}, {"type": "web_search", "external_web_access": false}]}))
                .send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["x-multivibe-unavailable-tools"], "web_search");
            let result: Value = response.json().await.unwrap();
            if turn == 0 {
                let call = result["output"].as_array().unwrap().iter().find(|v| v["type"] == "custom_tool_call").unwrap();
                assert_eq!(call["call_id"], "call_lookup");
                assert_eq!(call["name"], "lookup");
                assert_eq!(call["input"], "print(42)");
                input.as_array_mut().unwrap().push(call.clone());
                input.as_array_mut().unwrap().push(json!({"type": "custom_tool_call_output", "call_id": "call_lookup", "output": "42"}));
            } else {
                assert!(result.to_string().contains("The result is 42."));
            }
        }
        let rejected = client.post(format!("{edge_url}/v1/responses")).bearer_auth("test-key")
            .json(&json!({"model": "glm-test", "input": "test", "tools": [{"type": "file_search"}]}))
            .send().await.unwrap();
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 2);
        edge_task.abort();
        upstream_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }

    #[test]
    fn claude_code_requests_route_to_luna_and_drop_unsupported_metadata() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::USER_AGENT,
            HeaderValue::from_static("claude-cli/2.1.241 (external, sdk-cli)"),
        );
        headers.insert("x-app", HeaderValue::from_static("cli"));
        assert!(is_claude_code_request(&headers));
        assert_eq!(
            claude_code_routing_model("claude-sonnet-4-5", true),
            "gpt-5.6-luna"
        );
        assert_eq!(
            claude_code_routing_model("claude-sonnet-4-5", false),
            "claude-sonnet-4-5"
        );

        let converted = anthropic_to_responses(
            &json!({
                "model": "claude-sonnet-4-5",
                "metadata": {"user_id": "client-only"},
                "messages": [{"role": "user", "content": "Hello"}]
            }),
            true,
            &EdgeConfig::default(),
        );
        assert_eq!(converted["model"], "gpt-5.6-luna");
        assert!(converted.get("metadata").is_none());
    }

    #[test]
    fn sse_conversion_emits_protocol_specific_completion() {
        let response_sse = concat!(
            "event: response.output_text.delta\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
            "event: response.output_text.delta\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\" world\"}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-1\",\"object\":\"response\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello world\"}]}]}}\n\n"
        );
        let response = response_from_sse(response_sse, "gpt-5.3-codex");
        assert_eq!(response["id"], "resp-1");
        assert_eq!(response["output"][0]["content"][0]["text"], "hello world");

        let chat_sse = concat!(
            "data: {\"id\":\"chat-1\",\"object\":\"chat.completion.chunk\",\"created\":1,\"choices\":[{\"delta\":{\"content\":\"hello\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chat-1\",\"object\":\"chat.completion.chunk\",\"created\":1,\"choices\":[{\"delta\":{\"content\":\" world\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chat-1\",\"object\":\"chat.completion.chunk\",\"created\":1,\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        );
        let chat = chat_from_sse(chat_sse, "gpt-5.3-codex");
        assert_eq!(chat["id"], "chat-1");
        assert_eq!(chat["choices"][0]["message"]["content"], "hello world");

        let empty_completed_sse = concat!(
            "event: response.output_text.delta\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"recovered\"}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-empty\",\"object\":\"response\",\"status\":\"completed\",\"output\":[]}}\n\n"
        );
        let recovered = response_from_sse(empty_completed_sse, "gpt-5.3-codex");
        assert_eq!(recovered["output"][0]["content"][0]["text"], "recovered");
    }

    #[test]
    fn generated_text_deltas_preserve_token_boundaries_in_both_stream_directions() {
        let mut chat_to_response =
            SseStreamTransformer::new(StreamTransform::ChatToResponse, "glm-test");
        let mut response_sse = String::new();
        for content in ["**Conclusion:", " this", " is", " correct."] {
            response_sse.push_str(&chat_to_response.transform_chat_chunk(&json!({
                "object": "chat.completion.chunk",
                "choices": [{"delta": {"content": content}, "finish_reason": null}]
            })));
        }
        response_sse.push_str(&chat_to_response.finish());
        let response = response_from_sse(&response_sse, "glm-test");
        assert_eq!(
            response["output"][0]["content"][0]["text"],
            "**Conclusion: this is correct."
        );

        let mut response_to_chat =
            SseStreamTransformer::new(StreamTransform::ResponseToChat, "glm-test");
        let mut chat_sse = String::new();
        for delta in ["**Conclusion:", " this", " is", " correct."] {
            chat_sse.push_str(&response_to_chat.transform_response_event(&json!({
                "type": "response.output_text.delta",
                "delta": delta
            })));
        }
        chat_sse.push_str(&response_to_chat.finish());
        let chat = chat_from_sse(&chat_sse, "glm-test");
        assert_eq!(
            chat["choices"][0]["message"]["content"],
            "**Conclusion: this is correct."
        );
    }

    #[test]
    fn response_chat_tools_preserve_names_ids_and_interleaved_arguments() {
        let mut converter = SseStreamTransformer::new(StreamTransform::ResponseToChat, "test");
        let mut output = String::new();
        for event in [
            json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"shell","arguments":""}}),
            json!({"type":"response.function_call_arguments.delta","item_id":"fc_a","output_index":1,"delta":"{\"cmd\":"}),
            json!({"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"fc_b","call_id":"call_b","name":"lookup","arguments":""}}),
            json!({"type":"response.function_call_arguments.delta","item_id":"fc_b","output_index":2,"delta":"{}"}),
            json!({"type":"response.function_call_arguments.delta","item_id":"fc_a","output_index":1,"delta":"\"pwd\"}"}),
            json!({"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_a","call_id":"call_a","name":"shell","arguments":"{\"cmd\":\"pwd\"}"}}),
            json!({"type":"response.completed","response":{"output":[]}}),
        ] {
            output.push_str(&converter.transform_response_event(&event));
        }
        let chunks: Vec<Value> = output.lines().filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|data| serde_json::from_str(data).ok()).collect();
        let mut calls: Vec<Value> = Vec::new();
        for chunk in &chunks {
            if let Some(deltas) = chunk["choices"][0]["delta"]["tool_calls"].as_array() {
                for delta in deltas {
                    let index = delta["index"].as_u64().unwrap() as usize;
                    if index == calls.len() {
                        assert!(delta["function"]["name"].is_string(), "first delta must name the tool");
                        calls.push(delta.clone());
                    } else {
                        assert!(delta.get("id").is_none());
                        let args = calls[index]["function"]["arguments"].as_str().unwrap().to_owned()
                            + delta["function"]["arguments"].as_str().unwrap();
                        calls[index]["function"]["arguments"] = json!(args);
                    }
                }
            }
        }
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["id"], "call_a");
        assert_eq!(calls[0]["function"]["arguments"], "{\"cmd\":\"pwd\"}");
        assert_eq!(calls[1]["id"], "call_b");
        assert_eq!(calls[1]["function"]["arguments"], "{}");
        assert_eq!(chunks.last().unwrap()["choices"][0]["finish_reason"], "tool_calls");
        assert!(converter.response_chat.finish().is_empty());
    }

    #[test]
    fn response_chat_tools_buffer_arguments_until_metadata_and_recover_completed_calls() {
        let mut converter = SseStreamTransformer::new(StreamTransform::ResponseToChat, "test");
        assert!(converter.transform_response_event(&json!({"type":"response.function_call_arguments.delta","item_id":"fc_a","output_index":0,"delta":"{}"})).is_empty());
        let output = converter.transform_response_event(&json!({"type":"response.completed","response":{"output":[
            {"type":"function_call","id":"fc_a","call_id":"call_a","name":"shell","arguments":"{}"},
            {"type":"function_call","id":"fc_b","call_id":"call_b","name":"lookup","arguments":"{}"}
        ]}}));
        let chat = chat_from_sse(&output, "test");
        let calls = chat["choices"][0]["message"]["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["function"]["name"], "shell");
        assert_eq!(calls[0]["function"]["arguments"], "{}");
        assert_eq!(calls[1]["function"]["name"], "lookup");
    }

    #[test]
    fn headerless_openai_chat_stream_is_converted() {
        let openai = account("openai-1");
        assert_eq!(
            transform_for("/v1/chat/completions", &openai, true, ""),
            StreamTransform::ResponseToChat
        );
        assert_eq!(
            transform_for("/v1/responses", &openai, true, ""),
            StreamTransform::None
        );
    }

    #[test]
    fn job_scheduler_is_weighted_and_fair_across_priorities_and_applications() {
        let priorities = ["critical", "interactive", "standard", "batch"];
        let candidates = priorities
            .iter()
            .map(|priority| SchedulingCandidate {
                id: (*priority).to_owned(),
                application: (*priority).to_owned(),
                priority: (*priority).to_owned(),
                created_at: 0,
            })
            .collect::<Vec<_>>();
        let mut scheduler = WeightedFairScheduler::default();
        let mut counts = HashMap::<String, usize>::new();
        for _ in 0..2_900 {
            let selected = scheduler.choose(&candidates, &HashMap::new()).unwrap();
            *counts.entry(selected).or_default() += 1;
        }
        assert_eq!(counts.get("critical"), Some(&1_600));
        assert_eq!(counts.get("interactive"), Some(&800));
        assert_eq!(counts.get("standard"), Some(&400));
        assert_eq!(counts.get("batch"), Some(&100));

        let candidates = ["heavy", "light"]
            .iter()
            .map(|application| SchedulingCandidate {
                id: (*application).to_owned(),
                application: (*application).to_owned(),
                priority: "standard".to_owned(),
                created_at: 0,
            })
            .collect::<Vec<_>>();
        let weights = HashMap::from([("heavy".to_owned(), 3.0), ("light".to_owned(), 1.0)]);
        let mut scheduler = WeightedFairScheduler::default();
        let mut counts = HashMap::<String, usize>::new();
        for _ in 0..400 {
            let selected = scheduler.choose(&candidates, &weights).unwrap();
            *counts.entry(selected).or_default() += 1;
        }
        assert_eq!(counts.get("heavy"), Some(&300));
        assert_eq!(counts.get("light"), Some(&100));
    }

    #[tokio::test]
    async fn jobs_are_persisted_and_results_are_application_scoped() {
        let path = temporary_path("jobs");
        let manager = JobManager::new(path.clone()).await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-multivibe-priority", HeaderValue::from_static("standard"));
        let job = manager
            .create(
                "batch-app",
                "/v1/responses",
                &headers,
                &json!({"model": "gpt-5.3-codex", "input": "hello"}),
                3,
            )
            .await
            .unwrap()
            .job;
        assert_eq!(job.status, "queued");
        let running = manager
            .acquire_next(&HashMap::new())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(running.status, "running");
        manager
            .succeed(
                &job.id,
                BufferedReply {
                    status: StatusCode::OK,
                    headers: vec![("content-type".to_owned(), "application/json".to_owned())],
                    body: Bytes::from_static(br#"{"ok":true}"#),
                },
            )
            .await
            .unwrap();
        assert!(manager.get_for("other-app", &job.id).await.is_none());
        let stored = manager.get_for("batch-app", &job.id).await.unwrap();
        assert_eq!(stored.status, "succeeded");
        assert_eq!(stored.result.as_ref().unwrap()["ok"], true);
        assert!(
            manager
                .consume_result("batch-app", &job.id)
                .await
                .unwrap()
                .is_some()
        );
        let events = manager.events_after("batch-app", &job.id, 0).await.unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.r#type.as_str())
                .collect::<Vec<_>>(),
            vec!["job.queued", "job.started", "job.succeeded", "job.consumed"]
        );
        assert!(events.windows(2).all(|pair| pair[0].id < pair[1].id));
        let last_event_id = events.last().unwrap().id;

        let reloaded = JobManager::new(path.clone()).await.unwrap();
        assert_eq!(reloaded.list_for("batch-app", 10).await.len(), 1);
        let replay = reloaded
            .events_after("batch-app", &job.id, 0)
            .await
            .unwrap();
        assert_eq!(replay.len(), 4);
        assert!(
            reloaded
                .events_after("batch-app", &job.id, last_event_id)
                .await
                .unwrap()
                .is_empty()
        );
        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = fs::remove_file(path).await;
    }

    #[test]
    fn batch_jobs_wait_for_the_paris_night_window() {
        for (timestamp, eligible) in [
            ("2026-07-01T04:59:59Z", "2026-07-01T04:59:59Z"),
            ("2026-07-01T05:00:00Z", "2026-07-01T20:00:00Z"),
            ("2026-07-01T19:59:59Z", "2026-07-01T20:00:00Z"),
            ("2026-07-01T20:00:00Z", "2026-07-01T20:00:00Z"),
            ("2026-01-01T05:59:59Z", "2026-01-01T05:59:59Z"),
            ("2026-01-01T06:00:00Z", "2026-01-01T21:00:00Z"),
            ("2026-01-01T20:59:59Z", "2026-01-01T21:00:00Z"),
            ("2026-01-01T21:00:00Z", "2026-01-01T21:00:00Z"),
        ] {
            let timestamp = parse_rfc3339_ms(timestamp).unwrap();
            assert_eq!(
                next_batch_window_at(timestamp),
                parse_rfc3339_ms(eligible).unwrap()
            );
        }
        let just_before_close = parse_rfc3339_ms("2026-07-01T04:59:59Z").unwrap();
        let retry_after_close = parse_rfc3339_ms("2026-07-01T05:00:00Z").unwrap();
        assert_eq!(
            eligible_job_not_before("batch", retry_after_close, just_before_close),
            parse_rfc3339_ms("2026-07-01T20:00:00Z").unwrap()
        );
    }

    #[tokio::test]
    async fn batch_eligibility_is_rechecked_before_every_acquisition() {
        let path = temporary_path("batch-window-recheck");
        let manager = JobManager::new(path.clone()).await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-multivibe-priority", HeaderValue::from_static("standard"));
        let job = manager
            .create(
                "batch-app",
                "/v1/responses",
                &headers,
                &json!({"model": "gpt-job", "input": "hello"}),
                3,
            )
            .await
            .unwrap()
            .job;
        let daytime = parse_rfc3339_ms("2026-09-07T12:00:00Z").unwrap();
        let window_start = parse_rfc3339_ms("2026-09-07T20:00:00Z").unwrap();
        {
            let mut state = manager.state.lock().await;
            let stored = state.jobs.get_mut(&job.id).unwrap();
            stored.priority = "batch".to_owned();
            stored.not_before = daytime.saturating_sub(1);
        }

        assert!(
            manager
                .acquire_next_at(&HashMap::new(), daytime)
                .await
                .unwrap()
                .is_none()
        );
        let queued = manager.get_for("batch-app", &job.id).await.unwrap();
        assert_eq!(queued.status, "queued");
        assert_eq!(queued.not_before, window_start);
        let reloaded = JobManager::new_with_legacy_at(path.clone(), None, daytime)
            .await
            .unwrap();
        assert_eq!(
            reloaded
                .get_for("batch-app", &job.id)
                .await
                .unwrap()
                .not_before,
            window_start
        );
        assert_eq!(
            manager
                .acquire_next_at(&HashMap::new(), window_start)
                .await
                .unwrap()
                .unwrap()
                .id,
            job.id
        );

        let _ = fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn batch_acquisition_reads_the_clock_after_waiting_for_persistence() {
        let path = temporary_path("batch-clock-after-lock");
        let manager = Arc::new(JobManager::new(path.clone()).await.unwrap());
        let mut headers = HeaderMap::new();
        headers.insert("x-multivibe-priority", HeaderValue::from_static("standard"));
        let job = manager
            .create(
                "batch-app",
                "/v1/responses",
                &headers,
                &json!({"model": "gpt-job", "input": "hello"}),
                3,
            )
            .await
            .unwrap()
            .job;
        let after_window = parse_rfc3339_ms("2026-07-01T05:00:00Z").unwrap();
        let next_window = parse_rfc3339_ms("2026-07-01T20:00:00Z").unwrap();
        {
            let mut state = manager.state.lock().await;
            let stored = state.jobs.get_mut(&job.id).unwrap();
            stored.priority = "batch".to_owned();
            stored.not_before = after_window.saturating_sub(1);
        }

        let persistence_guard = manager.persist_lock.lock().await;
        let clock_called = Arc::new(AtomicBool::new(false));
        let acquisition_manager = manager.clone();
        let acquisition_clock_called = clock_called.clone();
        let acquisition = tokio::spawn(async move {
            acquisition_manager
                .acquire_next_with_clock(&HashMap::new(), || {
                    acquisition_clock_called.store(true, AtomicOrdering::SeqCst);
                    after_window
                })
                .await
        });
        tokio::task::yield_now().await;
        assert!(!clock_called.load(AtomicOrdering::SeqCst));
        drop(persistence_guard);

        assert!(acquisition.await.unwrap().unwrap().is_none());
        assert!(clock_called.load(AtomicOrdering::SeqCst));
        assert_eq!(
            manager
                .get_for("batch-app", &job.id)
                .await
                .unwrap()
                .not_before,
            next_window
        );

        let _ = fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn batch_retries_and_restart_recovery_return_to_the_next_window() {
        let retry_path = temporary_path("batch-retry-window");
        let retry_manager = JobManager::new(retry_path.clone()).await.unwrap();
        let retry_job = retry_manager
            .create(
                "batch-app",
                "/v1/responses",
                &HeaderMap::new(),
                &json!({"model": "gpt-job", "input": "retry"}),
                3,
            )
            .await
            .unwrap()
            .job;
        let just_before_close = parse_rfc3339_ms("2026-07-01T04:59:59Z").unwrap();
        let next_window = parse_rfc3339_ms("2026-07-01T20:00:00Z").unwrap();
        {
            let mut state = retry_manager.state.lock().await;
            let stored = state.jobs.get_mut(&retry_job.id).unwrap();
            stored.status = "running".to_owned();
            stored.priority = "batch".to_owned();
            stored.attempts = 1;
        }
        retry_manager.persist().await.unwrap();
        retry_manager
            .fail_at(&retry_job.id, "temporary", true, just_before_close)
            .await
            .unwrap();
        let retry = retry_manager
            .get_for("batch-app", &retry_job.id)
            .await
            .unwrap();
        assert_eq!(retry.status, "retry");
        assert_eq!(retry.not_before, next_window);
        let _ = fs::remove_file(retry_path).await;

        let recovery_path = temporary_path("batch-recovery-window");
        let recovery_manager = JobManager::new(recovery_path.clone()).await.unwrap();
        let recovery_job = recovery_manager
            .create(
                "batch-app",
                "/v1/responses",
                &HeaderMap::new(),
                &json!({"model": "gpt-job", "input": "recover"}),
                3,
            )
            .await
            .unwrap()
            .job;
        let daytime = parse_rfc3339_ms("2026-09-07T12:00:00Z").unwrap();
        let recovery_window = parse_rfc3339_ms("2026-09-07T20:00:00Z").unwrap();
        {
            let mut state = recovery_manager.state.lock().await;
            let stored = state.jobs.get_mut(&recovery_job.id).unwrap();
            stored.status = "running".to_owned();
            stored.priority = "batch".to_owned();
            stored.not_before = daytime.saturating_sub(1);
            stored.attempts = 1;
        }
        recovery_manager.persist().await.unwrap();
        drop(recovery_manager);
        let recovered = JobManager::new_with_legacy_at(recovery_path.clone(), None, daytime)
            .await
            .unwrap()
            .get_for("batch-app", &recovery_job.id)
            .await
            .unwrap();
        assert_eq!(recovered.status, "queued");
        assert_eq!(recovered.not_before, recovery_window);
        assert_eq!(recovered.attempts, 1);
        let _ = fs::remove_file(recovery_path).await;
    }

    #[tokio::test]
    async fn failed_job_persistence_never_publishes_a_transition() {
        let rejected_path = temporary_path("job-create-persistence-failure");
        let rejected_manager = JobManager::new(rejected_path.clone()).await.unwrap();
        let mut rejected_events = rejected_manager.subscribe_events();
        fs::create_dir(&rejected_path).await.unwrap();
        assert!(matches!(
            rejected_manager
                .create(
                    "durable-app",
                    "/v1/responses",
                    &HeaderMap::new(),
                    &json!({"model": "gpt-job", "input": "rejected"}),
                    3,
                )
                .await,
            Err(JobCreateError::Persistence(_))
        ));
        assert!(
            rejected_manager
                .list_for("durable-app", 10)
                .await
                .is_empty()
        );
        assert!(rejected_events.try_recv().is_err());
        fs::remove_dir(rejected_path).await.unwrap();

        let path = temporary_path("job-persistence-failure");
        let manager = JobManager::new(path.clone()).await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-multivibe-priority", HeaderValue::from_static("standard"));
        let job = manager
            .create(
                "durable-app",
                "/v1/responses",
                &headers,
                &json!({"model": "gpt-job", "input": "hello"}),
                3,
            )
            .await
            .unwrap()
            .job;

        fs::remove_file(&path).await.unwrap();
        fs::create_dir(&path).await.unwrap();
        assert!(manager.acquire_next(&HashMap::new()).await.is_err());
        let queued = manager.get_for("durable-app", &job.id).await.unwrap();
        assert_eq!(queued.status, "queued");
        assert_eq!(queued.attempts, 0);
        assert_eq!(queued.events.len(), 1);

        fs::remove_dir(&path).await.unwrap();
        manager.persist().await.unwrap();
        let running = manager
            .acquire_next(&HashMap::new())
            .await
            .unwrap()
            .unwrap();
        fs::remove_file(&path).await.unwrap();
        fs::create_dir(&path).await.unwrap();
        assert!(
            manager
                .succeed(
                    &running.id,
                    BufferedReply {
                        status: StatusCode::OK,
                        headers: Vec::new(),
                        body: Bytes::from_static(br#"{"ok":true}"#),
                    },
                )
                .await
                .is_err()
        );
        let still_running = manager.get_for("durable-app", &job.id).await.unwrap();
        assert_eq!(still_running.status, "running");
        assert!(still_running.result.is_none());
        assert_eq!(still_running.events.len(), 2);

        fs::remove_dir(path).await.unwrap();
    }

    #[tokio::test]
    async fn no_op_job_transitions_do_not_require_storage() {
        let path = temporary_path("job-no-op-without-storage");
        let manager = JobManager::new(path.clone()).await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-multivibe-priority", HeaderValue::from_static("standard"));
        headers.insert(
            "x-multivibe-idempotency-key",
            HeaderValue::from_static("same-request"),
        );
        let body = json!({"model": "gpt-job", "input": "hello"});
        let created = manager
            .create("durable-app", "/v1/responses", &headers, &body, 3)
            .await
            .unwrap();

        fs::remove_file(&path).await.unwrap();
        fs::create_dir(&path).await.unwrap();

        let replay = manager
            .create("durable-app", "/v1/responses", &headers, &body, 3)
            .await
            .unwrap();
        assert!(!replay.created);
        assert_eq!(replay.job.id, created.job.id);
        assert!(matches!(
            manager
                .create(
                    "durable-app",
                    "/v1/responses",
                    &headers,
                    &json!({"model": "gpt-job", "input": "different"}),
                    3,
                )
                .await,
            Err(JobCreateError::IdempotencyConflict)
        ));
        manager
            .succeed(
                &created.job.id,
                BufferedReply {
                    status: StatusCode::OK,
                    headers: Vec::new(),
                    body: Bytes::from_static(br#"{"ok":true}"#),
                },
            )
            .await
            .unwrap();
        assert!(
            manager
                .consume_result("durable-app", &created.job.id)
                .await
                .unwrap()
                .is_none()
        );
        manager.purge_due(now_ms()).await.unwrap();
        assert!(matches!(
            manager.cancel("durable-app", "missing-job").await,
            Err(JobCancelError::NotFound)
        ));

        fs::remove_dir(path).await.unwrap();
    }

    #[tokio::test]
    async fn cancelling_a_transition_cannot_leave_a_stale_writer() {
        let path = temporary_path("cancel-safe-job-commit");
        let manager = Arc::new(JobManager::new(path.clone()).await.unwrap());
        let mut headers = HeaderMap::new();
        headers.insert("x-multivibe-priority", HeaderValue::from_static("standard"));
        let job = manager
            .create(
                "durable-app",
                "/v1/responses",
                &headers,
                &json!({"model": "gpt-job", "input": "hello"}),
                3,
            )
            .await
            .unwrap()
            .job;
        manager
            .acquire_next(&HashMap::new())
            .await
            .unwrap()
            .unwrap();
        let _ = timeout(Duration::from_millis(1), manager.changed.notified()).await;
        let _ = timeout(
            Duration::from_millis(1),
            manager.webhooks_changed.notified(),
        )
        .await;
        let gate = CommitTestGate {
            started: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
        };
        *manager.commit_test_gate.lock().await = Some(gate.clone());
        let first_manager = manager.clone();
        let first_job_id = job.id.clone();
        let first =
            tokio::spawn(async move { first_manager.fail(&first_job_id, "retry", true).await });
        timeout(Duration::from_secs(2), gate.started.notified())
            .await
            .unwrap();
        *manager.commit_test_gate.lock().await = None;
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());

        let follower_manager = manager.clone();
        let follower =
            tokio::spawn(
                async move { follower_manager.cancel("durable-app", "missing-job").await },
            );
        let mut first_notified = Box::pin(manager.changed.notified());
        first_notified.as_mut().enable();
        let mut second_notified = Box::pin(manager.webhooks_changed.notified());
        second_notified.as_mut().enable();
        gate.release.notify_one();
        timeout(Duration::from_secs(2), async {
            tokio::join!(first_notified, second_notified);
        })
        .await
        .unwrap();
        assert!(matches!(
            follower.await.unwrap(),
            Err(JobCancelError::NotFound)
        ));
        manager.cancel("durable-app", &job.id).await.unwrap();

        let persisted = JobManager::new(path.clone())
            .await
            .unwrap()
            .get_for("durable-app", &job.id)
            .await
            .unwrap();
        assert_eq!(persisted.status, "cancelled");
        assert_eq!(
            persisted
                .events
                .iter()
                .map(|event| event.r#type.as_str())
                .collect::<Vec<_>>(),
            vec!["job.queued", "job.started", "job.retry", "job.cancelled"]
        );

        let _ = fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn public_jobs_use_iso8601_timestamps() {
        let path = temporary_path("public-job-timestamps");
        let manager = JobManager::new(path.clone()).await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-multivibe-priority", HeaderValue::from_static("standard"));
        headers.insert(
            "x-multivibe-deadline",
            HeaderValue::from_static("2099-01-02T03:04:05.678Z"),
        );
        let job = manager
            .create(
                "timestamp-app",
                "/v1/responses",
                &headers,
                &json!({"model": "gpt-job", "input": "hello"}),
                3,
            )
            .await
            .unwrap()
            .job;
        let public = public_job(&job);

        for (field, expected) in [
            ("created_at", job.created_at),
            ("updated_at", job.updated_at),
            ("not_before", job.not_before),
        ] {
            let timestamp = public[field].as_str().expect("public timestamp is text");
            assert!(timestamp.ends_with('Z'));
            assert_eq!(parse_rfc3339_ms(timestamp), Some(expected));
        }
        assert_eq!(public["deadline"], "2099-01-02T03:04:05.678Z");

        let _ = fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn legacy_sqlite_jobs_are_backed_up_and_imported_once() {
        let sqlite_path = temporary_path("legacy-jobs.sqlite");
        let json_path = temporary_path("migrated-jobs.json");
        {
            let connection = rusqlite::Connection::open(&sqlite_path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE jobs (
                        id TEXT PRIMARY KEY, application TEXT NOT NULL, route TEXT NOT NULL,
                        request_headers_json TEXT, request_json TEXT, status TEXT NOT NULL,
                        priority TEXT NOT NULL, model TEXT, idempotency_key TEXT, webhook_id TEXT,
                        deadline_at INTEGER, not_before INTEGER NOT NULL, attempts INTEGER NOT NULL,
                        max_attempts INTEGER NOT NULL, response_status INTEGER,
                        response_headers_json TEXT, result_json TEXT, error TEXT,
                        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                        completed_at INTEGER, consumed_at INTEGER, purge_after INTEGER
                    );
                    CREATE TABLE webhook_deliveries (
                        event_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempts INTEGER NOT NULL,
                        next_attempt_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
                        delivered_at INTEGER, last_error TEXT
                    );",
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO jobs VALUES (?1, ?2, ?3, '{}', ?4, 'queued', 'standard', ?5, ?6, NULL, NULL, ?7, 0, 3, NULL, NULL, NULL, NULL, ?7, ?7, NULL, NULL, NULL)",
                    rusqlite::params![
                        "legacy-job",
                        "legacy-app",
                        "/v1/responses",
                        r#"{"model":"gpt-legacy","input":"hello"}"#,
                        "gpt-legacy",
                        "legacy-key",
                        now_ms() as i64,
                    ],
                )
                .unwrap();
        }

        let manager = JobManager::new_with_legacy(json_path.clone(), Some(sqlite_path.clone()))
            .await
            .unwrap();
        let imported = manager.get_for("legacy-app", "legacy-job").await.unwrap();
        assert_eq!(imported.request_body["model"], "gpt-legacy");
        assert!(json_path.exists());
        let backup_path = sqlite_path.with_extension("pre-rust-backup.sqlite");
        assert!(backup_path.exists());

        let reloaded = JobManager::new_with_legacy(json_path.clone(), Some(sqlite_path.clone()))
            .await
            .unwrap();
        assert_eq!(reloaded.list_for("legacy-app", 10).await.len(), 1);

        let _ = fs::remove_file(sqlite_path).await;
        let _ = fs::remove_file(backup_path).await;
        let _ = fs::remove_file(json_path).await;
    }

    #[tokio::test]
    async fn completed_jobs_deliver_signed_webhooks() {
        let received = Arc::new(Mutex::new(None::<(Vec<u8>, String, String)>));
        let received_request = received.clone();
        let webhook = Router::new().route(
            "/job",
            post(move |headers: HeaderMap, body: Bytes| {
                let received = received_request.clone();
                async move {
                    *received.lock().await = Some((
                        body.to_vec(),
                        header_value(&headers, "x-multivibe-signature").unwrap_or_default(),
                        header_value(&headers, "x-multivibe-event-id").unwrap_or_default(),
                    ));
                    StatusCode::NO_CONTENT
                }
            }),
        );
        let (webhook_url, webhook_task) = start_server(webhook).await;
        let store_path = temporary_path("webhook-accounts");
        let jobs_path = temporary_path("webhook-jobs");
        let mut store = StoreFile::default();
        store.application_policies.push(ApplicationPolicy {
            application: "webhook-app".to_owned(),
            fairness_weight: Some(1.0),
            webhooks: vec![ApplicationWebhook {
                id: "result-hook".to_owned(),
                url: format!("{webhook_url}/job"),
                secret: "webhook-secret".to_owned(),
                enabled: true,
                created_at: None,
            }],
        });
        fs::write(&store_path, serde_json::to_vec(&store).unwrap())
            .await
            .unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.legacy_jobs_db_path = None;
        let state = EdgeState::new(config).await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-multivibe-priority", HeaderValue::from_static("standard"));
        headers.insert(
            "x-multivibe-webhook",
            HeaderValue::from_static("result-hook"),
        );
        let job = state
            .jobs
            .create(
                "webhook-app",
                "/v1/responses",
                &headers,
                &json!({"model": "gpt-webhook", "input": "hello"}),
                3,
            )
            .await
            .unwrap()
            .job;
        let running = state
            .jobs
            .acquire_next(&HashMap::new())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(running.id, job.id);
        state
            .jobs
            .succeed(
                &job.id,
                BufferedReply {
                    status: StatusCode::OK,
                    headers: Vec::new(),
                    body: Bytes::from_static(br#"{"ok":true}"#),
                },
            )
            .await
            .unwrap();
        let runner = state.start_job_runner().unwrap();
        timeout(Duration::from_secs(2), async {
            loop {
                if received.lock().await.is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let (body, signature, event_id) = received.lock().await.clone().unwrap();
        let mut signer = <HmacSha256 as Mac>::new_from_slice(b"webhook-secret").unwrap();
        signer.update(&body);
        assert_eq!(
            signature,
            format!("sha256={}", hex_bytes(&signer.finalize().into_bytes()))
        );
        assert!(!event_id.is_empty());
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["type"],
            "job.completed"
        );

        runner.abort();
        webhook_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }

    #[tokio::test]
    async fn webhook_delivery_stops_when_job_persistence_requires_restart() {
        let deliveries = Arc::new(AtomicUsize::new(0));
        let counted_deliveries = deliveries.clone();
        let webhook = Router::new().route(
            "/job",
            post(move || {
                let counted_deliveries = counted_deliveries.clone();
                async move {
                    counted_deliveries.fetch_add(1, AtomicOrdering::SeqCst);
                    StatusCode::NO_CONTENT
                }
            }),
        );
        let (webhook_url, webhook_task) = start_server(webhook).await;
        let store_path = temporary_path("uncertain-webhook-accounts");
        let jobs_path = temporary_path("uncertain-webhook-jobs");
        let mut store = StoreFile::default();
        store.application_policies.push(ApplicationPolicy {
            application: "webhook-app".to_owned(),
            fairness_weight: Some(1.0),
            webhooks: vec![ApplicationWebhook {
                id: "result-hook".to_owned(),
                url: format!("{webhook_url}/job"),
                secret: "webhook-secret".to_owned(),
                enabled: true,
                created_at: None,
            }],
        });
        fs::write(&store_path, serde_json::to_vec(&store).unwrap())
            .await
            .unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.legacy_jobs_db_path = None;
        let state = EdgeState::new(config).await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-multivibe-priority", HeaderValue::from_static("standard"));
        headers.insert(
            "x-multivibe-webhook",
            HeaderValue::from_static("result-hook"),
        );
        let job = state
            .jobs
            .create(
                "webhook-app",
                "/v1/responses",
                &headers,
                &json!({"model": "gpt-webhook", "input": "hello"}),
                3,
            )
            .await
            .unwrap()
            .job;
        state.jobs.acquire_next(&HashMap::new()).await.unwrap();
        state
            .jobs
            .succeed(
                &job.id,
                BufferedReply {
                    status: StatusCode::OK,
                    headers: Vec::new(),
                    body: Bytes::from_static(br#"{"ok":true}"#),
                },
            )
            .await
            .unwrap();
        state
            .jobs
            .persistence_uncertain
            .store(true, AtomicOrdering::SeqCst);

        timeout(Duration::from_secs(1), webhook_delivery_loop(state))
            .await
            .unwrap();
        assert_eq!(deliveries.load(AtomicOrdering::SeqCst), 0);

        webhook_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }

    #[tokio::test]
    async fn jobs_enforce_creation_idempotency_retries_deadlines_and_restart_recovery() {
        let path = temporary_path("robust-jobs");
        let manager = JobManager::new(path.clone()).await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-multivibe-idempotency-key",
            HeaderValue::from_static("job-key"),
        );
        headers.insert("x-multivibe-priority", HeaderValue::from_static("critical"));
        let body = json!({"model": "gpt-job", "input": "same"});
        let created = manager
            .create("app-a", "/v1/responses", &headers, &body, 3)
            .await
            .unwrap();
        assert!(created.created);
        let replay = manager
            .create("app-a", "/v1/responses", &headers, &body, 3)
            .await
            .unwrap();
        assert!(!replay.created);
        assert_eq!(replay.job.id, created.job.id);
        assert!(matches!(
            manager
                .create(
                    "app-a",
                    "/v1/responses",
                    &headers,
                    &json!({"model": "gpt-job", "input": "different"}),
                    3,
                )
                .await,
            Err(JobCreateError::IdempotencyConflict)
        ));

        let running = manager
            .acquire_next(&HashMap::new())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(running.attempts, 1);
        drop(manager);

        let manager = JobManager::new(path.clone()).await.unwrap();
        let recovered = manager.get_for("app-a", &created.job.id).await.unwrap();
        assert_eq!(recovered.status, "queued");
        let running = manager
            .acquire_next(&HashMap::new())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(running.id, created.job.id);
        assert_eq!(running.attempts, 2);
        manager
            .fail(&running.id, "temporary outage", true)
            .await
            .unwrap();
        let retry = manager.get_for("app-a", &running.id).await.unwrap();
        assert_eq!(retry.status, "retry");
        assert!(retry.not_before > retry.updated_at);
        {
            let mut state = manager.state.lock().await;
            state.jobs.get_mut(&running.id).unwrap().not_before = now_ms();
        }
        let final_attempt = manager
            .acquire_next(&HashMap::new())
            .await
            .unwrap()
            .unwrap();
        manager
            .fail(&final_attempt.id, "permanent failure", false)
            .await
            .unwrap();
        assert_eq!(
            manager
                .get_for("app-a", &final_attempt.id)
                .await
                .unwrap()
                .status,
            "failed"
        );
        let other_application = manager
            .create("app-b", "/v1/responses", &headers, &body, 3)
            .await
            .unwrap();
        assert!(other_application.created);
        assert_ne!(other_application.job.id, created.job.id);

        let mut invalid_deadline = HeaderMap::new();
        invalid_deadline.insert("x-multivibe-deadline", HeaderValue::from_static("tomorrow"));
        assert!(matches!(
            manager
                .create("app-a", "/v1/responses", &invalid_deadline, &body, 3)
                .await,
            Err(JobCreateError::InvalidDeadline)
        ));
        let past_deadline = (chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339();
        invalid_deadline.insert(
            "x-multivibe-deadline",
            HeaderValue::from_str(&past_deadline).unwrap(),
        );
        assert!(matches!(
            manager
                .create("app-a", "/v1/responses", &invalid_deadline, &body, 3)
                .await,
            Err(JobCreateError::ExpiredDeadline)
        ));
        assert_eq!(
            parse_rfc3339_ms("2026-08-28T07:00:00+02:00"),
            parse_rfc3339_ms("2026-08-28T05:00:00Z")
        );

        let _ = fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn capacity_unavailable_requeues_without_consuming_an_attempt() {
        let store_path = temporary_path("capacity-wait-accounts");
        let jobs_path = temporary_path("capacity-wait-jobs");
        let mut saturated = account("saturated-account");
        saturated.capacity_profile = Some(CapacityProfile {
            max_concurrent: Some(1),
            ..Default::default()
        });
        fs::write(
            &store_path,
            serde_json::to_vec(&store_with_accounts(vec![saturated.clone()])).unwrap(),
        )
        .await
        .unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.legacy_jobs_db_path = None;
        let state = EdgeState::new(config).await.unwrap();
        let (_, _held_capacity) = state
            .admission
            .acquire_any(std::slice::from_ref(&saturated))
            .unwrap();

        let mut headers = HeaderMap::new();
        headers.insert("x-multivibe-priority", HeaderValue::from_static("standard"));
        headers.insert("x-multivibe-max-wait-ms", HeaderValue::from_static("0"));
        let job = state
            .jobs
            .create(
                "capacity-app",
                "/v1/responses",
                &headers,
                &json!({"model": "gpt-job", "input": "hello"}),
                1,
            )
            .await
            .unwrap()
            .job;
        let running = state
            .jobs
            .acquire_next(&HashMap::new())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(running.attempts, 1);
        let mut events = state.jobs.events.subscribe();
        let permit = Arc::new(Semaphore::new(1)).acquire_owned().await.unwrap();

        let activity = state.drain.admit(ActivityKind::Job).unwrap();
        run_claimed_job(state.clone(), running, permit, activity).await;

        let queued = state.jobs.get_for("capacity-app", &job.id).await.unwrap();
        assert_eq!(queued.status, "queued");
        assert_eq!(queued.attempts, 0);
        assert_eq!(
            queued.not_before.saturating_sub(queued.updated_at),
            JOB_CAPACITY_WAIT_MS
        );
        assert!(queued.error.is_none());
        assert!(
            state
                .jobs
                .acquire_next(&HashMap::new())
                .await
                .unwrap()
                .is_none()
        );
        let event = timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.job_id, job.id);
        assert_eq!(event.r#type, "job.capacity_wait");
        assert_eq!(event.data["nextAttemptAt"], queued.not_before);

        {
            let mut jobs = state.jobs.state.lock().await;
            jobs.jobs.get_mut(&job.id).unwrap().not_before = now_ms();
        }
        let retried = state
            .jobs
            .acquire_next(&HashMap::new())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retried.attempts, 1);
        state
            .jobs
            .reschedule_for_capacity(&retried.id, u64::MAX)
            .await
            .unwrap();
        let bounded = state
            .jobs
            .get_for("capacity-app", &retried.id)
            .await
            .unwrap();
        assert_eq!(bounded.attempts, 0);
        assert_eq!(
            bounded.not_before.saturating_sub(bounded.updated_at),
            JOB_RETRY_MAX_MS
        );

        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }

    #[tokio::test]
    async fn releasing_a_job_slot_wakes_every_dispatch_consumer() {
        let path = temporary_path("job-slot-release");
        let manager = JobManager::new(path.clone()).await.unwrap();
        let slots = Arc::new(Semaphore::new(1));
        let permit = slots.clone().acquire_owned().await.unwrap();
        let mut dispatcher = Box::pin(manager.changed.notified());
        dispatcher.as_mut().enable();
        let mut webhooks = Box::pin(manager.webhooks_changed.notified());
        webhooks.as_mut().enable();

        release_job_slot(permit, &manager);

        timeout(Duration::from_secs(1), async {
            tokio::join!(dispatcher, webhooks);
        })
        .await
        .unwrap();
        assert_eq!(slots.available_permits(), 1);

        let _ = fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn native_job_runner_bounds_global_concurrency() {
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let upstream_active = active.clone();
        let upstream_maximum = maximum.clone();
        let upstream = Router::new()
            .route(
                "/backend-api/codex/models",
                get(|| async { Json(json!({"models": [{"slug": "gpt-job"}]})) }),
            )
            .route(
                "/backend-api/codex/responses",
                post(move || {
                    let active = upstream_active.clone();
                    let maximum = upstream_maximum.clone();
                    async move {
                        let current = active.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                        maximum.fetch_max(current, AtomicOrdering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        active.fetch_sub(1, AtomicOrdering::SeqCst);
                        Json(json!({
                            "id": new_id("resp"),
                            "object": "response",
                            "model": "gpt-job",
                            "status": "completed",
                            "output": [],
                            "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
                        }))
                    }
                }),
            );
        let (upstream_url, upstream_task) = start_server(upstream).await;

        let store_path = temporary_path("job-runner-accounts");
        let jobs_path = temporary_path("job-runner-jobs");
        let mut job_account = account("job-account");
        job_account.capacity_profile = Some(CapacityProfile {
            max_concurrent: Some(10),
            ..Default::default()
        });
        fs::write(
            &store_path,
            serde_json::to_vec(&store_with_accounts(vec![job_account])).unwrap(),
        )
        .await
        .unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.chatgpt_base_url = upstream_url;
        config.job_worker_concurrency = 2;
        config.upstream_timeout = Duration::from_secs(5);
        let state = EdgeState::new(config).await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-multivibe-priority", HeaderValue::from_static("standard"));
        for index in 0..6 {
            state
                .jobs
                .create(
                    "batch-app",
                    "/v1/responses",
                    &headers,
                    &json!({"model": "gpt-job", "input": format!("job-{index}")}),
                    3,
                )
                .await
                .unwrap();
        }
        let runner = state.start_job_runner().unwrap();
        assert!(state.start_job_runner().is_none());

        let completed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let jobs = state.jobs.list_for("batch-app", 10).await;
                if jobs.iter().all(|job| job.status == "succeeded") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        assert!(
            completed.is_ok(),
            "jobs did not complete before the timeout"
        );
        assert_eq!(maximum.load(AtomicOrdering::SeqCst), 2);

        runner.abort();
        upstream_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }

    #[tokio::test]
    async fn native_catalog_and_routing_do_not_cross_the_node_control_plane() {
        let model_discovery_requests = Arc::new(AtomicUsize::new(0));
        let upstream_requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let control_plane_requests = Arc::new(AtomicUsize::new(0));

        let discovery_requests = model_discovery_requests.clone();
        let request_bodies = upstream_requests.clone();
        let upstream = Router::new()
            .route(
                "/backend-api/codex/models",
                get(move || {
                    let discovery_requests = discovery_requests.clone();
                    async move {
                        discovery_requests.fetch_add(1, AtomicOrdering::Relaxed);
                        Json(json!({
                            "models": [{
                                "slug": "gpt-5.6-sol",
                                "display_name": "GPT 5.6 Sol",
                                "supported_tool_types": ["function"],
                                "supports_reasoning": true
                            }]
                        }))
                    }
                }),
            )
            .route(
                "/backend-api/codex/responses",
                post(move |request: Request<Body>| {
                    let request_bodies = request_bodies.clone();
                    async move {
                        let bytes = to_bytes(request.into_body(), 4 * 1024 * 1024)
                            .await
                            .unwrap();
                        request_bodies
                            .lock()
                            .await
                            .push(serde_json::from_slice::<Value>(&bytes).unwrap());
                        Json(json!({
                            "id": "resp-native",
                            "object": "response",
                            "model": "gpt-5.6-sol",
                            "status": "completed",
                            "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]}],
                            "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
                        }))
                    }
                }),
            );
        let (upstream_url, upstream_task) = start_server(upstream).await;

        let control_requests = control_plane_requests.clone();
        let control_plane = Router::new().fallback(move || {
            let control_requests = control_requests.clone();
            async move {
                control_requests.fetch_add(1, AtomicOrdering::Relaxed);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected control-plane request",
                )
            }
        });
        let (control_plane_url, control_plane_task) = start_server(control_plane).await;

        let store_path = temporary_path("native-catalog");
        let jobs_path = temporary_path("native-catalog-jobs");
        let trace_path = temporary_path("native-catalog-trace");
        fs::write(
            &store_path,
            serde_json::to_vec(&store_with_accounts(vec![account("openai-1")])).unwrap(),
        )
        .await
        .unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.chatgpt_base_url = upstream_url;
        config.node_control_plane_url = control_plane_url;
        config.configured_api_keys = vec![("interactive".to_owned(), "edge-secret".to_owned())];
        config.models_cache_ttl = Duration::from_secs(60);
        config.upstream_timeout = Duration::from_secs(5);
        config.trace_path = Some(trace_path.clone());
        config.trace_include_body = true;
        config.trace_include_headers = true;

        let state = EdgeState::new(config).await.unwrap();
        let (edge_url, edge_task) = start_server(build_router(state)).await;
        let client = reqwest::Client::new();

        let response = client
            .get(format!("{edge_url}/v1/models"))
            .header("authorization", "Bearer edge-secret")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let catalog: Value = response.json().await.unwrap();
        let discovered = catalog["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["id"] == "gpt-5.6-sol")
            .unwrap();
        assert!(discovered.get("codexModelInfo").is_none());
        assert_eq!(discovered["metadata"]["account_ids"][0], "openai-1");
        assert_eq!(catalog["models"][0]["slug"], "gpt-5.6-sol");
        assert_eq!(model_discovery_requests.load(AtomicOrdering::Relaxed), 1);
        assert_eq!(control_plane_requests.load(AtomicOrdering::Relaxed), 0);

        let response = client
            .post(format!("{edge_url}/v1/responses"))
            .header("authorization", "Bearer edge-secret")
            .json(&json!({
                "model": "gpt-5.6-sol",
                "input": [{
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "describe this"},
                        {"type": "input_image", "image_url": "data:image/png;base64,AAAA"}
                    ]
                }],
                "tools": [{"type": "function", "name": "lookup", "parameters": {"type": "object"}}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.json::<Value>().await.unwrap()["id"], "resp-native");

        let request_bodies = upstream_requests.lock().await;
        assert_eq!(request_bodies.len(), 1);
        assert_eq!(request_bodies[0]["model"], "gpt-5.6-sol");
        assert_eq!(
            request_bodies[0]["input"][0]["content"][1]["type"],
            "input_image"
        );
        assert_eq!(request_bodies[0]["tools"][0]["type"], "function");
        drop(request_bodies);

        let trace_contents = fs::read_to_string(&trace_path).await.unwrap();
        let traces = trace_contents
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|entry| entry["route"] == "/v1/responses")
            .collect::<Vec<_>>();
        let trace = traces
            .iter()
            .find(|entry| entry["traceKind"] == "upstream-attempt")
            .unwrap();
        assert_eq!(trace["model"], "gpt-5.6-sol");
        assert_eq!(trace["provider"], "openai");
        assert_eq!(trace["usageStatus"], "measured");
        assert_eq!(trace["tokensInput"], 1);
        assert_eq!(trace["tokensOutput"], 1);
        assert_eq!(trace["tokensTotal"], 2);
        assert_eq!(trace["assistantEmptyOutput"], false);
        assert_eq!(trace["lifecycleState"], "completed");
        assert!(trace["costUsd"].as_f64().is_some());
        assert_eq!(trace["requestBody"]["model"], "gpt-5.6-sol");
        assert_eq!(trace["requestHeaders"]["authorization"], "[REDACTED]");
        let client_trace = traces
            .iter()
            .find(|entry| entry["traceKind"] == "client-request")
            .unwrap();
        assert_eq!(client_trace["providerAttempts"], 1);
        assert_eq!(client_trace["status"], 200);

        let response = client
            .get(format!(
                "{edge_url}/v1/capacity?model=gpt-5.6-sol&priority=interactive"
            ))
            .header("authorization", "Bearer edge-secret")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let capacity: Value = response.json().await.unwrap();
        assert_eq!(capacity["state"], "ready");
        assert_eq!(capacity["freeSlots"], 1);

        let response = client
            .get(format!("{edge_url}/v1/jobs"))
            .header("authorization", "Bearer edge-secret")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.json::<Value>().await.unwrap()["object"], "list");
        assert_eq!(control_plane_requests.load(AtomicOrdering::Relaxed), 0);

        edge_task.abort();
        upstream_task.abort();
        control_plane_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
        let _ = fs::remove_file(trace_path).await;
    }

    #[tokio::test]
    async fn model_catalog_can_be_forced_and_preserves_last_success_on_failure() {
        let discovery_mode = Arc::new(AtomicUsize::new(0));
        let discovery_requests = Arc::new(AtomicUsize::new(0));
        let mode = discovery_mode.clone();
        let requests = discovery_requests.clone();
        let upstream = Router::new().route(
            "/backend-api/codex/models",
            get(move || {
                let mode = mode.clone();
                let requests = requests.clone();
                async move {
                    requests.fetch_add(1, AtomicOrdering::Relaxed);
                    match mode.load(AtomicOrdering::Relaxed) {
                        0 => json_response(
                            StatusCode::OK,
                            json!({"models": [{"slug": "gpt-cached"}]}),
                        ),
                        1 => {
                            json_response(StatusCode::OK, json!({"models": [{"slug": "gpt-new"}]}))
                        }
                        2 => json_response(
                            StatusCode::SERVICE_UNAVAILABLE,
                            json!({"error": "temporary failure"}),
                        ),
                        _ => json_response(
                            StatusCode::OK,
                            json!({"models": [{"slug": "gpt-recovered"}]}),
                        ),
                    }
                }
            }),
        );
        let (upstream_url, upstream_task) = start_server(upstream).await;

        let store_path = temporary_path("model-cache-refresh");
        let jobs_path = temporary_path("model-cache-refresh-jobs");
        fs::write(
            &store_path,
            serde_json::to_vec(&store_with_accounts(vec![account("openai-1")])).unwrap(),
        )
        .await
        .unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.chatgpt_base_url = upstream_url;
        config.configured_api_keys = vec![("test".to_owned(), "edge-secret".to_owned())];
        config.models_cache_ttl = Duration::from_secs(60);

        let state = EdgeState::new(config).await.unwrap();
        let (edge_url, edge_task) = start_server(build_router(state)).await;
        let client = reqwest::Client::new();
        let get_catalog = |suffix: &str| {
            client
                .get(format!("{edge_url}/v1/models{suffix}"))
                .header("authorization", "Bearer edge-secret")
                .send()
        };

        let first: Value = get_catalog("").await.unwrap().json().await.unwrap();
        assert!(
            first["data"]
                .as_array()
                .unwrap()
                .iter()
                .any(|model| model["id"] == "gpt-cached")
        );
        assert_eq!(first["catalog"]["stale"], false);
        assert_eq!(discovery_requests.load(AtomicOrdering::Relaxed), 1);

        discovery_mode.store(1, AtomicOrdering::Relaxed);
        let cached: Value = get_catalog("").await.unwrap().json().await.unwrap();
        assert!(
            cached["data"]
                .as_array()
                .unwrap()
                .iter()
                .any(|model| model["id"] == "gpt-cached")
        );
        assert_eq!(discovery_requests.load(AtomicOrdering::Relaxed), 1);

        let refreshed: Value = get_catalog("?refresh=true")
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(
            refreshed["data"]
                .as_array()
                .unwrap()
                .iter()
                .any(|model| model["id"] == "gpt-new")
        );
        assert_eq!(discovery_requests.load(AtomicOrdering::Relaxed), 2);

        discovery_mode.store(2, AtomicOrdering::Relaxed);
        let stale: Value = get_catalog("?refresh=true")
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(
            stale["data"]
                .as_array()
                .unwrap()
                .iter()
                .any(|model| model["id"] == "gpt-new")
        );
        assert_eq!(stale["catalog"]["stale"], true);
        assert!(
            stale["catalog"]["accounts"][0]["lastError"]
                .as_str()
                .unwrap()
                .contains("HTTP 503")
        );

        discovery_mode.store(3, AtomicOrdering::Relaxed);
        let recovered: Value = get_catalog("?refresh=true")
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(
            recovered["data"]
                .as_array()
                .unwrap()
                .iter()
                .any(|model| model["id"] == "gpt-recovered")
        );
        assert_eq!(recovered["catalog"]["stale"], false);
        assert!(recovered["catalog"]["accounts"][0]["lastError"].is_null());

        edge_task.abort();
        upstream_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }

    #[tokio::test]
    async fn native_sse_stream_is_relayed_without_a_node_hop() {
        let upstream = Router::new()
            .route(
                "/backend-api/codex/models",
                get(|| async {
                    Json(json!({
                        "models": [{"slug": "gpt-5.6-sol", "display_name": "GPT 5.6 Sol"}]
                    }))
                }),
            )
            .route(
                "/backend-api/codex/responses",
                post(|| async {
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(Body::from(concat!(
                            "event: response.output_text.delta\n",
                            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"native\"}\n\n",
                            "event: response.completed\n",
                            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-stream\",\"object\":\"response\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"total_tokens\":5}}}\n\n",
                        )))
                        .unwrap()
                }),
            );
        let (upstream_url, upstream_task) = start_server(upstream).await;

        let store_path = temporary_path("native-stream");
        let jobs_path = temporary_path("native-stream-jobs");
        let trace_path = temporary_path("native-stream-trace");
        fs::write(
            &store_path,
            serde_json::to_vec(&store_with_accounts(vec![account("openai-1")])).unwrap(),
        )
        .await
        .unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.chatgpt_base_url = upstream_url;
        config.configured_api_keys = vec![("stream-app".to_owned(), "stream-key".to_owned())];
        config.models_cache_ttl = Duration::from_secs(60);
        config.upstream_timeout = Duration::from_secs(5);
        config.trace_path = Some(trace_path.clone());

        let state = EdgeState::new(config).await.unwrap();
        let (edge_url, edge_task) = start_server(build_router(state)).await;
        let response = reqwest::Client::new()
            .post(format!("{edge_url}/v1/responses"))
            .header("authorization", "Bearer stream-key")
            .json(&json!({
                "model": "gpt-5.6-sol",
                "input": "hello",
                "stream": true
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.starts_with("text/event-stream"))
        );
        let body = response.text().await.unwrap();
        assert!(body.contains("response.output_text.delta"));
        assert!(body.contains("resp-stream"));
        let trace_contents = fs::read_to_string(&trace_path).await.unwrap();
        let traces = trace_contents
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|entry| entry["route"] == "/v1/responses")
            .collect::<Vec<_>>();
        let trace = traces
            .iter()
            .find(|entry| entry["traceKind"] == "upstream-attempt")
            .unwrap();
        assert_eq!(trace["usageStatus"], "measured");
        assert_eq!(trace["tokensInput"], 3);
        assert_eq!(trace["tokensOutput"], 2);
        assert_eq!(trace["tokensTotal"], 5);
        assert!(trace["ttftMs"].as_u64().is_some());
        assert_eq!(trace["assistantEmptyOutput"], false);
        assert_eq!(
            trace["responseStreamDiagnostics"]["sawResponseCompleted"],
            true
        );
        assert_eq!(
            trace["responseStreamDiagnostics"]["outputTextDeltaCount"],
            1
        );
        assert!(
            traces
                .iter()
                .any(|entry| entry["traceKind"] == "client-request")
        );

        edge_task.abort();
        upstream_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
        let _ = fs::remove_file(trace_path).await;
    }

    #[tokio::test]
    async fn native_realtime_and_voice_requests_are_traced_with_explicit_models() {
        let upstream = Router::new()
            .route(
                "/backend-api/realtime/calls",
                post(|| async {
                    Response::builder()
                        .status(StatusCode::CREATED)
                        .header(header::CONTENT_TYPE, "application/sdp")
                        .body(Body::from("v=0\\r\\na=answer\\r\\n"))
                        .unwrap()
                }),
            )
            .route(
                "/backend-api/settings/voices",
                get(|| async { Json(json!({"voices": ["cove"]})) }),
            );
        let (upstream_url, upstream_task) = start_server(upstream).await;

        let store_path = temporary_path("native-realtime-trace");
        let jobs_path = temporary_path("native-realtime-trace-jobs");
        let trace_path = temporary_path("native-realtime-trace-log");
        fs::write(
            &store_path,
            serde_json::to_vec(&store_with_accounts(vec![account("openai-1")])).unwrap(),
        )
        .await
        .unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.chatgpt_base_url = upstream_url;
        config.configured_api_keys = vec![("realtime-app".to_owned(), "realtime-key".to_owned())];
        config.upstream_timeout = Duration::from_secs(5);
        config.trace_path = Some(trace_path.clone());
        config.trace_include_body = true;
        config.trace_include_headers = true;

        let state = EdgeState::new(config).await.unwrap();
        let (edge_url, edge_task) = start_server(build_router(state)).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("{edge_url}/v1/realtime/calls"))
            .header("authorization", "Bearer realtime-key")
            .header(header::CONTENT_TYPE, "application/sdp")
            .body("v=0\\r\\n")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(response.text().await.unwrap(), "v=0\\r\\na=answer\\r\\n");

        let response = client
            .get(format!(
                "{edge_url}/v1/settings/voices?spoken_language=fr-FR"
            ))
            .header("authorization", "Bearer realtime-key")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.json::<Value>().await.unwrap()["voices"][0], "cove");

        let trace_contents = fs::read_to_string(&trace_path).await.unwrap();
        let traces = trace_contents
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let realtime = traces
            .iter()
            .find(|entry| {
                entry["route"] == "/v1/realtime/calls" && entry["traceKind"] == "upstream-attempt"
            })
            .unwrap();
        assert_eq!(realtime["model"], "realtime");
        assert_eq!(realtime["requestedModel"], "realtime");
        assert_eq!(realtime["provider"], "openai");
        assert_eq!(realtime["accountId"], "openai-1");
        assert_eq!(realtime["status"], 201);
        assert_eq!(realtime["usageStatus"], "missing");
        assert_eq!(realtime["requestBody"]["contentType"], "application/sdp");
        assert_eq!(realtime["requestHeaders"]["authorization"], "[REDACTED]");
        assert!(traces.iter().any(|entry| {
            entry["route"] == "/v1/realtime/calls" && entry["traceKind"] == "client-request"
        }));

        let voices = traces
            .iter()
            .find(|entry| {
                entry["route"] == "/v1/settings/voices" && entry["traceKind"] == "upstream-attempt"
            })
            .unwrap();
        assert_eq!(voices["model"], "realtime-voices");
        assert_eq!(voices["provider"], "openai");
        assert_eq!(voices["status"], 200);
        assert_eq!(voices["usageStatus"], "missing");

        edge_task.abort();
        upstream_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
        let _ = fs::remove_file(trace_path).await;
    }

    #[tokio::test]
    async fn native_realtime_retries_once_after_a_401_token_refresh() {
        let store_path = temporary_path("native-realtime-refresh");
        let jobs_path = temporary_path("native-realtime-refresh-jobs");
        let mut stale = account("realtime-refresh-account");
        stale.access_token = "stale-access".to_owned();
        stale.refresh_token = Some("refresh-token".to_owned());
        stale.expires_at = Some(now_ms().saturating_add(60 * 60 * 1_000));
        fs::write(
            &store_path,
            serde_json::to_vec(&store_with_accounts(vec![stale])).unwrap(),
        )
        .await
        .unwrap();

        let upstream_calls = Arc::new(AtomicUsize::new(0));
        let oauth_calls = Arc::new(AtomicUsize::new(0));
        let persistence_calls = Arc::new(AtomicUsize::new(0));
        let upstream_counter = upstream_calls.clone();
        let oauth_counter = oauth_calls.clone();
        let persistence_counter = persistence_calls.clone();
        let persisted_store_path = store_path.clone();
        let services = Router::new()
            .route(
                "/backend-api/realtime/calls",
                post(move |headers: HeaderMap| {
                    let counter = upstream_counter.clone();
                    async move {
                        counter.fetch_add(1, AtomicOrdering::SeqCst);
                        if header_value(&headers, "authorization").as_deref()
                            == Some("Bearer fresh-access")
                        {
                            Response::builder()
                                .status(StatusCode::CREATED)
                                .header(header::CONTENT_TYPE, "application/sdp")
                                .body(Body::from("v=0\\r\\na=refreshed\\r\\n"))
                                .unwrap()
                        } else {
                            error_response(
                                StatusCode::UNAUTHORIZED,
                                "expired token",
                                "unauthorized",
                            )
                        }
                    }
                }),
            )
            .route(
                "/oauth/token",
                post(move || {
                    let counter = oauth_counter.clone();
                    async move {
                        counter.fetch_add(1, AtomicOrdering::SeqCst);
                        Json(json!({
                            "access_token": "fresh-access",
                            "refresh_token": "next-refresh-token",
                            "expires_in": 3600
                        }))
                    }
                }),
            )
            .route(
                "/internal/v1-edge/accounts/{id}/token",
                post(move |Path(id): Path<String>, Json(payload): Json<Value>| {
                    let counter = persistence_counter.clone();
                    let path = persisted_store_path.clone();
                    async move {
                        counter.fetch_add(1, AtomicOrdering::SeqCst);
                        let mut store: StoreFile =
                            serde_json::from_slice(&fs::read(&path).await.unwrap()).unwrap();
                        let account = store
                            .accounts
                            .iter_mut()
                            .find(|account| account.id == id)
                            .unwrap();
                        assert_eq!(payload["expectedAccessToken"], account.access_token);
                        account.access_token = payload["accessToken"].as_str().unwrap().to_owned();
                        account.refresh_token = value_string(payload.get("refreshToken"));
                        account.expires_at = payload.get("expiresAt").and_then(Value::as_u64);
                        fs::write(&path, serde_json::to_vec(&store).unwrap())
                            .await
                            .unwrap();
                        Json(json!({"ok": true}))
                    }
                }),
            );
        let (services_url, services_task) = start_server(services).await;

        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.legacy_jobs_db_path = None;
        config.chatgpt_base_url = services_url.clone();
        config.node_control_plane_url = services_url.clone();
        config.oauth_token_url = format!("{services_url}/oauth/token");
        config.internal_job_token = Some("refresh-internal".to_owned());
        config.configured_api_keys = vec![("realtime-app".to_owned(), "realtime-key".to_owned())];
        config.upstream_timeout = Duration::from_secs(5);

        let state = EdgeState::new(config).await.unwrap();
        let (edge_url, edge_task) = start_server(build_router(state)).await;
        let response = reqwest::Client::new()
            .post(format!("{edge_url}/v1/realtime/calls"))
            .header("authorization", "Bearer realtime-key")
            .header(header::CONTENT_TYPE, "application/sdp")
            .body("v=0\\r\\n")
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(response.text().await.unwrap(), "v=0\\r\\na=refreshed\\r\\n");
        assert_eq!(upstream_calls.load(AtomicOrdering::SeqCst), 2);
        assert_eq!(oauth_calls.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(persistence_calls.load(AtomicOrdering::SeqCst), 1);

        edge_task.abort();
        services_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }

    #[tokio::test]
    async fn native_websocket_responses_are_authenticated_and_served_by_rust() {
        let store_path = temporary_path("native-websocket");
        let jobs_path = temporary_path("native-websocket-jobs");
        fs::write(
            &store_path,
            serde_json::to_vec(&store_with_accounts(Vec::new())).unwrap(),
        )
        .await
        .unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.configured_api_keys = vec![("websocket-app".to_owned(), "websocket-key".to_owned())];

        let state = EdgeState::new(config).await.unwrap();
        let drain = state.drain.clone();
        let (edge_url, edge_task) = start_server(build_router(state)).await;
        let mut request = format!("{}/v1/responses", edge_url.replace("http://", "ws://"))
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer websocket-key"),
        );
        let (mut socket, _) = connect_async(request).await.unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"type":"response.create","model":"gpt-5.3-codex","generate":false}"#.into(),
            ))
            .await
            .unwrap();

        let created = socket.next().await.unwrap().unwrap();
        let completed = socket.next().await.unwrap().unwrap();
        let created = match created {
            tokio_tungstenite::tungstenite::Message::Text(value) => {
                serde_json::from_str::<Value>(&value).unwrap()
            }
            other => panic!("expected response.created text frame, got {other:?}"),
        };
        let completed = match completed {
            tokio_tungstenite::tungstenite::Message::Text(value) => {
                serde_json::from_str::<Value>(&value).unwrap()
            }
            other => panic!("expected response.completed text frame, got {other:?}"),
        };
        assert_eq!(created["type"], "response.created");
        assert_eq!(completed["type"], "response.completed");
        assert_eq!(completed["response"]["status"], "completed");

        drain.begin();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"type":"response.create","model":"gpt-5.3-codex","generate":false}"#.into(),
            ))
            .await
            .unwrap();
        let rejected = socket.next().await.unwrap().unwrap();
        let rejected = match rejected {
            tokio_tungstenite::tungstenite::Message::Text(value) => {
                serde_json::from_str::<Value>(&value).unwrap()
            }
            other => panic!("expected drain error text frame, got {other:?}"),
        };
        assert_eq!(rejected["type"], "error");
        assert_eq!(rejected["status"], 503);
        assert_eq!(rejected["error"]["code"], "host_update_draining");
        socket.close(None).await.unwrap();

        edge_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }

    #[tokio::test]
    async fn root_inference_aliases_are_served_by_rust_without_node_fallback() {
        let control_plane_requests = Arc::new(AtomicUsize::new(0));
        let upstream = Router::new()
            .route(
                "/backend-api/codex/models",
                get(|| async {
                    Json(json!({
                        "models": [{
                            "slug": "gpt-root",
                            "display_name": "GPT Root",
                            "supported_tool_types": ["function"]
                        }]
                    }))
                }),
            )
            .route(
                "/backend-api/codex/responses",
                post(|| async {
                    Json(json!({
                        "id": "resp-root",
                        "object": "response",
                        "model": "gpt-root",
                        "status": "completed",
                        "output": [{
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": "root alias"}]
                        }],
                        "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}
                    }))
                }),
            )
            .route(
                "/backend-api/codex/responses/compact",
                post(|| async {
                    Json(json!({
                        "id": "resp-root-compact",
                        "object": "response",
                        "model": "gpt-root",
                        "status": "completed",
                        "output": [],
                        "usage": {"input_tokens": 1, "output_tokens": 0, "total_tokens": 1}
                    }))
                }),
            )
            .route(
                "/backend-api/realtime/calls",
                post(|| async {
                    Response::builder()
                        .status(StatusCode::CREATED)
                        .header(header::CONTENT_TYPE, "application/sdp")
                        .body(Body::from("v=0\\r\\na=answer\\r\\n"))
                        .unwrap()
                }),
            )
            .route(
                "/backend-api/settings/voices",
                get(|| async { Json(json!({"voices": ["cove"]})) }),
            );
        let (upstream_url, upstream_task) = start_server(upstream).await;

        let control_requests = control_plane_requests.clone();
        let control_plane = Router::new().fallback(move || {
            let control_requests = control_requests.clone();
            async move {
                control_requests.fetch_add(1, AtomicOrdering::Relaxed);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "unexpected control-plane request",
                )
            }
        });
        let (control_plane_url, control_plane_task) = start_server(control_plane).await;

        let store_path = temporary_path("root-aliases");
        let jobs_path = temporary_path("root-aliases-jobs");
        fs::write(
            &store_path,
            serde_json::to_vec(&store_with_accounts(vec![account("openai-1")])).unwrap(),
        )
        .await
        .unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.chatgpt_base_url = upstream_url;
        config.node_control_plane_url = control_plane_url;
        config.configured_api_keys = vec![("root-app".to_owned(), "root-key".to_owned())];
        config.app_version = "9.8.7-test".to_owned();
        config.models_cache_ttl = Duration::from_secs(60);
        config.upstream_timeout = Duration::from_secs(5);

        let state = EdgeState::new(config).await.unwrap();
        let (edge_url, edge_task) = start_server(build_router(state)).await;
        let client = reqwest::Client::new();
        let authorized_get = |path: &str| {
            client
                .get(format!("{edge_url}{path}"))
                .header("authorization", "Bearer root-key")
        };
        let authorized_post = |path: &str| {
            client
                .post(format!("{edge_url}{path}"))
                .header("authorization", "Bearer root-key")
        };

        let response = authorized_get("/models").send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.json::<Value>().await.unwrap()["data"]
                .as_array()
                .is_some_and(|models| models.iter().any(|model| model["id"] == "gpt-root"))
        );

        let response = authorized_get("/models/gpt-root").send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.json::<Value>().await.unwrap()["id"], "gpt-root");

        let response = authorized_get("/api/v1/models").send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.json::<Value>().await.unwrap()["data"]
                .as_array()
                .is_some_and(|models| models.iter().any(|model| model["id"] == "gpt-root"))
        );

        let response = authorized_get("/api/v1/models/gpt-root")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let model = response.json::<Value>().await.unwrap();
        assert_eq!(model["id"], "gpt-root");
        assert!(model.get("codexModelInfo").is_none());

        let response = authorized_get("/api/tags").send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let tags = response.json::<Value>().await.unwrap();
        let tag = tags["models"]
            .as_array()
            .and_then(|models| models.iter().find(|model| model["name"] == "gpt-root"))
            .expect("Ollama compatibility response should contain the exposed model");
        assert_eq!(tag["model"], "gpt-root");
        assert_eq!(tag["modified_at"], "1970-01-01T00:00:00.000Z");
        assert_eq!(tag["details"]["family"], "openai");

        let response = authorized_get("/version").send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.json::<Value>().await.unwrap()["version"],
            "9.8.7-test"
        );

        let response = authorized_get("/props").send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.json::<Value>().await.unwrap()["models_url"],
            "/v1/models"
        );

        let response = authorized_post("/responses")
            .json(&json!({"model": "gpt-root", "input": "hello"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.json::<Value>().await.unwrap()["id"], "resp-root");

        let response = authorized_post("/responses/compact")
            .json(&json!({"model": "gpt-root", "input": "hello"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.json::<Value>().await.unwrap()["id"],
            "resp-root-compact"
        );

        let response = authorized_post("/chat/completions")
            .json(&json!({
                "model": "gpt-root",
                "messages": [{"role": "user", "content": "hello"}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.json::<Value>().await.unwrap()["object"],
            "chat.completion"
        );

        let response = authorized_post("/messages")
            .json(&json!({
                "model": "gpt-root",
                "max_tokens": 64,
                "messages": [{"role": "user", "content": "hello"}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.json::<Value>().await.unwrap()["type"], "message");

        let response = authorized_post("/realtime/calls")
            .header(header::CONTENT_TYPE, "application/sdp")
            .body("v=0\\r\\n")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(response.text().await.unwrap(), "v=0\\r\\na=answer\\r\\n");

        for path in ["/realtime/voices", "/settings/voices"] {
            let response = authorized_get(path).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.json::<Value>().await.unwrap()["voices"][0], "cove");
        }

        let mut request = format!("{}/responses", edge_url.replace("http://", "ws://"))
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer root-key"),
        );
        let (mut socket, _) = connect_async(request).await.unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"type":"response.create","model":"gpt-root","generate":false}"#.into(),
            ))
            .await
            .unwrap();
        let created = socket.next().await.unwrap().unwrap();
        assert!(matches!(
            created,
            tokio_tungstenite::tungstenite::Message::Text(_)
        ));
        let completed = socket.next().await.unwrap().unwrap();
        let completed = match completed {
            tokio_tungstenite::tungstenite::Message::Text(value) => {
                serde_json::from_str::<Value>(&value).unwrap()
            }
            other => panic!("expected response.completed text frame, got {other:?}"),
        };
        assert_eq!(completed["type"], "response.completed");
        socket.close(None).await.unwrap();

        let response = client
            .post(format!("{edge_url}/messages"))
            .json(&json!({"model": "gpt-root", "messages": []}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.json::<Value>().await.unwrap()["type"], "error");

        let response = client
            .get(format!("{edge_url}/api/tags"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(control_plane_requests.load(AtomicOrdering::Relaxed), 0);

        edge_task.abort();
        upstream_task.abort();
        control_plane_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }

    #[tokio::test]
    async fn native_session_affinity_is_isolated_by_application() {
        let inference_accounts = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen_accounts = inference_accounts.clone();
        let upstream = Router::new()
            .route(
                "/backend-api/codex/models",
                get(|| async {
                    Json(json!({
                        "models": [{
                            "slug": "gpt-5.6-sol",
                            "display_name": "GPT 5.6 Sol"
                        }]
                    }))
                }),
            )
            .route(
                "/backend-api/codex/responses",
                post(move |request: Request<Body>| {
                    let seen_accounts = seen_accounts.clone();
                    async move {
                        if let Some(value) = request.headers().get(header::AUTHORIZATION) {
                            seen_accounts
                                .lock()
                                .await
                                .push(value.to_str().unwrap_or_default().to_owned());
                        }
                        Json(json!({
                            "id": "resp-affinity",
                            "object": "response",
                            "model": "gpt-5.6-sol",
                            "status": "completed",
                            "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]}],
                            "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
                        }))
                    }
                }),
            );
        let (upstream_url, upstream_task) = start_server(upstream).await;

        let mut first = account("account-one");
        first.access_token = "token-one".to_owned();
        let mut second = account("account-two");
        second.access_token = "token-two".to_owned();
        let store_path = temporary_path("native-affinity");
        let jobs_path = temporary_path("native-affinity-jobs");
        fs::write(
            &store_path,
            serde_json::to_vec(&store_with_accounts(vec![first, second])).unwrap(),
        )
        .await
        .unwrap();

        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.chatgpt_base_url = upstream_url;
        config.configured_api_keys = vec![
            (
                "application-one".to_owned(),
                "application-one-key".to_owned(),
            ),
            (
                "application-two".to_owned(),
                "application-two-key".to_owned(),
            ),
        ];
        config.models_cache_ttl = Duration::from_secs(60);
        config.session_affinity_enabled = true;
        config.session_affinity_ttl = Duration::from_secs(60);
        config.session_affinity_max_entries = 32;
        config.upstream_timeout = Duration::from_secs(5);

        let state = EdgeState::new(config).await.unwrap();
        let (edge_url, edge_task) = start_server(build_router(state)).await;
        let client = reqwest::Client::new();

        let request = |key: &'static str, session: &'static str| {
            client
                .post(format!("{edge_url}/v1/responses"))
                .header("authorization", format!("Bearer {key}"))
                .header("thread-id", session)
                .json(&json!({"model": "gpt-5.6-sol", "input": "hello"}))
        };

        for response in [
            request("application-one-key", "same-thread")
                .send()
                .await
                .unwrap(),
            request("application-one-key", "same-thread")
                .send()
                .await
                .unwrap(),
            request("application-two-key", "same-thread")
                .send()
                .await
                .unwrap(),
            request("application-one-key", "same-thread")
                .send()
                .await
                .unwrap(),
        ] {
            assert_eq!(response.status(), StatusCode::OK);
        }

        let seen = inference_accounts.lock().await.clone();
        assert_eq!(
            seen,
            vec![
                "Bearer token-one",
                "Bearer token-one",
                "Bearer token-two",
                "Bearer token-one",
            ]
        );

        edge_task.abort();
        upstream_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }

    #[tokio::test]
    async fn dashboard_session_health_and_admin_guard_terminate_in_rust() {
        let control_plane_requests = Arc::new(AtomicUsize::new(0));
        let seen_requests = control_plane_requests.clone();
        let control_plane = Router::new().fallback(move |req: Request<Body>| {
            let seen_requests = seen_requests.clone();
            async move {
                seen_requests.fetch_add(1, AtomicOrdering::Relaxed);
                (StatusCode::OK, req.uri().path().to_owned())
            }
        });
        let (control_plane_url, control_plane_task) = start_server(control_plane).await;

        let store_path = temporary_path("dashboard-store");
        let jobs_path = temporary_path("dashboard-jobs");
        let store = StoreFile {
            proxy_api_keys: vec![StoredProxyApiKey {
                id: "managed-key".to_owned(),
                application: "desktop".to_owned(),
                key: "mv_managed_secret_1234".to_owned(),
                created_at: Some(1_788_803_484_000),
            }],
            application_policies: vec![ApplicationPolicy {
                application: "desktop".to_owned(),
                fairness_weight: Some(2.5),
                webhooks: vec![ApplicationWebhook {
                    id: "webhook-1".to_owned(),
                    url: "https://example.test/jobs".to_owned(),
                    secret: "webhook-secret".to_owned(),
                    enabled: true,
                    created_at: Some(1_788_803_485_000),
                }],
            }],
            ..Default::default()
        };
        fs::write(&store_path, serde_json::to_vec(&store).unwrap())
            .await
            .unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.node_control_plane_url = control_plane_url;
        config.admin_token = "dashboard-secret".to_owned();
        config.configured_api_keys = vec![(
            "environment-app".to_owned(),
            "mv_environment_secret_5678".to_owned(),
        )];
        config.app_version = "0.2.99".to_owned();
        config.app_git_sha = "abc123".to_owned();
        config.app_build_id = "build-7".to_owned();
        config.upstream_timeout = Duration::from_secs(5);

        let edge_state = EdgeState::new(config).await.unwrap();
        let (edge_url, edge_task) = start_server(build_router(edge_state)).await;
        let client = reqwest::Client::new();

        let health: Value = client
            .get(format!("{edge_url}/health"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            health,
            json!({"ok": true, "version": "0.2.99", "gitSha": "abc123", "buildId": "build-7"})
        );

        let session: Value = client
            .get(format!("{edge_url}/admin/session"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(session, json!({"authenticated": false}));

        let invalid = client
            .post(format!("{edge_url}/admin/session"))
            .json(&json!({"token": "wrong"}))
            .send()
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::UNAUTHORIZED);

        let login = client
            .post(format!("{edge_url}/admin/session"))
            .header("x-forwarded-proto", "https")
            .json(&json!({"token": "dashboard-secret"}))
            .send()
            .await
            .unwrap();
        assert_eq!(login.status(), StatusCode::OK);
        let set_cookie = login
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("SameSite=Strict"));
        assert!(set_cookie.contains("Secure"));
        let cookie = set_cookie.split(';').next().unwrap().to_owned();

        let session: Value = client
            .get(format!("{edge_url}/admin/session"))
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(session, json!({"authenticated": true}));

        let keys: Value = client
            .get(format!("{edge_url}/admin/proxy-api-keys"))
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(keys["proxyApiKeys"].as_array().unwrap().len(), 2);
        assert_eq!(keys["proxyApiKeys"][0]["source"], "environment");
        assert_eq!(keys["proxyApiKeys"][1]["source"], "dashboard");
        assert_eq!(
            keys["proxyApiKeys"][1]["createdAt"],
            1_788_803_484_000_u64
        );
        let keys_json = keys.to_string();
        assert!(!keys_json.contains("mv_environment_secret_5678"));
        assert!(!keys_json.contains("mv_managed_secret_1234"));

        let policies: Value = client
            .get(format!("{edge_url}/admin/application-policies"))
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            policies["applicationPolicies"][0]["fairnessWeight"],
            2.5
        );
        assert_eq!(
            policies["applicationPolicies"][0]["webhooks"][0]["createdAt"],
            1_788_803_485_000_u64
        );
        assert!(!policies.to_string().contains("webhook-secret"));
        assert_eq!(control_plane_requests.load(AtomicOrdering::Relaxed), 1);

        let rejected = client
            .get(format!("{edge_url}/admin/config"))
            .send()
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(control_plane_requests.load(AtomicOrdering::Relaxed), 1);

        let forwarded = client
            .get(format!("{edge_url}/admin/config"))
            .header("x-admin-token", "dashboard-secret")
            .send()
            .await
            .unwrap();
        assert_eq!(forwarded.status(), StatusCode::OK);
        assert_eq!(forwarded.text().await.unwrap(), "/admin/config");

        for path in ["/admin/cloud/oauth/callback", "/admin/codex-sessions"] {
            let request = if path.ends_with("codex-sessions") {
                client.post(format!("{edge_url}{path}"))
            } else {
                client.get(format!("{edge_url}{path}"))
            };
            assert_eq!(request.send().await.unwrap().status(), StatusCode::OK);
        }
        assert_eq!(control_plane_requests.load(AtomicOrdering::Relaxed), 4);

        let desktop: Value = client
            .post(format!("{edge_url}/admin/desktop-session"))
            .header(header::COOKIE, &cookie)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let desktop_path = desktop["path"].as_str().unwrap();
        assert!(desktop_path.starts_with("/desktop/session?code="));
        let no_redirect_client = reqwest::Client::builder()
            .redirect(Policy::none())
            .build()
            .unwrap();
        let consumed = no_redirect_client
            .get(format!("{edge_url}{desktop_path}"))
            .header("x-forwarded-proto", "https")
            .send()
            .await
            .unwrap();
        assert_eq!(consumed.status(), StatusCode::SEE_OTHER);
        assert_eq!(consumed.headers()[header::LOCATION], "/");
        assert!(
            consumed.headers()[header::SET_COOKIE]
                .to_str()
                .unwrap()
                .contains("Secure")
        );
        assert_eq!(
            no_redirect_client
                .get(format!("{edge_url}{desktop_path}"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );

        let logout = client
            .delete(format!("{edge_url}/admin/session"))
            .header("x-forwarded-proto", "https")
            .send()
            .await
            .unwrap();
        assert_eq!(logout.status(), StatusCode::OK);
        let cleared = logout.headers()[header::SET_COOKIE].to_str().unwrap();
        assert!(cleared.contains("Max-Age=0"));
        assert!(cleared.contains("Secure"));

        for _ in 0..18 {
            assert_eq!(
                client
                    .post(format!("{edge_url}/admin/session"))
                    .json(&json!({"token": "wrong"}))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        let limited = client
            .post(format!("{edge_url}/admin/session"))
            .json(&json!({"token": "wrong"}))
            .send()
            .await
            .unwrap();
        assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(limited.headers()[header::CACHE_CONTROL], "no-store");
        assert!(limited.headers().contains_key(header::RETRY_AFTER));
        assert_eq!(control_plane_requests.load(AtomicOrdering::Relaxed), 4);

        control_plane_task.abort();
        let _ = control_plane_task.await;
        let unavailable = client
            .get(format!("{edge_url}/health"))
            .send()
            .await
            .unwrap();
        assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            unavailable.json::<Value>().await.unwrap(),
            json!({"ok": false, "error": "control_plane_unavailable"})
        );

        edge_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }

    #[tokio::test]
    async fn v1_requests_are_served_by_rust_and_non_v1_falls_back_to_control_plane() {
        let upstream = Router::new().route(
            "/backend-api/codex/responses",
            post(|| async {
                Json(json!({
                    "id": "resp-upstream",
                    "object": "response",
                    "model": "gpt-5.3-codex",
                    "status": "completed",
                    "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "native rust"}]}],
                    "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}
                }))
            }),
        );
        let (upstream_url, upstream_task) = start_server(upstream).await;

        let control_plane = Router::new()
            .route(
                "/admin/cloud/oauth/callback",
                get(|req: Request<Body>| async move {
                    assert_eq!(req.uri().query(), Some("state=flow-id&code=cloud-code"));
                    Response::builder()
                        .status(StatusCode::SEE_OTHER)
                        .header(header::LOCATION, "/?tab=accounts&cloud=connected")
                        .body(Body::empty())
                        .unwrap()
                }),
            )
            .fallback(|| async { (StatusCode::OK, "control-plane") });
        let (control_plane_url, control_plane_task) = start_server(control_plane).await;

        let store_path = temporary_path("accounts");
        let jobs_path = temporary_path("edge-jobs");
        fs::write(
            &store_path,
            serde_json::to_vec(&store_with_accounts(vec![account("openai-1")])).unwrap(),
        )
        .await
        .unwrap();
        let mut config = EdgeConfig::default();
        config.store_path = store_path.clone();
        config.jobs_path = jobs_path.clone();
        config.chatgpt_base_url = upstream_url;
        config.node_control_plane_url = control_plane_url;
        config.configured_api_keys = vec![("test".to_owned(), "edge-secret".to_owned())];
        config.request_body_limit = 1024 * 1024;
        config.upstream_timeout = Duration::from_secs(5);

        let edge_state = EdgeState::new(config).await.unwrap();
        let (edge_url, edge_task) = start_server(build_router(edge_state)).await;
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{edge_url}/v1/responses"))
            .header("authorization", "Bearer edge-secret")
            .json(&json!({"model": "gpt-5.3-codex", "input": "hello"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response_body: Value = response.json().await.unwrap();
        assert_eq!(response_body["id"], "resp-upstream");
        assert_eq!(
            response_body["output"][0]["content"][0]["text"],
            "native rust"
        );

        let compressed = zstd::stream::encode_all(
            Cursor::new(b"{\"model\":\"gpt-5.3-codex\",\"input\":\"compressed\"}"),
            1,
        )
        .unwrap();
        let response = client
            .post(format!("{edge_url}/v1/responses"))
            .header("authorization", "Bearer edge-secret")
            .header("content-type", "application/json")
            .header("content-encoding", "zstd")
            .body(compressed)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = client
            .get(format!("{edge_url}/v1/does-not-fallback"))
            .header("authorization", "Bearer edge-secret")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(
            response
                .text()
                .await
                .unwrap()
                .contains("Unknown /v1 endpoint")
        );

        let response = client
            .get(format!("{edge_url}/admin/from-control-plane"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), "control-plane");

        let no_redirect_client = reqwest::Client::builder()
            .redirect(Policy::none())
            .build()
            .unwrap();
        let response = no_redirect_client
            .get(format!(
                "{edge_url}/admin/cloud/oauth/callback?state=flow-id&code=cloud-code"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(
            response.headers().get(header::LOCATION).unwrap(),
            "/?tab=accounts&cloud=connected"
        );

        edge_task.abort();
        upstream_task.abort();
        control_plane_task.abort();
        let _ = fs::remove_file(store_path).await;
        let _ = fs::remove_file(jobs_path).await;
    }
}
