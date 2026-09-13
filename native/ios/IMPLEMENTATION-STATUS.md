# Native iOS chat — implementation in progress

## Current authoritative status — September 13, 2026

Source is integrated into local `main`, without a push. **Not release-ready.**
The historical journal below records intermediate observations; outstanding items
in older entries are superseded by this summary and subsequent validation entries.

### Implemented locally

- Native SwiftUI iPhone/iPad application (iOS 18+), split navigation, MultiVibe
  colors, model selection, bounded streamed responses, local search/sharing,
  interrupted-response retry with explicit confirmation, and scroll-follow control.
- Native email/password signup/login, legal configuration fetched from the backend,
  TOTP challenge, password reset request/completion and exact recovery universal
  link handling. Opening a reset link does not redeem it or change accounts.
- System-browser SSO handoff with PKCE/state and exact HTTPS callback, backed by
  staged Apple provider support. No unverified Apple claims or automatic email
  linking. The generic SSO button does not claim Apple is configured in production.
- Device-only Keychain credentials, single-flight refresh rotation, stale-session
  race protection, best-effort remote token cleanup and visible persistence errors.
- Protected, backup-excluded per-account history plus explicitly confirmed cloud
  synchronization through the shared web-history schema. Raw branches, arbitrary
  IDs, folders and unknown fields are retained. Revision conflicts require explicit
  keep-both consent; exact pending writes are persisted before POST for lost-response
  recovery. No automatic upload, last-write-wins overwrite, or E2EE claim.
- Foreground device-authenticated App Intents: new conversation, dictation, draft,
  and voice sheet. Drafting never sends a message. Optional compile-gated
  `.assistant.activate` adapter; no side-button entitlement enabled.
- Mandatory on-device dictation, editable transcript, explicit Send and local speech
  playback. This is push-to-talk, **not full-duplex realtime voice**.
- Backend native auth/history/recovery routes, Apple OIDC adapter/broker source,
  migration files and optional deployment configuration are present locally.
  They have not been migrated, provisioned or deployed by this task.

### Latest completed validation

- Local main at `c464ad3`: unsigned iPhone 17 / iOS 27 simulator build and **42
  XCTest tests passed**, zero failures, terminal `TEST SUCCEEDED` / exit 0.
  Log: `/tmp/multivibe-ios-privacy-tests.log`. Exact DerivedData and
  disposable simulator were removed. No live authentication or two-device proof.
- Earlier main builds validated French App Intents metadata packaging and the
  optional assistant macro; these are not signed-device Siri invocation tests.
- Backend main previously passed TypeScript build and targeted native-auth,
  provider and history tests; Rust broker suite passed 17 with one diagnostic
  ignored. See backend status for exact source scope; unrelated later main
  commits are not implicitly validated by those older results.
- Audio-ownership fix `b66230c`: worktree `git diff --check` passed, committed and
  fast-forwarded to main. All three ownership regression tests passed in the
  33-test audio suite and the later 35-test suite. These are state-machine tests, not microphone
  or physical-device playback verification.

### Required before completion / release

1. Implement actual account deletion with fresh authorization, ownership and
   retained-record handling, session revocation and Apple authorization revocation.
   Investigation found Apple token exchange currently does not retain a revocation
   token; logout is not account deletion. No destructive account operation exists
   in the native app yet.
2. Finish truthful privacy collection declarations and verify legal disclosures.
   The collection manifest and native disclosure sheet now reflect source-evidenced flows; production processing and submission declarations remain unverified.
3. Complete Cloud realtime audio/session/metering/cancellation transport if pursuing
   the reference's full-duplex assistant experience; never bypass Cloud using
   provider credentials in the app.
4. Verify physical-device audio/permissions/interruption handling, Siri/Shortcuts,
   accessibility, visual layout and signed universal-link routing. Audio session
   activation/deactivation still runs synchronously; the scoped ownership fix
   avoids redundant idle deactivation, not every responsiveness concern.
