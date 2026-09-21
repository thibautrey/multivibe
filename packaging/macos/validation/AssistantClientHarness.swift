import AppKit

struct TestCredentials { let proxyAPIKey: String? }
final class MultiVibeMenuBarApp: NSObject, NSApplicationDelegate {
    var operational = true
    var startAtLoginEnabled = true
    let dashboardURL: URL
    var proxyAPIKey = "fixture-only-token"
    init(port: String) { dashboardURL = URL(string: "http://127.0.0.1:\(port)")! }
    func readCredentials() -> TestCredentials? { TestCredentials(proxyAPIKey: proxyAPIKey) }
    func ensureServiceIsRunning() {}
    func launchService() {}
}

struct FixtureLocalModel: AppleFoundationServing {
    let available: Bool
    var model: HostAssistantModel? { get async { available ? HostAssistantModel(id: AppleFoundationModel.id, name: "Apple fixture", local: true) : nil } }
    func respond(messages: [[String: String]], update: @MainActor @escaping (String) -> Void) async throws {
        if messages.last?["content"] == "Annuler local" {
            try await Task.sleep(nanoseconds: 2_000_000_000)
        }
        precondition(messages.last == ["role": "user", "content": "Local uniquement"])
        try Task.checkCancellation()
        await update("Réponse locale")
    }
}

@main struct AssistantClientHarness {
    @MainActor static func main() async throws {
        let app = NSApplication.shared
        let delegate = MultiVibeMenuBarApp(port: CommandLine.arguments[1])
        app.delegate = delegate
        let client = HostAssistantClient(localModel: FixtureLocalModel(available: false))
        let original = client.defaultModel
        defer { client.defaultModel = original }
        let models = try await client.models()
        precondition(models.map(\.id) == ["empty", "error", "normal", "redirect", "slow", "stream", "truncated"])
        client.defaultModel = "normal"
        let reply = try await client.ask("Bonjour")
        precondition(reply == "Réponse fixture")
        do { _ = try await client.ask(" "); fatalError("Empty input accepted") } catch HostAssistantError.invalidInput {}
        do { _ = try await client.ask(String(repeating: "x", count: 32_001)); fatalError("Oversized input accepted") } catch HostAssistantError.invalidInput {}
        do { _ = try await client.ask("test", model: "unknown"); fatalError("Unknown model accepted") } catch HostAssistantError.missingModel {}
        do { _ = try await client.ask("test", model: "empty"); fatalError("Empty output accepted") } catch HostAssistantError.emptyReply {}
        do { _ = try await client.ask("test", model: "error"); fatalError("Server error accepted") } catch HostAssistantError.rejected(503) {}
        do { _ = try await client.ask("test", model: "redirect"); fatalError("Redirect followed") } catch HostAssistantError.rejected(307) {}
        let pending = Task { try await client.ask("test", model: "slow") }
        try await Task.sleep(nanoseconds: 150_000_000)
        pending.cancel()
        do { _ = try await pending.value; fatalError("Cancellation ignored") } catch {}
        let history = [["role": "user", "content": "Bonjour"], ["role": "assistant", "content": "Salut"], ["role": "user", "content": "Suite"]]
        var updates: [String] = []
        try await client.stream(history, model: "stream") { updates.append($0) }
        precondition(updates == ["Bonjour ", "Bonjour été"])
        do { try await client.stream(history, model: "truncated") { _ in }; fatalError("Truncated SSE accepted") } catch HostAssistantError.unavailable {}
        let local = HostAssistantClient(localModel: FixtureLocalModel(available: true))
        let localCatalog = try await local.models()
        precondition(localCatalog.first?.id == AppleFoundationModel.id)
        precondition(localCatalog.first?.local == true)
        delegate.operational = false
        let localReply = try await local.ask("Local uniquement", model: AppleFoundationModel.id)
        precondition(localReply == "Réponse locale")
        let stoppedCatalog = try await local.models()
        precondition(stoppedCatalog.map(\.id) == [AppleFoundationModel.id])
        let localPending = Task { try await local.ask("Annuler local", model: AppleFoundationModel.id) }
        try await Task.sleep(nanoseconds: 50_000_000)
        localPending.cancel()
        do { _ = try await localPending.value; fatalError("Local cancellation ignored") } catch is CancellationError {}
        let bounded = try AppleFoundationModel.boundedTranscript((0..<20).map { ["role": $0.isMultiple(of: 2) ? "user" : "assistant", "content": String(repeating: "x", count: 2_000)] })
        precondition(bounded.count <= 9_600 && bounded.components(separatedBy: "\n\n").count == 8)
        delegate.operational = true
        delegate.proxyAPIKey = "fixture-local-fallback-token"
        let fallbackCatalog = try await local.models()
        precondition(fallbackCatalog.map(\.id) == [AppleFoundationModel.id])
        let unavailable = HostAssistantClient(localModel: FixtureLocalModel(available: false))
        do { _ = try await unavailable.models(); fatalError("Remote and local unavailability accepted") } catch HostAssistantError.rejected(503) {}
        withExtendedLifetime(delegate) {}
        print("PASS remote and Apple-local catalogs, local routing, fallback, response, input bounds, errors and cancellation")
    }
}
