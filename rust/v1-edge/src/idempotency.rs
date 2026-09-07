use axum::http::{HeaderMap, StatusCode};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bytes::Bytes;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, broadcast};

pub(crate) const STATUS_HEADER: &str = "x-multivibe-idempotency-status";

const SEMANTIC_REQUEST_HEADERS: &[&str] = &[
    "anthropic-version",
    "anthropic-beta",
    "openai-beta",
    "session_id",
    "session-id",
    "x-session-id",
    "x-session_id",
    "thread-id",
    "x-codex-turn-state",
];

#[derive(Clone, Debug)]
pub(crate) struct StoredResponse {
    pub status: StatusCode,
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
}

impl StoredResponse {
    pub(crate) fn new(
        status: StatusCode,
        headers: &[(String, String)],
        body: Bytes,
    ) -> Self {
        Self {
            status,
            headers: headers
                .iter()
                .filter(|(name, _)| should_replay_header(name))
                .cloned()
                .collect(),
            body,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Options {
    pub ttl: Duration,
    pub in_flight_timeout: Duration,
    pub max_entries: usize,
    pub max_bytes: usize,
    pub max_response_bytes: usize,
}

#[derive(Clone)]
pub(crate) struct Cache {
    inner: Arc<Mutex<CacheState>>,
    options: Options,
}

#[derive(Default)]
struct CacheState {
    entries: HashMap<String, Entry>,
    completed_bytes: usize,
    next_id: u64,
    next_order: u64,
}

struct Entry {
    request_hash: String,
    expires_at: u64,
    order: u64,
    state: EntryState,
}

enum EntryState {
    InFlight {
        id: u64,
        sender: broadcast::Sender<Option<StoredResponse>>,
    },
    Completed {
        response: StoredResponse,
        size: usize,
    },
    Seen,
}

pub(crate) enum Claim {
    Leader(Leader),
    Follower(Follower),
    Replay(StoredResponse),
    Conflict,
    Bypass,
}

pub(crate) struct Follower {
    receiver: broadcast::Receiver<Option<StoredResponse>>,
}

impl Follower {
    pub(crate) async fn wait(mut self) -> Option<StoredResponse> {
        self.receiver.recv().await.ok().flatten()
    }
}

pub(crate) struct Leader {
    cache: Cache,
    scope: String,
    request_hash: String,
    id: u64,
    sender: broadcast::Sender<Option<StoredResponse>>,
    active: bool,
}

impl Leader {
    pub(crate) async fn complete(mut self, response: StoredResponse) {
        self.cache
            .complete_entry(
                &self.scope,
                &self.request_hash,
                self.id,
                &self.sender,
                response,
            )
            .await;
        self.active = false;
    }

    pub(crate) async fn fail(mut self) {
        self.cache
            .fail_entry(
                &self.scope,
                &self.request_hash,
                self.id,
                &self.sender,
            )
            .await;
        self.active = false;
    }
}

impl Drop for Leader {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let cache = self.cache.clone();
        let scope = self.scope.clone();
        let request_hash = self.request_hash.clone();
        let id = self.id;
        let sender = self.sender.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                cache
                    .fail_entry(&scope, &request_hash, id, &sender)
                    .await;
            });
        }
    }
}

impl Cache {
    pub(crate) fn new(options: Options) -> Self {
        Self {
            inner: Arc::new(Mutex::new(CacheState::default())),
            options: Options {
                ttl: options.ttl,
                in_flight_timeout: options.in_flight_timeout,
                max_entries: options.max_entries.max(1),
                max_bytes: options.max_bytes,
                max_response_bytes: options.max_response_bytes,
            },
        }
    }