5. Configure real Apple identifiers, key rotation, signing/provisioning and deployed
   AASA. Validate signup/login/MFA/password recovery/chat/Apple SSO against the
   intended backend and verify two-device history behavior. No keys were created.
6. Apply authorized migrations/deployment separately; no push or deployment has
   occurred. Preserve other tasks' main-branch work. Remove this task's worktrees
   when implementation is actually finished.

## Historical implementation journal

## System SSO handoff (September 13, 2026)

- The native sign-in screen now starts ASWebAuthenticationSession with an exact
  HTTPS callback, ephemeral browser session, random state and PKCE S256. It uses
  the existing provider chooser, consent and MFA flow, not client-decoded Apple claims.
- Authorization-code exchange uses fixed first-party endpoints. A separate
  authenticated iOS-only endpoint resolves the account identifier. Failed account
  lookup attempts revocation of the newly issued refresh token.
- Simulator compilation succeeded. This is not a verified Apple login: the
  Apple provider still needs production configuration, and the associated domain
  requires a deployed apple-app-site-association file naming the actual signed
  Team ID plus cloud.multivibe.chat under webcredentials.apps. Do not invent a Team ID.
- No AASA file has been published and no physical-device HTTPS callback has been
  proven. The generic SSO button intentionally does not claim Apple availability.
- SSU metadata archival was repaired by declaring the French development locale in both the project and Info.plist; see validation below.

### Transport and SSO lifecycle hardening

- All native API calls use an ephemeral URLSession delegate which rejects HTTP redirects, including same-host redirects. Sensitive POST bodies and bearer tokens are never intentionally forwarded to a redirected endpoint; 3xx remains an API failure.
- SSO tasks cancel when the authentication view disappears. Task cancellation resumes the browser continuation; callbacks are scoped to a unique attempt so a late callback cannot complete a newer attempt. A token issued after cancellation is revoked in a separate cleanup task before returning.
- Local main simulator build passed (`/tmp/multivibe-ios-transport-build.log`). A local synthetic HTTP 307 probe checks actual Foundation redirect behavior independently of production.
- Production inspection: admission manifests still authorize only Google/GitHub broker credentials. Apple client ID/secret opt-in, public iOS application association configuration, matching guardrail hashes and egress rules remain deployment work. No credentials were provisioned and no production policy was changed.

### Native signup configuration and conversation selection

- Native signup now reads `/native/v1/auth/config`; legal links are no longer hardcoded. The server rejects disabled signup, absent configuration and stale `termsVersion` before invoking account creation. The app resets acceptance when reloading changed terms.
- Switching conversations cancels the previous stream and audio, restores the conversation's model only if available, and requires explicit model selection when it is no longer available. Draft text is cleared when switching conversations. Reselecting the same conversation does not cancel it.
- Backend main: TypeScript build and 24 HTTP tests passed (`/tmp/multivibe-native-legal-tests.log`).
- iOS main: 11 XCTest tests executed with zero failures on a disposable iPhone 17 / iOS 27 simulator, covering SSE parsing, redirect rejection and conversation selection (`/tmp/multivibe-ios-selection-tests.log`). This is not evidence of production authentication or physical-device voice/Siri behavior.

### Shortcut restoration and French Siri metadata

- Pending shortcuts no longer mutate history before authentication/history restoration. Only the latest prepared action survives, and drafting never sends a message. The root view gates chat behind restoration completion.
- Local main: 14 XCTest tests passed on iPhone 17 / iOS 27 simulator (`/tmp/multivibe-ios-intents-tests.log`), including three shortcut preparation tests. These tests do not execute Siri or a production login.
- Declared `developmentLanguage: fr` and `CFBundleDevelopmentRegion=$(DEVELOPMENT_LANGUAGE)`. A fresh unsigned simulator build now explicitly trains all four phrases for `fr`, archives the locale to 100%, and packages `Metadata.appintents/nlu/nlu.lzfse` without the previous SSU error (`/tmp/multivibe-ios-locale-build.log`).
- This establishes local metadata packaging, not signed-device Siri discovery or invocation. Temporary DerivedData was removed after inspecting output.

