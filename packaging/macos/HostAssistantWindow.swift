import AppKit
import SwiftUI

@MainActor
final class HostAssistantWindow: NSWindowController {
    let store = NativeChatStore()
    init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1060, height: 740), styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "MultiVibe"
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 760, height: 540)
        window.setFrameAutosaveName("MultiVibeNativeChat")
        window.contentView = NSHostingView(rootView: NativeChatView(store: store))
        window.isReleasedWhenClosed = false
        window.center()
        super.init(window: window)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
}

extension MultiVibeMenuBarApp {
    @MainActor func showAssistant(text: String = "") {
        let controller: HostAssistantWindow
        if let existing = assistantWindows.first { controller = existing }
        else {
            controller = HostAssistantWindow()
            assistantWindows = [controller]
        }
        if !text.isEmpty { controller.store.newConversation(text: text) }
        NSApplication.shared.setActivationPolicy(.regular)
        controller.showWindow(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Activating the menu bar popover also triggers this delegate callback.
        // Only a Dock reopen should bring up the chat in that case.
        guard !popover.isShown, !notificationPopover.isShown else { return false }
        Task { @MainActor in self.showAssistant() }
        return true
    }
    @objc func askFromMenu() { Task { @MainActor in self.showAssistant(); self.assistantWindows.first?.store.newConversation() } }
    @objc func askSelection(_ pasteboard: NSPasteboard, userData: String?, error: AutoreleasingUnsafeMutablePointer<NSString>) {
        guard let text = pasteboard.string(forType: .string), !text.isEmpty, text.count <= 32_000 else {
            error.pointee = "Sélectionnez entre 1 et 32 000 caractères."; return
        }
        Task { @MainActor in self.showAssistant(text: text) }
    }
    func configureAssistantIntegration() {
        NSApplication.shared.servicesProvider = self
        NSUpdateDynamicServices()
        let mainMenu = NSMenu()
        let applicationItem = NSMenuItem()
        let applicationMenu = NSMenu(title: "MultiVibe Host")
        let ask = NSMenuItem(title: "Nouvelle conversation", action: #selector(askFromMenu), keyEquivalent: "n")
        ask.target = self
        applicationMenu.addItem(ask)
        let services = NSMenu(title: "Services")
        let servicesItem = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        servicesItem.submenu = services
        applicationMenu.addItem(servicesItem)
        NSApplication.shared.servicesMenu = services
        applicationMenu.addItem(withTitle: "Quitter MultiVibe Host", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        applicationItem.submenu = applicationMenu; mainMenu.addItem(applicationItem)
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Édition")
        for (title, selector, key) in [
            ("Annuler", "undo:", "z"), ("Couper", "cut:", "x"),
            ("Copier", "copy:", "c"), ("Coller", "paste:", "v"),
            ("Tout sélectionner", "selectAll:", "a")
        ] { editMenu.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key) }
        editItem.submenu = editMenu; mainMenu.addItem(editItem)
        NSApplication.shared.mainMenu = mainMenu
        HostAppShortcuts.updateAppShortcutParameters()
    }
}
