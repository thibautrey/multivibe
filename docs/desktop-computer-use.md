# Desktop agent control and embedded browser

MultiVibe Desktop exposes browsing and macOS application control as native
conversation capabilities. There is no separate engine to select. A remote Host
model receives the bounded `computer` tool on every native conversation and can
either answer normally or use the tool. Apple’s local text model remains text-only.
Legacy conversations that selected the former `computer-use` harness migrate to
the native engine when their local history is loaded.

## Embedded Chromium panel

Web tasks use Chromium Embedded Framework 156.0.8078.48, not WebKit. CEF is
pinned separately for macOS arm64 and x86_64 with SHA-256 hashes in
`scripts/provider-host/cef-runtime.mjs`. The build downloads the official minimal
archive from `cef-builds.spotifycdn.com`, validates every archive path and digest,
builds the official C++ wrapper, links the native bridge, and bundles the Chromium
framework, helper app and upstream license. The release signer signs nested CEF
libraries, the framework and the JIT-enabled helper before sealing the app.

The browser appears only when a page is opened. It occupies a resizable pane on
the right of the chat with back, forward, reload/stop, address and close controls.
Users and the agent share the same rendered page. Closing the pane stops an active
automated turn while retaining Chromium’s separate MultiVibe profile. Manual
address-bar navigation is user-authorized. Agent navigation still requires site
approval.

The browser profile lives under `Application Support/MultiVibe/Chromium`, separate
from Safari, Chrome and the Host dashboard. Cookies and sign-ins persist in that
profile. Production builds encrypt them through the dedicated `MultiVibe Chromium
Safe Storage` Keychain item instead of Chromium's shared default, and run renderer
processes in CEF's macOS sandbox. Test harnesses use a disposable profile and
Chromium's mock keychain switch so tests never prompt for or touch the user’s login
keychain.

Browser observation and input use the Chrome DevTools Protocol through CEF’s
in-process API; no remote debugging port is opened. An isolated JavaScript world
collects bounded visible text and controls. Element handles, isolated execution
contexts and observation IDs expire after every action or navigation. Screenshots
come from `Page.captureScreenshot`; password, OTP and card fields are excluded
from observations and covered before capture. Mouse, wheel, keyboard and drag
input use CDP `Input` events. Top-level redirects to unapproved origins, popups,
downloads, certificate errors and HTTP authentication are refused.

## macOS apps

App control retains the ScreenCaptureKit and Accessibility implementation.
MultiVibe asks before observing an application, protects terminals, assistants,
credential managers and system settings, and rejects secure fields, stale process
IDs, moved windows and stale observations. Actions require confirmation by default.
Physical input in the controlled surface, changing conversation, closing the chat
or selecting **Reprendre la main** cancels the turn.

The user interface shows only actionable approval and progress prompts. It does
not expose implementation terms or a dedicated control engine. Durable chat
history stores messages and bounded action metadata, never screenshots or entered
text. Browser screenshots and tool context remain in memory for the active turn.

## Validation

```sh
npm run test:computer-use
xcrun swiftc -typecheck -parse-as-library -target arm64-apple-macos13.0 packaging/macos/*.swift
```

The Chromium harness builds a real `.app`, installs and signs the pinned framework
and helper into it, runs a local page in the native right panel, types through CDP,
performs a trusted click, captures a JPEG observation and verifies the resulting
DOM. A separate native-app fixture validates ScreenCaptureKit, Accessibility,
Unicode input and AXPress. Chat-store tests prove that ordinary native conversations
receive the implicit tool loop while custom Hermes/Pi harness routing is preserved.
Release validation must additionally build both architectures and verify the final
Developer ID signature, notarization and installed app permissions.