### Streaming viewport and staged deployment configuration

- The native chat initially anchors to its latest message and follows streamed text while the reader remains at the bottom. User scrolling suspends programmatic scrolling; reading earlier messages exposes an explicit native “Dernier message” button. Conversation changes restore following.
- A fresh unsigned simulator build from local main succeeded (`/tmp/multivibe-ios-scroll-build.log`). Temporary DerivedData was removed. Gesture behavior, Dynamic Type and VoiceOver still require interactive validation; compilation alone does not prove them.
- Backend local main now includes optional Apple SSO / iOS association components and bounded admission-source changes (through `6ec05d78`). Two offline composition/static tests passed across all four component combinations, plus validation of 155 Kubernetes manifests. These are not CEL execution tests or live cluster admission proof.
- No overlay enables these components, no production rules or hashes were changed, and Apple credentials / signed application identity remain unprovisioned. The earlier production limitation remains true for the installed policy, not for the updated local source.

### Refresh persistence failure and account-switch races

- Session services are injectable for deterministic tests without production credentials or Keychain writes. Concurrent callers still share one rotation and one persistence operation.
- If persistence of a rotated token fails, the app clears the stale local session and pending intents, stops chat/audio, and attempts revocation of the rotated token. A failed remote revocation is explicitly reported; it is not presented as confirmed logout on the server.
- A rotation finishing after an account revision no longer silently leaves its new token orphaned: it attempts revocation without replacing the newer account's session or Keychain entry.
- Local main simulator XCTest execution: 17 tests, zero failures, including three new rotation tests (`/tmp/multivibe-ios-rotation-tests.log`). These are injected service tests, not actual Keychain-failure injection or production token lifecycle proof.

### Dictation disclosure and final test process status

- Permission copy now describes mandatory on-device dictation and explicit text sending. A denied Speech permission no longer triggers an unnecessary microphone permission request. Recognition failure preserves the editable transcript and displays an interruption warning.
- Plist validation and a fresh unsigned simulator build from main succeeded (`/tmp/multivibe-ios-dictation-build.log`); this does not verify physical-device permission/audio behavior.
- The preceding 17-test run ultimately exited successfully with `TEST SUCCEEDED`. The long post-test wait was Xcode's `simctl diagnose`, which timed out at 600 seconds; diagnostic collection failed, not the XCTest suite. The disposable simulator and exact DerivedData directory were removed, and no second build ran concurrently.

### Sign-in persistence failure cleanup

- A rejected session persistence operation now attempts to revoke the newly issued refresh token while preserving the previously active account. This handling is shared by native authentication and SSO; cancellation before acceptance retains its separate cleanup path.
- Authentication displays manager-level session warnings as well as view-local errors. Cleanup uses best-effort revocation and does not establish remote success.
- September 13, 2026: local main simulator test command completed with exit 0 and `TEST SUCCEEDED`: 18 tests, zero failures (`/tmp/multivibe-ios-accept-tests.log`). The new injected persistence-failure test verifies incoming-token revocation and preservation of the current account. Actual Keychain failures and production revocation remain unverified.

### Local history deletion confirmation

- Conversation swipe actions no longer allow full-swipe deletion. A native alert names the selected conversation and explicitly explains irreversible removal from this device; cancellation leaves history unchanged.
- Fresh unsigned simulator build on local main passed (`/tmp/multivibe-ios-delete-build.log`, exit 0, `BUILD SUCCEEDED`). Temporary DerivedData was removed. This is compile validation, not an interactive alert/gesture test.

### Reference recovered and opt-in system assistant adapter

