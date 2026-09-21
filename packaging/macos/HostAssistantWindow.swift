import AppKit
import SwiftUI

@MainActor
final class HostAssistantWindow: NSWindowController {
    init(text: String) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 580), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Demander à MultiVibe"
        window.contentView = NSHostingView(rootView: HostAssistantView(initialText: text))
        window.isReleasedWhenClosed = false
        window.center()
        super.init(window: window)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
}

private struct HostAssistantView: View {
    let initialText: String
    @State private var prompt = ""
    @State private var models: [HostAssistantModel] = []
    @State private var model = ""
    @State private var reply = ""
    @State private var error = ""
    @State private var running: Task<Void, Never>?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Picker("Modèle", selection: $model) {
                    Text("Choisir un modèle").tag("")
                    ForEach(models) { Text($0.id).tag($0.id) }
                }
                Button { Task { await loadModels() } } label: { Image(systemName: "arrow.clockwise") }
                    .help("Actualiser les modèles")
            }
            TextEditor(text: $prompt).frame(minHeight: 100).accessibilityLabel("Question")
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
            HStack {
                Text("Le texte sera envoyé au fournisseur du modèle choisi.").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if busy { Button("Annuler") { running?.cancel() } }
                else { Button("Envoyer", action: send).keyboardShortcut(.return, modifiers: .command).disabled(model.isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }
            if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            Divider()
            ScrollView { Text(reply.isEmpty ? "La réponse apparaîtra ici." : reply).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(minHeight: 180)
            HStack {
                Button("Copier la réponse") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(reply, forType: .string) }.disabled(reply.isEmpty)
                Spacer()
                Button("Utiliser ce modèle par défaut") { HostAssistantClient.shared.defaultModel = model }.disabled(model.isEmpty)
            }
        }
        .padding(20).frame(minWidth: 480, minHeight: 450)
        .task { prompt = initialText; await loadModels() }
        .onDisappear { running?.cancel() }
    }
    private func loadModels() async {
        do {
            models = try await HostAssistantClient.shared.models()
            let preferred = HostAssistantClient.shared.defaultModel
            if model.isEmpty, models.contains(where: { $0.id == preferred }) { model = preferred }
            error = ""
        } catch { self.error = error.localizedDescription }
    }
    private func send() {
        busy = true; error = ""; reply = ""
        let submittedPrompt = prompt, submittedModel = model
        running = Task { @MainActor in
            defer { busy = false; running = nil }
            do { reply = try await HostAssistantClient.shared.ask(submittedPrompt, model: submittedModel) }
            catch is CancellationError { error = "Demande annulée." }
            catch { self.error = Task.isCancelled ? "Demande annulée." : error.localizedDescription }
        }
    }
}

extension MultiVibeMenuBarApp {
    @MainActor func showAssistant(text: String = "") {
        let controller = HostAssistantWindow(text: text)
        assistantWindows.removeAll { $0.window?.isVisible != true }
        assistantWindows.append(controller)
        controller.showWindow(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        Task { @MainActor in self.showAssistant() }
        return true
    }
    @objc func askFromMenu() { Task { @MainActor in self.showAssistant() } }
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
        let ask = NSMenuItem(title: "Demander à MultiVibe…", action: #selector(askFromMenu), keyEquivalent: "n")
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
