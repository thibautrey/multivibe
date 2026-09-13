# Native iOS chat — implementation in progress

This source is integrated into local main, without a push. It is not release-ready.

## Implemented source

- SwiftUI iPhone/iPad app, native split navigation, model selection, streamed chat,
  local search, message sharing, explicit on-device dictation and speech playback.
- Email/password registration and login, consent input, TOTP challenge UI and
  non-enumerating password reset request.
- Device-only unlocked Keychain sessions, rotated refresh tokens using the existing
  OAuth endpoint, remote refresh-family revocation on logout.
- Per-account SHA-256-named local history with complete file protection and backup
  exclusion. No cloud-history synchronization is implemented yet.
- Session/generation revision checks reject stale streaming and model-list callbacks.
- Foreground, device-authenticated App Intents: new conversation, dictation,
  prepare a draft, and open the voice conversation sheet. Metadata is extracted;
  actual discovery and invocation still require verification through
  supported system shortcut surfaces. Draft preparation never sends a message.
- Pending microphone permission callbacks are invalidated on stop/background.

## Validation so far

- September 13, 2026: Xcode 27 beta simulator build passed from local main.
- iPhone 17 Pro / iOS 26.5 simulator: seven SSE tests passed (zero failures).
  Includes LF/CR/CRLF, Unicode/BOM, empty/multiline events, truncation, invalid
  UTF-8 and bounded event buffering. Streaming uses byte framing rather than a
  line sequence that might normalize empty delimiters.
- App process launched successfully on that simulator; screenshot captured.
  Visual inspection was unavailable, so this is not visual UX verification.
- Temporary simulator and exact task DerivedData directory removed after testing.
- App Intents extraction emitted a nonfatal SSU archival error: metadata packaging
  and Siri/Shortcuts invocation still need validation.
- Backend main: TypeScript build passed, 12 native-auth/Apple/browser-chat tests
  passed; Rust broker suite passed 17 tests with one external diagnostic ignored.
  No database migration application, deployment or real Apple login is proven.

## Required before completion

- Complete Apple SSO backend routes, database constraints, broker configuration,
  native authentication handoff and tests. Apple capability alone does not provide SSO.
- Verify password recovery end-to-end and finish authentication error/retry UX.
- Validate refresh rotation against live backend semantics, including logout racing
  a refresh, connectivity failure after rotation, and revoked account behavior.
- Verify SSE framing against URLSession.AsyncBytes, strict Swift 6 concurrency,
  voice interruption/permission lifecycle, and supported App Intents metadata.
- Add account deletion, actual privacy collection declarations and verified legal
  URLs before any App Store submission. The current privacy manifest is provisional.
- A native push-to-talk sheet shares dictation and speech synthesis with shortcuts.
  Sending remains explicit, and only successfully completed replies authorize
  automatic readout; cancellation never authorizes partial-response playback.
  Hands-free microphone restart is deliberately not implemented.
- Cloud history integration remains outstanding.
- Configure signing, Apple identifiers/keys and provisioning separately. No private
  credentials belong in this repository. No side-button entitlement is enabled;
  region-limited system-assistant activation must not be promised to all users.
- Integrate commits into local main without pushing; validate sequentially there;
  remove task worktrees after the implementation task is finished.

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
