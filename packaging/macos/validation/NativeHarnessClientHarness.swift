import AppKit
import Foundation

private actor BootstrapEvents {
    private var order: [String] = []
    func record(_ value: String) { order.append(value) }
    func values() -> [String] { order }
}

final class MultiVibeMenuBarApp: NSObject, NSApplicationDelegate {
    let base: URL
    init(port: String) { base = URL(string: "http://127.0.0.1:\(port)")! }
    func authorizedRequest(path: String, method: String = "GET") -> URLRequest? {
        guard let url = URL(string: path, relativeTo: base) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("fixture-admin", forHTTPHeaderField: "x-admin-token")
        return request
    }
}

@main struct NativeHarnessClientHarness {
    @MainActor static func main() async throws {
        let events = BootstrapEvents()
        await loadNativeChatDependencies(
            restoreCloud: {
                try? await Task.sleep(for: .milliseconds(150))
                await events.record("cloud")
            },
            loadModels: {
                try? await Task.sleep(for: .milliseconds(75))
                await events.record("models")
            },
            loadHarnesses: { await events.record("harnesses") }
        )
        let bootstrapOrder = await events.values()
        precondition(bootstrapOrder == ["harnesses", "models", "cloud"])

        let app = NSApplication.shared
        let delegate = MultiVibeMenuBarApp(port: CommandLine.arguments[1])
        app.delegate = delegate
        let client = NativeHarnessClient()
        let harnesses = try await client.harnesses()
        precondition(harnesses.map(\.id) == ["native", "hermes-agent", "pi"])
        precondition(harnesses.sortedForDisplay(lastUsedAt: ["pi": 2, "hermes-agent": 1]).map(\.id) == ["pi", "hermes-agent", "native"])
        var installationLogs: [String] = []
        try await client.install(harnessID: "pi") { installationLogs.append($0) }
        precondition(installationLogs == ["Downloading Pi…", "Connexion à MultiVibe configurée."])
        precondition(harnesses[1].capabilities.longTermMemory)
        var updates: [String] = []
        let session = try await client.stream(
            harnessID: "hermes-agent", conversationID: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!,
            prompt: "Bonjour", model: "gpt-test", sessionID: nil
        ) { updates.append($0) }
        precondition(updates == ["Bon", "Bonjour"])
        precondition(session == "session-1")
        print("PASS native harness discovery, independent bootstrap, capabilities, bounded SSE and session binding")
    }
}
