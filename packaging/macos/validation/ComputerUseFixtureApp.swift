import AppKit

/// Visible, disposable target for native AX/input/capture validation. No production data.
@main final class ComputerUseFixtureApp: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let input = NSTextField(string: "")
    let result = NSTextField(labelWithString: "En attente native")
    static func main() {
        let app = NSApplication.shared
        let delegate = ComputerUseFixtureApp(); app.delegate = delegate
        app.setActivationPolicy(.regular); app.run()
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 350), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Recette native"
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 350))
        let title = NSTextField(labelWithString: "Recette native MultiVibe")
        title.font = .systemFont(ofSize: 25, weight: .semibold); title.frame = NSRect(x: 30, y: 270, width: 580, height: 40)
        input.frame = NSRect(x: 30, y: 210, width: 580, height: 32); input.setAccessibilityLabel("Texte de recette")
        let button = NSButton(title: "Valider la recette", target: self, action: #selector(verify))
        button.frame = NSRect(x: 30, y: 145, width: 220, height: 38)
        result.frame = NSRect(x: 30, y: 75, width: 580, height: 45); result.setAccessibilityLabel("Résultat natif")
        for view in [title, input, button, result] { content.addSubview(view) }
        window.contentView = content; window.center(); window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(input)
        NSApp.activate(ignoringOtherApps: true)
        if CommandLine.arguments.count > 1 { try? String(ProcessInfo.processInfo.processIdentifier).write(toFile: CommandLine.arguments[1], atomically: true, encoding: .utf8) }
    }
    @objc func verify() { result.stringValue = "Native confirmé : " + input.stringValue }
}
