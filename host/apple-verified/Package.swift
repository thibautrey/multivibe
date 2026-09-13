// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MultiVibeAppleVerifiedHost",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "AppleVerifiedCore", targets: ["AppleVerifiedCore"]),
        .executable(name: "MultiVibeVerifiedHost", targets: ["MultiVibeVerifiedHost"]),
    ],
    dependencies: [
        // Exact reviewed versions, not moving branches. See README qualification requirements.
        .package(url: "https://github.com/ml-explore/mlx-swift-lm", exact: "2.29.3"),
        .package(url: "https://github.com/ml-explore/mlx-swift", exact: "0.29.1"),
        .package(url: "https://github.com/huggingface/swift-transformers", exact: "1.1.6"),
    ],
    targets: [
        .target(name: "AppleVerifiedCore"),
        .target(name: "CHardening"),
        .executableTarget(name: "MultiVibeVerifiedHost", dependencies: [
            "AppleVerifiedCore", "CHardening",
            .product(name: "MLXLLM", package: "mlx-swift-lm"),
            .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
            .product(name: "MLX", package: "mlx-swift"),
        ]),
        .testTarget(name: "AppleVerifiedCoreTests", dependencies: ["AppleVerifiedCore"]),
    ],
    swiftLanguageModes: [.v5]
)
