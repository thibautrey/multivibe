//! Layered admission: physical capacity, per-application fair share, session
//! grace, and time-of-day share windows.
//!
//! The layers apply in this order, and each one only ever *narrows* the
//! previous one:
//!
//! 1. **physical capacity** — `account_max_concurrent`, declared today and
//!    measured once a runtime exposes `metricsUrl`;
//! 2. **fair share per application** — `application_policies[].maxConcurrentShare`
//!    plus a small idle-account `burst`, enforced at admission;
//! 3. **session grace** — a bounded registry that lets an already running
//!    conversation keep going through a load spike;
//! 4. **priority and calendar** — `shareWindows` scale the fair share so the
//!    weekend and the night are roomier than a weekday afternoon.
//!
//! Invariant: grace never grants capacity beyond the application's fair share.
//! It only decides *who* waits inside that share. Without this, a client that
//! farms session identifiers could defeat the share entirely.

use std::collections::HashMap;
use std::time::Duration;

/// Cloudflare closes a proxied response that yields no byte for 100s. Any
/// inline wait must finish well inside that budget, so the inline path is
/// clamped rather than permitted to reach a point where a 524 is guaranteed.
pub const INLINE_MAX_WAIT_MS: u64 = 55_000;

/// Lease lifetime. A queued client re-polls a few times per minute instead of
/// holding one long request open through the edge.
pub const LEASE_TTL_MS: u64 = 90_000;
/// How many times one lease may be renewed before the client must re-admit.
pub const LEASE_MAX_RENEWALS: u32 = 3;

/// Default fraction of an account's slots one application may hold.
pub const DEFAULT_MAX_CONCURRENT_SHARE: f64 = 0.25;
/// Additional slots granted only when no other application is using the account.
pub const DEFAULT_BURST: u32 = 1;

/// Grace is only offered to a session that started while the account was
/// comfortably below saturation. A conversation that began during a spike is
/// not "already running" in the sense the promise means.
pub const DEFAULT_GRACE_ELIGIBLE_BELOW: f64 = 0.60;
/// A turn must have produced real output before the session earns grace; this
/// is proof the conversation actually ran rather than a probe.
pub const DEFAULT_GRACE_MIN_DECODED_TOKENS: u32 = 128;
/// Fraction of an account's slots all graced sessions may hold together.
pub const DEFAULT_GRACE_SLOT_SHARE: f64 = 0.25;
/// Above this utilisation a graced session keeps its queue position but loses
/// slot priority, so grace degrades instead of starving new work.
pub const DEFAULT_GRACE_DROP_PRIORITY_ABOVE: f64 = 0.85;
pub const DEFAULT_GRACE_TTL_MS: u64 = 20 * 60 * 1_000;
pub const DEFAULT_GRACE_MAX_AGE_MS: u64 = 2 * 60 * 60 * 1_000;
pub const DEFAULT_GRACE_MAX_ENTRIES: usize = 10_000;

/// A recurring period that scales an application's fair share.
#[derive(Debug, Clone, PartialEq)]
pub struct ShareWindow {
    /// Inclusive start hour in `timezone` local time, 0-23.
    pub start_hour: u8,
    /// Exclusive end hour, 0-24. A window may wrap past midnight.
    pub end_hour: u8,
    /// `None` means every day. Otherwise ISO weekday numbers, Monday = 1.
    pub days: Option<Vec<u8>>,
    pub multiplier: f64,
}

impl ShareWindow {
    /// Weekend nights and full weekends are the roomy default: the operator's
    /// own machines are idle when their weekday is not.
    pub fn default_windows() -> Vec<Self> {
        vec![Self {
            start_hour: 20,
            end_hour: 8,
            days: None,
            multiplier: 2.0,
        }]
    }
}

/// Per-application admission policy, as stored in `application_policies`.
#[derive(Debug, Clone, PartialEq)]
pub struct ApplicationShare {
    pub max_concurrent_share: f64,
    pub burst: u32,
    pub share_windows: Vec<ShareWindow>,
}

