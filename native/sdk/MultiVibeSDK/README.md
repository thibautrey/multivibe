# MultiVibe SDK for iOS

Swift 6, iOS 18+. The package exports `MultiVibeSDK` (account, models, streaming, history and host tools) and `MultiVibeChatUI` (SwiftUI and UIKit). It has no external dependencies. Add this directory as a local Swift package, or use the root manifest with the repository URL `https://github.com/thibautrey/multivibe.git`. Once this commit has been pushed, Xcode can resolve the SDK from that URL using an explicit commit revision; repository access is required if the repository is private. No SDK version tag is published by this implementation. Pushing, publishing and selecting a release tag are separate authorized release operations.

For a consuming Swift package after publication, select the tested commit explicitly:

```swift
.package(url: "https://github.com/thibautrey/multivibe.git", revision: "PUBLISHED_COMMIT_SHA")
```

Use `.product(name: "MultiVibeChatUI", package: "multivibe")` and `.product(name: "MultiVibeSDK", package: "multivibe")` in the consuming target. The root and nested manifests export the same sources, products and tests; do not add both packages to one application.

## Register and embed

Register an application in the MultiVibe developer portal. Verify your HTTPS callback domain using the portal's DNS challenge, register the exact callback URL and bundle identifier, and serve an Apple App Site Association document on your callback domain. That domain’s association document must identify your signed application using your own Apple Team ID and bundle identifier; the portal does not collect an Apple Team ID. Each application must have its own public client UUID. No client secret belongs in an iOS app.

```swift
import SwiftUI
import MultiVibeSDK
import MultiVibeChatUI

@MainActor struct Assistant: View {
    @State private var client = MultiVibeClient(configuration: .init(
        clientID: "YOUR_PORTAL_UUID",
        redirectURI: URL(string: "https://your-domain.example/multivibe/callback")!
    ))
    var body: some View {
        NavigationStack { MultiVibeChatView(client: client).tint(.indigo) }
    }
}
```

The chat view owns its navigation toolbar. Keep it in a `NavigationStack`. Pass `initialPrompt:` to prefill the composer without sending or consuming credits; the user remains in control of submission. The view handles incoming callback URLs; if authentication is initiated outside that view, deliver callbacks to `client.handleOpenURL(_:)` exactly once. Add `applinks:your-domain.example` to your app's Associated Domains entitlement. Callback URLs must be HTTPS without query or fragment. The default Cloud origin is `https://app.multivibe.cloud`.

On iOS the sign-in presenter first opens the official app's universal link. If no app handles it, it opens `ASWebAuthenticationSession`, permitting an existing web session. The official app or web page presents consent. The SDK validates state, exact callback and PKCE, exchanges a one-use code, and stores its own rotating credentials in the application's private Keychain. A transport redirect cannot forward bearer credentials. Token refresh failure requires reconnection instead of replaying a possibly consumed rotating credential.

For UIKit, push `MultiVibeChatViewController(client:tools:contextProvider:)` onto a navigation controller. `MultiVibeAuthenticationPresenter(window:)` is available for custom sign-in screens. macOS can use the core package and SwiftUI chat after the host supplies an authorization flow using `beginAuthorization()` and `handleOpenURL(_:)`; the turnkey sign-in presenter is iOS-only.

## Host tools and context

```swift
let tools = [MultiVibeTool(
    name: "create_note", description: "Create a note in this application",
    parameters: .object([
        "type": .string("object"),
        "properties": .object(["title": .object(["type": .string("string")])]),
        "required": .array([.string("title")]),
        "additionalProperties": .bool(false)
    ]), modifiesData: true
) { arguments in
    guard case .object(let fields) = arguments,
          case .string(let title) = fields["title"] else {
        throw MultiVibeError.invalidArguments
    }
    // Validate your business rules and perform your app's authorized operation.
    return .object(["createdTitle": .string(title)])
}]
```

