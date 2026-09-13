# Native iOS chat — implementation in progress

This source is not release-ready and has not been integrated into main yet.

## Implemented source

- SwiftUI iPhone/iPad app, native split navigation, model selection, streamed chat,
  local search, message sharing, explicit on-device dictation and speech playback.
- Email/password registration and login, consent input, TOTP challenge UI.
- Device-only unlocked Keychain sessions, rotated refresh tokens using the existing
  OAuth endpoint, remote refresh-family revocation on logout.
- Per-account SHA-256-named local history with complete file protection and backup
  exclusion. No cloud-history synchronization is implemented yet.
- Session/generation revision checks reject stale streaming and model-list callbacks.
- Foreground, device-authenticated App Intents: new conversation, dictation,
  prepare a draft. They are discoverable in Shortcuts and can be assigned through
  supported system shortcut surfaces. Draft preparation never sends a message.
- Pending microphone permission callbacks are invalidated on stop/background.

## Validation so far

- XcodeGen project generation succeeded.
- Swift frontend syntax parsing succeeded. This is NOT typechecking, linking,
  simulator/device validation or App Intents metadata validation.
- No dependency-backed build/test has run: those must run after integration into
  local main per repository workflow.

## Required before completion

- Complete Apple SSO backend routes, database constraints, broker configuration,
  native authentication handoff and tests. Apple capability alone does not provide SSO.
- Finish password recovery and authentication error/retry UX.
- Validate refresh rotation against live backend semantics, including logout racing
  a refresh, connectivity failure after rotation, and revoked account behavior.
- Verify SSE framing against URLSession.AsyncBytes, strict Swift 6 concurrency,
  voice interruption/permission lifecycle, and supported App Intents metadata.
- Add account deletion, actual privacy collection declarations and verified legal
  URLs before any App Store submission. The current privacy manifest is provisional.
- Cloud history integration and a true conversational voice mode remain outstanding.
- Configure signing, Apple identifiers/keys and provisioning separately. No private
  credentials belong in this repository. No side-button entitlement is enabled;
  region-limited system-assistant activation must not be promised to all users.
- Integrate commits into local main without pushing; validate sequentially there;
  remove task worktrees after the implementation task is finished.
