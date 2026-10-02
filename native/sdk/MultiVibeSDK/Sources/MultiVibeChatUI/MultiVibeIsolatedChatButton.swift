import SwiftUI
import MultiVibeSDK

/// Opens Chat in Safari, outside the integrating application's process.
@MainActor public struct MultiVibeIsolatedChatButton: View {
    private let destination: URL
    public init(configuration: MultiVibeConfiguration) throws {
        destination = try MultiVibeIsolatedChat(configuration: configuration).url
    }
    public var body: some View {
        Link(destination: destination) {
            Label("Open private MultiVibe Chat", systemImage: "lock.shield")
                .fontWeight(.semibold)
        }
        .buttonStyle(.borderedProminent)
        .tint(Color(red: 0.24, green: 0.64, blue: 0.45))
        .accessibilityHint("Opens a MultiVibe-controlled browser surface")
    }
}
