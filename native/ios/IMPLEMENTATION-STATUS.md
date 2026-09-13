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
- SSU metadata archival still emits a nonfatal error and requires separate repair.