Pass tools and a `MultiVibeContextProvider` to the chat view. The context is persisted with the conversation, so supply only data the user agreed to share. Tool parameters support the strict JSON Schema subset `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `description` and `title`. Unknown constraints are rejected; host executors must also validate business rules. Object properties default to disallowed unless declared. The SDK does not infer mutation safety: mark every data-changing operation `modifiesData: true`.

The chat asks before mutations, records denials and failures, allows at most eight calls per response and waits at most 30 seconds for each executor. Executors should respect task cancellation. A non-cooperative closure cannot be forcibly stopped by Swift; the SDK stops waiting and reports uncertainty. Its durable, per-account/app/conversation/call journal blocks automatic replay after an interrupted or unknown outcome. Verify the actual app state before initiating a new action. Journal receipts are written before publishing results to the server. Tool errors are visible, and no inferred tool calls are executed from partial streams.

Models retain their original identifiers. The interface identifies tool-capable models; for other models it sends a text-only request and explains that tools are unavailable. Optional `localProvider: AppleFoundationLocalProvider()` adds Apple Foundation Local on eligible iOS 26+/macOS 26+ devices. It is text-only and brings no private MultiVibe data or permissions. Conversation synchronization still uses the signed-in Cloud account; this is not an offline anonymous mode.

## History and failure behavior

The third-party SDK only lists and edits its application's legacy v1 conversations. This transport is Cloud-readable, not end-to-end encrypted. The official app uses the separate v2 encrypted store through account-owner routes. It does not list or continue those legacy v1 threads; no automatic migration or merging connects the two stores. Third-party context remains a user-role data message, never a system instruction. Origin app tools are unavailable in the official app. Its “Open in application” link includes a conversation ID; `conversationFromOpenURL(_:)` resolves it only within the authenticated application's own history store. A v2 conversation ID does not make its content available to a third-party v1 client.

`save(_:operationID:)` accepts a caller-retained operation UUID for an exact network retry. The built-in UI never automatically retries uncertain writes or generation requests. A version conflict is displayed and “Reload” explicitly adopts server state. Streaming failures preserve partial text when possible; “Resume response” explicitly starts a new inference after removing the failed partial answer and may incur additional usage. Stopping cancels the active task and does not start another tool. Concurrent edits never silently overwrite another revision. Deletion is performed via the API; revoking application access preserves user history.

`Mode.accountOwner` is reserved for the official app integration and requires an injected asynchronous token provider. The client checks server account identity and refuses an account change. Recreate it when the signed-in account changes. It never loads or persists the official session in third-party SDK credential storage.

## Examples and verification

`../Examples/MultiVibeSDKExamples.xcodeproj` has NotesExample and TasksExample targets. Register each with a distinct client ID, bundle ID and callback domain, and set each target's `SDK_CLIENT_ID`, `SDK_CALLBACK_HOST` and signing team. Both examples persist their own sandboxed items and expose read/create tools. Without registration they show a configuration screen, not a fabricated connection.

Run `swift test --package-path native/sdk/MultiVibeSDK` from the monorepo root. Tests cover stream framing, OAuth callback substitution/replay input, strict schemas, application write isolation and journal non-replay. These are local protocol proofs, not Cloud or physical-device acceptance.

For physical validation, install signed copies of both examples and MultiVibe iOS with working associated-domain files. Sign into one account, authorize both apps, choose an available model, read items, deny then approve creation, and verify each app sees only its own folder. Validate the official app separately with v2 encrypted conversations: unlock its history, open an application folder and continue a v2 conversation. Do not expect the legacy v1 example conversations to appear there. Follow an origin link and verify the receiving app resolves only conversations present in its own store, with a visible unavailable state for an unknown ID. Then test revocation, account switching, simultaneous edits, deletion, exhausted credits and an unavailable model. Interrupt networking during streaming and after an action executes but before its result saves; verify the actual app data contains one mutation and no automatic replay. Repeat authorization with MultiVibe uninstalled to exercise the web fallback. Universal links, consumption and device behavior require a deployed Cloud and physical proof; package tests do not establish them.

### Encrypted history migration boundary

`EncryptedHistory.swift` contains internal, memory-only primitives compatible
with the Cloud TypeScript account keyring and conversation envelope. The fixture
in `Tests/MultiVibeSDKTests/Fixtures/history-v1.json` was produced by the Cloud
TypeScript SDK with synthetic keys; it exercises both key generations after
rotation. The official `accountOwner` client now uses the native v2 encrypted conversation
transport. `SDKApplicationsView` asks for the recovery code locally, decrypts
web conversation documents, and locks on backgrounding. Keys are memory-only;
configure a missing keyring in the MultiVibe account web surface first.

The third-party `application` client still uses legacy v1 conversation transport.
Do not advertise end-to-end encrypted history for integrating native apps yet.

Account recovery codes and account root keys must remain inside a trusted
MultiVibe surface. A native library executes inside its host application's
process; a secure text field or private Swift property does not isolate secrets
from that host. Third-party apps must not ask for the account recovery code or
receive the global keyring. An isolated MultiVibe UI or an application-scoped
key delegation protocol is required before enabling native v2 history. No such
delegation endpoint is exposed by this change. Model providers receive inference
context and authorized tools receive their arguments.

Official-owner writes preserve unknown web document/message fields. Interrupted
write receipts retain the exact envelope and operation ID in a file protected by
the OS. Only ciphertext and routing metadata are persisted. The UI offers explicit
retry or abandonment/reload, and blocks further mutations until resolution.
Retrying a history write never replays inference or a tool. Local Swift tests use
synthetic transport and real encryption; they are not signed-device or production
proof. Locking erases in-memory history; it does not delete pending ciphertext.

The official-owner model chooser has Cloud, My accounts and Relay sections.
Relay models come from `/relay/v1/models`; their exact `relay/<machine>/<model>`
selection is sent to `/relay/v1/completions`. Offline entries remain visible and
cannot be selected. Catalogue errors are shown in the Relay section; they never
switch a selected Relay model to a Cloud model. Monthly remaining messages or
unlimited entitlement come from the server allowance, not a client-side counter.
The Relay backend feature flag and machine availability still govern access.

### Shared application tools and skills

`MultiVibeAgentManifest(data:)` validates the same version-1 JSON manifest used by
the web and Android SDKs. Tool definitions include `inputSchema`, `permission` and
`modifiesData`; skills reference declared tools and all their required permissions.
Unknown fields and unsupported JSON Schema constraints fail before use.

Create `MultiVibeAgentCapabilities(manifest:)` on the main actor. Its published
permissions and skill selection start empty. Embed
`MultiVibeCapabilitiesView(capabilities:)` from MultiVibeChatUI, or supply custom
controls calling `setPermission` and `setSkill`. Revoking a permission deselects
dependent skills. Regranting a permission does not reselect a skill.

Use `try capabilities.tools(handlers:)` to construct the tools passed to the
existing `respond(to:tools:...)` method. These wrappers recheck consent immediately
before executing host code, including after a modifying-action confirmation.
`replace` clears consent and permanently invalidates previously built wrappers.
Construct fresh tools for the next request; retain the journal of prior actions.
Host handlers must still enforce the application's own authorization.

`try capabilities.skillMessage()` returns optional user-role context containing
only selected skills. Insert it before the new user message and persist it with
the conversation before inference. Application skills are not system authority.
This helper does not change history transport: third-party native encrypted
history/key delegation is still pending the privacy design decision. Never ask
for an account recovery code or pass account-wide history keys to this component.
The controls alone are not proof of complete native Chat parity or physical UI QA.
