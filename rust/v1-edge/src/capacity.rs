//! Measured physical capacity.
//!
//! `capacityProfile.maxConcurrent` has always been a declaration. A declared
//! number cannot know that a runtime is loading a second model, that a GPU is
//! thermal-throttling, or that an operator halved the batch size. This module
//! turns the declaration into an observation, with two rules that matter more
//! than the measurement itself:
//!
//! * **Rising is slow, falling is immediate.** Admitting more work is only safe
//!   after a sustained quiet period, so a single quiet sample cannot widen the
//!   gate. A drop is honoured at once: over-admitting is the expensive mistake.
//! * **A failing probe is not evidence of capacity.** A runtime that stops
//!   answering keeps its last *observed* ceiling rather than regressing to the
//!   declared one, which would silently widen the gate during an incident.

use std::collections::HashMap;
use std::time::Duration;

/// How long the runtime must stay quiet before the ceiling is raised.
pub const RAMP_UP_AFTER_MS: u64 = 5 * 60 * 1_000;
/// A sample below this fraction of the current ceiling counts as quiet.
pub const RAMP_UP_BELOW: f64 = 0.60;
/// A probe older than this is stale and must not widen the gate.
pub const STALE_AFTER_MS: u64 = 90 * 1_000;

/// One reading from the runtime's metrics endpoint.
///
/// Field names are the camelCase and snake_case spellings the Node coordinator
/// already accepts, so one deployment serves both paths.
#[derive(Debug, Clone, PartialEq)]
pub struct MetricSample {
    pub max_concurrent: Option<u32>,
    pub in_flight: Option<u32>,
    pub prefill_tokens_per_second: Option<f64>,
    pub decode_tokens_per_second: Option<f64>,
}