- September 13, 2026: the supplied ChatGPT conversation loaded in the internal browser. Its final exchanges explicitly recommend an availability/feature-gated `.assistant.activate` adapter and a shared voice engine. Prior notes saying the reference was inaccessible describe earlier attempts, not current evidence.
- Added `ActivateMultiVibeAssistantIntent` behind the Swift compilation condition `MULTIVIBE_SIDE_BUTTON_ASSISTANT`, unavailable before iOS 26.2. Default builds do not compile this schema; no entitlement was added. To compile-check the opt-in adapter, pass `SWIFT_ACTIVE_COMPILATION_CONDITIONS='$(inherited) MULTIVIBE_SIDE_BUTTON_ASSISTANT'` to xcodebuild.
- The adapter prepares the same native voice interface, with local dictation beginning only after authenticated foreground presentation and existing Speech/microphone permission handling. Recognition never automatically transmits a message. Pending immediate capture is cleared when another shortcut replaces it or session cleanup runs.
- Verified against the installed SDK and Apple's article at https://developer.apple.com/documentation/appintents/launching-your-voice-based-conversational-app-from-the-side-button-of-iphone : production eligibility requires Japan account/physical location and the side-button entitlement. Do not promise automatic future EU enablement.
- The first opt-in build found a missing closing brace; fixed immediately. Fresh main unsigned simulator build with the opt-in compilation condition then passed (`/tmp/multivibe-ios-assistant-build.log`, exit 0). This verifies macro compilation, not eligible-device invocation or signing. Added a preparation-state regression test; execution remains pending.
- Remaining reference gap: this app still uses local push-to-talk recognition plus explicit send and TTS, not full-duplex realtime voice. Do not describe it as the complete realtime assistant envisioned in the reference.

### Assistant regression suite and realtime transport discovery

- Local main simulator XCTest suite reached 19 tests with zero failures on September 13, 2026, including the assistant preparation test (`/tmp/multivibe-ios-assistant-tests.log`). The xcodebuild process was still completing post-test work at this observation; do not conflate suite success with command completion until its terminal status is checked.
- Backend source inspection confirms that a catalog/protocol `realtime` operation is not a working native audio transport: `src/inference-protocol.ts` classifies `/v1/realtime`, but `src/inference-http.ts` explicitly destroys HTTP upgrade sockets. The dashboard native allowlist in `src/app.ts` exposes models/completions/auth only, with no native realtime endpoint. The separate Apple Host WebSocket is a host-enrollment/inference transport, not an iOS user session endpoint.
- Consequently the native app must not connect a bearer session to a guessed realtime URL or bypass Cloud with provider credentials. A complete realtime feature still needs a verified Cloud user-session transport, provider capability selection, streaming audio/cancellation/backpressure, metering, and physical-device audio validation. This discovery is source evidence only; no production WebSocket probe was made.

### Deferred assistant activation lifecycle

- `VoiceConversationView` now reacts to capture eligibility changes instead of running only once on initial presentation. A pending assistant request waits for foreground, authenticated restoration completion, and an idle chat stream; a request arriving while the voice view is already open also triggers handling.
- The pending flag is consumed after permission handling rather than before foreground validation. Cancellation retains the request; existing scene/disappearance handlers stop audio.
- Dependency-free `git diff --check` passed. This lifecycle patch is integrated into local main (`9f31b1a`) but has not yet been compiled or tested: the preceding simulator test command is still running diagnostics, and free space is only 34 GiB. No additional parallel Apple build was started. Physical-device lifecycle validation remains required.

### Native password recovery completion

