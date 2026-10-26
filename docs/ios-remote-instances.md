# iOS and account-owned Host instances

The iOS **Account → Instances** screen lists the current account's Personal Relay
machines. A Host advertises the versioned `multivibe/host-harness-v1` adapter only
after its owner activates remote access from Desktop. Enrollment reuses the
Host's existing Cloud account authentication and `/relay/v1/machines`. The
machine credential remains in the Host's private data directory. It is never
returned to iOS, put into a QR, or used as a proxy/admin credential.

The main chat's execution picker switches between this iPhone, Hermes Cloud and
each paired instance's available harnesses. Remote conversations use the existing
composer, Markdown rendering and history sidebar, with their instance and harness
shown explicitly. Instance management opens conversations in that same chat.
Model and project pickers are searchable; effort options come from the harness.
Preferences are retained per instance and harness. Switching sources preserves
each conversation and stops following the previous stream without replaying it.

The project picker contains Host-discovered folders. iOS sends an opaque project
ID; only the Host resolves it to a directory. The project is fixed on the first
turn. Model and effort can change between turns through durable Desktop runtime
commands. An unconfirmed configuration is persisted with its command ID and blocks
sending until the same receipt has been checked. Stop requests native interruption;
Resume follows the saved prompt receipt without resubmitting the prompt.

The adapter carries a bounded JSON envelope in one completion message over the
existing Personal Relay transport. Cloud binds every directory, catalogue and
completion operation to the authenticated owner; the Host never trusts the
envelope's claimed account ID. It supports pairing, authorization renewal,
revocation, harness/model discovery, prompt and receipt recovery. Cloud validates
the account and machine ownership before delivery. The Host accepts only its
configured account and machine, then a separately paired device. Neither the QR
nor an envelope can choose a network destination, workspace path or executable.
The existing encrypted queue, single-use start receipt, cancellation/expiry and
streamed result contracts remain unchanged; no Cloud rollout is required.

Every submitted adapter operation, including pairing and catalogue requests, uses
the existing Relay message allowance. The transport is not zero-access: Cloud can
read its transient encrypted payloads. It does not export local iPhone history or
silently fall back to another inference provider.

Pairing uses a random 60-bit, single-use handoff, bound to the account-owned
machine. It expires after five minutes, eight failed guesses, replacement or
closing the Desktop sheet. Manual pairing requires selecting the same machine
from the account directory. The QR contains only its public machine selector and
ephemeral handoff, using an exact `multivibe-chat://instance/pair` URL. It never
contains the account session, machine credential, admin key or device credential.

Device credentials expire after 24 hours. iOS stores them in its bundle-scoped,
device-only, unlocked Keychain and renews before expiry. Host stores only their
hashes. Rotation retains the prior hash for one minute to recover a lost response;
the replacement plaintext exists only in bounded process memory. Restarting Host
invalidates pending handoffs. Revocation denies the next operation and interrupts
stream delivery. Desktop can revoke an individual device or disable the machine;
iOS can revoke its device or explicitly revoke the account's whole machine.
Offline disconnect clears local credentials and reports unconfirmed revocation.

Native harness sessions, model discovery, command fingerprints, receipts and
event journals all use the same `HostHarnessRuntime` as Desktop. Mobile session
identities are scoped to account, device and conversation. A dropped stream does
not resubmit the prompt: **Resume** reads the persisted command and cursor. A new
device never adopts another device's session. Tool approvals remain on Desktop;
iOS explicitly reports when an approval is required there.

The iOS archive is separate from existing on-device conversations, protected by
iOS file protection, excluded from backups and scoped to the account. Harness and
model preferences are scoped to the instance within that archive. An unreadable
archive is preserved. Local models and previous conversations remain in their
existing storage. Signing out clears the device's instance credentials and makes
best-effort remote revocations before the normal account-session revocation.

No inbound port is opened. Both devices contact the fixed Cloud HTTPS origin with
normal certificate validation and redirects disabled. The iOS screen displays its
network path; a physical WAN acceptance requires a matching completed Host receipt
and an actual answer on the iPhone, preferably while its Wi-Fi is disabled.