    pub(crate) async fn claim(&self, scope: String, request_hash: String) -> Claim {
        let now = now_ms();
        let mut state = self.inner.lock().await;
        evict_expired(&mut state, now);

        if let Some(mut existing) = state.entries.remove(&scope) {
            if existing.request_hash != request_hash {
                state.entries.insert(scope, existing);
                return Claim::Conflict;
            }
            match &existing.state {
                EntryState::Completed { response, .. } => {
                    let response = response.clone();
                    state.next_order = state.next_order.wrapping_add(1);
                    existing.order = state.next_order;
                    state.entries.insert(scope, existing);
                    return Claim::Replay(response);
                }
                EntryState::InFlight { sender, .. } => {
                    let follower = Follower {
                        receiver: sender.subscribe(),
                    };
                    state.entries.insert(scope, existing);
                    return Claim::Follower(follower);
                }
                EntryState::Seen => {}
            }
        }

        while state.entries.len() >= self.options.max_entries {
            let Some(oldest) = oldest_evictable_scope(&state, false) else {
                return Claim::Bypass;
            };
            remove_entry(&mut state, &oldest, false);
        }

        state.next_id = state.next_id.wrapping_add(1);
        state.next_order = state.next_order.wrapping_add(1);
        let id = state.next_id;
        let order = state.next_order;
        let expires_at = now.saturating_add(duration_ms(self.options.in_flight_timeout));
        let (sender, _) = broadcast::channel(1);
        state.entries.insert(
            scope.clone(),
            Entry {
                request_hash: request_hash.clone(),
                expires_at,
                order,
                state: EntryState::InFlight {
                    id,
                    sender: sender.clone(),
                },
            },
        );
        drop(state);

        let cache = self.clone();
        let expiry_scope = scope.clone();
        tokio::spawn(async move {
            tokio::time::sleep(cache.options.in_flight_timeout).await;
            cache.expire_in_flight(&expiry_scope, id).await;
        });

        Claim::Leader(Leader {
            cache: self.clone(),
            scope,
            request_hash,
            id,
            sender,
            active: true,
        })
    }

    async fn complete_entry(
        &self,
        scope: &str,
        request_hash: &str,
        id: u64,
        sender: &broadcast::Sender<Option<StoredResponse>>,
        response: StoredResponse,
    ) {
        let cacheable = response.body.len() <= self.options.max_response_bytes
            && response.body.len() <= self.options.max_bytes
            && is_cacheable_completed_response(&response);
        let mut state = self.inner.lock().await;
        if is_current_in_flight(&state, scope, id) {
            remove_entry(&mut state, scope, false);
            state.next_order = state.next_order.wrapping_add(1);
            let order = state.next_order;
            let expires_at = now_ms().saturating_add(duration_ms(self.options.ttl));
            if cacheable {
                while state.completed_bytes.saturating_add(response.body.len())
                    > self.options.max_bytes
                {
                    let Some(oldest) = oldest_evictable_scope(&state, true) else {
                        break;
                    };
                    remove_entry(&mut state, &oldest, false);
                }
            }
            if cacheable
                && state.completed_bytes.saturating_add(response.body.len())
                    <= self.options.max_bytes
            {
                let size = response.body.len();
                state.completed_bytes = state.completed_bytes.saturating_add(size);
                state.entries.insert(
                    scope.to_owned(),
                    Entry {
                        request_hash: request_hash.to_owned(),
                        expires_at,
                        order,
                        state: EntryState::Completed {
                            response: response.clone(),
                            size,
                        },
                    },
                );
            } else {
                state.entries.insert(
                    scope.to_owned(),
                    Entry {
                        request_hash: request_hash.to_owned(),
                        expires_at,
                        order,
                        state: EntryState::Seen,
                    },
                );
            }
        }
        drop(state);
        let _ = sender.send(Some(response));
    }

    async fn fail_entry(
        &self,
        scope: &str,
        request_hash: &str,
        id: u64,
        sender: &broadcast::Sender<Option<StoredResponse>>,
    ) {
        let mut state = self.inner.lock().await;
        if is_current_in_flight(&state, scope, id) {
            remove_entry(&mut state, scope, false);
            state.next_order = state.next_order.wrapping_add(1);
            let order = state.next_order;
            state.entries.insert(
                scope.to_owned(),
                Entry {
                    request_hash: request_hash.to_owned(),
                    expires_at: now_ms().saturating_add(duration_ms(self.options.ttl)),
                    order,
                    state: EntryState::Seen,
                },
            );
        }
        drop(state);
        let _ = sender.send(None);
    }

    async fn expire_in_flight(&self, scope: &str, id: u64) {
        let mut state = self.inner.lock().await;
        if !is_current_in_flight(&state, scope, id) {
            return;
        }
        remove_entry(&mut state, scope, true);
    }

    #[cfg(test)]
    async fn counts(&self) -> (usize, usize) {
        let mut state = self.inner.lock().await;
        evict_expired(&mut state, now_ms());
        (state.entries.len(), state.completed_bytes)
    }
}

fn is_current_in_flight(state: &CacheState, scope: &str, id: u64) -> bool {
    matches!(
        state.entries.get(scope).map(|entry| &entry.state),
        Some(EntryState::InFlight { id: current, .. }) if *current == id
    )
}

fn evict_expired(state: &mut CacheState, now: u64) {
    let expired = state
        .entries
        .iter()
        .filter_map(|(scope, entry)| (entry.expires_at <= now).then(|| scope.clone()))
        .collect::<Vec<_>>();
    for scope in expired {
        remove_entry(state, &scope, true);
    }
}

