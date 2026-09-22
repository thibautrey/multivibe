// swift-tools-version: 6.0
import PackageDescription

// The root manifest makes the SDK installable from the monorepo Git URL.
// Keep products and platform requirements aligned with the local package in
// native/sdk/MultiVibeSDK, used by the native app and example projects.
let package = Package(
    name: "MultiVibeSDK",
    platforms: [.iOS(.v18), .macOS(.v14)],
    products: [
        .library(name: "MultiVibeSDK", targets: ["MultiVibeSDK"]),
        .library(name: "MultiVibeChatUI", targets: ["MultiVibeChatUI"])
    ],
    targets: [
        .target(name: "MultiVibeSDK", path: "native/sdk/MultiVibeSDK/Sources/MultiVibeSDK"),
        .target(name: "MultiVibeChatUI", dependencies: ["MultiVibeSDK"], path: "native/sdk/MultiVibeSDK/Sources/MultiVibeChatUI"),
        .testTarget(name: "MultiVibeSDKTests", dependencies: ["MultiVibeSDK"], path: "native/sdk/MultiVibeSDK/Tests/MultiVibeSDKTests")
    ]
)
