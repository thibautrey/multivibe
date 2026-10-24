import AppKit
import Foundation

struct TestCredentials { let proxyAPIKey: String? }
final class MultiVibeMenuBarApp: NSObject, NSApplicationDelegate {
    var operational = true
    var startAtLoginEnabled = true
    let dashboardURL: URL
    init(port: String) { dashboardURL = URL(string: "http://127.0.0.1:\(port)")! }
    func readCredentials() -> TestCredentials? { .init(proxyAPIKey: "computer-use-fixture") }
    func ensureServiceIsRunning() {}
    func launchService() {}
}

@MainActor final class FixtureComputerDriver: ComputerUseDriving {
    var operations: [String] = []
    var generation = 0
    func reset() {}
    func apps() -> [ComputerUseApp] { [.init(id: "test.editor", name: "Test Editor", pid: 42)] }
    func observe(target: String) async throws -> ComputerUseObservation {
        generation += 1
        return .init(id: "obs-\(generation)", target: target, text: "Fixture observation \(generation)", image: nil, imageURL: nil)
    }
    func perform(_ command: ComputerUseCommand, target: String) async throws { operations.append(command.action) }
}

@main struct ComputerUseHarness {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        Task { @MainActor in
            do { try await runTests(); exit(0) }
            catch { print("FAIL computer use: \(error.localizedDescription)"); exit(1) }
        }
        app.run()
    }
    @MainActor static func runTests() async throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = MultiVibeMenuBarApp(port: CommandLine.arguments[1]); app.delegate = delegate
        let suite = "MULTIVIBE-132-fixture-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let driver = FixtureComputerDriver()
        let controller = ComputerUseController(driver: driver, defaults: defaults)
        precondition(!ComputerUsePolicy.allowedApp("com.apple.Terminal"))
        precondition(!ComputerUsePolicy.allowedApp("com.openai.codex"))
        precondition(!ComputerUsePolicy.allowedApp("com.apple.systempreferences"))
        precondition(ComputerUsePolicy.allowedApp("com.apple.TextEdit"))
        for url in ["file:///etc/passwd", "javascript:alert(1)", "https://user:pass@example.com", "data:text/html,test"] {
            do { _ = try ComputerUsePolicy.origin(url); fatalError("Unsafe URL accepted") } catch {}
        }
        for raw in [#"{"action":"exec"}"#, #"{"action":"click","x":-1,"y":2}"#, #"{"action":"key","key":"shell"}"#] {
            do { try JSONDecoder().decode(ComputerUseCommand.self, from: Data(raw.utf8)).validate(); fatalError("Unsafe command accepted") } catch {}
        }
        let observationTask = Task { try await controller.execute(.init(action: "observe", target: "test.editor")) }
        while controller.approval == nil { await Task.yield() }
        precondition(driver.generation == 0) // No observation before consent.
        controller.resolveApproval(2)
        let observed = try await observationTask.value!
        precondition(controller.allowedApps.contains("test.editor"))
        do { _ = try await controller.execute(.init(action: "click", target: "test.editor", observation: "stale", element: 1)); fatalError("Stale action accepted") } catch {}
        precondition(driver.operations.isEmpty)
        let denied = Task { try await controller.execute(.init(action: "click", target: "test.editor", observation: observed.id, element: 1)) }
        while controller.approval == nil { await Task.yield() }
        controller.resolveApproval(0)
        do { _ = try await denied.value; fatalError("Denied action ran") } catch {}
        precondition(driver.operations.isEmpty)
        let cancelled = Task { try await controller.execute(.init(action: "click", target: "test.editor", observation: observed.id, element: 1)) }
        while controller.approval == nil { await Task.yield() }
        cancelled.cancel()
        do { _ = try await cancelled.value; fatalError("Cancelled approval ran") } catch {}
        precondition(controller.approval == nil && driver.operations.isEmpty)
        let action = Task { try await controller.execute(.init(action: "type", target: "test.editor", observation: observed.id, text: "private fixture")) }
        while controller.approval == nil { await Task.yield() }
        controller.resolveApproval(1); _ = try await action.value
        precondition(driver.operations == ["type"])
        precondition(!controller.events.contains { $0.detail.contains("private fixture") })
        controller.revoke("test.editor")
        precondition(!controller.allowedApps.contains("test.editor"))
        print("PASS policy, application consent, stale rejection, denial, cancellation, redacted journal and revocation")

        if CommandLine.arguments.count > 2 && controller.accessibilityGranted && controller.screenGranted {
            let native = ComputerUseMacDriver()
            let target = "solutions.pleiades.ComputerFixture"
            for _ in 0..<50 {
                if native.apps().contains(where: { $0.id == target }) { break }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            NSRunningApplication.runningApplications(withBundleIdentifier: target).last?.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
            try await Task.sleep(nanoseconds: 500_000_000)
            print("Native fixture listed: \(native.apps().contains { $0.id == target }), running: \(NSRunningApplication.runningApplications(withBundleIdentifier: target).map { "\($0.bundleIdentifier ?? "nil")/\($0.activationPolicy.rawValue)/\($0.isTerminated)" }), own: \(Bundle.main.bundleIdentifier ?? "nil"), allowed: \(ComputerUsePolicy.allowedApp(target))")
            var nativeObservation = try await native.observe(target: target)
            precondition(nativeObservation.imageURL?.hasPrefix("data:image/jpeg;base64,") == true)
            func index(_ text: String, _ observation: ComputerUseObservation) throws -> Int {
                guard let line = observation.text.components(separatedBy: "\n").first(where: { $0.contains(text) }),
                      let index = Int(line.dropFirst().prefix(while: { $0.isNumber })) else { throw ComputerUseFailure("Missing \(text) in AX observation: \(observation.text)") }
                return index
            }
            let field = try index("Texte de recette", nativeObservation)
            try await native.perform(.init(action: "type", observation: nativeObservation.id, element: field, text: "Entrée réelle été"), target: target)
            nativeObservation = try await native.observe(target: target)
            precondition(nativeObservation.text.contains("Entrée réelle été"))
            let button = try index("Valider la recette", nativeObservation)
            try await native.perform(.init(action: "click", observation: nativeObservation.id, element: button), target: target)
            nativeObservation = try await native.observe(target: target)
            precondition(nativeObservation.text.contains("Native confirmé : Entrée réelle été"))
            do { try await native.perform(.init(action: "click", observation: "stale", element: button), target: target); fatalError("Stale native observation accepted") } catch {}
            do { _ = try await native.observe(target: "com.apple.Terminal"); fatalError("Protected application captured") } catch {}
            print("PASS real macOS ScreenCaptureKit, AX tree, PID Unicode input, AXPress and verified native result")
        }
        // Real native driver must fail closed when macOS consent is missing, without prompting in tests.
        print("Native permissions: accessibility=\(controller.accessibilityGranted), screen=\(controller.screenGranted)")
        withExtendedLifetime(delegate) {}
    }
}
