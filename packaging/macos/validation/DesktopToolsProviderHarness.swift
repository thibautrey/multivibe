import AppKit
import Foundation
import SwiftUI

enum AppleFoundationModel { static let id = "apple-local" }
enum HostAssistantError: Error { case emptyReply }
@MainActor final class HostAssistantClient {
    static let shared = HostAssistantClient()
    func connection() async throws -> (URL, String) { throw HostAssistantError.emptyReply }
}
@MainActor final class MultiVibeMenuBarApp: NSObject, NSApplicationDelegate {
    let port: String; let key: String
    var operational = true
    init(port: String, key: String) { self.port = port; self.key = key }
    func authorizedRequest(path: String, method: String) -> URLRequest? {
        guard let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { return nil }
        var request = URLRequest(url: url); request.httpMethod = method
        request.setValue(key, forHTTPHeaderField: "x-fixture-key")
        return request
    }
}

/// Real native provider, real embedded Chromium and the production HTTP client.
/// Automatic approval is restricted to the disposable localhost test page.
@main struct DesktopToolsProviderHarness {
    @MainActor static func main() {
        let app = NSApplication.shared; app.setActivationPolicy(.regular)
        Task { @MainActor in
            do { try await run(); exit(0) }
            catch { print("FAIL Desktop provider: \(error.localizedDescription)"); exit(1) }
        }
        app.run()
    }
    @MainActor static func run() async throws {
        guard CommandLine.arguments.count == 5, let fixture = URL(string: CommandLine.arguments[3]), fixture.host == "127.0.0.1" else { throw HostAssistantError.emptyReply }
        let delegate = MultiVibeMenuBarApp(port: CommandLine.arguments[1], key: CommandLine.arguments[4]); NSApp.delegate = delegate
        let session = CommandLine.arguments[2], conversation = UUID(), controller = ComputerUseController()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 740, height: 560), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "MultiVibe · Validation des outils Host"
        window.contentView = NSHostingView(rootView: ChromiumBrowserPanel(browser: controller.browser))
        window.center(); window.makeKeyAndOrderFront(nil)
        let approval = Task { @MainActor in
            while !Task.isCancelled {
                if controller.approval != nil { controller.resolveApproval(1) }
                try? await Task.sleep(nanoseconds: 10_000_000)
            }
        }
        defer { approval.cancel(); controller.releaseExternal(conversation: conversation); controller.browser.close(); ChromiumRuntime.stop(); withExtendedLifetime((delegate, window)) {} }
        let client = DesktopHarnessClient.shared
        let attached = try await client.call("/sessions/\(session)/desktop/attach", method: "POST", body: .object([:]))
        guard let lease = attached["lease"].string else { throw HostAssistantError.emptyReply }
        var executed = false
        while true {
            let request = try await client.call("/sessions/\(session)/desktop/next", method: "POST", body: .object(["lease": .string(lease)]))
            if request["release"] == .bool(true) {
                controller.releaseExternal(conversation: conversation)
                if executed { print("PASS native Host provider, scoped requests, real Chromium actions and release"); return }
            }
            guard let id = request["id"].string else { continue }
            let command = try request["command"].decode(ComputerUseCommand.self)
            guard command.target == "browser", command.action != "navigate" || command.url == fixture.absoluteString else { throw ComputerUseFailure("Test commands must target the disposable local browser fixture") }
            let result: HarnessJSON
            do {
                let content = try await controller.executeExternal(conversation: conversation, command: command)
                result = .object(["content": try .encode(content)])
                executed = true
            } catch { result = .object(["isError": .bool(true), "content": .array([.object(["type": .string("text"), "text": .string(error.localizedDescription)])])]) }
            _ = try await client.call("/sessions/\(session)/desktop/result", method: "POST", body: .object(["lease": .string(lease), "id": .string(id), "result": result]))
        }
    }
}