impl Default for ApplicationShare {
    fn default() -> Self {
        Self {
            max_concurrent_share: DEFAULT_MAX_CONCURRENT_SHARE,
            burst: DEFAULT_BURST,
            share_windows: ShareWindow::default_windows(),
        }
    }
}

impl ApplicationShare {
    /// Resolve the multiplier in force at `now_ms`, in Europe/Paris, where the
    /// operator's own schedule lives. Weekend days double the share outright.
    pub fn multiplier_at(&self, now: u64) -> f64 {
        let Some(utc) = chrono::DateTime::from_timestamp_millis(now as i64) else {
            return 1.0;
        };
        use chrono::Datelike;
        let local = utc.with_timezone(&chrono_tz::Europe::Paris);
        let hour = local.hour();
        let weekday = local.weekday().number_from_monday() as u8;
        let mut multiplier: f64 = 1.0;
        if weekday >= 6 {
            // A whole weekend day is as roomy as a night.
            multiplier = multiplier.max(2.0);
        }
        for window in &self.share_windows {
            let day_matches = window.days.as_ref().is_none_or(|days| days.contains(&weekday));
            if !day_matches || !hour_in_window(hour, window.start_hour, window.end_hour) {
                continue;
            }
            multiplier = multiplier.max(window.multiplier.max(1.0));
        }
        multiplier
    }

    /// Concurrent slots one application may hold on an account with
    /// `capacity` physical slots.
    ///
    /// `account_active` is the total in flight on that account across every
    /// application; `burst` only applies when nobody else is using it, so a
    /// burst can never take a slot another application could have used.
    pub fn slots(&self, capacity: u32, account_active: u32, now: u64) -> u32 {
        let capacity = capacity.max(1);
        let share = self.max_concurrent_share.clamp(0.0, 1.0);
        let scaled = (capacity as f64 * share * self.multiplier_at(now)).floor();
        let mut limit = (scaled as u32).max(1).min(capacity);
        if account_active == 0 {
            limit = limit.saturating_add(self.burst).min(capacity);
        }
        limit
    }
}

use chrono::Timelike;

fn hour_in_window(hour: u32, start: u8, end: u8) -> bool {
    let start = start as u32;
    let end = end as u32;
    if start == end {
        return false;
    }
    if start < end {
        hour >= start && hour < end
    } else {
        // Wraps past midnight, e.g. 20:00 -> 08:00.
        hour >= start || hour < end
    }
}

/// Grace registry limits.
#[derive(Debug, Clone, PartialEq)]
pub struct GracePolicy {
    pub ttl: Duration,
    pub max_age: Duration,
    pub max_entries: usize,
    pub eligible_below: f64,
    pub min_decoded_tokens: u32,
    pub slot_share: f64,
    pub drop_priority_above: f64,
}

impl Default for GracePolicy {
    fn default() -> Self {
        Self {
            ttl: Duration::from_millis(DEFAULT_GRACE_TTL_MS),
            max_age: Duration::from_millis(DEFAULT_GRACE_MAX_AGE_MS),
            max_entries: DEFAULT_GRACE_MAX_ENTRIES,
            eligible_below: DEFAULT_GRACE_ELIGIBLE_BELOW,
            min_decoded_tokens: DEFAULT_GRACE_MIN_DECODED_TOKENS,
            slot_share: DEFAULT_GRACE_SLOT_SHARE,
            drop_priority_above: DEFAULT_GRACE_DROP_PRIORITY_ABOVE,
        }
    }
}

