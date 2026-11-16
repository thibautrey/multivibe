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
    /// Whether the reserved slot came from the grace pool.
    ///
    /// Recorded at grant time because it cannot be recovered later: by the time
    /// the lease expires or is redeemed, the counters no longer say whether this
    /// particular slot was the application's own or a borrowed one. Without it
    /// the pool is debited and never credited, so a client that uses leases
    /// slowly loses grace capacity until it has none.
    borrowed_from_grace: bool,
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
    /// The reservation was a grace slot, so releasing it must also credit the
    /// pool.
    pub borrowed_from_grace: bool,
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
    /// The redeemed slot came from the grace pool, so the pool must be credited.
    pub borrowed_from_grace: bool,
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
                    borrowed_from_grace: entry.borrowed_from_grace,
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
        borrowed_from_grace: bool,
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
                borrowed_from_grace,
                state: LeaseState::Admitted,
            },
        );
        Ok(released)
    }

    /// Read a lease without consuming it. Scoped by application so one tenant
    /// cannot probe another tenant's lease.
    #[must_use]
    pub fn peek(
        &mut self,
        application: &str,
        id: &str,
        now: u64,
    ) -> (Option<(LeaseState, u64, u32)>, Vec<ExpiredReservation>) {
        let released = self.prune(now);
        let found = self.entries.get(id).filter(|entry| entry.application == application).map(|entry| {
            (entry.state, entry.expires_at, entry.renewals)
        });
        (found, released)
    }

    /// Extend a waiting lease. Renewals are bounded so a client cannot hold a
    /// reservation indefinitely by polling.
    pub fn renew(
        &mut self,
        application: &str,
        id: &str,
        now: u64,
    ) -> (Option<(u32, u64)>, Vec<ExpiredReservation>) {
        let mut released = self.prune(now);
        let outcome = match self.entries.get_mut(id) {
            Some(entry)
                if entry.application == application && entry.state == LeaseState::Admitted =>
            {
                if entry.renewals >= admission::LEASE_MAX_RENEWALS {
                    // Exhausting the budget ends the lease; its reservation must
                    // be returned in the same breath or the slot leaks.
                    entry.state = LeaseState::Expired;
                    released.push(ExpiredReservation {
                        account_id: entry.account_id.clone(),
                        application: entry.application.clone(),
                        borrowed_from_grace: entry.borrowed_from_grace,
                    });
                    None
                } else {
                    entry.renewals = entry.renewals.saturating_add(1);
                    entry.expires_at = now + admission::LEASE_TTL_MS;
                    Some((entry.renewals, entry.expires_at))
                }
            }
            _ => None,
        };
        // The expired entry is removed on the next prune; drop it now so a
        // subsequent grant cannot count it as live.
        if outcome.is_none()
            && self
                .entries
                .get(id)
                .is_some_and(|entry| {
                    entry.state == LeaseState::Expired && entry.application == application
                })
        {
            self.entries.remove(id);
        }
        (outcome, released)
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
            borrowed_from_grace: entry.borrowed_from_grace,
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
            borrowed_from_grace: entry.borrowed_from_grace,
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
    fn a_grace_borrowed_lease_reports_what_it_borrowed() {
        // The pool can only be credited if the lease remembers where its slot
        // came from. It cannot be recovered at expiry or redemption: by then the
        // counters no longer distinguish this slot from the application's own.
        // Without this the pool is debited and never credited, so a client using
        // leases slowly loses grace until it has none.
        let mut leases = registry();
        leases.grant("own".into(), "app", "acct", false, 1_000).unwrap();
        leases.grant("borrowed".into(), "app", "acct", true, 1_000).unwrap();

        let own = leases.redeem("app", "own", 1_100).expect("own slot");
        assert!(!own.borrowed_from_grace);

        let borrowed = leases.redeem("app", "borrowed", 1_100).expect("borrowed slot");
        assert!(borrowed.borrowed_from_grace, "the pool must be credited");
    }

    #[test]
    fn an_expired_grace_lease_still_reports_the_borrow() {
        let mut leases = registry();
        leases.grant("l1".into(), "app", "acct", true, 1_000).unwrap();
        let released = leases.prune(1_000 + admission::LEASE_TTL_MS + 1);
        assert_eq!(released.len(), 1);
        assert!(released[0].borrowed_from_grace);
    }

    #[test]
    fn a_lease_is_redeemable_exactly_once() {
        let mut leases = registry();
        leases.grant("l1".into(), "app", "acct", false, 1_000).unwrap();
        let first = leases.redeem("app", "l1", 1_100).expect("first redemption");
        assert_eq!(first.account_id, "acct");
        assert!(leases.redeem("app", "l1", 1_200).is_none(), "second use fails");
    }

    #[test]
    fn leases_are_scoped_to_their_application() {
        let mut leases = registry();
        leases.grant("l1".into(), "app-a", "acct", false, 1_000).unwrap();
        assert!(leases.peek("app-b", "l1", 1_000).0.is_none());
        assert!(leases.redeem("app-b", "l1", 1_000).is_none());
        assert!(leases.redeem("app-a", "l1", 1_000).is_some());
    }

    #[test]
    fn a_lease_expires_after_its_ttl() {
        let mut leases = registry();
        leases.grant("l1".into(), "app", "acct", false, 1_000).unwrap();
        let after_ttl = 1_000 + admission::LEASE_TTL_MS + 1;
        assert!(leases.redeem("app", "l1", after_ttl).is_none());
        assert_eq!(leases.len(), 0, "expired lease is pruned");
    }

    #[test]
    fn renewals_are_bounded_then_expire() {
        let mut leases = registry();
        leases.grant("l1".into(), "app", "acct", false, 1_000).unwrap();
        let mut now = 1_000;
        for expected in 1..=admission::LEASE_MAX_RENEWALS {
            now += 1_000;
            let (renewals, _) = leases.renew("app", "l1", now).0.expect("renewal allowed");
            assert_eq!(renewals, expected);
        }
        now += 1_000;
        assert!(
            leases.renew("app", "l1", now).0.is_none(),
            "renewal budget is exhausted"
        );
    }

    #[test]
    fn one_application_cannot_hoard_leases() {
        let mut leases = registry();
        leases.grant("l1".into(), "app", "acct", false, 1_000).unwrap();
        leases.grant("l2".into(), "app", "acct", false, 1_000).unwrap();
        assert_eq!(
            leases.grant("l3".into(), "app", "acct", false, 1_000),
            Err(LeaseError::TooManyLeases)
        );
        // Another application is unaffected.
        assert!(leases.grant("l3".into(), "other", "acct", false, 1_000).is_ok());
    }

    #[test]
    fn a_full_registry_refuses_new_leases() {
        let mut leases = LeaseRegistry::new(LeaseLimits {
            max_entries: 1,
            max_per_application: 10,
        });
        leases.grant("l1".into(), "app", "acct", false, 1_000).unwrap();
        assert_eq!(
            leases.grant("l2".into(), "app", "acct", false, 1_000),
            Err(LeaseError::RegistryFull)
        );
    }

    #[test]
    fn an_abandoned_lease_returns_its_slot_on_the_next_sweep() {
        // A client that takes a lease and dies must not hold capacity forever:
        // the reservation is released when any later call sweeps the registry.
        let mut leases = registry();
        leases.grant("l1".into(), "app", "acct", false, 1_000).unwrap();
        assert_eq!(leases.len(), 1);

        let after_ttl = 1_000 + admission::LEASE_TTL_MS + 1;
        let (found, released) = leases.peek("app", "l1", after_ttl);
        assert!(found.is_none(), "the lease itself is gone");
        assert_eq!(released.len(), 1, "and its reservation is reported");
        assert_eq!(released[0].account_id, "acct");
        assert_eq!(released[0].application, "app");
        assert_eq!(leases.len(), 0);
    }

    #[test]
    fn exhausting_the_renewal_budget_also_returns_the_slot() {
        // Ending a lease by policy is the same accounting event as expiring it.
        let mut leases = registry();
        leases.grant("l1".into(), "app", "acct", false, 1_000).unwrap();
        let mut now = 1_000;
        for _ in 0..admission::LEASE_MAX_RENEWALS {
            now += 1_000;
            let (outcome, released) = leases.renew("app", "l1", now);
            assert!(outcome.is_some());
            assert!(released.is_empty(), "a live renewal frees nothing");
        }
        now += 1_000;
        let (outcome, released) = leases.renew("app", "l1", now);
        assert!(outcome.is_none(), "the budget is spent");
        assert_eq!(released.len(), 1, "the slot comes back exactly once");
        assert_eq!(leases.len(), 0);
    }

    #[test]
    fn revoking_frees_the_reservation() {
        let mut leases = registry();
        leases.grant("l1".into(), "app", "acct", false, 1_000).unwrap();
        let released = leases.revoke("app", "l1").expect("reservation released");
        assert_eq!(released.account_id, "acct");
        assert_eq!(leases.len(), 0);
        assert!(leases.redeem("app", "l1", 1_000).is_none());
    }
}
