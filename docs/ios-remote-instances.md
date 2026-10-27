# iOS and account-owned Host instances

The iOS **Account → Instances** screen lists the current account's Personal Relay
machines. A Host advertises the versioned `multivibe/host-harness-v1` adapter only
after its owner activates remote access from Desktop. Enrollment reuses the
Host's existing Cloud account authentication and `/relay/v1/machines`. The
machine credential remains in the Host's private data directory. It is never
returned to iOS, put into a QR, or used as a proxy/admin credential.

The main chat's central welcome identity switches between this iPhone, Hermes
Cloud and each paired instance's available harnesses. Once a conversation has
messages, the same compact identity moves to the navigation bar rather than
occupying another row above the composer. Remote conversations use the existing
composer, Markdown rendering and history sidebar, with their instance and harness
shown explicitly. Instance management opens conversations in that same chat.
Local and remote execution share one model picker. When a harness advertises
effort options, that picker also contains the Desktop-style effort scale. Project
selection remains searchable and conversation-scoped.
Preferences are retained per instance and harness. Switching sources preserves
each conversation and stops following the previous stream without replaying it.

The project picker contains Host-discovered folders. iOS sends an opaque project
ID; only the Host resolves it to a directory. The project is fixed on the first
turn. Model and effort can change between turns through durable Desktop runtime
commands. An unconfirmed configuration is persisted with its command ID and blocks
sending until the same receipt has been checked. Stop requests native interruption;
tracking otherwise stays attached until the turn reaches a terminal state.

The adapter carries a bounded JSON envelope in one completion message over the
existing Personal Relay transport. Cloud binds every directory, catalogue and
completion operation to the authenticated owner; the Host never trusts the
envelope's claimed account ID. It supports pairing, authorization renewal,
revocation, harness/model discovery, prompt and receipt recovery. Cloud validates
the account and machine ownership before delivery. The Host accepts only its
configured account and machine, then a separately paired device. Neither the QR
nor an envelope can choose a network destination, workspace path or executable.
The encrypted queue retains its single-use start receipt, cancellation and streamed
result contracts. Its running lease is renewed by authenticated Host status checks
for as long as the turn continues.

Every submitted adapter operation, including pairing and catalogue requests, uses
the existing Relay message allowance. The transport is not zero-access: Cloud can
read its transient encrypted payloads. It does not export local iPhone history or
silently fall back to another inference provider.

Pairing v2 starts on iOS: select the account-owned Mac, tap Connect, then
approve the named iPhone in MultiVibe on the Mac. The menu-bar application checks
for requests even when no chat window is open and presents the approval window.
System notifications are supplementary and only used when already authorized.
Requests expire after five minutes; accept, refuse and cancel are explicit states.
Repeated submissions use the same request/device ID and proof. Pending request
secrets are saved in the device-only unlocked Keychain before transmission, so
lost responses and app/Host restarts do not create duplicate devices. Host stores
only hashes. No request can select another network origin or filesystem path.

The association is durable until revocation or account sign-out. Device access
tokens last 24 hours; a separate durable secret can renew them after inactivity.
iOS serializes renewal per machine and saves the next token before sending it.
Host installs its hash idempotently, including after restart. Valid v1 associations
upgrade during use; expired v1 associations require one final approval. Older
Hosts retain QR/code pairing and legacy token renewal. The QR fallback remains a
60-bit, single-use handoff bound to the machine, expiring after five minutes,
eight failed guesses, replacement or closing its Desktop sheet.

Temporary transport failures retain trust and history. Account-session expiry,
explicit device revocation and old expired authorizations have separate recovery
messages. Revocation denies the next operation and interrupts stream delivery.
Desktop can revoke a device or disable the machine; iOS can revoke its device or
explicitly revoke the account's whole machine. Offline disconnect reports
unconfirmed remote revocation. Pending cancellation is retained for retry.

Native harness sessions, model discovery, command fingerprints, receipts and
event journals all use the same `HostHarnessRuntime` as Desktop. Mobile session
identities are scoped to account, device and conversation. A dropped stream does
not create a new user turn: iOS reconnects with the same command and cursor using
bounded backoff until a terminal receipt arrives. A new device never adopts another
device's session. Tool approvals remain on Desktop; iOS reports when an approval is
required there and keeps following so completion appears automatically afterward.

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
