import AppKit
import SwiftUI

@main struct ChromiumPanelHarness {
    @MainActor static func main() {
        let app = NSApplication.shared; app.setActivationPolicy(.regular)
        Task { @MainActor in
            do { try await run(); exit(0) }
            catch { print("FAIL Chromium panel: \(error.localizedDescription)"); exit(1) }
        }
        app.run()
    }
    @MainActor static func run() async throws {
        guard CommandLine.arguments.count == 2, let url = URL(string: CommandLine.arguments[1]), url.host == "127.0.0.1" else { throw ComputerUseFailure("Expected a local fixture URL") }
        guard ChromiumRuntime.start() else { throw ComputerUseFailure(ChromiumRuntime.error ?? "Chromium unavailable") }
        let browser = ChromiumBrowser(), origin = try ComputerUsePolicy.origin(url.absoluteString)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 700), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "MultiVibe · Navigateur"
        window.contentView = NSHostingView(rootView: ChromiumBrowserPanel(browser: browser))
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        browser.allow(origin: origin); browser.navigate(url.absoluteString)
        var observation = try await browser.observe()
        guard observation.text.contains("\"engine\":\"Chromium\"") else { throw ComputerUseFailure("The observation did not come from Chromium: \(observation.text.prefix(1000))") }
        let snapshotLine = observation.text.components(separatedBy: "\n").first { $0.hasPrefix("{") } ?? ""
        let snapshot = try JSONSerialization.jsonObject(with: Data(snapshotLine.utf8)) as! [String: Any]
        let elements = snapshot["elements"] as! [[String: Any]]
        let input = elements.first { $0["label"] as? String == "Votre texte" }!["id"] as! Int
        try await browser.perform(.init(action: "type", target: "browser", observation: observation.id, element: input, text: "Validation Chromium"))
        observation = try await browser.observe()
        let second = try JSONSerialization.jsonObject(with: Data(observation.text.components(separatedBy: "\n").first { $0.hasPrefix("{") }!.utf8)) as! [String: Any]
        let button = (second["elements"] as! [[String: Any]]).first { $0["label"] as? String == "Vérifier" }!["id"] as! Int
        try await browser.perform(.init(action: "click", target: "browser", observation: observation.id, element: button))
        observation = try await browser.observe()
        guard observation.text.contains("Chromium confirmé : Validation Chromium"), observation.imageURL?.hasPrefix("data:image/jpeg;base64,") == true else { throw ComputerUseFailure("The final Chromium result was not verified") }
        if let content = window.contentView, let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) {
            content.cacheDisplay(in: content.bounds, to: bitmap)
            if let png = bitmap.representation(using: .png, properties: [:]) { try png.write(to: URL(fileURLWithPath: "/tmp/MULTIVIBE-138-chromium-panel.png")) }
        }
        print("PASS real embedded Chromium panel, isolated profile, CDP observation, JPEG capture, input and trusted click")
        browser.close(); ChromiumRuntime.stop(); withExtendedLifetime((browser, window)) {}
    }
}
