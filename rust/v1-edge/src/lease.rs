//! Admission leases.
//!
//! A lease lets a client wait outside the HTTP request. That is not a
//! convenience: Cloudflare closes a proxied response that yields no byte for
//! 100 seconds, so an inline wait long enough to matter cannot be held at all.
//!
//! A lease is a *promise of a specific slot on a specific account*. Reserving
//! the slot when the lease is granted — rather than when it is redeemed — is
//! what makes the promise true: a client that redeems within the TTL is
//! guaranteed the capacity it was told it had. The cost is bounded by the TTL
//! and the number of live leases.

use std::collections::HashMap;

use crate::admission;

/// Lease states as reported to the client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseState {
    /// A slot is reserved and still unused.
    Admitted,
    /// The client consumed the lease on an inference request.
    Consumed,
    /// The lease outlived its TTL, or every renewal was spent.
    Expired,
}

impl LeaseState {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admitted => "admitted",
            Self::Consumed => "consumed",
            Self::Expired => "expired",
        }
    }
}

#[derive(Debug, Clone)]
struct LeaseEntry {
    application: String,
    account_id: String,
    expires_at: u64,
    renewals: u32,
    state: LeaseState,
}

/// Hard bounds on the lease table. Both are needed: a client that never
/// redeems must not be able to accumulate reservations forever.
#[derive(Debug, Clone, Copy)]
pub struct LeaseLimits {
    pub max_entries: usize,
    pub max_per_application: usize,
}

impl Default for LeaseLimits {
    fn default() -> Self {
        Self {
            max_entries: 4_096,
            max_per_application: 64,
        }
    }
}

#[derive(Debug)]
pub struct LeaseRegistry {
    limits: LeaseLimits,
    entries: HashMap<String, LeaseEntry>,
}

/// A lease that expired while still holding a reservation, reported so the
/// caller can release the capacity it no longer needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpiredReservation {
    pub account_id: String,
    pub application: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseError {
    /// The application already holds the maximum number of live leases.
    TooManyLeases,
    /// The registry is full.
    RegistryFull,
}

impl LeaseError {
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::TooManyLeases => "too_many_leases",
            Self::RegistryFull => "lease_registry_full",
        }
    }
}

/// What one lease reservation hands back when it is redeemed.
#[derive(Debug)]
pub struct LeaseRedemption {
    pub account_id: String,
}

impl LeaseRegistry {
    #[must_use]
    pub fn new(limits: LeaseLimits) -> Self {
        Self {
            limits,
            entries: HashMap::new(),
        }
    }

    /// Drop dead entries, returning those that still held a reservation.
    ///
    /// Expiring a lease without releasing its slot would leak capacity until
    /// the process restarted, so the release is part of pruning rather than an
    /// afterthought.
    fn prune(&mut self, now: u64) -> Vec<ExpiredReservation> {
        let mut released = Vec::new();
        self.entries.retain(|_, entry| {
            let dead = entry.state == LeaseState::Expired || entry.expires_at <= now;
            if dead && entry.state == LeaseState::Admitted {
                released.push(ExpiredReservation {
                    account_id: entry.account_id.clone(),
                    application: entry.application.clone(),
                });
            }
            !dead
        });
        released
    }

    /// Reserve a slot for `application` on `account_id`.
    ///
    /// Returns the lease id; the caller keeps the real capacity lease and drops
    /// it if this fails, so a rejected reservation never holds a slot.
    pub fn grant(
        &mut self,
        id: String,
        application: &str,
        account_id: &str,
        now: u64,
    ) -> Result<Vec<ExpiredReservation>, LeaseError> {
        let released = self.prune(now);
        if self.entries.len() >= self.limits.max_entries {
            return Err(LeaseError::RegistryFull);
        }
        let live_for_application = self
            .entries
            .values()
            .filter(|entry| entry.application == application)
            .count();
        if live_for_application >= self.limits.max_per_application {
            return Err(LeaseError::TooManyLeases);
        }
        self.entries.insert(
            id,
            LeaseEntry {
                application: application.to_owned(),
                account_id: account_id.to_owned(),
                expires_at: now + admission::LEASE_TTL_MS,
                renewals: 0,
                state: LeaseState::Admitted,
            },
        );
        Ok(released)
    }

    /// Read a lease without consuming it. Scoped by application so one tenant
    /// cannot probe another tenant's lease.
    #[must_use]
    pub fn peek(&mut self, application: &str, id: &str, now: u64) -> Option<(LeaseState, u64, u32)> {
        self.prune(now);
        let entry = self.entries.get(id)?;
        if entry.application != application {
            return None;
        }
        Some((entry.state, entry.expires_at, entry.renewals))
    }