fn oldest_evictable_scope(state: &CacheState, completed_only: bool) -> Option<String> {
    state
        .entries
        .iter()
        .filter(|(_, entry)| match &entry.state {
            EntryState::InFlight { .. } => false,
            EntryState::Completed { .. } => true,
            EntryState::Seen => !completed_only,
        })
        .min_by_key(|(_, entry)| entry.order)
        .map(|(scope, _)| scope.clone())
}

fn remove_entry(state: &mut CacheState, scope: &str, notify_in_flight: bool) {
    let Some(entry) = state.entries.remove(scope) else {
        return;
    };
    match entry.state {
        EntryState::Completed { size, .. } => {
            state.completed_bytes = state.completed_bytes.saturating_sub(size);
        }
        EntryState::InFlight { sender, .. } if notify_in_flight => {
            let _ = sender.send(None);
        }
        _ => {}
    }
}

pub(crate) fn normalized_route(path: &str) -> Option<&str> {
    let route = path.strip_prefix("/v1").unwrap_or(path);
    matches!(route, "/responses" | "/chat/completions" | "/messages").then_some(route)
}

pub(crate) fn scope(application: &str, route: &str, key: &str) -> String {
    format!("{application}\0{route}\0{key}")
}

pub(crate) fn request_hash(body: &Value, headers: &HeaderMap) -> String {
    let semantic_headers = SEMANTIC_REQUEST_HEADERS
        .iter()
        .filter_map(|name| {
            headers
                .get(*name)
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| ((*name).to_owned(), Value::String(value.to_owned())))
        })
        .collect::<Map<_, _>>();
    let serialized = serde_json::to_vec(&json!({
        "body": body,
        "headers": semantic_headers,
    }))
    .unwrap_or_default();
    URL_SAFE_NO_PAD.encode(Sha256::digest(serialized))
}

pub(crate) fn is_eligible_body(body: &Value) -> bool {
    let Some(payload) = body.as_object() else {
        return false;
    };
    if payload.get("stream") == Some(&Value::Bool(true))
        || payload.get("background") == Some(&Value::Bool(true))
        || payload.get("store") == Some(&Value::Bool(true))
    {
        return false;
    }
    if value_is_present(payload.get("previous_response_id"))
        || value_is_present(payload.get("conversation"))
    {
        return false;
    }
    if non_empty_array(payload.get("tools")) || non_empty_array(payload.get("functions")) {
        return false;
    }
    if let Some(choice) = payload.get("tool_choice").filter(|value| !value.is_null())
        && choice != "none"
        && choice != "auto"
    {
        return false;
    }
    if payload
        .get("modalities")
        .and_then(Value::as_array)
        .is_some_and(|values| values.iter().any(|value| value.as_str() != Some("text")))
    {
        return false;
    }
    !contains_unsafe_request_content(body)
}

fn contains_unsafe_request_content(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(contains_unsafe_request_content),
        Value::Object(object) => {
            let unsafe_type = object
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_ascii_lowercase)
                .is_some_and(|kind| {
                    [
                        "image",
                        "audio",
                        "file",
                        "function",
                        "custom_tool",
                        "computer",
                        "web_search",
                        "mcp",
                        "reasoning",
                        "compaction",
                    ]
                    .iter()
                    .any(|unsafe_kind| kind.contains(unsafe_kind))
                });
            if unsafe_type
                || matches!(
                    object.get("role").and_then(Value::as_str),
                    Some("tool" | "function")
                )
            {
                return true;
            }
            for key in [
                "image_url",
                "input_audio",
                "audio",
                "file_id",
                "file_data",
                "attachments",
                "tool_calls",
                "function_call",
            ] {
                if let Some(candidate) = object.get(key).filter(|value| !value.is_null())
                    && candidate.as_array().is_none_or(|values| !values.is_empty())
                {
                    return true;
                }
            }
            object.values().any(contains_unsafe_request_content)
        }
        _ => false,
    }
}

fn is_cacheable_completed_response(response: &StoredResponse) -> bool {
    if !response.status.is_success() || response.status == StatusCode::ACCEPTED {
        return false;
    }
    if !response.headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("content-type")
            && value.to_ascii_lowercase().contains("json")
    }) {
        return false;
    }
    let Ok(parsed) = serde_json::from_slice::<Value>(&response.body) else {
        return false;
    };
    let Some(object) = parsed.as_object() else {
        return false;
    };
    if value_is_present(object.get("error"))
        || value_is_present(object.get("incomplete_details"))
        || object
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| {
                matches!(
                    status,
                    "failed" | "incomplete" | "in_progress" | "queued" | "cancelled"
                )
            })
    {
        return false;
    }
    !contains_unsafe_response_content(&parsed) && !contains_partial_terminal_reason(&parsed)
}