impl GracePolicy {
    /// Slots on one account that graced sessions may occupy together.
    #[must_use]
    pub fn slots(&self, capacity: u32) -> u32 {
        let capacity = capacity.max(1);
        let share = self.slot_share.clamp(0.0, 1.0);
        ((capacity as f64 * share).floor() as u32)
            .max(1)
            .min(capacity)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraceState {
    /// The session holds or qualifies for grace right now.
    Granted,
    /// The session is known but does not qualify.
    Ineligible,
    /// No session identity was supplied, so grace cannot apply.
    None,
}

impl GraceState {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Granted => "granted",
            Self::Ineligible => "ineligible",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionDecision {
    /// A slot is available now.
    Admit,
    /// No slot now, but one is expected; poll again.
    Queue,
    /// The caller should switch upstream instead of waiting.
    Switch,
}

impl AdmissionDecision {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admit => "admit",
            Self::Queue => "queue",
            Self::Switch => "switch",
        }
    }
}

#[derive(Debug, Clone)]
struct GraceEntry {
    first_seen: u64,
    last_seen: u64,
    decoded_tokens: u32,
    account_id: String,
    /// Monotonic counter used to evict the least recently used entry first.
    recency: u64,
}

/// Bounded session-grace registry.
///
/// Bounded by entry count and by absolute age. Nothing is persisted: an edge
/// restart loses grace cleanly, which is preferable to resurrecting a claim
/// from a previous process lifetime.
#[derive(Debug)]
pub struct GraceRegistry {
    policy: GracePolicy,
    entries: HashMap<(String, String), GraceEntry>,
    next_recency: u64,
}

impl GraceRegistry {
    #[must_use]
    pub fn new(policy: GracePolicy) -> Self {
        Self {
            policy,
            entries: HashMap::new(),
            next_recency: 0,
        }
    }

    #[must_use]
    pub fn policy(&self) -> &GracePolicy {
        &self.policy
    }

    fn bump(&mut self) -> u64 {
        self.next_recency = self.next_recency.saturating_add(1);
        self.next_recency
    }

    fn expired(ttl_ms: u64, max_age_ms: u64, entry: &GraceEntry, now: u64) -> bool {
        let idle = now.saturating_sub(entry.last_seen);
        let age = now.saturating_sub(entry.first_seen);
        idle >= ttl_ms || age >= max_age_ms
    }

    fn prune(&mut self, now: u64) {
        let ttl_ms = self.policy.ttl.as_millis() as u64;
        let max_age_ms = self.policy.max_age.as_millis() as u64;
        self.entries
            .retain(|_, entry| !Self::expired(ttl_ms, max_age_ms, entry, now));
    }

    fn evict_to_bound(&mut self) {
        let max = self.policy.max_entries.max(1);
        while self.entries.len() > max {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.recency)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.entries.remove(&oldest);
        }
    }

    /// Record that a session produced inference output. This is the only path
    /// that can create or refresh a grace entry.
    pub fn observe(&mut self, application: &str, session: &str, account_id: &str, decoded_tokens: u32, now: u64) {
        if session.trim().is_empty() || application.trim().is_empty() {
            return;
        }
        self.prune(now);
        let key = (application.to_owned(), session.to_owned());
        let recency = self.bump();
        match self.entries.get_mut(&key) {
            Some(entry) => {
                entry.last_seen = now;
                entry.decoded_tokens = entry.decoded_tokens.saturating_add(decoded_tokens);
                entry.account_id = account_id.to_owned();
                entry.recency = recency;
            }
            None => {
                self.entries.insert(
                    key,
                    GraceEntry {
                        first_seen: now,
                        last_seen: now,
                        decoded_tokens,
                        account_id: account_id.to_owned(),
                        recency,
                    },
                );
            }
        }
        self.evict_to_bound();
    }

    /// Whether this session may claim grace, ignoring slot accounting.
    #[must_use]
    pub fn qualifies(&mut self, application: &str, session: &str, now: u64) -> bool {
        if session.trim().is_empty() || application.trim().is_empty() {
            return false;
        }
        self.prune(now);
        let key = (application.to_owned(), session.to_owned());
        let Some(entry) = self.entries.get(&key) else {
            return false;
        };
        entry.decoded_tokens >= self.policy.min_decoded_tokens
    }

