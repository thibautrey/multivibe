# Native App Intents

MultiVibe exposes 22 App Intents on iOS 18+, including 10 featured App Shortcuts.
Apple Foundation Local execution additionally requires a compatible device, OS,
downloaded model and an available Foundation Models session. No remote fallback.

## Actions

| Group | Actions |
| --- | --- |
| Conversation | New conversation; prepare message; open selected conversation; find conversations; get last completed reply; export conversation as UTF-8 text |
| Local inference | Prepare Apple Foundation Local request; ask Apple Foundation Local and return its completed response; prepare HTTPS page analysis; prepare calendar/reminders/contacts/location request |
| Voice | Dictation; voice conversation; read a selected completed reply aloud; stop audio |
| Documents | Import text; import UTF-8 plain-text file (100 KB maximum); find local documents; return a document's text |
| Memory | Propose a memory for human review |
| Navigation | Open history, documents/tools, memory, privacy or history synchronization confirmation |
| Generation | Stop response |

The first four original intents remain compatible. All actions require local device
authentication and foreground the app. Siri phrases are French. All 22 actions are
available to the Shortcuts catalog; only 10 are featured by the AppShortcutsProvider.

Example workflows in Shortcuts:
- Text → Ask Apple Foundation Local → use returned text in another action.
- Find conversations → choose a conversation → export conversation → save file.
- Text file → import file → prepare a local question about that document.
- URL → prepare page analysis → review/send in MultiVibe → approve Internet if requested.
- Text → propose memory → verify topic, source and expiry → confirm in the app.

## Runtime and data boundaries

- Foreground routes wait for protected history restoration. A pending route is
  consumed once, tied to the active account, and invalidated on login/logout.
- Native entity queries and app launch share initial restoration. Queries do not
  initiate remote model discovery. Previously opted-in automatic history sync
  retains its existing policy.
- Conversation/document entities use account-scoped IDs and re-resolve current
  data. Private content is not automatically indexed in Core Spotlight or
  donated as proactive entity suggestions.
- Explicit read/export actions return personal data to the user's Shortcut.
  Downstream actions can transmit it; app descriptions state that boundary.
- Preparing text never sends it. The separate “Ask Apple Foundation Local” action
  is explicit execution: a new local conversation, normal permission prompts,
  bounded inference, no silent remote fallback, cancellation scoped to that run.
  Keep the app foregrounded; iOS may interrupt long-running Shortcuts.
- Device-data preparation neither grants permission nor queries data. Execution
  uses existing native permissions and tool scope. There is no public Apple Mail
  inbox access intent.
- The memory action only opens a review draft. It cannot confirm facts or delete
  memory without the existing UI.
- Synchronization navigation opens the existing confirmation/login flow; it does
  not silently opt in. Web access retains the per-conversation allow/deny gate.

## Scope and verification

No WidgetKit/Control Center extension or app group is introduced. Users can assign
eligible Shortcuts through Apple's own interfaces; this does not assert physical
Action button/lock-screen behavior. The special assistant activation schema stays
compile-gated, with no claim of entitlement or regional eligibility.

Validation uses simulator unit tests, cold-launch UI fixtures and Xcode-generated
App Intents metadata. UI fixtures exercise the production foreground route, not
Siri's speech recognition or the Shortcuts application. Physical Siri, installed
Shortcuts execution, locked-device authentication and Action button invocation
remain device acceptance checks.