fn contains_unsafe_response_content(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(contains_unsafe_response_content),
        Value::Object(object) => {
            let unsafe_type = object
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_ascii_lowercase)
                .is_some_and(|kind| {
                    [
                        "function",
                        "custom_tool",
                        "computer",
                        "web_search",
                        "mcp",
                        "reasoning",
                        "compaction",
                    ]
                    .iter()
                    .any(|unsafe_kind| kind.contains(unsafe_kind))
                });
            unsafe_type
                || non_empty_array(object.get("tool_calls"))
                || value_is_present(object.get("function_call"))
                || value_is_present(object.get("encrypted_content"))
                || object.get("finish_reason").and_then(Value::as_str) == Some("tool_calls")
                || object.values().any(contains_unsafe_response_content)
        }
        _ => false,
    }
}

fn contains_partial_terminal_reason(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(contains_partial_terminal_reason),
        Value::Object(object) => {
            object.get("finish_reason").and_then(Value::as_str) == Some("length")
                || object.get("stop_reason").and_then(Value::as_str) == Some("max_tokens")
                || object.values().any(contains_partial_terminal_reason)
        }
        _ => false,
    }
}

fn should_replay_header(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "content-type" | "request-id" | "openai-request-id" | "anthropic-request-id"
    ) || (normalized.starts_with("x-multivibe-") && normalized != STATUS_HEADER)
}

fn value_is_present(value: Option<&Value>) -> bool {
    value.is_some_and(|value| !value.is_null())
}

