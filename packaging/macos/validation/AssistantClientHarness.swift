import AppKit

struct TestCredentials { let proxyAPIKey: String? = "fixture-only-token" }
final class MultiVibeMenuBarApp: NSObject, NSApplicationDelegate {
    var operational = true
    var startAtLoginEnabled = true
    let dashboardURL: URL
    init(port: String) { dashboardURL = URL(string: "http://127.0.0.1:\(port)")! }
    func readCredentials() -> TestCredentials? { TestCredentials() }
    func ensureServiceIsRunning() {}
    func launchService() {}
}

@main struct AssistantClientHarness {
    @MainActor static func main() async throws {
        let app = NSApplication.shared
        let delegate = MultiVibeMenuBarApp(port: CommandLine.arguments[1])
        app.delegate = delegate
        let client = HostAssistantClient.shared
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
        withExtendedLifetime(delegate) {}
        print("PASS models, default, response, input bounds, stale model, empty response, HTTP error, redirect rejection, cancellation")
    }
}