- The native recovery sheet now accepts the exact first-party email reset link and a confirmed new password, then calls `/native/v1/auth/reset/complete`. It validates the scheme, host, path, absence of credentials/port/query, and one 43-character opaque fragment token; it never navigates to clipboard-provided destinations. Sensitive fields are cleared on completion or dismissal.
- Backend local main (`a98f93f6`) delegates to the existing password-reset transaction, which consumes the challenge and revokes sessions. Completion issues no session and does not bypass subsequent sign-in/MFA. The route retains bounded JSON, rate limiting, and rejection of browser Origin/cookies.
- September 13, 2026: backend main TypeScript build and 29 native-auth/identity HTTP tests passed (`/tmp/multivibe-native-reset-tests.log`), including completion delegation, malformed/expired-link behavior through stubs, no session issuance, and HTTP cookie/origin rejection. These are not production email/database integration proof.
- Fresh unsigned iOS simulator build from main succeeded (`/tmp/multivibe-ios-reset-build.log`, exit 0), covering both the recovery UI and the earlier deferred assistant lifecycle patch. Exact temporary DerivedData was removed. Added XCTest parser cases have not yet been executed; the build does not run tests.
- The previous 19-test simulator command ultimately returned exit 0 and `TEST SUCCEEDED`; only simulator diagnostic collection timed out after 600 seconds. Its DerivedData was removed before this sequential build began.
- Recovery currently uses explicit link paste inside the app; automatic universal-link routing is not implemented. Actual email delivery, expired/used-token database behavior, signed-device recovery, and production route activation remain to be validated. No push or deployment performed.

### Recovery universal links and shared presentation

- Recovery uses one shared native form, presented at the application root for both manual recovery and a validated incoming HTTPS link. The root also handles links while signed in or restoring. Opening a link does not redeem it, change accounts, send a password, or log out automatically. An already-presented recovery form is not replaced by another incoming link.
- Added `applinks:auth.multivibe.cloud` alongside webcredentials. Backend association output includes only the exact `/password/reset` path; OAuth callbacks and other authentication pages are not claimed. Application identity remains deployment-configured; unset configuration still returns 404.
- Verified against Apple's `supporting-associated-domains` documentation: matching entitlement and published AASA are required. This local source change does not prove installed-app association or universal-link delivery; signing, deployment and real-device testing remain outstanding.
- September 13, 2026: main unsigned simulator build passed (`/tmp/multivibe-ios-recovery-links-build.log`), entitlement plist lint passed, and exact DerivedData was removed. Backend TypeScript build and 29 native-auth/identity HTTP tests passed (`/tmp/multivibe-recovery-links-backend-tests.log`), including exact association JSON.
- Parser and recovery-request assertions passed against the current Models source using macOS Foundation (`/tmp/multivibe-recovery-parser-assertions.log`), including rejection of OAuth callbacks. A direct Swift-script XCTest attempt failed because XCTest was not on that script's module search path; this was not an app/test-target build failure. Simulator XCTest execution of these new cases remains outstanding.

## 2026-09-13 — Interrupted-response retry

- `02e35e1` and `dd3852e`: optional backward-compatible completion states,
  restored in-flight messages become stopped, explicit confirmation before replacing
  only the current interrupted tail, preserved original prompt/model, late-delta
  isolation after stop/selection changes. No automatic or hidden billable retry.
- Streaming and history writes are injectable for tests; production still uses the
  existing authenticated endpoint and device-protected local history.
- Main unsigned simulator build succeeded (`/tmp/multivibe-ios-retry-build.log`).
- Simulator suite reports **23 tests, zero failures**, including three new retry/
  cancellation/legacy-decoding cases and recovery parsing. At this checkpoint
  xcodebuild remains in post-test finalization; its terminal status and temporary
  simulator/DerivedData cleanup still require verification (session 23784,
  `/tmp/multivibe-ios-retry-tests.log`). No second test run should be started.
- Simulator emitted an AVAudioSession synchronous-deactivation responsiveness
  warning; inspect audio lifecycle separately. No physical-device claim.

## 2026-09-13 — Shared-history codec groundwork

- Added native GET/POST history transport and a lossless JSON snapshot envelope.
  Selected-branch projection preserves raw web IDs, alternative branches, drafts,
  folders and unknown fields in the retained envelope; it is not yet wired into
  ConversationManager and does not activate background synchronization.
