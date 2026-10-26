//! OpenAI Realtime-compatible cascaded voice sessions.
//!
//! The public WebSocket terminates in the native edge so authentication,
//! admission, model aliases and inference tracing remain shared with the
//! existing `/v1/responses` path. Audio adapters are startup configuration,
//! never client-provided URLs.

use super::{
    ActivityKind, AuthContext, EdgeState, ProxyResult, SseStreamTransformer, authorize,
    bearer_or_api_key, build_trace_context, client_trace_outcome, error_response, hex_bytes,
    new_id, now_ms, parse_sse_events, proxy_inference, raw_string, value_string,
};
use axum::{
    body::{Body, to_bytes},
    extract::{
        Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, Request, StatusCode, Uri, header},
    response::Response,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fmt,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Mutex, mpsc},
    task::{JoinHandle, JoinSet},
    time::timeout,
};

const PCM_SAMPLE_RATE: u32 = 24_000;
const PCM_CHANNELS: u16 = 1;
const PCM_BITS_PER_SAMPLE: u16 = 16;
const PCM_BYTES_PER_MILLISECOND: usize = 48;
const MAX_EVENT_BYTES: usize = 512 * 1024;
const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_STT_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_TOOLS: usize = 64;
const MAX_CLIENT_SECRETS: usize = 10_000;

#[derive(Clone)]
pub struct Config {
    pub enabled: bool,
    pub public_model: String,
    pub llm_model: Option<String>,
    pub stt_url: Option<String>,
    stt_api_key: Option<String>,
    pub stt_model: String,
    pub tts_url: Option<String>,
    tts_api_key: Option<String>,
    pub tts_model: String,
    pub tts_voice: String,
    pub tts_response_format: String,
    pub max_audio_bytes: usize,
    pub max_conversation_items: usize,
    pub max_session_duration: Duration,
    pub adapter_timeout: Duration,
    pub client_secret_ttl: Duration,
}

impl fmt::Debug for Config {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RealtimeVoiceConfig")
            .field("enabled", &self.enabled)
            .field("public_model", &self.public_model)
            .field("llm_model", &self.llm_model)
            .field("stt_url", &self.stt_url.as_ref().map(|_| "[configured]"))
            .field(
                "stt_api_key",
                &self.stt_api_key.as_ref().map(|_| "[redacted]"),
            )
            .field("stt_model", &self.stt_model)
            .field("tts_url", &self.tts_url.as_ref().map(|_| "[configured]"))
            .field(
                "tts_api_key",
                &self.tts_api_key.as_ref().map(|_| "[redacted]"),
            )
            .field("tts_model", &self.tts_model)
            .field("tts_voice", &self.tts_voice)
            .field("tts_response_format", &self.tts_response_format)
            .field("max_audio_bytes", &self.max_audio_bytes)
            .field("max_conversation_items", &self.max_conversation_items)
            .field("max_session_duration", &self.max_session_duration)
            .field("adapter_timeout", &self.adapter_timeout)
            .field("client_secret_ttl", &self.client_secret_ttl)
            .finish()
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            public_model: "multivibe/voice".to_owned(),
            llm_model: None,
            stt_url: None,
            stt_api_key: None,
            stt_model: "whisper-1".to_owned(),
            tts_url: None,
            tts_api_key: None,
            tts_model: "kokoro".to_owned(),
            tts_voice: "af_heart".to_owned(),
            tts_response_format: "pcm".to_owned(),
            max_audio_bytes: 12 * 1024 * 1024,
            max_conversation_items: 128,
            max_session_duration: Duration::from_secs(60 * 60),
            adapter_timeout: Duration::from_secs(120),
            client_secret_ttl: Duration::from_secs(10 * 60),
        }
    }
}

impl Config {
    pub fn from_env() -> Self {
        let mut config = Self::default();
        let env = |name: &str| {
            std::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
        };
        config.public_model =
            env("REALTIME_CASCADE_MODEL").unwrap_or_else(|| config.public_model.clone());
        config.llm_model = env("REALTIME_CASCADE_LLM_MODEL");
        config.stt_url = env("REALTIME_STT_URL");
        config.stt_api_key = env("REALTIME_STT_API_KEY");
        config.stt_model = env("REALTIME_STT_MODEL").unwrap_or_else(|| config.stt_model.clone());
        config.tts_url = env("REALTIME_TTS_URL");
        config.tts_api_key = env("REALTIME_TTS_API_KEY");
        config.tts_model = env("REALTIME_TTS_MODEL").unwrap_or_else(|| config.tts_model.clone());
        config.tts_voice = env("REALTIME_TTS_VOICE").unwrap_or_else(|| config.tts_voice.clone());
        config.tts_response_format = env("REALTIME_TTS_RESPONSE_FORMAT")
            .map(|value| value.to_ascii_lowercase())
            .filter(|value| matches!(value.as_str(), "pcm" | "wav"))
            .unwrap_or_else(|| config.tts_response_format.clone());
        config.max_audio_bytes = env("REALTIME_MAX_AUDIO_BYTES")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(config.max_audio_bytes)
            .clamp(48_000, 100 * 1024 * 1024);
        config.max_conversation_items = env("REALTIME_MAX_CONVERSATION_ITEMS")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(config.max_conversation_items)
            .clamp(1, 1_024);
        config.max_session_duration = Duration::from_secs(
            env("REALTIME_MAX_SESSION_SECONDS")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(config.max_session_duration.as_secs())
                .clamp(10, 60 * 60),
        );
        config.adapter_timeout = Duration::from_millis(
            env("REALTIME_ADAPTER_TIMEOUT_MS")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(config.adapter_timeout.as_millis() as u64)
                .clamp(100, 10 * 60 * 1_000),
        );
        config.client_secret_ttl = Duration::from_secs(
            env("REALTIME_CLIENT_SECRET_TTL_SECONDS")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(config.client_secret_ttl.as_secs())
                .clamp(10, 10 * 60),
        );
        let automatically_enabled = config.stt_url.is_some() && config.tts_url.is_some();
        config.enabled = env("REALTIME_CASCADE_ENABLED")
            .map(|value| value.eq_ignore_ascii_case("true") || value == "1")
            .unwrap_or(automatically_enabled);
        config
    }

    pub fn operational(&self) -> bool {
        self.enabled && self.stt_url.is_some() && self.tts_url.is_some()
    }
}

#[derive(Clone)]
struct EphemeralSecret {
    application: String,
    model: String,
    session: Value,
    expires_at_ms: u64,
}

struct SecretGrant {
    auth: AuthContext,
    session: Value,
}

#[derive(Clone, Default)]
pub struct SecretStore {
    entries: Arc<Mutex<HashMap<String, EphemeralSecret>>>,
}

impl SecretStore {
    async fn issue(
        &self,
        application: String,
        model: String,
        session: Value,
        ttl: Duration,
    ) -> (String, u64) {
        let token = format!("ek_{}", new_id("rt").trim_start_matches("rt_"));
        let digest = digest_secret(&token);
        let expires_at_ms = now_ms().saturating_add(ttl.as_millis() as u64);
        let mut entries = self.entries.lock().await;
        entries.retain(|_, entry| entry.expires_at_ms > now_ms());
        while entries.len() >= MAX_CLIENT_SECRETS {
            let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, entry)| entry.expires_at_ms)
                .map(|(digest, _)| digest.clone())
            else {
                break;
            };
            entries.remove(&oldest);
        }
        entries.insert(
            digest,
            EphemeralSecret {
                application,
                model,
                session,
                expires_at_ms,
            },
        );
        (token, expires_at_ms)
    }

    async fn resolve(&self, token: &str, requested_model: &str) -> Option<SecretGrant> {
        let mut entries = self.entries.lock().await;
        entries.retain(|_, entry| entry.expires_at_ms > now_ms());
        let digest = digest_secret(token);
        let entry = entries.get(&digest)?.clone();
        if entry.model != requested_model {
            return None;
        }
        Some(SecretGrant {
            auth: AuthContext {
                application: entry.application,
            },
            session: entry.session,
        })
    }
}

fn digest_secret(secret: &str) -> String {
    hex_bytes(&Sha256::digest(secret.as_bytes()))
}

pub async fn client_secret_handler(
    State(state): State<EdgeState>,
    request: Request<Body>,
) -> Response {
    if !state.config.realtime_voice.operational() {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "The cascaded Realtime voice gateway is not configured",
            "realtime_cascade_not_configured",
        );
    }
    let headers = request.headers().clone();
    let path = request.uri().path().to_owned();
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
    let bytes = match to_bytes(request.into_body(), 64 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Realtime client secret request is too large",
                "payload_too_large",
            );
        }
    };
    let body = if bytes.is_empty() {
        Value::Object(Map::new())
    } else {
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(body)) => Value::Object(body),
            _ => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "Expected a JSON object",
                    "invalid_json",
                );
            }
        }
    };
    if body
        .pointer("/expires_after/anchor")
        .and_then(Value::as_str)
        .is_some_and(|anchor| anchor != "created_at")
    {
        return error_response(
            StatusCode::BAD_REQUEST,
            "expires_after.anchor must be created_at",
            "invalid_value",
        );
    }
    let ttl = Duration::from_secs(
        body.pointer("/expires_after/seconds")
            .and_then(Value::as_u64)
            .unwrap_or(state.config.realtime_voice.client_secret_ttl.as_secs())
            .clamp(10, state.config.realtime_voice.client_secret_ttl.as_secs()),
    );
    let mut session = body
        .get("session")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    if !session.is_object() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "session must be an object",
            "invalid_value",
        );
    }
    if session.get("model").is_none()
        && let Some(model) = body.get("model")
    {
        session["model"] = model.clone();
    }
    let model = session
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&state.config.realtime_voice.public_model)
        .to_owned();
    if model.len() > 200 {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Realtime model is too long",
            "invalid_value",
        );
    }
    session["type"] = Value::String("realtime".to_owned());
    session["model"] = Value::String(model.clone());
    let fallback_model = state
        .config
        .proxy_models
        .first()
        .cloned()
        .unwrap_or_else(|| model.clone());
    let mut effective =
        SessionOptions::new(&state.config.realtime_voice, model.clone(), fallback_model);
    if let Err(message) = effective.update(&session) {
        return error_response(StatusCode::BAD_REQUEST, message, "invalid_value");
    }
    let (value, expires_at_ms) = state
        .realtime_secrets
        .issue(auth.application, model.clone(), session, ttl)
        .await;
    super::json_response(
        StatusCode::OK,
        json!({
            "value": value,
            "expires_at": expires_at_ms / 1_000,
            "session": effective.public_value(&new_id("sess"))
        }),
    )
}

