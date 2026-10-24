import AppKit
import Foundation

struct TestCredentials { let proxyAPIKey: String? }
final class MultiVibeMenuBarApp: NSObject, NSApplicationDelegate {
    var operational = true
    var startAtLoginEnabled = true
    let dashboardURL = URL(string: "http://127.0.0.1:1455")!
    func readCredentials() -> TestCredentials? {
        let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/MultiVibe/host-credentials.json")
        guard let data = try? Data(contentsOf: file), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let key = value["proxy_api_key"] as? String else { return nil }
        return .init(proxyAPIKey: key)
    }
    func ensureServiceIsRunning() {}
    func launchService() {}
}
@MainActor final class BrowserOnlyValidationDriver: ComputerUseDriving {
    func apps() -> [ComputerUseApp] { [] }
    func observe(target: String) async throws -> ComputerUseObservation { throw ComputerUseFailure("Cette recette est limitée au navigateur de test.") }
    func perform(_ command: ComputerUseCommand, target: String) async throws { throw ComputerUseFailure("Cette recette est limitée au navigateur de test.") }
    func reset() {}
}
@main struct ComputerUseLiveHarness {
    @MainActor static func main() {
        let app = NSApplication.shared; app.setActivationPolicy(.regular)
        Task { @MainActor in
            do { try await run(); exit(0) }
            catch { print("FAIL live computer use: \(error.localizedDescription)"); exit(1) }
        }
        app.run()
    }
    @MainActor static func run() async throws {
        guard CommandLine.arguments.count == 3 else { throw ComputerUseFailure("Expected fixture URL and model") }
        let url = CommandLine.arguments[1], model = CommandLine.arguments[2]
        let origin = try ComputerUsePolicy.origin(url)
        guard URL(string: url)?.host == "127.0.0.1" else { throw ComputerUseFailure("Only the local fixture is allowed") }
        let delegate = MultiVibeMenuBarApp(); NSApp.delegate = delegate
        let suite = "computer-use-live-\(UUID())", defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let controller = ComputerUseController(driver: BrowserOnlyValidationDriver(), defaults: defaults)
        let approvals = Task { @MainActor in
            while !Task.isCancelled {
                if let approval = controller.approval {
                    let permitted = (approval.title == "Autoriser ce site ?" && approval.detail.hasPrefix(origin + "\n")) || (approval.title == "Vérifier l’action" && approval.detail.hasPrefix("Navigateur intégré\n"))
                    controller.resolveApproval(permitted ? 1 : 0)
                }
                try? await Task.sleep(nanoseconds: 20_000_000)
            }
        }
        defer { approvals.cancel() }
        var response = "", turns = 0
        let prompt = "Recette de computer use autorisée, limitée strictement à \(url). Navigue vers cette URL dans le navigateur intégré. Remplis le champ Votre texte avec Validation réelle puis clique Vérifier. Observe le résultat final et rapporte exactement ce qui apparaît. Ces saisies et ce clic sont explicitement autorisés dans cette page de recette. N’utilise aucune autre app ou site."
        try await controller.run(conversation: UUID(), messages: [["role":"user","content":prompt]], model: model,
            turn: { context, model in
                turns += 1
                let reply = try await HostAssistantClient.shared.computerTurn(context, model: model)
                print("Live turn \(turns): \(reply.calls.map(\.name).joined(separator: ","))")
                return reply
            }, update: { response = $0 })
        controller.browser.allow(origin: origin)
        let observed = try await controller.browser.observe()
        guard observed.text.contains("Computer use confirmé : Validation réelle"), controller.events.contains(where: { $0.action == "click" && $0.succeeded }) else { throw ComputerUseFailure("The live model did not achieve the expected fixture result") }
        print("PASS LIVE model=\(model) turns=\(turns) actual browser result and native click verified")
        print("Live response: \(response)")
        withExtendedLifetime(delegate) {}
    }
}
