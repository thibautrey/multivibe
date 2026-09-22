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

The chat view owns its navigation toolbar. Keep it in a `NavigationStack`. The view handles incoming callback URLs; if authentication is initiated outside that view, deliver callbacks to `client.handleOpenURL(_:)` exactly once. Add `applinks:your-domain.example` to your app's Associated Domains entitlement. Callback URLs must be HTTPS without query or fragment. The default Cloud origin is `https://app.multivibe.cloud`.

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

The SDK only lists and edits its application's conversations. The official app lists all application folders and continues the same versioned conversation through account-owner routes. Third-party context remains a user-role data message, never a system instruction. Origin app tools are unavailable in the official app. Its “Open in application” link includes a conversation ID; `conversationFromOpenURL(_:)` resolves it only within the authenticated application's own history.

`save(_:operationID:)` accepts a caller-retained operation UUID for an exact network retry. The built-in UI never automatically retries uncertain writes or generation requests. A version conflict is displayed and “Reload” explicitly adopts server state. Streaming failures preserve partial text when possible; “Resume response” explicitly starts a new inference after removing the failed partial answer and may incur additional usage. Stopping cancels the active task and does not start another tool. Concurrent edits never silently overwrite another revision. Deletion is performed via the API; revoking application access preserves user history.

`Mode.accountOwner` is reserved for the official app integration and requires an injected asynchronous token provider. The client checks server account identity and refuses an account change. Recreate it when the signed-in account changes. It never loads or persists the official session in third-party SDK credential storage.

## Examples and verification

`../Examples/MultiVibeSDKExamples.xcodeproj` has NotesExample and TasksExample targets. Register each with a distinct client ID, bundle ID and callback domain, and set each target's `SDK_CLIENT_ID`, `SDK_CALLBACK_HOST` and signing team. Both examples persist their own sandboxed items and expose read/create tools. Without registration they show a configuration screen, not a fabricated connection.

Run `swift test --package-path native/sdk/MultiVibeSDK` from the monorepo root. Tests cover stream framing, OAuth callback substitution/replay input, strict schemas, application write isolation and journal non-replay. These are local protocol proofs, not Cloud or physical-device acceptance.

For physical validation, install signed copies of both examples and MultiVibe iOS with working associated-domain files. Sign into one account, authorize both apps, choose an available model, read items, deny then approve creation, and verify each app sees only its own folder. In MultiVibe open each folder, continue the same conversation and follow the origin link. Then test revocation, account switching, simultaneous edits, deletion, exhausted credits and an unavailable model. Interrupt networking during streaming and after an action executes but before its result saves; verify the actual app data contains one mutation and no automatic replay. Repeat authorization with MultiVibe uninstalled to exercise the web fallback. Universal links, consumption and device behavior require a deployed Cloud and physical proof; package tests do not establish them.