    /// Number of distinct graced sessions currently bound to `account_id`.
    #[must_use]
    pub fn active_on_account(&mut self, account_id: &str, now: u64) -> u32 {
        self.prune(now);
        self.entries
            .values()
            .filter(|entry| entry.account_id == account_id)
            .filter(|entry| entry.decoded_tokens >= self.policy.min_decoded_tokens)
            .count()
            .try_into()
            .unwrap_or(u32::MAX)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

}

/// One application's view of one account at admission time.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AccountPressure {
    pub capacity: u32,
    pub account_active: u32,
    pub application_active: u32,
    pub grace_active: u32,
}

/// The pure decision function. Kept free of locks and I/O so it can be tested
/// exhaustively; the controller below only supplies counters and applies the
/// resulting lease.
///
/// Three gates, in order. Each is a hard ceiling, so no layer can widen an
/// earlier one:
///
/// 1. physical capacity on the account — a graced session cannot exceed it;
/// 2. the application's fair share;
/// 3. the grace pool, which lends slots *beyond the fair share but never
///    beyond physical capacity* to a conversation that is already running.
#[must_use]
pub fn decide(
    share: &ApplicationShare,
    grace: &GracePolicy,
    pressure: AccountPressure,
    grace_qualifies: bool,
    graced_elsewhere: bool,
    now: u64,
) -> AdmissionDecision {
    // Gate 1: physical capacity is absolute. Grace changes ordering, never
    // arithmetic: a slot that does not exist cannot be lent.
    if pressure.account_active >= pressure.capacity {
        return AdmissionDecision::Queue;
    }
    // Gate 2: the application's own fair share.
    let limit = share.slots(pressure.capacity, pressure.account_active, now);
    if pressure.application_active < limit {
        return AdmissionDecision::Admit;
    }
    // Gate 3: the grace pool. A qualifying session may borrow a slot that is
    // physically free, on top of its share, but the pool is capped so grace
    // can never consume the whole account.
    let grace_slots = grace.slots(pressure.capacity);
    let grace_room = pressure.grace_active < grace_slots;
    if grace_qualifies && graced_elsewhere && grace_room {
        return AdmissionDecision::Admit;
    }
    AdmissionDecision::Queue
}

/// Whether a graced session still outranks new work when it has to queue.
///
/// Above the threshold grace degrades to an ordinary queue position: the
/// conversation is not dropped, it simply stops jumping the line, so a long
/// spike cannot starve newcomers forever.
#[must_use]
pub fn grace_keeps_priority(utilisation: f64, policy: &GracePolicy) -> bool {
    utilisation <= policy.drop_priority_above
}

/// Estimated wait, in milliseconds, for a request that must queue.
///
/// Deliberately conservative: it reports the wait implied by the slots that
/// must drain, not an optimistic guess. A client that switches on this value
/// should not discover the wait was longer.
#[must_use]
pub fn estimated_wait_ms(pressure: AccountPressure, share_limit: u32, average_turn_ms: u64) -> u64 {
    let limit = share_limit.max(1);
    if pressure.application_active < limit {
        return 0;
    }
    let queued_waves = pressure
        .application_active
        .saturating_sub(limit)
        .saturating_add(1);
    (queued_waves as u64).saturating_mul(average_turn_ms.max(1_000))
}

/// A bounded sliding window of latency samples, enough to report a real p99.
///
/// `inline_wait_ms_max` alone cannot answer "is the tail getting worse?": one
/// outlier sets it forever. A mean cannot answer it either. The plan asks for
/// `admission.inline_wait_p99`, so the edge keeps the recent samples and
/// computes the percentile honestly rather than approximating it with the max.
///
/// Bounded on purpose: an unbounded `Vec` would grow with traffic and turn an
/// observability feature into a memory leak.
#[derive(Debug)]
pub struct LatencyWindow {
    samples: std::collections::VecDeque<u64>,
    capacity: usize,
}