#[derive(Debug, Deserialize)]
pub struct RealtimeQuery {
    model: Option<String>,
    client_secret: Option<String>,
}

pub async fn websocket_handler(
    State(state): State<EdgeState>,
    Query(query): Query<RealtimeQuery>,
    websocket: WebSocketUpgrade,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if !state.config.realtime_voice.operational() {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "The cascaded Realtime voice gateway is not configured",
            "realtime_cascade_not_configured",
        );
    }
    if state.drain.is_draining() {
        return super::draining_response();
    }
    let requested_model = query
        .model
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| state.config.realtime_voice.public_model.clone());
    if requested_model.len() > 200 {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Realtime model is too long",
            "invalid_value",
        );
    }
    let store = match state.store.snapshot().await {
        Ok(store) => store,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::SERVICE_UNAVAILABLE)
                .body(Body::empty())
                .unwrap_or_else(|_| Response::new(Body::empty()));
        }
    };
    let grant = match authorize(&headers, uri.path(), &store, &state.config) {
        Ok(auth) => Some(SecretGrant {
            auth,
            session: Value::Null,
        }),
        Err(_) => {
            let secret = query.client_secret.or_else(|| bearer_or_api_key(&headers));
            match secret {
                Some(secret) => {
                    state
                        .realtime_secrets
                        .resolve(&secret, &requested_model)
                        .await
                }
                None => None,
            }
        }
    };
    let Some(grant) = grant else {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty()));
    };
    let preset = (!grant.session.is_null()).then_some(grant.session);
    websocket.on_upgrade(move |socket| {
        run_session(
            socket,
            state,
            headers,
            grant.auth.application,
            requested_model,
            preset,
        )
    })
}

#[derive(Clone)]
struct Outbound {
    generation: Option<u64>,
    value: Value,
}

#[derive(Clone)]
struct EventSender {
    tx: mpsc::Sender<Outbound>,
    generation: Option<u64>,
}

impl EventSender {
    async fn send(&self, value: Value) -> bool {
        self.tx
            .send(Outbound {
                generation: self.generation,
                value: server_event(value),
            })
            .await
            .is_ok()
    }

    fn for_generation(&self, generation: u64) -> Self {
        Self {
            tx: self.tx.clone(),
            generation: Some(generation),
        }
    }
}

fn server_event(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object
            .entry("event_id")
            .or_insert_with(|| Value::String(new_id("event")));
    }
    value
}

#[derive(Clone)]
struct TurnDetection {
    threshold: f64,
    prefix_padding_ms: u64,
    silence_duration_ms: u64,
    create_response: bool,
    interrupt_response: bool,
}

impl Default for TurnDetection {
    fn default() -> Self {
        Self {
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 700,
            create_response: true,
            interrupt_response: true,
        }
    }
}

#[derive(Clone)]
struct SessionOptions {
    public_model: String,
    llm_model: String,
    instructions: String,
    output_modalities: Vec<String>,
    voice: String,
    tools: Vec<Value>,
    tool_choice: Value,
    language: Option<String>,
    turn_detection: Option<TurnDetection>,
}

impl SessionOptions {
    fn new(config: &Config, requested_model: String, fallback_model: String) -> Self {
        let llm_model = if requested_model == config.public_model {
            config
                .llm_model
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(fallback_model)
        } else {
            requested_model.clone()
        };
        Self {
            public_model: requested_model,
            llm_model,
            instructions: String::new(),
            output_modalities: vec!["audio".to_owned()],
            voice: config.tts_voice.clone(),
            tools: Vec::new(),
            tool_choice: Value::String("auto".to_owned()),
            language: None,
            turn_detection: Some(TurnDetection::default()),
        }
    }

    fn public_value(&self, id: &str) -> Value {
        json!({
            "id": id,
            "object": "realtime.session",
            "type": "realtime",
            "model": self.public_model,
            "output_modalities": self.output_modalities,
            "modalities": self.output_modalities,
            "instructions": self.instructions,
            "voice": self.voice,
            "input_audio_format": "pcm16",
            "output_audio_format": "pcm16",
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": PCM_SAMPLE_RATE},
                    "turn_detection": self.turn_detection.as_ref().map(|turn| json!({
                        "type": "server_vad",
                        "threshold": turn.threshold,
                        "prefix_padding_ms": turn.prefix_padding_ms,
                        "silence_duration_ms": turn.silence_duration_ms,
                        "create_response": turn.create_response,
                        "interrupt_response": turn.interrupt_response,
                    })),
                },
                "output": {
                    "format": {"type": "audio/pcm", "rate": PCM_SAMPLE_RATE},
                    "voice": self.voice,
                },
            },
            "turn_detection": self.turn_detection.as_ref().map(|turn| json!({
                "type": "server_vad",
                "threshold": turn.threshold,
                "prefix_padding_ms": turn.prefix_padding_ms,
                "silence_duration_ms": turn.silence_duration_ms,
                "create_response": turn.create_response,
                "interrupt_response": turn.interrupt_response,
            })),
            "tools": self.tools,
            "tool_choice": self.tool_choice,
        })
    }

    fn update(&mut self, value: &Value) -> Result<(), String> {
        if let Some(model) = value_string(value.get("model"))
            && model != self.public_model
        {
            return Err("The session model cannot be changed after connection".to_owned());
        }
        if let Some(instructions) = raw_string(value.get("instructions")) {
            if instructions.len() > MAX_TEXT_BYTES {
                return Err("Session instructions are too large".to_owned());
            }
            self.instructions = instructions;
        }
        if let Some(modalities) = value
            .get("output_modalities")
            .or_else(|| value.get("modalities"))
            .and_then(Value::as_array)
        {
            let parsed = modalities
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>();
            if parsed.is_empty()
                || parsed
                    .iter()
                    .any(|value| !matches!(value.as_str(), "audio" | "text"))
            {
                return Err("output_modalities must contain audio and/or text".to_owned());
            }
            self.output_modalities = parsed;
        }
        if let Some(voice) = value
            .pointer("/audio/output/voice")
            .and_then(Value::as_str)
            .or_else(|| value.get("voice").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if voice.len() > 200 {
                return Err("Voice is too long".to_owned());
            }
            self.voice = voice.to_owned();
        }
        validate_audio_format(
            value
                .pointer("/audio/input/format")
                .or_else(|| value.get("input_audio_format")),
        )?;
        validate_audio_format(
            value
                .pointer("/audio/output/format")
                .or_else(|| value.get("output_audio_format")),
        )?;
        if let Some(tools) = value.get("tools").and_then(Value::as_array) {
            if tools.len() > MAX_TOOLS {
                return Err("Too many Realtime tools".to_owned());
            }
            self.tools = tools.clone();
        }
        if let Some(tool_choice) = value.get("tool_choice") {
            self.tool_choice = tool_choice.clone();
        }
        if let Some(language) = value
            .pointer("/audio/input/transcription/language")
            .and_then(Value::as_str)
            .or_else(|| {
                value
                    .pointer("/input_audio_transcription/language")
                    .and_then(Value::as_str)
            })
        {
            self.language = Some(language.to_owned());
        }
        let turn_detection = value
            .pointer("/audio/input/turn_detection")
            .or_else(|| value.get("turn_detection"));
        if let Some(turn_detection) = turn_detection {
            self.turn_detection = parse_turn_detection(turn_detection)?;
        }
        Ok(())
    }
}

fn validate_audio_format(value: Option<&Value>) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.as_str().is_some_and(|value| value == "pcm16") {
        return Ok(());
    }
    if value
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|value| value == "audio/pcm")
        && value
            .get("rate")
            .and_then(Value::as_u64)
            .is_none_or(|value| value == u64::from(PCM_SAMPLE_RATE))
    {
        return Ok(());
    }
    Err("Only PCM16 mono audio at 24000 Hz is supported".to_owned())
}

fn parse_turn_detection(value: &Value) -> Result<Option<TurnDetection>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("server_vad");
    if kind != "server_vad" {
        return Err(format!(
            "turn_detection type '{kind}' is unavailable; use server_vad or null"
        ));
    }
    Ok(Some(TurnDetection {
        threshold: value
            .get("threshold")
            .and_then(Value::as_f64)
            .unwrap_or(0.5)
            .clamp(0.0, 1.0),
        prefix_padding_ms: value
            .get("prefix_padding_ms")
            .and_then(Value::as_u64)
            .unwrap_or(300)
            .clamp(0, 2_000),
        silence_duration_ms: value
            .get("silence_duration_ms")
            .and_then(Value::as_u64)
            .unwrap_or(700)
            .clamp(100, 5_000),
        create_response: value
            .get("create_response")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        interrupt_response: value
            .get("interrupt_response")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    }))
}

#[derive(Clone)]
struct ConversationRecord {
    id: String,
    input: Value,
    public_item: Value,
    text: String,
    audio_duration_ms: u64,
}

type Conversation = Arc<Mutex<VecDeque<ConversationRecord>>>;

async fn push_conversation(
    conversation: &Conversation,
    record: ConversationRecord,
    max_items: usize,
) {
    let mut items = conversation.lock().await;
    items.push_back(record);
    while items.len() > max_items {
        items.pop_front();
    }
}

struct ActiveResponse {
    generation: u64,
    response_id: String,
    item_id: String,
    audio: bool,
    transcript: Arc<Mutex<String>>,
    handle: JoinHandle<()>,
}