- Main `swiftc -typecheck native/ios/MultiVibeChat/Core/Models.swift` passed.
  Direct macOS Swift assertions passed for JSON roundtrip, selected branch,
  stable local IDs, timestamp/status mapping, cycles and missing heads. This is
  codec evidence, not iOS simulator or live synchronization evidence.
- Added persistent XCTest coverage. These additions await the next simulator run;
  existing run 23784 is still alive in post-test finalization and must not be
  replaced merely because output has paused. No additional Apple build started.

## 2026-09-13 — Explicit native history synchronization

- Native menu now offers an explicitly confirmed account sync. Local history is
  uploaded only after confirmation; the notice states server storage is not E2EE.
- Persistent local cache retains the server revision, last synchronized baseline,
  raw branches and ID mappings. Concurrent remote/local edits stop without a
  last-write-wins overwrite. Conflict resolution UI remains to implement.
- New/changed native messages append graph nodes rather than altering original
  nodes used by web branches. Folders, drafts and unknown fields are retained.
- Unsigned main simulator build succeeded at `f03cf42`:
  `/tmp/multivibe-ios-history-build.log`; exact DerivedData was removed by trap.
  Subsequent small guards block send/retry during sync and reject duplicate
  remote conversation IDs; these need the next validation run.
- Previous retry test process 23784 finally exited 0 with TEST SUCCEEDED (23 tests).
  Diagnostic collection timed out after 600 seconds, not tests. Its DerivedData
  `/private/tmp/multivibe-ios-20260913.NwED3H` was confirmed absent.
- Live two-device synchronization is not proven; native endpoints are not deployed.
  Deterministic synchronization manager tests and conflict resolution remain.

## 2026-09-13 — History save race hardening

- Commit `4448108` validates downloaded projections before POST and records a
  confirmed save as the baseline while reapplying edits/deletions created during
  the request. A change of account still prevents applying its response.
- Assistant nodes with changed completion state get a new branch node, retaining
  the original branch rather than silently keeping an obsolete completion status.
- Main unsigned simulator build passed in
  `/tmp/multivibe-ios-history-race-build.log`; task DerivedData was cleaned.
  Main model typecheck and diff whitespace checks passed.
- Added deterministic manager coverage for mutation during save and malformed
  remote data, plus completion branch reuse coverage. Execution is recorded below
  when available; this is not proof of deployed or physical-device sync.
- Conflict resolution and uncertain POST-result reconciliation remain unfinished.

## 2026-09-13 — Explicit conflict recovery and ambiguous saves

- Native conflict action now offers explicit keep-both resolution: remote chats
  remain intact, locally edited chats become labelled copies, local deletions are
  not propagated during resolution. Subsequent sync does not duplicate copies.
- Simulator run at `2e23d65` reports 28 tests passed, zero failures, including
  conflict consent, save-time edits/deletions and malformed remote rejection.
  Process 45669 is still finalizing; do not claim terminal Xcode success yet.
- Subsequent recovery patch persists the exact outgoing snapshot and ID mappings
  before POST. A lost response can be reconciled only against the exact next
  server revision/payload. Later divergent revisions require explicit conflict
  resolution instead of guessing success. Local persistence failure blocks POST.
  This patch and its lost-response test require subsequent build/test validation.

## 2026-09-13 — Local storage failure handling

- `254097b` prevents a successful-sync banner when final local persistence fails,
  and clears synchronization metadata if a rotated session cannot be saved.
- Added a deterministic test asserting that failure to persist the recovery
  snapshot blocks the remote POST and preserves local conversations.
- The simulator process 45669 was verified still running (Xcode PID 45577,
  DerivedData `/private/tmp/multivibe-ios-20260913.kn637v`, disposable simulator
  `BD2EDA7A-6A48-426A-B0A4-D75F9A8E601A`). Its 28 tests passed at `2e23d65`;
  final diagnostic collection has not yet returned. Do not start another Apple
  build until it terminates. Subsequent commits `cf90ca6` and `254097b` still
  require dependency-backed validation from main.

## 2026-09-13 — History recovery validation complete