impl MetricSample {
    /// Parse the JSON object the metrics endpoint returns. Unknown keys are
    /// ignored; a wrong type for a known key yields `None` rather than a guess.
    pub fn from_json(value: &serde_json::Value) -> Self {
        let number = |keys: &[&str]| -> Option<f64> {
            keys.iter()
                .find_map(|key| value.get(key))
                .and_then(serde_json::Value::as_f64)
                .filter(|number| number.is_finite())
        };
        let count = |keys: &[&str]| -> Option<u32> {
            number(keys).filter(|value| *value >= 0.0).and_then(|value| {
                // A fractional count is not a count; refuse it rather than floor
                // it into a silently different limit.
                (value.fract() == 0.0 && value <= f64::from(u32::MAX)).then_some(value as u32)
            })
        };
        Self {
            max_concurrent: count(&["maxConcurrent", "max_concurrent"]),
            in_flight: count(&["inFlight", "in_flight", "queueDepth", "queue_depth"]),
            prefill_tokens_per_second: number(&[
                "prefillTokensPerSecond",
                "prefill_tokens_per_second",
            ]),
            decode_tokens_per_second: number(&[
                "decodeTokensPerSecond",
                "decode_tokens_per_second",
            ]),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Observed {
    /// The ceiling in force. Starts at the declared value.
    ceiling: u32,
    prefill_tokens_per_second: Option<f64>,
    decode_tokens_per_second: Option<f64>,
    observed_at: u64,
    /// When the runtime was first seen quiet at or below `RAMP_UP_BELOW`.
    quiet_since: Option<u64>,
}

#[derive(Debug)]
pub struct CapacityRegistry {
    declared: HashMap<String, u32>,
    observed: HashMap<String, Observed>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleOutcome {
    /// The ceiling moved down (or was set for the first time).
    Lowered,
    /// The ceiling stayed where it was.
    Unchanged,
    /// A sustained quiet period allowed it to rise.
    Raised,
    /// Ignored: too recent to justify a change, or not a usable sample.
    Ignored,
}

impl CapacityRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self {
            declared: HashMap::new(),
            observed: HashMap::new(),
        }
    }

    /// Remember what the operator declared. Also the fallback whenever no
    /// measurement exists yet.
    pub fn declare(&mut self, account_id: &str, max_concurrent: u32) {
        self.declared
            .insert(account_id.to_owned(), max_concurrent.max(1));
    }

    /// The ceiling to admit against right now.
    ///
    /// An unmeasured account uses its declaration; a measured one uses the
    /// observation, even when that observation has gone stale — a stale ceiling
    /// is still closer to reality than a guess, and widening it on silence would
    /// be the dangerous direction.
    #[must_use]
    pub fn ceiling(&self, account_id: &str) -> Option<u32> {
        let declared = self.declared.get(account_id).copied();
        match self.observed.get(account_id) {
            Some(observed) => Some(observed.ceiling),
            None => declared,
        }
    }

    #[must_use]
    pub fn prefill_tokens_per_second(&self, account_id: &str) -> Option<f64> {
        self.observed
            .get(account_id)
            .and_then(|observed| observed.prefill_tokens_per_second)
    }

    #[must_use]
    pub fn decode_tokens_per_second(&self, account_id: &str) -> Option<f64> {
        self.observed
            .get(account_id)
            .and_then(|observed| observed.decode_tokens_per_second)
    }

    /// Whether the last measurement for this account is too old to trust.
    #[must_use]
    pub fn is_stale(&self, account_id: &str, now: u64) -> bool {
        match self.observed.get(account_id) {
            Some(observed) => now.saturating_sub(observed.observed_at) > STALE_AFTER_MS,
            None => false,
        }
    }

    /// Apply one sample. `None` for `max_concurrent` means the runtime did not
    /// report a ceiling; the observation is still refreshed for the throughput
    /// figures, but the gate does not move.
    pub fn apply(
        &mut self,
        account_id: &str,
        sample: &MetricSample,
        now: u64,
    ) -> SampleOutcome {
        let declared = self.declared.get(account_id).copied();
        let previous = self.observed.get(account_id).cloned();

        // Seed with whatever we already trust: a prior observation, else the
        // declaration. An account with neither cannot be measured usefully.
        let base = previous
            .as_ref()
            .map(|observed| observed.ceiling)
            .or(declared);
        let Some(base) = base else {
            return SampleOutcome::Ignored;
        };

        let Some(reported) = sample.max_concurrent.filter(|value| *value >= 1) else {
            // No ceiling reported: record throughput only.
            self.observed.insert(
                account_id.to_owned(),
                Observed {
                    ceiling: base,
                    prefill_tokens_per_second: sample
                        .prefill_tokens_per_second
                        .or(previous.as_ref().and_then(|o| o.prefill_tokens_per_second)),
                    decode_tokens_per_second: sample
                        .decode_tokens_per_second
                        .or(previous.as_ref().and_then(|o| o.decode_tokens_per_second)),
                    observed_at: now,
                    quiet_since: previous.as_ref().and_then(|o| o.quiet_since),
                },
            );
            return SampleOutcome::Ignored;
        };

        let in_flight = sample.in_flight.unwrap_or(0);
        let utilisation = f64::from(in_flight) / f64::from(base.max(1));

        // Falling is immediate: fewer slots exist now than the gate believes.
        if reported < base {
            self.observed.insert(
                account_id.to_owned(),
                Observed {
                    ceiling: reported,
                    prefill_tokens_per_second: sample.prefill_tokens_per_second,
                    decode_tokens_per_second: sample.decode_tokens_per_second,
                    observed_at: now,
                    quiet_since: None,
                },
            );
            return SampleOutcome::Lowered;
        }

        // Rising needs a sustained quiet period, so one idle moment cannot widen
        // the gate and start a queue oscillation.
        if reported > base {
            // The quiet window must survive across samples while the runtime
            // stays quiet. Losing it on every above-ceiling sample would reset
            // the clock forever and the gate would never rise at all.
            let quiet_since = if utilisation <= RAMP_UP_BELOW {
                previous.as_ref().and_then(|o| o.quiet_since).or(Some(now))
            } else {
                // Load returned: the window restarts from nothing.
                None
            };
            let sustained = quiet_since.is_some_and(|since| {
                now.saturating_sub(since) >= RAMP_UP_AFTER_MS
            });
            let ceiling = if sustained { reported } else { base };
            self.observed.insert(
                account_id.to_owned(),
                Observed {
                    ceiling,
                    prefill_tokens_per_second: sample.prefill_tokens_per_second,
                    decode_tokens_per_second: sample.decode_tokens_per_second,
                    observed_at: now,
                    quiet_since: if sustained { None } else { quiet_since },
                },
            );
            return if sustained {
                SampleOutcome::Raised
            } else {
                SampleOutcome::Ignored
            };
        }

        self.observed.insert(
            account_id.to_owned(),
            Observed {
                ceiling: base,
                prefill_tokens_per_second: sample.prefill_tokens_per_second,
                decode_tokens_per_second: sample.decode_tokens_per_second,
                observed_at: now,
                quiet_since: previous.as_ref().and_then(|o| o.quiet_since),
            },
        );
        SampleOutcome::Unchanged
    }
}

impl Default for CapacityRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Interval between metric probes. Slow on purpose: this is a coarse gate, and a
/// tight loop against a runtime's metrics endpoint is its own kind of load.
pub const PROBE_INTERVAL: Duration = Duration::from_secs(30);
/// A metrics endpoint that has not answered by this deadline is treated as
/// absent for this cycle, never as "capacity unchanged".
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample(max: Option<u32>, in_flight: Option<u32>) -> MetricSample {
        MetricSample {
            max_concurrent: max,
            in_flight,
            prefill_tokens_per_second: None,
            decode_tokens_per_second: None,
        }
    }

    #[test]
    fn both_camel_and_snake_case_are_accepted() {
        let camel = MetricSample::from_json(&json!({
            "maxConcurrent": 8, "inFlight": 2,
            "prefillTokensPerSecond": 120.5, "decodeTokensPerSecond": 40.0
        }));
        let snake = MetricSample::from_json(&json!({
            "max_concurrent": 8, "in_flight": 2,
            "prefill_tokens_per_second": 120.5, "decode_tokens_per_second": 40.0
        }));
        assert_eq!(camel, snake);
        assert_eq!(camel.max_concurrent, Some(8));
        assert_eq!(camel.in_flight, Some(2));
    }

    #[test]
    fn a_fractional_or_negative_count_is_refused() {
        assert_eq!(MetricSample::from_json(&json!({"maxConcurrent": 2.5})).max_concurrent, None);
        assert_eq!(MetricSample::from_json(&json!({"maxConcurrent": -1})).max_concurrent, None);
        assert_eq!(MetricSample::from_json(&json!({"maxConcurrent": "8"})).max_concurrent, None);
    }

    #[test]
    fn an_unmeasured_account_uses_its_declaration() {
        let mut registry = CapacityRegistry::new();
        registry.declare("acct", 8);
        assert_eq!(registry.ceiling("acct"), Some(8));
        assert!(!registry.is_stale("acct", 0));
        assert_eq!(registry.ceiling("unknown"), None);
    }

    #[test]
    fn a_drop_is_honoured_immediately() {
        let mut registry = CapacityRegistry::new();
        registry.declare("acct", 8);
        assert_eq!(registry.apply("acct", &sample(Some(8), Some(0)), 1_000), SampleOutcome::Unchanged);
        assert_eq!(registry.apply("acct", &sample(Some(2), Some(0)), 2_000), SampleOutcome::Lowered);
        assert_eq!(registry.ceiling("acct"), Some(2), "the gate follows reality down at once");
    }

    #[test]
    fn a_rise_waits_for_a_sustained_quiet_period() {
        let mut registry = CapacityRegistry::new();
        registry.declare("acct", 2);
        registry.apply("acct", &sample(Some(2), Some(0)), 0);

        // The runtime now claims more. One quiet sample is not enough.
        const FIRST_ABOVE: u64 = 1_000;
        assert_eq!(
            registry.apply("acct", &sample(Some(8), Some(0)), FIRST_ABOVE),
            SampleOutcome::Ignored
        );
        assert_eq!(registry.ceiling("acct"), Some(2), "not widened on a single sample");

        // Still quiet one millisecond before the window closes: not enough.
        assert_eq!(
            registry.apply(
                "acct",
                &sample(Some(8), Some(0)),
                FIRST_ABOVE + RAMP_UP_AFTER_MS - 1
            ),
            SampleOutcome::Ignored
        );
        assert_eq!(registry.ceiling("acct"), Some(2));

        // At the window boundary, with load still low, the gate widens.
        assert_eq!(
            registry.apply(
                "acct",
                &sample(Some(8), Some(0)),
                FIRST_ABOVE + RAMP_UP_AFTER_MS
            ),
            SampleOutcome::Raised
        );
        assert_eq!(registry.ceiling("acct"), Some(8));
    }

    #[test]
    fn a_busy_runtime_never_ramps_up() {
        let mut registry = CapacityRegistry::new();
        registry.declare("acct", 2);
        registry.apply("acct", &sample(Some(2), Some(0)), 0);
        // Load above the quiet threshold throughout the window.
        for at in (0..=RAMP_UP_AFTER_MS * 2).step_by(10_000) {
            registry.apply("acct", &sample(Some(8), Some(2)), at);
        }
        assert_eq!(
            registry.ceiling("acct"),
            Some(2),
            "a runtime that is always busy is already saturated"
        );
    }

    #[test]
    fn a_sample_without_a_ceiling_never_moves_the_gate() {
        let mut registry = CapacityRegistry::new();
        registry.declare("acct", 8);
        registry.apply("acct", &sample(Some(8), Some(0)), 0);
        assert_eq!(registry.apply("acct", &sample(None, Some(0)), 1_000), SampleOutcome::Ignored);
        assert_eq!(registry.ceiling("acct"), Some(8));
    }

    #[test]
    fn a_missing_ceiling_still_records_throughput() {
        let mut registry = CapacityRegistry::new();
        registry.declare("acct", 8);
        registry.apply(
            "acct",
            &MetricSample {
                max_concurrent: None,
                in_flight: None,
                prefill_tokens_per_second: Some(150.0),
                decode_tokens_per_second: Some(45.0),
            },
            1_000,
        );
        assert_eq!(registry.prefill_tokens_per_second("acct"), Some(150.0));
        assert_eq!(registry.decode_tokens_per_second("acct"), Some(45.0));
    }

    #[test]
    fn an_account_with_no_declaration_and_no_observation_is_ignored() {
        let mut registry = CapacityRegistry::new();
        assert_eq!(registry.apply("ghost", &sample(Some(4), Some(0)), 0), SampleOutcome::Ignored);
        assert_eq!(registry.ceiling("ghost"), None);
    }

    #[test]
    fn a_stale_observation_keeps_its_ceiling_and_is_flagged() {
        let mut registry = CapacityRegistry::new();
        registry.declare("acct", 8);
        registry.apply("acct", &sample(Some(3), Some(0)), 0);
        assert!(!registry.is_stale("acct", STALE_AFTER_MS));
        assert!(registry.is_stale("acct", STALE_AFTER_MS + 1));
        // Staleness must not regress to the wider declaration.
        assert_eq!(registry.ceiling("acct"), Some(3));
    }
}