async fn run_session(
    socket: WebSocket,
    state: EdgeState,
    headers: HeaderMap,
    application: String,
    requested_model: String,
    preset: Option<Value>,
) {
    let (mut sink, mut source) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<Outbound>(256);
    let sender = EventSender {
        tx: out_tx,
        generation: None,
    };
    let (completed_tx, mut completed_rx) = mpsc::channel::<(u64, String)>(8);
    let generation = Arc::new(AtomicU64::new(0));
    let fallback_model = state
        .config
        .proxy_models
        .first()
        .cloned()
        .unwrap_or_else(|| requested_model.clone());
    let mut options = SessionOptions::new(
        &state.config.realtime_voice,
        requested_model,
        fallback_model,
    );
    if let Some(preset) = preset
        && let Err(message) = options.update(&preset)
    {
        let event = server_event(json!({
            "type": "error",
            "error": {
                "type": "invalid_request_error",
                "code": "invalid_client_secret_session",
                "message": message,
            }
        }));
        let _ = sink.send(Message::Text(event.to_string().into())).await;
        return;
    }
    let session_id = new_id("sess");
    let conversation: Conversation = Arc::new(Mutex::new(VecDeque::new()));
    let mut audio = Vec::new();
    let mut speech_active = false;
    let mut silence_ms = 0_u64;
    let mut active: Option<ActiveResponse> = None;
    let mut cancelled_through = 0_u64;
    let _ = sender
        .send(json!({
            "type": "session.created",
            "session": options.public_value(&session_id),
        }))
        .await;
    let session_deadline = tokio::time::sleep(state.config.realtime_voice.max_session_duration);
    tokio::pin!(session_deadline);

    loop {
        tokio::select! {
            outbound = out_rx.recv() => {
                let Some(outbound) = outbound else { break; };
                if outbound.generation.is_some_and(|value| value <= cancelled_through) {
                    continue;
                }
                if sink.send(Message::Text(outbound.value.to_string().into())).await.is_err() {
                    break;
                }
            }
            completed = completed_rx.recv() => {
                if let Some((finished_generation, response_id)) = completed
                    && active.as_ref().is_some_and(|current| {
                        current.generation == finished_generation && current.response_id == response_id
                    })
                {
                    active = None;
                }
            }
            _ = &mut session_deadline => {
                let event = server_event(json!({
                    "type": "error",
                    "error": {
                        "type": "session_expired",
                        "code": "session_expired",
                        "message": "The Realtime session reached its configured lifetime",
                    }
                }));
                let _ = sink.send(Message::Text(event.to_string().into())).await;
                break;
            }
            message = source.next() => {
                let Some(Ok(message)) = message else { break; };
                match message {
                    Message::Text(text) => {
                        if text.len() > MAX_EVENT_BYTES {
                            send_protocol_error(&sender, None, "payload_too_large", "Realtime event is too large", None).await;
                            continue;
                        }
                        let frame = match serde_json::from_str::<Value>(&text) {
                            Ok(Value::Object(frame)) => Value::Object(frame),
                            _ => {
                                send_protocol_error(&sender, None, "invalid_json", "Expected a JSON object", None).await;
                                continue;
                            }
                        };
                        let client_event_id = value_string(frame.get("event_id"));
                        let kind = frame.get("type").and_then(Value::as_str).unwrap_or_default();
                        match kind {
                            "session.update" => {
                                let Some(update) = frame.get("session") else {
                                    send_protocol_error(&sender, client_event_id.as_deref(), "missing_required_parameter", "session.update requires session", Some("session")).await;
                                    continue;
                                };
                                match options.update(update) {
                                    Ok(()) => {
                                        let _ = sender.send(json!({
                                            "type": "session.updated",
                                            "session": options.public_value(&session_id),
                                        })).await;
                                    }
                                    Err(message) => {
                                        send_protocol_error(&sender, client_event_id.as_deref(), "invalid_value", &message, Some("session")).await;
                                    }
                                }
                            }
                            "conversation.item.create" => {
                                match conversation_record_from_client(frame.get("item")) {
                                    Ok(record) => {
                                        let previous_item_id = conversation.lock().await.back().map(|item| item.id.clone());
                                        emit_item_created(&sender, &record.public_item, previous_item_id).await;
                                        push_conversation(
                                            &conversation,
                                            record,
                                            state.config.realtime_voice.max_conversation_items,
                                        ).await;
                                    }
                                    Err(message) => {
                                        send_protocol_error(&sender, client_event_id.as_deref(), "invalid_value", &message, Some("item")).await;
                                    }
                                }
                            }
                            "conversation.item.delete" => {
                                let Some(item_id) = value_string(frame.get("item_id")) else {
                                    send_protocol_error(&sender, client_event_id.as_deref(), "missing_required_parameter", "conversation.item.delete requires item_id", Some("item_id")).await;
                                    continue;
                                };
                                let removed = {
                                    let mut items = conversation.lock().await;
                                    let before = items.len();
                                    items.retain(|item| item.id != item_id);
                                    before != items.len()
                                };
                                if removed {
                                    let _ = sender.send(json!({
                                        "type": "conversation.item.deleted",
                                        "item_id": item_id,
                                    })).await;
                                } else {
                                    send_protocol_error(&sender, client_event_id.as_deref(), "item_not_found", "Conversation item was not found", Some("item_id")).await;
                                }
                            }
                            "conversation.item.truncate" => {
                                let Some(item_id) = value_string(frame.get("item_id")) else {
                                    send_protocol_error(&sender, client_event_id.as_deref(), "missing_required_parameter", "conversation.item.truncate requires item_id", Some("item_id")).await;
                                    continue;
                                };
                                let audio_end_ms = frame.get("audio_end_ms").and_then(Value::as_u64).unwrap_or(0);
                                let truncated = truncate_item(&conversation, &item_id, audio_end_ms).await;
                                if truncated {
                                    let _ = sender.send(json!({
                                        "type": "conversation.item.truncated",
                                        "item_id": item_id,
                                        "content_index": frame.get("content_index").and_then(Value::as_u64).unwrap_or(0),
                                        "audio_end_ms": audio_end_ms,
                                    })).await;
                                } else {
                                    send_protocol_error(&sender, client_event_id.as_deref(), "item_not_found", "Conversation item was not found", Some("item_id")).await;
                                }
                            }
                            "input_audio_buffer.clear" => {
                                audio.clear();
                                speech_active = false;
                                silence_ms = 0;
                                let _ = sender.send(json!({"type": "input_audio_buffer.cleared"})).await;
                            }
                            "input_audio_buffer.append" => {
                                let Some(encoded) = frame.get("audio").and_then(Value::as_str) else {
                                    send_protocol_error(&sender, client_event_id.as_deref(), "missing_required_parameter", "input_audio_buffer.append requires audio", Some("audio")).await;
                                    continue;
                                };
                                let bytes = match STANDARD.decode(encoded) {
                                    Ok(bytes) if !bytes.is_empty() && bytes.len() % 2 == 0 => bytes,
                                    _ => {
                                        send_protocol_error(&sender, client_event_id.as_deref(), "invalid_value", "audio must be non-empty base64 PCM16", Some("audio")).await;
                                        continue;
                                    }
                                };
                                if audio.len().saturating_add(bytes.len()) > state.config.realtime_voice.max_audio_bytes {
                                    audio.clear();
                                    speech_active = false;
                                    send_protocol_error(&sender, client_event_id.as_deref(), "audio_buffer_too_large", "The input audio buffer exceeded its configured limit", Some("audio")).await;
                                    continue;
                                }
                                audio.extend_from_slice(&bytes);
                                let mut auto_commit = false;
                                if let Some(turn) = options.turn_detection.as_ref() {
                                    let voiced = pcm_rms(&bytes) >= vad_rms_threshold(turn.threshold);
                                    if voiced {
                                        silence_ms = 0;
                                        if !speech_active {
                                            speech_active = true;
                                            if turn.interrupt_response
                                                && let Some(cancelled) = cancel_active_response(
                                                    &mut active,
                                                    &generation,
                                                    &sender,
                                                    "turn_detected",
                                                ).await
                                            {
                                                cancelled_through = cancelled_through.max(cancelled);
                                            }
                                            let _ = sender.send(json!({
                                                "type": "input_audio_buffer.speech_started",
                                                "audio_start_ms": audio.len().saturating_sub(bytes.len()) / PCM_BYTES_PER_MILLISECOND,
                                                "item_id": Value::Null,
                                            })).await;
                                        }
                                    } else if speech_active {
                                        silence_ms = silence_ms.saturating_add(
                                            (bytes.len() / PCM_BYTES_PER_MILLISECOND) as u64
                                        );
                                        auto_commit = silence_ms >= turn.silence_duration_ms;
                                    } else {
                                        let keep = (turn.prefix_padding_ms as usize)
                                            .saturating_mul(PCM_BYTES_PER_MILLISECOND);
                                        if audio.len() > keep {
                                            audio.drain(..audio.len() - keep);
                                        }
                                    }
                                }
                                if auto_commit {
                                    let create_response = options.turn_detection.as_ref().is_some_and(|turn| turn.create_response);
                                    if commit_audio(
                                        &state,
                                        &headers,
                                        &application,
                                        &sender,
                                        &conversation,
                                        &options,
                                        &mut audio,
                                        &mut speech_active,
                                    ).await.is_ok() && create_response {
                                        start_response(
                                            &mut active,
                                            &generation,
                                            &state,
                                            &headers,
                                            &application,
                                            &options,
                                            &conversation,
                                            &sender,
                                            &completed_tx,
                                            Value::Object(Map::new()),
                                        ).await;
                                    }
                                    silence_ms = 0;
                                }
                            }
                            "input_audio_buffer.commit" => {
                                if let Err(message) = commit_audio(
                                    &state,
                                    &headers,
                                    &application,
                                    &sender,
                                    &conversation,
                                    &options,
                                    &mut audio,
                                    &mut speech_active,
                                ).await {
                                    send_protocol_error(&sender, client_event_id.as_deref(), "invalid_value", &message, Some("audio")).await;
                                }
                                silence_ms = 0;
                            }
                            "response.create" => {
                                if active.as_ref().is_some_and(|active| !active.handle.is_finished()) {
                                    send_protocol_error(&sender, client_event_id.as_deref(), "conversation_already_has_active_response", "A response is already in progress", None).await;
                                    continue;
                                }
                                active = None;
                                if !audio.is_empty()
                                    && let Err(message) = commit_audio(
                                        &state,
                                        &headers,
                                        &application,
                                        &sender,
                                        &conversation,
                                        &options,
                                        &mut audio,
                                        &mut speech_active,
                                    ).await
                                {
                                    send_protocol_error(&sender, client_event_id.as_deref(), "invalid_value", &message, Some("audio")).await;
                                    continue;
                                }
                                start_response(
                                    &mut active,
                                    &generation,
                                    &state,
                                    &headers,
                                    &application,
                                    &options,
                                    &conversation,
                                    &sender,
                                    &completed_tx,
                                    frame.get("response").cloned().unwrap_or_else(|| Value::Object(Map::new())),
                                ).await;
                            }
                            "response.cancel" => {
                                if active.as_ref().is_some_and(|active| !active.handle.is_finished()) {
                                    if let Some(cancelled) = cancel_active_response(
                                        &mut active,
                                        &generation,
                                        &sender,
                                        "client_cancelled",
                                    ).await {
                                        cancelled_through = cancelled_through.max(cancelled);
                                    }
                                } else {
                                    active = None;
                                    send_protocol_error(&sender, client_event_id.as_deref(), "response_cancel_not_active", "No response is currently active", None).await;
                                }
                            }
                            "ping" => {
                                let _ = sender.send(json!({"type": "pong"})).await;
                            }
                            _ => {
                                send_protocol_error(&sender, client_event_id.as_deref(), "invalid_value", &format!("Unsupported Realtime event type '{kind}'"), Some("type")).await;
                            }
                        }
                    }
                    Message::Binary(_) => {
                        send_protocol_error(&sender, None, "invalid_value", "Binary WebSocket frames are not supported", None).await;
                    }
                    Message::Close(_) => break,
                    Message::Ping(_) | Message::Pong(_) => {}
                }
            }
        }
    }
    if let Some(active) = active {
        active.handle.abort();
    }
}

