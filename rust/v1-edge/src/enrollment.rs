//! Single-use enrollment codes for the Hermes bridge.
//!
//! The operator sends a prompt containing a short-lived code, never a
//! long-lived credential. The bridge exchanges it once for a per-machine key.
//! Codes live in memory only: an edge restart invalidates outstanding codes,
//! which is the safe direction — an operator issues a fresh one.

use std::collections::HashMap;

/// Lives long enough for an operator to send a message and a client to act.
pub const CODE_TTL_MS: u64 = 24 * 60 * 60 * 1_000;
/// Bound on outstanding codes so a leaked operator token cannot exhaust memory.
pub const MAX_CODES: usize = 256;

pub const CODE_PREFIX: &str = "mvenr_";
/// How long an expired code stays reportable as `Expired`.
pub const EXCHANGE_PRESERVE_MS: u64 = 7 * 24 * 60 * 60 * 1_000;

#[derive(Debug, Clone, PartialEq)]
pub struct EnrollmentGrant {
    /// The application name the key is issued to, e.g. `hermes-acme`.
    pub application: String,
    pub max_concurrent_share: f64,
    pub burst: u32,
    /// Model substitutions the client's bridge should use.
    pub mappings: Vec<ModelMapping>,
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ModelMapping {
    pub from: String,
    pub edge: String,
    pub nous: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExchangeError {
    Unknown,
    Expired,
    /// Another caller already used this code.
    Used,
}

impl ExchangeError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown_enrollment_code",
            Self::Expired => "expired_enrollment_code",
            Self::Used => "used_enrollment_code",
        }
    }
}

#[derive(Debug)]
struct Entry {
    grant: EnrollmentGrant,
    used: bool,
}

#[derive(Debug, Default)]
pub struct EnrollmentCodes {
    entries: HashMap<String, Entry>,
}

impl EnrollmentCodes {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a code. Returns an error rather than silently dropping one when
    /// the table is full, so the operator knows issuance failed.
    pub fn issue(&mut self, code: &str, grant: EnrollmentGrant, now: u64) -> Result<(), &'static str> {
        self.prune(now);
        if !code.starts_with(CODE_PREFIX) || code.len() < CODE_PREFIX.len() + 32 {
            return Err("invalid_enrollment_code_format");
        }
        if self.entries.len() >= MAX_CODES {
            return Err("too_many_enrollment_codes");
        }
        self.entries.insert(code.to_owned(), Entry { grant, used: false });
        Ok(())
    }

    /// Drop entries that can no longer produce a useful answer.
    ///
    /// An expired code stays for a retention window so `exchange` can report
    /// `Expired` rather than `Unknown`: telling an operator their code expired
    /// is actionable, telling them it never existed is not.
    fn prune(&mut self, now: u64) {
        self.entries.retain(|_, entry| {
            // A used code is remembered until its expiry passes, because a
            // replay must read as `Used`, not `Unknown`.
            entry.used || entry.grant.expires_at.saturating_add(EXCHANGE_PRESERVE_MS) > now
        });
    }

    /// Consume a code exactly once.
    ///
    /// A used code stays in the table until it expires so a replay is reported
    /// as `Used` rather than `Unknown`; that distinction is what lets the bridge
    /// tell "already enrolled" from "wrong code".
    pub fn exchange(&mut self, code: &str, now: u64) -> Result<EnrollmentGrant, ExchangeError> {
        self.prune(now);
        let Some(entry) = self.entries.get_mut(code) else {
            return Err(ExchangeError::Unknown);
        };
        if entry.used {
            return Err(ExchangeError::Used);
        }
        if entry.grant.expires_at <= now {
            return Err(ExchangeError::Expired);
        }
        entry.used = true;
        Ok(entry.grant.clone())
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(expires_at: u64) -> EnrollmentGrant {
        EnrollmentGrant {
            application: "hermes-acme".to_owned(),
            max_concurrent_share: 0.25,
            burst: 1,
            mappings: vec![ModelMapping {
                from: "hermes-4-405b".to_owned(),
                edge: "nousresearch/hermes-4-405b".to_owned(),
                nous: "hermes-4-405b".to_owned(),
            }],
            expires_at,
        }
    }

    fn code() -> String {
        format!("{CODE_PREFIX}{}", "a".repeat(43))
    }

    #[test]
    fn a_code_is_exchangeable_once() {
        let mut codes = EnrollmentCodes::new();
        codes.issue(&code(), grant(10_000), 0).unwrap();
        let first = codes.exchange(&code(), 100).expect("first exchange");
        assert_eq!(first.application, "hermes-acme");
        assert_eq!(codes.exchange(&code(), 200), Err(ExchangeError::Used));
    }

    #[test]
    fn an_expired_code_is_reported_separately() {
        let mut codes = EnrollmentCodes::new();
        codes.issue(&code(), grant(1_000), 0).unwrap();
        assert_eq!(codes.exchange(&code(), 1_001), Err(ExchangeError::Expired));
    }

    #[test]
    fn an_unknown_code_is_rejected() {
        let mut codes = EnrollmentCodes::new();
        assert_eq!(codes.exchange(&code(), 0), Err(ExchangeError::Unknown));
    }

    #[test]
    fn malformed_codes_are_refused_at_issue() {
        let mut codes = EnrollmentCodes::new();
        assert!(codes.issue("short", grant(1_000), 0).is_err());
        assert!(codes.issue("mvenr_tooshort", grant(1_000), 0).is_err());
    }

    #[test]
    fn the_table_is_bounded() {
        let mut codes = EnrollmentCodes::new();
        for index in 0..MAX_CODES {
            let unique = format!("{CODE_PREFIX}{index:0>43}");
            codes.issue(&unique, grant(10_000), 0).unwrap();
        }
        let overflow = format!("{CODE_PREFIX}{}", "z".repeat(43));
        assert_eq!(codes.issue(&overflow, grant(10_000), 0), Err("too_many_enrollment_codes"));
    }

    #[test]
    fn used_entries_survive_pruning_until_expiry() {
        let mut codes = EnrollmentCodes::new();
        codes.issue(&code(), grant(1_000), 0).unwrap();
        codes.exchange(&code(), 10).unwrap();
        // Still reportable as used inside the window...
        assert_eq!(codes.exchange(&code(), 500), Err(ExchangeError::Used));
    }

    #[test]
    fn an_expired_code_eventually_disappears() {
        let mut codes = EnrollmentCodes::new();
        codes.issue(&code(), grant(1_000), 0).unwrap();
        // Well past the retention window the entry is gone entirely.
        let far_future = 1_000 + EXCHANGE_PRESERVE_MS + 1;
        assert_eq!(codes.exchange(&code(), far_future), Err(ExchangeError::Unknown));
        assert_eq!(codes.len(), 0);
    }
}