    /// Extend a waiting lease. Renewals are bounded so a client cannot hold a
    /// reservation indefinitely by polling.
    pub fn renew(&mut self, application: &str, id: &str, now: u64) -> Option<(u32, u64)> {
        self.prune(now);
        let entry = self.entries.get_mut(id)?;
        if entry.application != application || entry.state != LeaseState::Admitted {
            return None;
        }
        if entry.renewals >= admission::LEASE_MAX_RENEWALS {
            entry.state = LeaseState::Expired;
            return None;
        }
        entry.renewals = entry.renewals.saturating_add(1);
        entry.expires_at = now + admission::LEASE_TTL_MS;
        Some((entry.renewals, entry.expires_at))
    }

    /// Consume a lease. Succeeds at most once per lease id.
    pub fn redeem(&mut self, application: &str, id: &str, now: u64) -> Option<LeaseRedemption> {
        self.prune(now);
        let entry = self.entries.get_mut(id)?;
        if entry.application != application || entry.state != LeaseState::Admitted {
            return None;
        }
        if entry.expires_at <= now {
            entry.state = LeaseState::Expired;
            return None;
        }
        entry.state = LeaseState::Consumed;
        Some(LeaseRedemption {
            account_id: entry.account_id.clone(),
        })
    }

    /// Drop a lease the caller could not honour. Returns the reservation it
    /// held, if any, so the caller can release the slot.
    pub fn revoke(&mut self, application: &str, id: &str) -> Option<ExpiredReservation> {
        let entry = self.entries.get(id)?;
        if entry.application != application {
            return None;
        }
        let held = (entry.state == LeaseState::Admitted).then(|| ExpiredReservation {
            account_id: entry.account_id.clone(),
            application: entry.application.clone(),
        });
        self.entries.remove(id);
        held
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> LeaseRegistry {
        LeaseRegistry::new(LeaseLimits {
            max_entries: 8,
            max_per_application: 2,
        })
    }

    #[test]
    fn a_lease_is_redeemable_exactly_once() {
        let mut leases = registry();
        leases.grant("l1".into(), "app", "acct", 1_000).unwrap();
        let first = leases.redeem("app", "l1", 1_100).expect("first redemption");
        assert_eq!(first.account_id, "acct");
        assert!(leases.redeem("app", "l1", 1_200).is_none(), "second use fails");
    }

    #[test]
    fn leases_are_scoped_to_their_application() {
        let mut leases = registry();
        leases.grant("l1".into(), "app-a", "acct", 1_000).unwrap();
        assert!(leases.peek("app-b", "l1", 1_000).is_none());
        assert!(leases.redeem("app-b", "l1", 1_000).is_none());
        assert!(leases.redeem("app-a", "l1", 1_000).is_some());
    }

    #[test]
    fn a_lease_expires_after_its_ttl() {
        let mut leases = registry();
        leases.grant("l1".into(), "app", "acct", 1_000).unwrap();
        let after_ttl = 1_000 + admission::LEASE_TTL_MS + 1;
        assert!(leases.redeem("app", "l1", after_ttl).is_none());
        assert_eq!(leases.len(), 0, "expired lease is pruned");
    }

    #[test]
    fn renewals_are_bounded_then_expire() {
        let mut leases = registry();
        leases.grant("l1".into(), "app", "acct", 1_000).unwrap();
        let mut now = 1_000;
        for expected in 1..=admission::LEASE_MAX_RENEWALS {
            now += 1_000;
            let (renewals, _) = leases.renew("app", "l1", now).expect("renewal allowed");
            assert_eq!(renewals, expected);
        }
        now += 1_000;
        assert!(
            leases.renew("app", "l1", now).is_none(),
            "renewal budget is exhausted"
        );
    }

    #[test]
    fn one_application_cannot_hoard_leases() {
        let mut leases = registry();
        leases.grant("l1".into(), "app", "acct", 1_000).unwrap();
        leases.grant("l2".into(), "app", "acct", 1_000).unwrap();
        assert_eq!(
            leases.grant("l3".into(), "app", "acct", 1_000),
            Err(LeaseError::TooManyLeases)
        );
        // Another application is unaffected.
        assert!(leases.grant("l3".into(), "other", "acct", 1_000).is_ok());
    }

    #[test]
    fn a_full_registry_refuses_new_leases() {
        let mut leases = LeaseRegistry::new(LeaseLimits {
            max_entries: 1,
            max_per_application: 10,
        });
        leases.grant("l1".into(), "app", "acct", 1_000).unwrap();
        assert_eq!(
            leases.grant("l2".into(), "app", "acct", 1_000),
            Err(LeaseError::RegistryFull)
        );
    }

    #[test]
    fn revoking_frees_the_reservation() {
        let mut leases = registry();
        leases.grant("l1".into(), "app", "acct", 1_000).unwrap();
        let released = leases.revoke("app", "l1").expect("reservation released");
        assert_eq!(released.account_id, "acct");
        assert_eq!(leases.len(), 0);
        assert!(leases.redeem("app", "l1", 1_000).is_none());
    }
}