async fn send_protocol_error(
    sender: &EventSender,
    client_event_id: Option<&str>,
    code: &str,
    message: &str,
    param: Option<&str>,
) {
    let _ = sender
        .send(json!({
            "type": "error",
            "error": {
                "type": "invalid_request_error",
                "code": code,
                "message": message,
                "param": param,
                "event_id": client_event_id,
            }
        }))
        .await;
}

async fn emit_item_created(sender: &EventSender, item: &Value, previous_item_id: Option<String>) {
    let _ = sender
        .send(json!({
            "type": "conversation.item.added",
            "previous_item_id": previous_item_id,
            "item": item,
        }))
        .await;
    // Legacy clients still use the pre-GA event name.
    let _ = sender
        .send(json!({
            "type": "conversation.item.created",
            "previous_item_id": previous_item_id,
            "item": item,
        }))
        .await;
    let _ = sender
        .send(json!({
            "type": "conversation.item.done",
            "previous_item_id": previous_item_id,
            "item": item,
        }))
        .await;
}

fn conversation_record_from_client(item: Option<&Value>) -> Result<ConversationRecord, String> {
    let Some(Value::Object(item)) = item else {
        return Err("conversation.item.create requires an item object".to_owned());
    };
    let mut public_item = Value::Object(item.clone());
    let id = value_string(public_item.get("id")).unwrap_or_else(|| new_id("item"));
    public_item["id"] = Value::String(id.clone());
    public_item["status"] = Value::String("completed".to_owned());
    let kind = public_item
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("message");
    let (input, text) = match kind {
        "function_call_output" => {
            let call_id = value_string(public_item.get("call_id"))
                .ok_or_else(|| "function_call_output requires call_id".to_owned())?;
            let output = raw_string(public_item.get("output"))
                .ok_or_else(|| "function_call_output requires output".to_owned())?;
            if output.len() > MAX_TEXT_BYTES {
                return Err("Function output is too large".to_owned());
            }
            (
                json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": output,
                }),
                String::new(),
            )
        }
        "message" => {
            let role = public_item
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user");
            if !matches!(role, "user" | "assistant" | "system" | "developer") {
                return Err("Unsupported message role".to_owned());
            }
            let text = extract_item_text(&public_item);
            if text.trim().is_empty() {
                return Err("Message item requires text content".to_owned());
            }
            if text.len() > MAX_TEXT_BYTES {
                return Err("Message text is too large".to_owned());
            }
            let content_type = if role == "assistant" {
                "output_text"
            } else {
                "input_text"
            };
            (
                json!({
                    "type": "message",
                    "role": role,
                    "content": [{"type": content_type, "text": text}],
                }),
                text,
            )
        }
        _ => return Err(format!("Unsupported conversation item type '{kind}'")),
    };
    Ok(ConversationRecord {
        id,
        input,
        public_item,
        text,
        audio_duration_ms: 0,
    })
}

fn extract_item_text(item: &Value) -> String {
    item.get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| {
            part.get("text")
                .or_else(|| part.get("transcript"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn truncate_item(conversation: &Conversation, item_id: &str, audio_end_ms: u64) -> bool {
    let mut items = conversation.lock().await;
    let Some(item) = items.iter_mut().find(|item| item.id == item_id) else {
        return false;
    };
    let keep = (item.text.chars().count() as u64)
        .saturating_mul(audio_end_ms.min(item.audio_duration_ms))
        .checked_div(item.audio_duration_ms)
        .unwrap_or(0) as usize;
    item.text = item.text.chars().take(keep).collect();
    if let Some(text) = item.input.pointer_mut("/content/0/text") {
        *text = Value::String(item.text.clone());
    }
    if let Some(transcript) = item.public_item.pointer_mut("/content/0/transcript") {
        *transcript = Value::String(item.text.clone());
    }
    true
}

#[allow(clippy::too_many_arguments)]
async fn commit_audio(
    state: &EdgeState,
    headers: &HeaderMap,
    application: &str,
    sender: &EventSender,
    conversation: &Conversation,
    options: &SessionOptions,
    audio: &mut Vec<u8>,
    speech_active: &mut bool,
) -> Result<String, String> {
    if audio.is_empty() {
        return Err("The input audio buffer is empty".to_owned());
    }
    let pcm = std::mem::take(audio);
    let audio_duration_ms = (pcm.len() / PCM_BYTES_PER_MILLISECOND) as u64;
    let item_id = new_id("item");
    if *speech_active {
        let _ = sender
            .send(json!({
                "type": "input_audio_buffer.speech_stopped",
                "audio_end_ms": audio_duration_ms,
                "item_id": item_id,
            }))
            .await;
    }
    *speech_active = false;
    let pending_item = json!({
        "id": item_id,
        "object": "realtime.item",
        "type": "message",
        "status": "in_progress",
        "role": "user",
        "content": [{"type": "input_audio", "transcript": Value::Null}],
    });
    let previous_item_id = conversation.lock().await.back().map(|item| item.id.clone());
    let _ = sender
        .send(json!({
            "type": "input_audio_buffer.committed",
            "previous_item_id": previous_item_id,
            "item_id": item_id,
        }))
        .await;
    let _ = sender
        .send(json!({
            "type": "conversation.item.added",
            "previous_item_id": previous_item_id,
            "item": pending_item,
        }))
        .await;
    let transcript = match transcribe(
        state,
        headers,
        application,
        &item_id,
        &pcm,
        options.language.as_deref(),
    )
    .await
    {
        Ok(transcript) => transcript,
        Err(message) => {
            let _ = sender
                .send(json!({
                    "type": "conversation.item.input_audio_transcription.failed",
                    "item_id": item_id,
                    "content_index": 0,
                    "error": {
                        "type": "server_error",
                        "code": "transcription_failed",
                        "message": message,
                    }
                }))
                .await;
            let mut failed_item = pending_item;
            failed_item["status"] = Value::String("incomplete".to_owned());
            let _ = sender
                .send(json!({
                    "type": "conversation.item.done",
                    "previous_item_id": previous_item_id,
                    "item": failed_item,
                }))
                .await;
            return Err(message);
        }
    };
    let completed_item = json!({
        "id": item_id,
        "object": "realtime.item",
        "type": "message",
        "status": "completed",
        "role": "user",
        "content": [{"type": "input_audio", "transcript": transcript}],
    });
    let _ = sender
        .send(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": item_id,
            "content_index": 0,
            "transcript": transcript,
            "usage": Value::Null,
        }))
        .await;
    let _ = sender
        .send(json!({
            "type": "conversation.item.done",
            "previous_item_id": previous_item_id,
            "item": completed_item,
        }))
        .await;
    push_conversation(
        conversation,
        ConversationRecord {
            id: item_id.clone(),
            input: json!({
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": transcript}],
            }),
            public_item: completed_item,
            text: transcript,
            audio_duration_ms,
        },
        state.config.realtime_voice.max_conversation_items,
    )
    .await;
    Ok(item_id)
}

async fn transcribe(
    state: &EdgeState,
    headers: &HeaderMap,
    application: &str,
    request_id: &str,
    pcm: &[u8],
    language: Option<&str>,
) -> Result<String, String> {
    let started_at = now_ms();
    let result = transcribe_inner(state, pcm, language).await;
    record_adapter_trace(
        state,
        headers,
        application,
        request_id,
        "/v1/realtime/stt",
        &state.config.realtime_voice.stt_model,
        started_at,
        &result,
        json!({"audioBytes": pcm.len(), "sampleRate": PCM_SAMPLE_RATE}),
    )
    .await;
    result
}

async fn transcribe_inner(
    state: &EdgeState,
    pcm: &[u8],
    language: Option<&str>,
) -> Result<String, String> {
    let config = &state.config.realtime_voice;
    let url = config
        .stt_url
        .as_deref()
        .ok_or_else(|| "REALTIME_STT_URL is not configured".to_owned())?;
    let part = Part::bytes(pcm16_wav(pcm))
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|error| format!("failed to prepare STT audio: {error}"))?;
    let mut form = Form::new()
        .part("file", part)
        .text("model", config.stt_model.clone())
        .text("response_format", "json");
    if let Some(language) = language.filter(|value| !value.trim().is_empty()) {
        form = form.text("language", language.to_owned());
    }
    let mut request = state.client.post(url).multipart(form);
    if let Some(key) = config.stt_api_key.as_deref() {
        request = request.bearer_auth(key);
    }
    let response = timeout(config.adapter_timeout, request.send())
        .await
        .map_err(|_| "STT request timed out".to_owned())?
        .map_err(|_| "STT endpoint is unavailable".to_owned())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("STT endpoint returned HTTP {}", status.as_u16()));
    }
    let bytes = bounded_response_bytes(response, MAX_STT_RESPONSE_BYTES, "STT").await?;
    let body = serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| "STT endpoint did not return JSON".to_owned())?;
    let transcript = body
        .get("text")
        .or_else(|| body.get("transcript"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "STT endpoint returned an empty transcript".to_owned())?;
    if transcript.len() > MAX_TEXT_BYTES {
        return Err("STT transcript is too large".to_owned());
    }
    Ok(transcript.to_owned())
}