- Previous process 45669 terminated with exit 0 and TEST SUCCEEDED (28 tests).
  Its 600-second diagnostic-collection timeout was not a test failure; its
  exact DerivedData directory was verified removed.
- Main at `1e1d66c` compiled and passed all 30 simulator tests, zero failures,
  including exact-payload lost-response recovery and persistence-failure guards.
  Log: `/tmp/multivibe-ios-history-recovery-tests.log`; process 5964 exited 0.
- Used the locally documented `xcodebuild -collect-test-diagnostics never`
  option to avoid the separate simulator sysdiagnose stall. Tests still ran;
  this does not skip assertions or change application behavior.
- Recovery run DerivedData `/private/tmp/multivibe-ios-20260913.BHp72R` was
  verified removed; the dedicated test simulators were removed by the trap.
- This is deterministic simulator proof only. Live two-device history, physical
  voice/shortcuts, Apple SSO provisioning, and backend deployment remain unproven.

## 2026-09-13 — Audio ownership and simulator recovery

- `b66230c` tracks recorder/playback ownership before deactivation. Idle recorder
  stop no longer releases playback; silence still releases both uses. Recognition
  language support is checked before activating audio. Synchronous AVAudioSession
  calls remain; this is not a complete audio responsiveness/interruption solution.
- First main test attempt compiled but exited 65 before tests: simulator launch
  failed with "No such process". Log `/tmp/multivibe-ios-audio-ownership-tests.log`.
- Retried sequentially on a new simulator after explicit `simctl bootstatus -b`.
  Main at `76c13df`: 33 tests, zero failures, terminal TEST SUCCEEDED / exit 0.
  Log `/tmp/multivibe-ios-audio-ownership-retry-tests.log`.
- Both exact task DerivedData directories and dedicated simulators were removed.
  No production change, signing or physical audio/Siri validation performed.

## 2026-09-13 — Native credential forms and screenshot evidence

- `70f0a1d`: signup confirms passwords before submission; native keyboard submit
  actions move from email to password to confirmation. Credential fields cannot
  change during a request, and mode switches clear password/confirmation/consent.
  MFA submission accepts six ASCII digits rather than any six characters.
- Signup and password recovery share pre-normalization UTF-8 password bounds
  (12–256 bytes) and ECMAScript whitespace handling with Cloud. No client trimming
  or normalization alters the secret; existing-password login is not constrained
  by the new-password UI policy. Two boundary/Unicode test methods were added.
- Worktree diff checks passed; committed and integrated to local main before
  dependency-backed validation. Main model typecheck passed. Main simulator
  suite passed 35 tests, zero failures, terminal TEST SUCCEEDED and exit 0.
  Log `/tmp/multivibe-ios-credential-tests.log`. Exact DerivedData and simulator
  removed; no parallel build was run with only 36 GiB available.
- Before the form change, main `381cd61` compiled, installed and launched on a
  disposable iPhone 17 simulator. Captures: `/tmp/multivibe-ios-signin-light.png`
  and `/tmp/multivibe-ios-signin-dark.png`. OCR recovered login/password/SSO/
  signup/recovery labels at distinct visible positions in both appearances.
  Image viewing returned "not allowed because you do not support image inputs".
  Consequently this is capture/OCR evidence, NOT completed visual UX review,
  signup interaction testing, or evidence of the newly changed form's rendering.
- No real account creation, password reset, Apple authorization or deployment
  was performed. Current native password authentication still uses an untracked
  Task unlike SSO; lifecycle cancellation and late-session cleanup need review.

### 2026-09-13 — Native credential lifecycle verified

