// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "MultiVibeSDK", platforms: [.iOS(.v18), .macOS(.v14)], products: [
    .library(name: "MultiVibeSDK", targets: ["MultiVibeSDK"]),
    .library(name: "MultiVibeChatUI", targets: ["MultiVibeChatUI"])
], targets: [.target(name: "MultiVibeSDK"), .target(name: "MultiVibeChatUI", dependencies: ["MultiVibeSDK"]), .testTarget(name: "MultiVibeSDKTests", dependencies: ["MultiVibeSDK"])])