fn pcm16_wav(pcm: &[u8]) -> Vec<u8> {
    let data_len = u32::try_from(pcm.len()).unwrap_or(u32::MAX);
    let byte_rate = PCM_SAMPLE_RATE * u32::from(PCM_CHANNELS) * u32::from(PCM_BITS_PER_SAMPLE) / 8;
    let block_align = PCM_CHANNELS * PCM_BITS_PER_SAMPLE / 8;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&data_len.saturating_add(36).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&PCM_CHANNELS.to_le_bytes());
    wav.extend_from_slice(&PCM_SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&PCM_BITS_PER_SAMPLE.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

#[allow(clippy::too_many_arguments)]
async fn record_adapter_trace<T>(
    state: &EdgeState,
    headers: &HeaderMap,
    application: &str,
    request_id: &str,
    route: &str,
    model: &str,
    started_at: u64,
    result: &Result<T, String>,
    metadata: Value,
) {
    let mut context = build_trace_context(
        state,
        route,
        headers,
        &metadata,
        application,
        request_id,
        model,
        model,
        None,
        route.ends_with("/tts"),
        started_at,
        1,
        1,
        "voice-stage",
    );
    // Voice content is never written to the trace journal, even when the
    // general TRACE_INCLUDE_BODY switch is enabled.
    context.request_body = None;
    context.input_context = None;
    let (status, error) = match result {
        Ok(_) => (StatusCode::OK.as_u16(), None),
        Err(error) if error.contains("timed out") => {
            (StatusCode::GATEWAY_TIMEOUT.as_u16(), Some(error.clone()))
        }
        Err(error) => (StatusCode::BAD_GATEWAY.as_u16(), Some(error.clone())),
    };
    state
        .trace
        .record(
            &context,
            client_trace_outcome(status, now_ms(), error, Some(false)),
        )
        .await;
}

fn pcm_rms(pcm: &[u8]) -> f64 {
    let mut squares = 0_f64;
    let mut count = 0_u64;
    for sample in pcm.as_chunks::<2>().0 {
        let value = f64::from(i16::from_le_bytes([sample[0], sample[1]])) / 32768.0;
        squares += value * value;
        count += 1;
    }
    if count == 0 {
        0.0
    } else {
        (squares / count as f64).sqrt()
    }
}

fn vad_rms_threshold(protocol_threshold: f64) -> f64 {
    // OpenAI's threshold is model-relative. The dependency-free fallback maps
    // it to a conservative normalized PCM RMS range.
    0.005 + protocol_threshold.clamp(0.0, 1.0) * 0.045
}

#[allow(clippy::too_many_arguments)]
async fn start_response(
    active: &mut Option<ActiveResponse>,
    generation_counter: &Arc<AtomicU64>,
    state: &EdgeState,
    headers: &HeaderMap,
    application: &str,
    options: &SessionOptions,
    conversation: &Conversation,
    sender: &EventSender,
    completed_tx: &mpsc::Sender<(u64, String)>,
    response_options: Value,
) {
    let audio = response_options
        .get("output_modalities")
        .or_else(|| response_options.get("modalities"))
        .and_then(Value::as_array)
        .map(|modalities| {
            modalities
                .iter()
                .filter_map(Value::as_str)
                .any(|value| value == "audio")
        })
        .unwrap_or_else(|| {
            options
                .output_modalities
                .iter()
                .any(|value| value == "audio")
        });
    let generation = generation_counter.fetch_add(1, Ordering::AcqRel) + 1;
    let response_id = new_id("resp");
    let item_id = new_id("item");
    let transcript = Arc::new(Mutex::new(String::new()));
    let task = tokio::spawn(run_response(
        state.clone(),
        headers.clone(),
        application.to_owned(),
        options.clone(),
        conversation.clone(),
        sender.for_generation(generation),
        completed_tx.clone(),
        generation,
        response_id.clone(),
        item_id.clone(),
        transcript.clone(),
        response_options,
    ));
    *active = Some(ActiveResponse {
        generation,
        response_id,
        item_id,
        audio,
        transcript,
        handle: task,
    });
}

async fn cancel_active_response(
    active: &mut Option<ActiveResponse>,
    generation_counter: &Arc<AtomicU64>,
    sender: &EventSender,
    reason: &str,
) -> Option<u64> {
    let active_response = active.take()?;
    let cancelled_generation = active_response.generation;
    active_response.handle.abort();
    let generation = generation_counter.fetch_add(1, Ordering::AcqRel) + 1;
    let sender = sender.for_generation(generation);
    let transcript = active_response.transcript.lock().await.clone();
    let item = assistant_item(
        &active_response.item_id,
        &transcript,
        "incomplete",
        active_response.audio,
    );
    if active_response.audio {
        let _ = sender
            .send(json!({
                "type": "response.output_audio.done",
                "response_id": active_response.response_id,
                "item_id": active_response.item_id,
                "output_index": 0,
                "content_index": 0,
            }))
            .await;
        let _ = sender
            .send(json!({
                "type": "response.output_audio_transcript.done",
                "response_id": active_response.response_id,
                "item_id": active_response.item_id,
                "output_index": 0,
                "content_index": 0,
                "transcript": transcript,
            }))
            .await;
    } else {
        let _ = sender
            .send(json!({
                "type": "response.output_text.done",
                "response_id": active_response.response_id,
                "item_id": active_response.item_id,
                "output_index": 0,
                "content_index": 0,
                "text": transcript,
            }))
            .await;
    }
    let _ = sender
        .send(json!({
            "type": "response.output_item.done",
            "response_id": active_response.response_id,
            "output_index": 0,
            "item": item,
        }))
        .await;
    let _ = sender
        .send(json!({
            "type": "response.done",
            "response": {
                "id": active_response.response_id,
                "object": "realtime.response",
                "status": "cancelled",
                "status_details": {"type": "cancelled", "reason": reason},
                "output": [item],
                "usage": Value::Null,
            }
        }))
        .await;
    Some(cancelled_generation)
}

#[allow(clippy::too_many_arguments)]
async fn run_response(
    state: EdgeState,
    mut headers: HeaderMap,
    application: String,
    options: SessionOptions,
    conversation: Conversation,
    sender: EventSender,
    completed_tx: mpsc::Sender<(u64, String)>,
    generation: u64,
    response_id: String,
    item_id: String,
    transcript: Arc<Mutex<String>>,
    response_options: Value,
) {
    let result = run_response_inner(
        &state,
        &mut headers,
        &application,
        &options,
        &conversation,
        &sender,
        &response_id,
        &item_id,
        &transcript,
        &response_options,
    )
    .await;
    if let Err(message) = result {
        let _ = sender
            .send(json!({
                "type": "error",
                "error": {
                    "type": "server_error",
                    "code": "realtime_pipeline_error",
                    "message": message,
                }
            }))
            .await;
        let _ = sender
            .send(json!({
                "type": "response.done",
                "response": {
                    "id": response_id,
                    "object": "realtime.response",
                    "status": "failed",
                    "status_details": {
                        "type": "failed",
                        "error": {
                            "type": "server_error",
                            "code": "realtime_pipeline_error",
                            "message": message,
                        }
                    },
                    "output": [],
                    "usage": Value::Null,
                }
            }))
            .await;
    }
    let _ = completed_tx.send((generation, response_id)).await;
}

#[allow(clippy::too_many_arguments)]
async fn run_response_inner(
    state: &EdgeState,
    headers: &mut HeaderMap,
    application: &str,
    options: &SessionOptions,
    conversation: &Conversation,
    sender: &EventSender,
    response_id: &str,
    item_id: &str,
    transcript: &Arc<Mutex<String>>,
    response_options: &Value,
) -> Result<(), String> {
    let modalities = response_options
        .get("output_modalities")
        .or_else(|| response_options.get("modalities"))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .filter(|values| !values.is_empty())
        .unwrap_or_else(|| options.output_modalities.clone());
    if modalities
        .iter()
        .any(|value| !matches!(value.as_str(), "audio" | "text"))
    {
        return Err("Unsupported response output modality".to_owned());
    }
    let audio_requested = modalities.iter().any(|value| value == "audio");
    let _ = sender
        .send(json!({
            "type": "response.created",
            "response": {
                "id": response_id,
                "object": "realtime.response",
                "status": "in_progress",
                "status_details": Value::Null,
                "output": [],
            }
        }))
        .await;
    let in_progress = assistant_item(item_id, "", "in_progress", audio_requested);
    let previous_item_id = conversation.lock().await.back().map(|item| item.id.clone());
    let _ = sender
        .send(json!({
            "type": "conversation.item.added",
            "previous_item_id": previous_item_id,
            "item": in_progress,
        }))
        .await;
    let _ = sender
        .send(json!({
            "type": "response.output_item.added",
            "response_id": response_id,
            "output_index": 0,
            "item": in_progress,
        }))
        .await;
    let part_type = if audio_requested {
        "audio"
    } else {
        "output_text"
    };
    let _ = sender
        .send(json!({
            "type": "response.content_part.added",
            "response_id": response_id,
            "item_id": item_id,
            "output_index": 0,
            "content_index": 0,
            "part": if audio_requested {
                json!({"type": part_type, "audio": Value::Null, "transcript": ""})
            } else {
                json!({"type": part_type, "text": ""})
            },
        }))
        .await;

    let inputs = if let Some(inputs) = response_options.get("input").and_then(Value::as_array) {
        inputs.clone()
    } else {
        conversation
            .lock()
            .await
            .iter()
            .map(|item| item.input.clone())
            .collect::<Vec<_>>()
    };
    let mut body = json!({
        "model": options.llm_model,
        "input": inputs,
        "stream": true,
    });
    let instructions = raw_string(response_options.get("instructions"))
        .unwrap_or_else(|| options.instructions.clone());
    if instructions.len() > MAX_TEXT_BYTES {
        return Err("Response instructions are too large".to_owned());
    }
    if !instructions.is_empty() {
        body["instructions"] = Value::String(instructions);
    }
    let tools = response_options
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| options.tools.clone());
    if tools.len() > MAX_TOOLS {
        return Err("Too many Realtime tools".to_owned());
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools);
        body["tool_choice"] = response_options
            .get("tool_choice")
            .cloned()
            .unwrap_or_else(|| options.tool_choice.clone());
    }
    headers.insert(
        header::HeaderName::from_static("x-multivibe-session-id"),
        header::HeaderValue::from_str(response_id)
            .map_err(|error| format!("invalid Realtime response id: {error}"))?,
    );
    headers.insert(
        header::HeaderName::from_static("x-multivibe-internal-trace-redact"),
        header::HeaderValue::from_static("1"),
    );

    let (tts_tx, tts_rx) = mpsc::channel::<String>(16);
    let mut tts_tasks = JoinSet::new();
    if audio_requested {
        let state = state.clone();
        let sender = sender.clone();
        let response_id = response_id.to_owned();
        let item_id = item_id.to_owned();
        let trace_headers = headers.clone();
        let trace_application = application.to_owned();
        let voice = response_options
            .get("voice")
            .and_then(Value::as_str)
            .unwrap_or(&options.voice)
            .to_owned();
        if voice.len() > 200 {
            return Err("Voice is too long".to_owned());
        }
        tts_tasks.spawn(async move {
            synthesize_segments(
                state,
                sender,
                trace_headers,
                trace_application,
                response_id,
                item_id,
                voice,
                tts_rx,
            )
            .await
        });
    } else {
        drop(tts_rx);
    }

    let proxy = proxy_inference(
        state,
        "/v1/responses",
        headers,
        &body,
        application,
        Some(ActivityKind::WebsocketTurn),
        None,
    )
    .await
    .map_err(response_error_message)?;
    let mut text = String::new();
    let mut sentence_buffer = String::new();
    let mut usage = Value::Null;
    let mut function_items = Vec::new();
    match proxy {
        ProxyResult::Buffered(reply) => {
            if !reply.status.is_success() {
                return Err(format!("LLM route returned HTTP {}", reply.status.as_u16()));
            }
            let value = serde_json::from_slice::<Value>(&reply.body)
                .map_err(|_| "LLM route returned invalid JSON".to_owned())?;
            consume_buffered_response(
                &value,
                sender,
                response_id,
                item_id,
                transcript,
                &mut text,
                &mut sentence_buffer,
                &tts_tx,
                audio_requested,
                &mut usage,
                &mut function_items,
            )
            .await?;
        }
        ProxyResult::Streaming(mut reply) => {
            let status = reply.status.as_u16();
            let mut transformer =
                SseStreamTransformer::new(reply.transform, &reply.requested_model);
            let mut upstream = reply.upstream.bytes_stream();
            let _capacity_lease = reply.capacity_lease;
            let _activity_lease = reply.activity_lease;
            while let Some(chunk) = upstream.next().await {
                let chunk = chunk.map_err(|error| format!("LLM stream failed: {error}"))?;
                if let Some(trace) = reply.trace.as_mut() {
                    trace.observe(&chunk);
                }
                let transformed = transformer.push(&chunk);
                consume_response_events(
                    parse_sse_events(&transformed),
                    sender,
                    response_id,
                    item_id,
                    transcript,
                    &mut text,
                    &mut sentence_buffer,
                    &tts_tx,
                    audio_requested,
                    &mut usage,
                    &mut function_items,
                )
                .await?;
            }
            let transformed = transformer.finish();
            consume_response_events(
                parse_sse_events(&transformed),
                sender,
                response_id,
                item_id,
                transcript,
                &mut text,
                &mut sentence_buffer,
                &tts_tx,
                audio_requested,
                &mut usage,
                &mut function_items,
            )
            .await?;
            if let Some(trace) = reply.trace.as_mut() {
                trace.finish(status, None, Some(false)).await;
            }
        }
    }
    if audio_requested && !sentence_buffer.trim().is_empty() {
        tts_tx
            .send(std::mem::take(&mut sentence_buffer))
            .await
            .map_err(|_| "TTS worker stopped before the response completed".to_owned())?;
    }
    drop(tts_tx);
    let audio_bytes = if audio_requested {
        match tts_tasks.join_next().await {
            Some(Ok(Ok(bytes))) => bytes,
            Some(Ok(Err(error))) => return Err(error),
            Some(Err(error)) => return Err(format!("TTS worker failed: {error}")),
            None => 0,
        }
    } else {
        0
    };
    let audio_duration_ms = (audio_bytes / PCM_BYTES_PER_MILLISECOND) as u64;
    let completed_item = assistant_item(item_id, &text, "completed", audio_requested);
    if audio_requested {
        let _ = sender
            .send(json!({
                "type": "response.output_audio.done",
                "response_id": response_id,
                "item_id": item_id,
                "output_index": 0,
                "content_index": 0,
            }))
            .await;
        let _ = sender
            .send(json!({
                "type": "response.output_audio_transcript.done",
                "response_id": response_id,
                "item_id": item_id,
                "output_index": 0,
                "content_index": 0,
                "transcript": text,
            }))
            .await;
    } else {
        let _ = sender
            .send(json!({
                "type": "response.output_text.done",
                "response_id": response_id,
                "item_id": item_id,
                "output_index": 0,
                "content_index": 0,
                "text": text,
            }))
            .await;
    }
    let _ = sender
        .send(json!({
            "type": "response.content_part.done",
            "response_id": response_id,
            "item_id": item_id,
            "output_index": 0,
            "content_index": 0,
            "part": if audio_requested {
                json!({"type": "audio", "audio": Value::Null, "transcript": text})
            } else {
                json!({"type": "output_text", "text": text})
            },
        }))
        .await;
    let _ = sender
        .send(json!({
            "type": "response.output_item.done",
            "response_id": response_id,
            "output_index": 0,
            "item": completed_item,
        }))
        .await;
    let _ = sender
        .send(json!({
            "type": "conversation.item.done",
            "previous_item_id": previous_item_id,
            "item": completed_item,
        }))
        .await;
    if !text.is_empty() {
        push_conversation(
            conversation,
            ConversationRecord {
                id: item_id.to_owned(),
                input: json!({
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": text}],
                }),
                public_item: completed_item.clone(),
                text: text.clone(),
                audio_duration_ms,
            },
            state.config.realtime_voice.max_conversation_items,
        )
        .await;
    }
    for function_item in &function_items {
        let id = value_string(function_item.get("id")).unwrap_or_else(|| new_id("item"));
        push_conversation(
            conversation,
            ConversationRecord {
                id,
                input: function_item.clone(),
                public_item: function_item.clone(),
                text: String::new(),
                audio_duration_ms: 0,
            },
            state.config.realtime_voice.max_conversation_items,
        )
        .await;
    }
    let mut output = vec![completed_item];
    output.extend(function_items);
    let _ = sender
        .send(json!({
            "type": "response.done",
            "response": {
                "id": response_id,
                "object": "realtime.response",
                "status": "completed",
                "status_details": Value::Null,
                "output": output,
                "usage": usage,
            }
        }))
        .await;
    Ok(())
}