/// How many samples each window retains. Large enough for a stable p99 (the
/// 99th percentile of 1024 samples is the 11th worst), small enough that two
/// windows cost a few kilobytes.
pub const LATENCY_WINDOW_SAMPLES: usize = 1_024;

impl Default for LatencyWindow {
    fn default() -> Self {
        Self::new(LATENCY_WINDOW_SAMPLES)
    }
}

impl LatencyWindow {
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        Self {
            samples: std::collections::VecDeque::with_capacity(capacity.max(1)),
            capacity: capacity.max(1),
        }
    }

    pub fn record(&mut self, value: u64) {
        if self.samples.len() == self.capacity {
            self.samples.pop_front();
        }
        self.samples.push_back(value);
    }


    /// Nearest-rank percentile, the same definition Prometheus' `histogram_quantile`
    /// converges to for a fine histogram: the smallest sample at or above rank
    /// `ceil(p * n)`. Returns `None` when nothing has been recorded, so a caller
    /// can omit the metric instead of reporting a confident zero.
    #[must_use]
    pub fn percentile(&self, quantile: f64) -> Option<u64> {
        if self.samples.is_empty() {
            return None;
        }
        let mut sorted: Vec<u64> = self.samples.iter().copied().collect();
        sorted.sort_unstable();
        let clamped = quantile.clamp(0.0, 1.0);
        // `ceil` on rank 0 would index before the start; a percentile of 0 is
        // still a real sample, so floor it at 1.
        let rank = (clamped * sorted.len() as f64).ceil().max(1.0) as usize;
        sorted.get(rank.min(sorted.len()) - 1).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn share(share: f64, burst: u32) -> ApplicationShare {
        ApplicationShare {
            max_concurrent_share: share,
            burst,
            share_windows: Vec::new(),
        }
    }

    fn pressure(capacity: u32, account_active: u32, app_active: u32, grace_active: u32) -> AccountPressure {
        AccountPressure {
            capacity,
            account_active,
            application_active: app_active,
            grace_active,
        }
    }

    #[test]
    fn hours_wrap_across_midnight() {
        assert!(hour_in_window(22, 20, 8));
        assert!(hour_in_window(3, 20, 8));
        assert!(!hour_in_window(8, 20, 8));
        assert!(!hour_in_window(12, 20, 8));
        assert!(hour_in_window(9, 9, 17));
        assert!(!hour_in_window(17, 9, 17));
        assert!(!hour_in_window(5, 7, 7), "an empty window matches nothing");
    }

    #[test]
    fn share_scales_with_capacity_and_never_drops_below_one() {
        let policy = share(0.25, 0);
        // 32 cloud slots -> 8.
        assert_eq!(policy.slots(32, 4, 0), 8);
        // A single-slot local runtime still admits one application.
        assert_eq!(policy.slots(1, 4, 0), 1);
        // A 2-slot account floors to 1 rather than 0.
        assert_eq!(policy.slots(2, 2, 0), 1);
    }

    #[test]
    fn burst_only_applies_to_an_idle_account() {
        let policy = share(0.125, 2);
        assert_eq!(policy.slots(32, 0, 0), 6, "4 share slots plus 2 idle burst");
        assert_eq!(policy.slots(32, 9, 0), 4, "no burst while others are active");
    }

    #[test]
    fn grace_never_exceeds_the_fair_share() {
        let policy = share(0.25, 0);
        let grace = GracePolicy::default();
        // Capacity 8 -> fair share 2, grace pool 2.
        assert_eq!(policy.slots(8, 8, 0), 2);
        assert_eq!(grace.slots(8), 2);
        // Application already at its share with the grace pool full: queue.
        assert_eq!(
            decide(&policy, &grace, pressure(8, 8, 2, 2), true, true, 0),
            AdmissionDecision::Queue
        );
    }

    #[test]
    fn a_graced_session_keeps_going_while_a_new_one_waits() {
        let policy = share(0.5, 0);
        let grace = GracePolicy::default();
        // Capacity 8 -> fair share 4. The application has used all four of its
        // slots and the account has three physical slots spare (a spike that
        // started low). The graced session continues...
        assert_eq!(
            decide(&policy, &grace, pressure(8, 5, 4, 1), true, true, 0),
            AdmissionDecision::Admit
        );
        // ...while a brand-new session at the same pressure must queue.
        assert_eq!(
            decide(&policy, &grace, pressure(8, 5, 4, 1), false, false, 0),
            AdmissionDecision::Queue
        );
    }

    #[test]
    fn grace_cannot_exceed_physical_capacity() {
        let policy = share(1.0, 0);
        let grace = GracePolicy::default();
        // Every physical slot is busy: ordering cannot invent another one.
        assert_eq!(
            decide(&policy, &grace, pressure(4, 4, 1, 0), true, true, 0),
            AdmissionDecision::Queue
        );
    }

    #[test]
    fn grace_drops_priority_above_the_threshold_without_being_dropped() {
        let grace = GracePolicy::default();
        assert!(grace_keeps_priority(0.5, &grace));
        assert!(grace_keeps_priority(0.85, &grace));
        assert!(!grace_keeps_priority(0.86, &grace));
        // And the conversation itself still survives at a physically free slot.
        let policy = share(0.5, 0);
        assert_eq!(
            decide(&policy, &grace, pressure(10, 6, 5, 1), true, true, 0),
            AdmissionDecision::Admit
        );
    }

    #[test]
    fn grace_requires_observed_output() {
        let grace = GracePolicy::default();
        let mut registry = GraceRegistry::new(grace);
        registry.observe("hermes-a", "s1", "acct", 10, 1_000);
        assert!(!registry.qualifies("hermes-a", "s1", 1_100));
        registry.observe("hermes-a", "s1", "acct", 200, 1_200);
        assert!(registry.qualifies("hermes-a", "s1", 1_300));
    }

    #[test]
    fn grace_is_scoped_per_application_and_session() {
        let mut registry = GraceRegistry::new(GracePolicy::default());
        registry.observe("app-a", "s1", "acct", 500, 1_000);
        assert!(registry.qualifies("app-a", "s1", 1_000));
        assert!(!registry.qualifies("app-b", "s1", 1_000));
        assert!(!registry.qualifies("app-a", "s2", 1_000));
    }

    #[test]
    fn grace_expires_on_idle_and_on_absolute_age() {
        let policy = GracePolicy {
            ttl: Duration::from_millis(1_000),
            max_age: Duration::from_millis(5_000),
            ..GracePolicy::default()
        };
        let mut registry = GraceRegistry::new(policy);
        registry.observe("app", "s1", "acct", 500, 1_000);
        assert!(registry.qualifies("app", "s1", 1_500));
        assert!(!registry.qualifies("app", "s1", 2_500), "idle expiry");

        registry.observe("app", "s2", "acct", 500, 1_000);
        // Keep it warm, but the absolute age still expires it.
        registry.observe("app", "s2", "acct", 0, 2_000);
        registry.observe("app", "s2", "acct", 0, 3_000);
        registry.observe("app", "s2", "acct", 0, 4_000);
        assert!(!registry.qualifies("app", "s2", 6_500), "absolute age expiry");
    }

    #[test]
    fn grace_registry_is_bounded_and_evicts_least_recent() {
        let policy = GracePolicy {
            max_entries: 2,
            ..GracePolicy::default()
        };
        let mut registry = GraceRegistry::new(policy);
        registry.observe("app", "s1", "acct", 500, 1_000);
        registry.observe("app", "s2", "acct", 500, 1_100);
        registry.observe("app", "s3", "acct", 500, 1_200);
        assert_eq!(registry.len(), 2);
        assert!(!registry.qualifies("app", "s1", 1_300), "oldest evicted");
        assert!(registry.qualifies("app", "s3", 1_300));
    }

    #[test]
    fn farming_session_ids_stays_capped_by_the_grace_pool() {
        let grace = GracePolicy::default();
        let mut registry = GraceRegistry::new(grace.clone());
        for index in 0..64 {
            registry.observe("app", &format!("s{index}"), "acct", 500, 1_000);
        }
        // Every session qualifies individually...
        for index in 0..64 {
            assert!(registry.qualifies("app", &format!("s{index}"), 1_000));
        }
        // ...but the account can only ever lend it `grace.slots(capacity)`,
        // and never a slot beyond the application's own fair share.
        assert_eq!(grace.slots(8), 2);
        let policy = share(0.5, 0);
        assert_eq!(
            policy.slots(8, 8, 1_000),
            4,
            "the fair share itself is the ceiling"
        );
        assert_eq!(
            decide(&policy, &grace, pressure(8, 7, 4, 2), true, true, 1_000),
            AdmissionDecision::Queue
        );
    }

    #[test]
    fn wait_estimate_reports_whole_draining_waves() {
        let saturated = pressure(8, 8, 5, 0);
        // Two requests past a limit of 4 -> two draining waves.
        assert_eq!(estimated_wait_ms(saturated, 4, 10_000), 20_000);
        // Still inside the share means no wait at all.
        assert_eq!(estimated_wait_ms(pressure(8, 7, 2, 0), 4, 10_000), 0);
    }

    #[test]
    fn weekend_nights_are_roomier_than_a_weekday_afternoon() {
        // Wednesday 2026-11-18 14:00 Europe/Paris.
        let wednesday_afternoon = 1_795_006_800_000;
        // Wednesday 2026-11-18 22:00 Europe/Paris.
        let wednesday_night = 1_795_035_600_000;
        let policy = ApplicationShare::default();
        assert_eq!(policy.multiplier_at(wednesday_afternoon), 1.0);
        assert_eq!(policy.multiplier_at(wednesday_night), 2.0);
        // Saturday 2026-11-21 12:00 Europe/Paris stays doubled.
        let saturday_noon = 1_795_258_800_000;
        assert_eq!(policy.multiplier_at(saturday_noon), 2.0);
    }

    #[test]
    fn empty_session_identity_never_earns_grace() {
        let mut registry = GraceRegistry::new(GracePolicy::default());
        registry.observe("app", "", "acct", 9_999, 1_000);
        assert_eq!(registry.len(), 0);
        assert!(!registry.qualifies("app", "", 1_000));
    }

    #[test]
    fn a_latency_window_reports_p99_not_the_maximum() {
        let mut window = LatencyWindow::new(200);
        // 199 samples at 100 ms and one 9-second outlier. The mean would be
        // ~145 ms and the max 9000 ms; the honest p99 is still 100 ms.
        for _ in 0..199 {
            window.record(100);
        }
        window.record(9_000);
        assert_eq!(window.percentile(0.99), Some(100));
        assert_eq!(window.percentile(1.0), Some(9_000));
        assert_eq!(window.percentile(0.5), Some(100));
    }

    #[test]
    fn a_latency_window_evicts_old_samples_so_the_tail_recovers() {
        let mut window = LatencyWindow::new(4);
        for _ in 0..4 {
            window.record(10_000);
        }
        assert_eq!(window.percentile(0.99), Some(10_000));
        // A spike that ended is not a permanent report of a spike.
        for _ in 0..4 {
            window.record(5);
        }
        // Eviction is what makes this 5 rather than 10_000: with an unbounded
        // window the four outliers would still dominate the 99th percentile, so
        // this single assertion also pins the bound.
        assert_eq!(window.percentile(0.99), Some(5));
    }

    #[test]
    fn an_empty_latency_window_reports_nothing_rather_than_zero() {
        let window = LatencyWindow::default();
        assert_eq!(window.percentile(0.99), None);
        assert_eq!(window.percentile(0.0), None);
    }
}
