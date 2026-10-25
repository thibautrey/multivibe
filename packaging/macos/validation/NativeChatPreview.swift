import AppKit
import SwiftUI

// Compiled only by preview-macos-chat.mjs with a generated, non-@main app delegate.
// The fixture Host, history, preferences and Cloud storage are isolated from the user.
@main enum NativeChatPreview {
    static func main() {
        let application = NSApplication.shared
        let delegate = ChatPreviewDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }
}

@MainActor final class ChatPreviewDelegate: MultiVibeMenuBarApp {
    private var chatWindow: NSWindow?
    private var previewStore: NativeChatStore?
    override func applicationDidFinishLaunching(_ notification: Notification) {
        operational = true
        dashboardURL = URL(string: ProcessInfo.processInfo.environment["MULTIVIBE_UI_PREVIEW_URL"]!)!
        Task {
            do {
                let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["MULTIVIBE_HOST_DATA_DIR"]!)
                let (data, _) = try await URLSession.shared.data(from: dashboardURL.appendingPathComponent("preview/seed"))
                let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
                let conversations = try decoder.decode([NativeChatConversation].self, from: data)
                let file = root.appendingPathComponent("conversations.json")
                try JSONEncoder().encode(conversations).write(to: file, options: .atomic)
                let store = NativeChatStore(file: file)
                previewStore = store
                let cloud = try NativeCloudSession(storage: .init(load: { nil }, save: { _ in }, clear: {}), transport: { _ in throw HostAssistantError.unavailable })
                let agent = NativeChatAgentCoordinator(session: cloud, root: root.appendingPathComponent("cloud"))
                let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780), styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false)
                window.title = "MultiVibe UI Preview"
                window.titleVisibility = .hidden
                window.titlebarAppearsTransparent = true
                window.titlebarSeparatorStyle = .none
                window.toolbarStyle = .unifiedCompact
                window.isMovableByWindowBackground = true
                window.backgroundColor = .textBackgroundColor
                window.minSize = NSSize(width: 760, height: 540)
                window.contentView = FullSizeHostingView(rootView: NativeChatView(store: store, agent: agent))
                window.setContentSize(NSSize(width: 1180, height: 780))
                window.isReleasedWhenClosed = false
                window.center(); window.makeKeyAndOrderFront(nil)
                chatWindow = window
                configurePreviewMenu()
                NSApplication.shared.activate(ignoringOtherApps: true)
            } catch { fputs("Preview failed: \(error)\n", stderr); NSApplication.shared.terminate(nil) }
        }
    }
    private func configurePreviewMenu() {
        let menu = NSMenu()
        let application = NSMenuItem(); application.submenu = NSMenu(title: "MultiVibe UI Preview")
        application.submenu?.addItem(withTitle: "Quitter", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(application)
        let edit = NSMenuItem(); edit.submenu = NSMenu(title: "Édition")
        for (title, selector, key) in [("Annuler", "undo:", "z"), ("Couper", "cut:", "x"), ("Copier", "copy:", "c"), ("Coller", "paste:", "v"), ("Tout sélectionner", "selectAll:", "a")] {
            edit.submenu?.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        menu.addItem(edit)
        let scenes = NSMenuItem(); scenes.submenu = NSMenu(title: "Scénarios")
        for (index, title) in ["Accueil", "Conversation", "Travail et file", "Question", "Erreur", "Fenêtre étroite", "Fenêtre large", "Clair", "Sombre", "Panneau navigateur"].enumerated() {
            let shortcut = index < 9 ? String(index + 1) : ""
            let item = NSMenuItem(title: title, action: #selector(selectScene(_:)), keyEquivalent: shortcut); item.target = self; item.tag = index
            scenes.submenu?.addItem(item)
        }
        menu.addItem(scenes); NSApplication.shared.mainMenu = menu
    }
    @objc private func selectScene(_ sender: NSMenuItem) {
        guard let store = previewStore, let window = chatWindow else { return }
        if sender.tag < 5 {
            store.selection = store.conversations[sender.tag].id
            store.error = sender.tag == 4 ? "2026-10-25 15:12:42 [ERROR] Streaming failed before delivery: Connection error.\nTraceback (most recent call last):\n  File \"internal.py\", line 101, in connect\n    raise ConnectionError()" : nil
        } else if sender.tag == 5 { window.setContentSize(NSSize(width: 760, height: 650)) }
        else if sender.tag == 6 { window.setContentSize(NSSize(width: 1180, height: 780)) }
        else if sender.tag == 7 { window.appearance = NSAppearance(named: .aqua) }
        else if sender.tag == 8 { window.appearance = NSAppearance(named: .darkAqua) }
        else { store.computer.browser.show() }
    }
    override func applicationWillTerminate(_ notification: Notification) {}
}