fn assistant_item(id: &str, text: &str, status: &str, audio: bool) -> Value {
    json!({
        "id": id,
        "object": "realtime.item",
        "type": "message",
        "status": status,
        "role": "assistant",
        "content": if audio {
            json!([{"type": "audio", "audio": Value::Null, "transcript": text}])
        } else {
            json!([{"type": "output_text", "text": text}])
        },
    })
}

fn response_error_message(response: Response) -> String {
    format!("LLM route returned HTTP {}", response.status().as_u16())
}

#[allow(clippy::too_many_arguments)]
async fn consume_buffered_response(
    response: &Value,
    sender: &EventSender,
    response_id: &str,
    item_id: &str,
    transcript: &Arc<Mutex<String>>,
    text: &mut String,
    sentence_buffer: &mut String,
    tts_tx: &mpsc::Sender<String>,
    audio_requested: bool,
    usage: &mut Value,
    function_items: &mut Vec<Value>,
) -> Result<(), String> {
    if let Some(output) = response.get("output").and_then(Value::as_array) {
        for item in output {
            if item.get("type").and_then(Value::as_str) == Some("function_call") {
                function_items.push(item.clone());
            }
            if let Some(content) = item.get("content").and_then(Value::as_array) {
                for part in content {
                    if let Some(delta) = part.get("text").and_then(Value::as_str) {
                        emit_text_delta(
                            delta,
                            sender,
                            response_id,
                            item_id,
                            transcript,
                            text,
                            sentence_buffer,
                            tts_tx,
                            audio_requested,
                        )
                        .await?;
                    }
                }
            }
        }
    }
    if let Some(value) = response.get("usage") {
        *usage = value.clone();
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn consume_response_events(
    events: Vec<(String, Value)>,
    sender: &EventSender,
    response_id: &str,
    item_id: &str,
    transcript: &Arc<Mutex<String>>,
    text: &mut String,
    sentence_buffer: &mut String,
    tts_tx: &mpsc::Sender<String>,
    audio_requested: bool,
    usage: &mut Value,
    function_items: &mut Vec<Value>,
) -> Result<(), String> {
    for (_, event) in events {
        if event.as_str() == Some("[DONE]") {
            continue;
        }
        match event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "response.output_text.delta" => {
                let delta = raw_string(event.get("delta")).unwrap_or_default();
                emit_text_delta(
                    &delta,
                    sender,
                    response_id,
                    item_id,
                    transcript,
                    text,
                    sentence_buffer,
                    tts_tx,
                    audio_requested,
                )
                .await?;
            }
            "response.output_item.added" => {
                if event
                    .get("item")
                    .and_then(|item| item.get("type"))
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind == "function_call" || kind == "custom_tool_call")
                {
                    let _ = sender
                        .send(external_response_event(event, response_id))
                        .await;
                }
            }
            "response.function_call_arguments.delta"
            | "response.function_call_arguments.done"
            | "response.custom_tool_call_input.delta"
            | "response.custom_tool_call_input.done" => {
                let _ = sender
                    .send(external_response_event(event, response_id))
                    .await;
            }
            "response.output_item.done" => {
                if let Some(item) = event.get("item")
                    && item
                        .get("type")
                        .and_then(Value::as_str)
                        .is_some_and(|kind| kind == "function_call" || kind == "custom_tool_call")
                {
                    function_items.push(item.clone());
                    let _ = sender
                        .send(external_response_event(event, response_id))
                        .await;
                }
            }
            "response.completed" | "response.done" => {
                if let Some(value) = event.pointer("/response/usage") {
                    *usage = value.clone();
                }
                if let Some(output) = event.pointer("/response/output").and_then(Value::as_array) {
                    for item in output {
                        if item
                            .get("type")
                            .and_then(Value::as_str)
                            .is_some_and(|kind| {
                                kind == "function_call" || kind == "custom_tool_call"
                            })
                            && !function_items
                                .iter()
                                .any(|existing| existing.get("id") == item.get("id"))
                        {
                            function_items.push(item.clone());
                        }
                    }
                }
            }
            "response.failed" | "error" => {
                return Err(event
                    .pointer("/response/error/message")
                    .or_else(|| event.pointer("/error/message"))
                    .and_then(Value::as_str)
                    .unwrap_or("LLM response failed")
                    .to_owned());
            }
            _ => {}
        }
    }
    Ok(())
}

fn external_response_event(mut event: Value, response_id: &str) -> Value {
    event["response_id"] = Value::String(response_id.to_owned());
    event
}

