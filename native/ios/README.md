# MultiVibe Chat — native iOS

SwiftUI application for iPhone and iPad, iOS 18 minimum, Swift 6. The Xcode
project is versioned: no dependency installation or XcodeGen generation is
needed to open it.

## Open and run

From the repository root:

```sh
open native/ios/MultiVibeChat.xcodeproj
```

Choose the **MultiVibeChat** scheme, then an iPhone or iPad simulator. The last
validation used the Xcode beta installed in `/Applications/Xcode-beta.app` and
an iPhone 17 / iOS 27 simulator. See `IMPLEMENTATION-STATUS.md` for the exact
results and the validation limits.

For a physical device, select a real development team under
Signing & Capabilities. The repository provides no team, certificate or
provisioning profile. The bundle identifier is `cloud.multivibe.chat`. A simulator
build does not prove signing entitlements, universal links or Siri execution.

## Authentication and environment

The application explicitly targets MultiVibe services:

- Application API: `https://app.multivibe.cloud`;
- OAuth: `https://auth.multivibe.cloud`;
- SSO callback: `https://auth.multivibe.cloud/oauth/callback/ios`.

These destinations are defined in code; there is no server selector or demo
mode. Do not assume that a local launch makes new routes available: changes to
the sibling `multivibe-cloud` backend were not deployed by this task.

Under Account, **Available credits** opens **Usage and credits**: charts over
24 hours, 7 days or 30 days, token breakdown, distribution by model, project and
provider, performance and recent requests with CSV export. The balance stays
current regardless of the selected period. Statistics cover the Cloud workspace
associated with the account and distinguish missing measurements from zeros.
The client uses `GET /native/v1/analytics` with its iOS bearer token; that route
must exist on Cloud for statistics to load. The export contains at most the last
50 requests of the period, without conversation content.

Email/password, registration, TOTP and recovery use native screens. SSO uses the
system authentication session, with PKCE and state verification, rather than
entering a provider password in the app. The generic SSO button does not
guarantee that Apple is enabled server-side.

Before a real trial: configure the Apple credentials on the backend, sign the
app and publish the domain association for the real team. Never place a provider
key, a private Apple key or an OAuth secret in the application. See also
`docs/apple-oauth-grant-retention.md` in the backend.

## Shortcuts and voice

Four App Intents open the application after local authentication: new
conversation, dictation, draft preparation and voice conversation. A draft or a
dictation never sends a message automatically.

The implemented voice mode is **local dictation → review → Send → play the
response**. It is not a full-duplex real-time conversation. The special
assistant path is disabled at build time by default; do not enable
`MULTIVIBE_SIDE_BUTTON_ASSISTANT` as a substitute for an entitlement, signing or
an Apple eligibility check.

## Pre-release checklist

Use an authorized test account and verify separately:

- registration, sign-in, TOTP challenge, recovery and sign-out;
- SSO callback on a signed device, denial/cancellation and account switching;
- model selection, streaming response, network interruption and resume;
- local history then explicitly accepted synchronization, including conflicts
  from a second device without silent overwrite;
- microphone access denial, audio interruption and the four shortcuts working
  on device;
- VoiceOver, large text sizes, keyboard, orientation and iPad display.

These checks are not declared successful by this list. Account deletion,
completion of Apple revocation, visual and physical validation, and production
configuration remain open. The authoritative status is
`IMPLEMENTATION-STATUS.md`: **not ready for release**.

## Apple Foundation Local

The iOS app offers `apple-foundation-local` alongside the account model catalog.
It uses Apple's on-device `SystemLanguageModel` on iOS 26+ with Apple Intelligence
available and its model downloaded. The app still supports iOS 18 for remote chat.
Local inference is available without creating or signing into a MultiVibe account;
it does not send remote completion requests or require a valid access token. There is no
implicit remote fallback.

The native model/tool loop can search saved conversations, list/read imported
UTF-8 text documents (100 KB each), perform arithmetic, obtain the current date,
and create new local text documents that can be inspected/shared from Local
tools. Optional calendar, reminders and consent-gated web tools are described below. Tool calls share a 12-call and 120-second budget. Context overflow can
restart with bounded successful tool observations twice, without resetting the
budget. Created documents are deduplicated by title and contents. This is an
app-scoped workspace, not access to arbitrary iPhone files, apps or web browsing.

History is written atomically with complete file protection and excluded from
backups. Guest storage is separate from hashed account storage. Sign-in does not
import guest data implicitly; Import guest conversations copies it into
the signed-in account without deleting the guest originals. Documents remain
local; conversation text, including quotations from documents, is synchronized.

After enabling automatic history synchronization, connectivity restoration and
foregrounding trigger the existing account-scoped revision-checked history API.
Transient failures receive bounded retries. Concurrent edits require preserving
both versions explicitly; the app never silently overwrites another device.
Suspension stops local generation and retains the partial conversation/tool trace;
Retry explicitly restarts the request with the current local workspace.
There is no promise of continuous background inference on iOS.

### Optional Internet tools

`fetch_website` performs HTTPS GET and extracts readable HTML/text/JSON/XML;
`http_head` retrieves status and content metadata. Both are native URLSession
tools, not a shell or arbitrary curl command execution. The first attempted
request presents a native permission sheet. Allow or Deny is persisted once per
conversation on this device, including across relaunches. Concurrent calls share
one prompt. New conversations ask independently. Consent is never accepted from
server history; guest imports are new conversations and ask again.

No HTTP request occurs before consent. A denied conversation can continue with
local tools. Approved requests use ephemeral sessions without cookies or saved
credentials, keep TLS validation, validate redirects, allow only GET/HEAD, limit
responses to 256 KiB and cache at most four URLs per run. Page content is treated
as untrusted evidence. The model always stays local. This permission is separate
from account-history synchronization. Human approval time is excluded from the
run deadline; Stop cancels a pending prompt.

Calendar and reminders are optional read-only tools enabled from Local tools
via iOS permission prompts. They read EventKit's local stores; they do not modify
events/reminders. Their text can appear in conversation responses and therefore
in synced history if history sync is enabled.
