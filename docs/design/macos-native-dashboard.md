# MULTIVIBE-8 — Native macOS dashboard

The interactive mockups define a SwiftUI replacement for the local web dashboard. They retain every current top-level area while adopting macOS conventions: a persistent sidebar, list-detail navigation, a separate Settings scene, native confirmation sheets, and a menu bar surface.

## Product direction

- The native app is the dashboard on macOS. Opening the local dashboard redirects to the installed app through a registered URL scheme or universal link.
- The browser interstitial explains the handoff, exposes a retry path, and offers installation guidance when the app is missing or the handoff is denied.
- The local service continues independently of the main window; closing the window does not imply stopping inference.
- Sensitive values use Keychain-backed flows. The UI never displays a real API key in these mockups.
- Missing cost or invoice data remains visible as unavailable instead of being treated as zero or removed.

## Screen inventory

The mockup contains 64 navigable states spanning:

1. Overview and connected coding tools.
2. Model catalogue, model details, variants, local engines, preparation, download, installed-model management, and deletion confirmation.
3. Provider list, account quota detail, OAuth/API-key connection, model exposure, and removal confirmation.
4. Invoice list and native document preview handoff.
5. Routing policy list, editor, simulation, and live-capacity result.
6. Activity overview, performance, sessions, usage/cost, requests, request inspection, and fallback recovery.
7. API endpoint, keys, one-time secret display, application access, revocation, and webhooks.
8. Playground, response, and documentation.
9. Extensions and extension settings.
10. Updates, onboarding, Cloud/team sharing, Settings, diagnostics, menu bar, empty/error/offline states, and browser-to-app handoff.

## Native implementation map

- `NavigationSplitView`: main sidebar and list-detail screens.
- `Settings` scene: General, Privacy, and Local Service.
- `MenuBarExtra`: service state and quick actions.
- Sheets and alerts: provider setup, destructive confirmations, secrets, and first-run onboarding.
- `openURL` / `onOpenURL`: deep links such as `multivibe://dashboard/activity`.
- Browser handoff route: attempt the deep link only after an explicit click, then show the missing-app recovery state.
- Service connection: authenticated loopback session with explicit offline and reconnect states.

All metrics, providers, keys, invoices, versions, and URLs shown in the mockups are illustrative.