#[allow(clippy::too_many_arguments)]
async fn emit_text_delta(
    delta: &str,
    sender: &EventSender,
    response_id: &str,
    item_id: &str,
    transcript: &Arc<Mutex<String>>,
    text: &mut String,
    sentence_buffer: &mut String,
    tts_tx: &mpsc::Sender<String>,
    audio_requested: bool,
) -> Result<(), String> {
    if delta.is_empty() {
        return Ok(());
    }
    if text.len().saturating_add(delta.len()) > MAX_TEXT_BYTES {
        return Err("LLM response text exceeded the Realtime limit".to_owned());
    }
    text.push_str(delta);
    transcript.lock().await.push_str(delta);
    if audio_requested {
        let _ = sender
            .send(json!({
                "type": "response.output_audio_transcript.delta",
                "response_id": response_id,
                "item_id": item_id,
                "output_index": 0,
                "content_index": 0,
                "delta": delta,
            }))
            .await;
        sentence_buffer.push_str(delta);
        for segment in take_speakable_segments(sentence_buffer, false) {
            tts_tx
                .send(segment)
                .await
                .map_err(|_| "TTS worker stopped unexpectedly".to_owned())?;
        }
    } else {
        let _ = sender
            .send(json!({
                "type": "response.output_text.delta",
                "response_id": response_id,
                "item_id": item_id,
                "output_index": 0,
                "content_index": 0,
                "delta": delta,
            }))
            .await;
    }
    Ok(())
}

fn take_speakable_segments(buffer: &mut String, force: bool) -> Vec<String> {
    let mut boundaries = Vec::new();
    let mut last = 0_usize;
    for (index, character) in buffer.char_indices() {
        let end = index + character.len_utf8();
        let span = &buffer[last..end];
        let sentence_end = matches!(character, '.' | '!' | '?' | ';' | ':' | '\n');
        if (sentence_end && span.trim().chars().count() >= 24) || span.chars().count() >= 320 {
            boundaries.push(end);
            last = end;
        }
    }
    if force && last < buffer.len() {
        boundaries.push(buffer.len());
    }
    let mut segments = Vec::new();
    let mut start = 0;
    for end in boundaries {
        let segment = buffer[start..end].trim();
        if !segment.is_empty() {
            segments.push(segment.to_owned());
        }
        start = end;
    }
    if start > 0 {
        buffer.drain(..start);
    }
    segments
}

#[allow(clippy::too_many_arguments)]
async fn synthesize_segments(
    state: EdgeState,
    sender: EventSender,
    headers: HeaderMap,
    application: String,
    response_id: String,
    item_id: String,
    voice: String,
    mut segments: mpsc::Receiver<String>,
) -> Result<usize, String> {
    let mut total = 0_usize;
    while let Some(segment) = segments.recv().await {
        let remaining = state
            .config
            .realtime_voice
            .max_audio_bytes
            .saturating_sub(total);
        if remaining == 0 {
            return Err("TTS output exceeded the configured audio limit".to_owned());
        }
        total = total.saturating_add(
            synthesize_segment(
                &state,
                &sender,
                &headers,
                &application,
                &response_id,
                &item_id,
                &voice,
                &segment,
                remaining,
            )
            .await?,
        );
    }
    Ok(total)
}

#[allow(clippy::too_many_arguments)]
async fn synthesize_segment(
    state: &EdgeState,
    sender: &EventSender,
    headers: &HeaderMap,
    application: &str,
    response_id: &str,
    item_id: &str,
    voice: &str,
    text: &str,
    max_bytes: usize,
) -> Result<usize, String> {
    let started_at = now_ms();
    let result =
        synthesize_segment_inner(state, sender, response_id, item_id, voice, text, max_bytes).await;
    record_adapter_trace(
        state,
        headers,
        application,
        response_id,
        "/v1/realtime/tts",
        &state.config.realtime_voice.tts_model,
        started_at,
        &result,
        json!({"textCharacters": text.chars().count(), "voice": voice}),
    )
    .await;
    result
}

async fn synthesize_segment_inner(
    state: &EdgeState,
    sender: &EventSender,
    response_id: &str,
    item_id: &str,
    voice: &str,
    text: &str,
    max_bytes: usize,
) -> Result<usize, String> {
    let config = &state.config.realtime_voice;
    let url = config
        .tts_url
        .as_deref()
        .ok_or_else(|| "REALTIME_TTS_URL is not configured".to_owned())?;
    let mut request = state.client.post(url).json(&json!({
        "model": config.tts_model,
        "input": text,
        "voice": voice,
        "response_format": config.tts_response_format,
    }));
    if let Some(key) = config.tts_api_key.as_deref() {
        request = request.bearer_auth(key);
    }
    let response = timeout(config.adapter_timeout, request.send())
        .await
        .map_err(|_| "TTS request timed out".to_owned())?
        .map_err(|_| "TTS endpoint is unavailable".to_owned())?;
    if !response.status().is_success() {
        return Err(format!(
            "TTS endpoint returned HTTP {}",
            response.status().as_u16()
        ));
    }
    if config.tts_response_format == "wav" {
        let bytes =
            bounded_response_bytes(response, max_bytes.saturating_add(64 * 1024), "TTS").await?;
        let pcm = wav_pcm_data(&bytes)?;
        if pcm.len() > max_bytes {
            return Err("TTS output exceeded the configured audio limit".to_owned());
        }
        emit_audio_chunks(sender, response_id, item_id, pcm).await;
        return Ok(pcm.len());
    }
    let mut stream = response.bytes_stream();
    let mut total = 0_usize;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "TTS stream failed".to_owned())?;
        if chunk.is_empty() {
            continue;
        }
        if total.saturating_add(chunk.len()) > max_bytes {
            return Err("TTS output exceeded the configured audio limit".to_owned());
        }
        total = total.saturating_add(chunk.len());
        emit_audio_chunks(sender, response_id, item_id, &chunk).await;
    }
    if total == 0 {
        return Err("TTS endpoint returned no audio".to_owned());
    }
    Ok(total)
}