fn non_empty_array(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .is_some_and(|values| !values.is_empty())
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().min(u64::MAX as u128) as u64
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> Options {
        Options {
            ttl: Duration::from_secs(60),
            in_flight_timeout: Duration::from_secs(60),
            max_entries: 10,
            max_bytes: 1024,
            max_response_bytes: 1024,
        }
    }

    fn response(id: &str, padding: usize) -> StoredResponse {
        StoredResponse::new(
            StatusCode::OK,
            &[
                ("content-type".to_owned(), "application/json".to_owned()),
                ("x-multivibe-decision".to_owned(), "cloud".to_owned()),
                (STATUS_HEADER.to_owned(), "created".to_owned()),
                ("set-cookie".to_owned(), "private".to_owned()),
            ],
            Bytes::from(
                serde_json::to_vec(&json!({"id": id, "output": "x".repeat(padding)}))
                    .unwrap(),
            ),
        )
    }

    #[test]
    fn scope_does_not_contain_the_payload_hash_and_hash_is_canonical() {
        let headers = HeaderMap::new();
        let first = json!({"model": "test", "input": {"b": 2, "a": 1}});
        let reordered = json!({"input": {"a": 1, "b": 2}, "model": "test"});
        assert_eq!(scope("app", "/responses", "key"), "app\0/responses\0key");
        assert_eq!(request_hash(&first, &headers), request_hash(&reordered, &headers));
        assert_ne!(request_hash(&first, &headers), request_hash(&json!({"input": "other"}), &headers));
    }

    #[tokio::test]
    async fn one_leader_coalesces_followers_then_replays() {
        let cache = Cache::new(options());
        let scope = "app\0/responses\0key".to_owned();
        let hash = "hash".to_owned();
        let leader = match cache.claim(scope.clone(), hash.clone()).await {
            Claim::Leader(leader) => leader,
            _ => panic!("expected leader"),
        };
        let follower = match cache.claim(scope.clone(), hash.clone()).await {
            Claim::Follower(follower) => follower,
            _ => panic!("expected follower"),
        };
        let expected = response("one", 0);
        leader.complete(expected.clone()).await;
        assert_eq!(follower.wait().await.unwrap().body, expected.body);
        match cache.claim(scope, hash).await {
            Claim::Replay(replayed) => {
                assert_eq!(replayed.body, expected.body);
                assert!(replayed.headers.iter().any(|(name, _)| name == "x-multivibe-decision"));
                assert!(!replayed.headers.iter().any(|(name, _)| name == STATUS_HEADER));
                assert!(!replayed.headers.iter().any(|(name, _)| name == "set-cookie"));
            }
            _ => panic!("expected replay"),
        }
    }

    #[tokio::test]
    async fn same_scope_with_a_different_payload_conflicts_even_after_failure() {
        let cache = Cache::new(options());
        let scope = "app\0/responses\0key".to_owned();
        let leader = match cache.claim(scope.clone(), "first".to_owned()).await {
            Claim::Leader(leader) => leader,
            _ => panic!("expected leader"),
        };
        assert!(matches!(
            cache.claim(scope.clone(), "different".to_owned()).await,
            Claim::Conflict
        ));
        leader.fail().await;
        assert!(matches!(
            cache.claim(scope.clone(), "different".to_owned()).await,
            Claim::Conflict
        ));
        assert!(matches!(
            cache.claim(scope, "first".to_owned()).await,
            Claim::Leader(_)
        ));
    }

    #[tokio::test]
    async fn in_flight_timeout_releases_followers_and_elects_a_replacement() {
        let mut configured = options();
        configured.in_flight_timeout = Duration::from_millis(20);
        let cache = Cache::new(configured);
        let scope = "app\0/responses\0key".to_owned();
        let leader = match cache.claim(scope.clone(), "hash".to_owned()).await {
            Claim::Leader(leader) => leader,
            _ => panic!("expected leader"),
        };
        let follower = match cache.claim(scope.clone(), "hash".to_owned()).await {
            Claim::Follower(follower) => follower,
            _ => panic!("expected follower"),
        };
        assert!(follower.wait().await.is_none());
        assert!(matches!(
            cache.claim(scope, "hash".to_owned()).await,
            Claim::Leader(_)
        ));
        drop(leader);
    }

    #[tokio::test]
    async fn entry_and_byte_limits_evict_only_retained_entries() {
        let mut configured = options();
        configured.max_entries = 2;
        configured.max_bytes = 90;
        configured.max_response_bytes = 90;
        let cache = Cache::new(configured);

        let seen = match cache.claim("seen".to_owned(), "seen-hash".to_owned()).await {
            Claim::Leader(leader) => leader,
            _ => panic!("expected leader"),
        };
        seen.fail().await;

        for key in ["first", "second"] {
            let leader = match cache.claim(key.to_owned(), key.to_owned()).await {
                Claim::Leader(leader) => leader,
                _ => panic!("expected leader"),
            };
            leader.complete(response(key, 35)).await;
        }

        let (entries, bytes) = cache.counts().await;
        assert!(entries <= 2);
        assert!(bytes <= 90);
        assert!(matches!(
            cache.claim("second".to_owned(), "second".to_owned()).await,
            Claim::Replay(_)
        ));
    }

    #[tokio::test]
    async fn byte_eviction_preserves_seen_key_conflicts() {
        let mut configured = options();
        configured.max_bytes = 80;
        configured.max_response_bytes = 80;
        let cache = Cache::new(configured);

        let seen = match cache
            .claim("seen".to_owned(), "original-hash".to_owned())
            .await
        {
            Claim::Leader(leader) => leader,
            _ => panic!("expected leader"),
        };
        seen.fail().await;

        for key in ["cached-a", "cached-b"] {
            let leader = match cache.claim(key.to_owned(), key.to_owned()).await {
                Claim::Leader(leader) => leader,
                _ => panic!("expected leader"),
            };
            leader.complete(response(key, 35)).await;
        }

        assert!(matches!(
            cache
                .claim("seen".to_owned(), "different-hash".to_owned())
                .await,
            Claim::Conflict
        ));
        assert!(matches!(
            cache
                .claim("cached-b".to_owned(), "cached-b".to_owned())
                .await,
            Claim::Replay(_)
        ));
        assert!(matches!(
            cache
                .claim("cached-a".to_owned(), "cached-a".to_owned())
                .await,
            Claim::Leader(_)
        ));
    }

    #[tokio::test]
    async fn all_in_flight_entries_make_new_keys_bypass() {
        let mut configured = options();
        configured.max_entries = 1;
        let cache = Cache::new(configured);
        let _leader = match cache.claim("first".to_owned(), "hash".to_owned()).await {
            Claim::Leader(leader) => leader,
            _ => panic!("expected leader"),
        };
        assert!(matches!(
            cache.claim("second".to_owned(), "hash".to_owned()).await,
            Claim::Bypass
        ));
    }

    #[test]
    fn eligibility_rejects_stateful_and_multimodal_requests() {
        assert!(is_eligible_body(&json!({"model": "test", "input": "hello"})));
        assert!(!is_eligible_body(&json!({"model": "test", "stream": true})));
        assert!(!is_eligible_body(&json!({
            "model": "test",
            "input": [{"type": "input_image", "image_url": "data:image/png;base64,AA=="}]
        })));
        assert!(!is_eligible_body(&json!({
            "model": "test",
            "tools": [{"type": "function", "name": "lookup"}]
        })));
    }
}