- `087c72f` integrated into local main: closing authentication invalidates adoption without cancelling an already issued HTTP exchange; late refresh tokens are best-effort revoked. Old completions cannot clear a newer attempt's busy state. Inconsistent MFA/token envelopes are rejected and their refresh token is best-effort revoked. A terms reload checks attempt identity after suspension.
- Worktree: `git diff --check` passed; no dependency installation or build there.
- Main: unsigned sequential iPhone 17 / iOS 27 simulator `xcodebuild test` passed **39 tests, zero failures**, including four new credential-lifecycle tests. Log: `/tmp/multivibe-ios-credential-lifecycle-tests.log`.
- Exact temporary DerivedData and disposable simulator cleaned by exit trap. No push, deployment, provisioning, or real-account verification. This supersedes the earlier outstanding native credential task-lifecycle item, not the other release requirements. Remote revocation success is not guaranteed when the network fails.


### 2026-09-13 — System audio events

- `46ade05`, integrated into local main: observe audio interruption start and lost/unsuitable route notifications. Active dictation/playback stops without automatic restart, preserving the transcript and showing an actionable explanation. Ignore our own category changes, newly available devices, interruption end, and idle events.
- Three regression tests cover notification decoding and idle transcript preservation. Main unsigned sequential simulator suite: **42 tests passed, zero failures**, exit 0. Log `/tmp/multivibe-ios-audio-events-tests.log`. This proves compilation and policy behavior, not a physical phone call/headset-disconnection scenario.
- Worktree diff check passed; no dependency installation there. Exact DerivedData `/private/tmp/multivibe-ios-20260913.lOAEX9` and disposable simulator removed by trap. No push or deployment. Media-services reset recovery and physical-device interruption validation remain outstanding.

### 2026-09-13 — Native privacy disclosures

- `c464ad3`: native disclosure sheet is available before login and from chat. It explains account credentials, transmitted conversation context, optional history sync, on-device dictation, explicit sending, system sharing, and the difference between local conversation removal and account deletion. Official legal URLs come from validated backend configuration, not guessed addresses.
- Replaced empty collection declaration with linked, non-tracking email address, user ID, other user content (AI conversation payload/history), and product interaction (account usage), for app functionality. Removed unsupported UserDefaults required-reason entry: no UserDefaults/AppStorage/SceneStorage usage found in native source. No third-party app SDK dependencies.
- Apple documentation JSON for collected-data-type and purpose keys fetched and checked on this date; all declared identifiers occur in the official schema documentation. Worktree `plutil -lint` and `git diff --check` passed.
- This is a source-evidenced baseline, not an approved App Store privacy label or exhaustive production processor/retention audit. Provider-side collection, SSO profile attributes, operational logging and legal retention still require verification before release. No no-collection/no-logging claim is made.

- Main validation at `c464ad3`: unsigned iPhone 17 / iOS 27 simulator suite passed **42 tests, zero failures**, terminal exit 0. Log `/tmp/multivibe-ios-privacy-tests.log`. Exact disposable simulator and DerivedData removed. This is not a visual review of the new sheet or a verification of live legal-document availability.

### 2026-09-13 — Apple revocation server primitive

- Backend local main `62727503` adds `AppleOidcAdapter.revoke`: fixed Apple HTTPS endpoint, form-encoded server credentials/token, 5-second abort signal, redirect rejection, bounded input and token-free errors. A 200 response is accepted, including already-invalidated tokens; other statuses fail. Response streams are cancelled without buffering untrusted bodies.
- Apple's official `Token revocation` documentation was retrieved on this date and specifies access/refresh token support, POST `/auth/revoke`, and 200 for newly or previously invalidated tokens.
- Backend worktree `git diff --check` passed; integrated into main before `npm run build` and `node --test dist/test/apple-oauth.test.js`: TypeScript build passed, **8 tests passed**, zero failures. Four new tests cover body encoding/endpoint/options, pre-network input validation, safe errors and stream cancellation. Only injected fetch fixtures, no real Apple credential used.
- This is deliberately not an account-deletion implementation or live revocation proof. Encrypted token retention, isolated Rust broker command, transactional deletion/revocation-job lifecycle, fresh authentication, and native deletion UI remain required. No provider token is added to native responses. No push/deployment/migration occurred.