async fn bounded_response_bytes(
    response: reqwest::Response,
    limit: usize,
    stage: &str,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(format!("{stage} response exceeded its size limit"));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| format!("failed to read {stage} response"))?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(format!("{stage} response exceeded its size limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn emit_audio_chunks(sender: &EventSender, response_id: &str, item_id: &str, pcm: &[u8]) {
    for chunk in pcm.chunks(4_800) {
        let _ = sender
            .send(json!({
                "type": "response.output_audio.delta",
                "response_id": response_id,
                "item_id": item_id,
                "output_index": 0,
                "content_index": 0,
                "delta": STANDARD.encode(chunk),
            }))
            .await;
    }
}

fn wav_pcm_data(bytes: &[u8]) -> Result<&[u8], String> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("TTS endpoint did not return a WAV file".to_owned());
    }
    let mut offset = 12_usize;
    while offset.saturating_add(8) <= bytes.len() {
        let size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        let data_start = offset + 8;
        let data_end = data_start.saturating_add(size);
        if data_end > bytes.len() {
            return Err("TTS WAV response is truncated".to_owned());
        }
        if &bytes[offset..offset + 4] == b"data" {
            return Ok(&bytes[data_start..data_end]);
        }
        offset = data_end.saturating_add(size % 2);
    }
    Err("TTS WAV response has no data chunk".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        response::IntoResponse,
        routing::{get, post},
    };
    use futures_util::{SinkExt, StreamExt};
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering as AtomicOrdering},
    };
    use tokio::net::TcpListener;
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{Message as ClientMessage, client::IntoClientRequest},
    };

    #[test]
    fn wav_wraps_pcm16_at_24khz() {
        let pcm = vec![0_u8, 1, 2, 3];
        let wav = pcm16_wav(&pcm);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 24_000);
        assert_eq!(wav_pcm_data(&wav).unwrap(), pcm);
    }

    #[test]
    fn sentence_chunker_preserves_unfinished_suffix() {
        let mut text = "Une phrase suffisamment longue se termine ici. Suite incomplète".to_owned();
        let chunks = take_speakable_segments(&mut text, false);
        assert_eq!(chunks, ["Une phrase suffisamment longue se termine ici."]);
        assert_eq!(text, " Suite incomplète");
        let chunks = take_speakable_segments(&mut text, true);
        assert_eq!(chunks, ["Suite incomplète"]);
        assert!(text.is_empty());
    }

    #[test]
    fn session_rejects_semantic_vad_without_backend() {
        let mut session = SessionOptions::new(
            &Config::default(),
            "multivibe/voice".to_owned(),
            "local-model".to_owned(),
        );
        let error = session
            .update(&json!({
                "audio": {"input": {"turn_detection": {"type": "semantic_vad"}}}
            }))
            .unwrap_err();
        assert!(error.contains("semantic_vad"));
    }

    #[test]
    fn ephemeral_tokens_are_stored_as_digests() {
        assert_ne!(digest_secret("ek_secret"), "ek_secret");
        assert_eq!(digest_secret("ek_secret"), digest_secret("ek_secret"));
    }

    #[tokio::test]
    async fn ephemeral_tokens_are_model_bound_and_reusable_until_expiry() {
        let store = SecretStore::default();
        let session = json!({
            "type": "realtime",
            "model": "multivibe/voice",
            "instructions": "Secret-scoped instructions",
        });
        let (token, _) = store
            .issue(
                "app-a".to_owned(),
                "multivibe/voice".to_owned(),
                session.clone(),
                Duration::from_secs(60),
            )
            .await;
        assert!(store.resolve(&token, "another-model").await.is_none());
        let first = store.resolve(&token, "multivibe/voice").await.unwrap();
        assert_eq!(first.auth.application, "app-a");
        assert_eq!(first.session, session);
        let second = store.resolve(&token, "multivibe/voice").await.unwrap();
        assert!(second.session["instructions"] == "Secret-scoped instructions");
    }

    #[tokio::test]
    async fn cancellation_advances_generation_and_emits_cancelled_response() {
        let (tx, mut rx) = mpsc::channel(16);
        let sender = EventSender {
            tx,
            generation: None,
        };
        let generation = Arc::new(AtomicU64::new(4));
        let transcript = Arc::new(Mutex::new("réponse partielle".to_owned()));
        let mut active = Some(ActiveResponse {
            generation: 4,
            response_id: "resp_test".to_owned(),
            item_id: "item_test".to_owned(),
            audio: true,
            transcript,
            handle: tokio::spawn(async {
                tokio::time::sleep(Duration::from_secs(60)).await;
            }),
        });

        cancel_active_response(&mut active, &generation, &sender, "client_cancelled").await;

        assert!(active.is_none());
        assert_eq!(generation.load(Ordering::Acquire), 5);
        let mut done = None;
        while let Ok(outbound) = rx.try_recv() {
            assert_eq!(outbound.generation, Some(5));
            if outbound.value["type"] == "response.done" {
                done = Some(outbound.value);
            }
        }
        let done = done.expect("response.done");
        assert_eq!(done["response"]["status"], "cancelled");
        assert_eq!(
            done["response"]["output"][0]["content"][0]["transcript"],
            "réponse partielle"
        );
    }

    #[tokio::test]
    async fn function_events_keep_calls_but_use_the_external_response_id() {
        let (tx, mut rx) = mpsc::channel(16);
        let sender = EventSender {
            tx,
            generation: Some(2),
        };
        let transcript = Arc::new(Mutex::new(String::new()));
        let mut text = String::new();
        let mut sentence = String::new();
        let (tts_tx, _tts_rx) = mpsc::channel(1);
        let mut usage = Value::Null;
        let mut functions = Vec::new();
        let item = json!({
            "id": "fc_upstream",
            "type": "function_call",
            "call_id": "call_stable",
            "name": "lookup",
            "arguments": "{\"city\":\"Paris\"}",
        });
        consume_response_events(
            vec![
                (
                    "response.output_item.added".to_owned(),
                    json!({
                        "type": "response.output_item.added",
                        "response_id": "upstream",
                        "output_index": 0,
                        "item": item,
                    }),
                ),
                (
                    "response.output_item.done".to_owned(),
                    json!({
                        "type": "response.output_item.done",
                        "response_id": "upstream",
                        "output_index": 0,
                        "item": item,
                    }),
                ),
            ],
            &sender,
            "resp_external",
            "item_external",
            &transcript,
            &mut text,
            &mut sentence,
            &tts_tx,
            false,
            &mut usage,
            &mut functions,
        )
        .await
        .unwrap();

        let first = rx.recv().await.unwrap();
        let second = rx.recv().await.unwrap();
        assert_eq!(first.value["response_id"], "resp_external");
        assert_eq!(second.value["response_id"], "resp_external");
        assert_eq!(functions[0]["call_id"], "call_stable");
    }

    fn temporary_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("multivibe-{label}-{}", new_id("test")))
    }

    async fn start(router: Router) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (format!("http://{address}"), task)
    }

    async fn next_event<S>(socket: &mut S) -> Value
    where
        S: StreamExt<
                Item = Result<
                    tokio_tungstenite::tungstenite::Message,
                    tokio_tungstenite::tungstenite::Error,
                >,
            > + Unpin,
    {
        let message = timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("Realtime event timed out")
            .expect("Realtime socket closed")
            .expect("Realtime WebSocket error");
        match message {
            ClientMessage::Text(value) => serde_json::from_str(&value).unwrap(),
            other => panic!("expected text event, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn websocket_pipeline_uses_stt_multivibe_router_and_tts() {
        let stt_calls = Arc::new(AtomicUsize::new(0));
        let tts_calls = Arc::new(AtomicUsize::new(0));
        let llm_calls = Arc::new(AtomicUsize::new(0));
        let adapters = Router::new()
            .route(
                "/v1/models",
                get(|| async {
                    Json(json!({"object": "list", "data": [{"id": "voice-llm"}]}))
                }),
            )
            .route(
                "/v1/audio/transcriptions",
                post({
                    let calls = stt_calls.clone();
                    move || {
                        let calls = calls.clone();
                        async move {
                            calls.fetch_add(1, AtomicOrdering::SeqCst);
                            Json(json!({"text": "Bonjour du micro"}))
                        }
                    }
                }),
            )
            .route(
                "/v1/audio/speech",
                post({
                    let calls = tts_calls.clone();
                    move || {
                        let calls = calls.clone();
                        async move {
                            calls.fetch_add(1, AtomicOrdering::SeqCst);
                            (
                                [(header::CONTENT_TYPE, "application/octet-stream")],
                                vec![7_u8; 960],
                            )
                        }
                    }
                }),
            )
            .route(
                "/v1/responses",
                post({
                    let calls = llm_calls.clone();
                    move || {
                        let calls = calls.clone();
                        async move {
                            calls.fetch_add(1, AtomicOrdering::SeqCst);
                            (
                                [(header::CONTENT_TYPE, "text/event-stream")],
                                concat!(
                                    "event: response.created\n",
                                    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"upstream\",\"model\":\"voice-llm\",\"status\":\"in_progress\"}}\n\n",
                                    "event: response.output_text.delta\n",
                                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Bonjour du pipeline vocal.\"}\n\n",
                                    "event: response.completed\n",
                                    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"upstream\",\"model\":\"voice-llm\",\"status\":\"completed\",\"output\":[{\"id\":\"msg_upstream\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Bonjour du pipeline vocal.\"}]}],\"usage\":{\"input_tokens\":3,\"output_tokens\":5,\"total_tokens\":8}}}\n\n",
                                    "data: [DONE]\n\n",
                                ),
                            )
                                .into_response()
                        }
                    }
                }),
            );
        let (adapter_url, adapter_task) = start(adapters).await;
        let store_path = temporary_path("realtime-store");
        let jobs_path = temporary_path("realtime-jobs");
        let trace_path = temporary_path("realtime-trace");
        let store = crate::StoreFile {
            accounts: vec![crate::Account {
                id: "voice-account".to_owned(),
                provider: Some("openai-compatible".to_owned()),
                upstream_mode: Some("responses".to_owned()),
                access_token: "provider-key".to_owned(),
                base_url: Some(adapter_url.clone()),
                enabled: true,
                ..Default::default()
            }],
            ..Default::default()
        };
        tokio::fs::write(&store_path, serde_json::to_vec(&store).unwrap())
            .await
            .unwrap();
        let config = crate::EdgeConfig {
            store_path: store_path.clone(),
            jobs_path: jobs_path.clone(),
            legacy_jobs_db_path: None,
            models_cache_path: None,
            configured_api_keys: vec![("voice-test".to_owned(), "voice-key".to_owned())],
            proxy_models: vec!["voice-llm".to_owned()],
            max_upstream_retries: 0,
            upstream_timeout: Duration::from_secs(5),
            trace_path: Some(trace_path.clone()),
            trace_include_body: true,
            realtime_voice: Config {
                enabled: true,
                llm_model: Some("voice-llm".to_owned()),
                stt_url: Some(format!("{adapter_url}/v1/audio/transcriptions")),
                tts_url: Some(format!("{adapter_url}/v1/audio/speech")),
                adapter_timeout: Duration::from_secs(5),
                ..Config::default()
            },
            ..Default::default()
        };
        let state = crate::EdgeState::new(config).await.unwrap();
        let (edge_url, edge_task) = start(crate::build_router(state)).await;

        let models = reqwest::Client::new()
            .get(format!("{edge_url}/v1/models"))
            .bearer_auth("voice-key")
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert!(models["data"].as_array().unwrap().iter().any(|model| {
            model["id"] == "multivibe/voice" && model["metadata"]["execution"] == "cascaded"
        }));

        let mut request = format!(
            "{}/v1/realtime?model=multivibe%2Fvoice",
            edge_url.replace("http://", "ws://")
        )
        .into_client_request()
        .unwrap();
        request.headers_mut().insert(
            header::AUTHORIZATION,
            header::HeaderValue::from_static("Bearer voice-key"),
        );
        let (mut socket, _) = connect_async(request).await.unwrap();
        assert_eq!(next_event(&mut socket).await["type"], "session.created");
        socket
            .send(ClientMessage::Text(
                json!({
                    "type": "session.update",
                    "session": {
                        "turn_detection": Value::Null,
                        "output_modalities": ["audio"],
                    }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        assert_eq!(next_event(&mut socket).await["type"], "session.updated");
        socket
            .send(ClientMessage::Text(
                json!({
                    "type": "input_audio_buffer.append",
                    "audio": STANDARD.encode(vec![0_u8; 960]),
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        socket
            .send(ClientMessage::Text(
                json!({"type": "input_audio_buffer.commit"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        loop {
            let event = next_event(&mut socket).await;
            if event["type"] == "conversation.item.input_audio_transcription.completed" {
                assert_eq!(event["transcript"], "Bonjour du micro");
                break;
            }
        }
        socket
            .send(ClientMessage::Text(
                json!({"type": "response.create"}).to_string().into(),
            ))
            .await
            .unwrap();
        let mut saw_transcript = false;
        let mut saw_audio = false;
        loop {
            let event = next_event(&mut socket).await;
            match event["type"].as_str().unwrap_or_default() {
                "response.output_audio_transcript.delta" => {
                    saw_transcript = true;
                    assert_eq!(event["delta"], "Bonjour du pipeline vocal.");
                }
                "response.output_audio.delta" => {
                    saw_audio = true;
                    assert!(!event["delta"].as_str().unwrap().is_empty());
                }
                "response.done" => {
                    assert_eq!(event["response"]["status"], "completed");
                    assert_eq!(event["response"]["usage"]["total_tokens"], 8);
                    break;
                }
                _ => {}
            }
        }
        assert!(saw_transcript);
        assert!(saw_audio);
        assert_eq!(stt_calls.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(tts_calls.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(llm_calls.load(AtomicOrdering::SeqCst), 1);
        let traces = tokio::fs::read_to_string(&trace_path).await.unwrap();
        assert!(traces.contains("/v1/realtime/stt"));
        assert!(traces.contains("/v1/realtime/tts"));
        assert!(!traces.contains("Bonjour du micro"));
        assert!(!traces.contains("Bonjour du pipeline vocal"));

        socket.close(None).await.unwrap();
        let secret = reqwest::Client::new()
            .post(format!("{edge_url}/v1/realtime/client_secrets"))
            .bearer_auth("voice-key")
            .json(&json!({
                "expires_after": {"anchor": "created_at", "seconds": 30},
                "session": {
                    "type": "realtime",
                    "model": "multivibe/voice",
                    "instructions": "Secret-scoped instructions",
                    "turn_detection": Value::Null,
                }
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(secret.status(), StatusCode::OK);
        let secret = secret.json::<Value>().await.unwrap();
        assert_eq!(
            secret["session"]["instructions"],
            "Secret-scoped instructions"
        );
        let secret = secret["value"].as_str().unwrap().to_owned();
        let secret_url = format!(
            "{}/v1/realtime?model=multivibe%2Fvoice&client_secret={secret}",
            edge_url.replace("http://", "ws://")
        );
        let (mut ephemeral_socket, _) = connect_async(&secret_url).await.unwrap();
        let created = next_event(&mut ephemeral_socket).await;
        assert_eq!(created["type"], "session.created");
        assert_eq!(
            created["session"]["instructions"],
            "Secret-scoped instructions"
        );
        ephemeral_socket.close(None).await.unwrap();
        let (mut reused_socket, _) = connect_async(&secret_url).await.unwrap();
        assert_eq!(
            next_event(&mut reused_socket).await["type"],
            "session.created"
        );
        reused_socket.close(None).await.unwrap();

        edge_task.abort();
        adapter_task.abort();
        let _ = tokio::fs::remove_file(store_path).await;
        let _ = tokio::fs::remove_file(jobs_path).await;
        let _ = tokio::fs::remove_file(trace_path).await;
    }
}
