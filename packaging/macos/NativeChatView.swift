import AppKit
import SwiftUI
import UniformTypeIdentifiers
import AVFoundation

private enum ChatPalette {
    static let accent = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0.45, green: 0.97, blue: 0.73, alpha: 1)
            : NSColor(srgbRed: 0.03, green: 0.45, blue: 0.26, alpha: 1)
    })
}

@MainActor struct NativeChatView: View {
    @ObservedObject var store: NativeChatStore
    @State private var search = ""
    @State private var models: [HostAssistantModel] = []
    @State private var loading = false
    @State private var importing = false
    @State private var deleteID: UUID?
    @State private var speech = AVSpeechSynthesizer()
    @FocusState private var composing: Bool

    private var draft: Binding<String> { Binding(get: { store.current?.draft ?? "" }, set: { value in store.edit { $0.draft = value } }) }
    private var model: Binding<String> { Binding(get: { store.current?.model ?? "" }, set: { value in store.edit { $0.model = value }; HostAssistantClient.shared.defaultModel = value }) }
    private var visible: [NativeChatConversation] {
        store.conversations.filter { (!$0.messages.isEmpty || !$0.draft.isEmpty) && (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) || $0.messages.contains { $0.content.localizedCaseInsensitiveContains(search) }) }
            .sorted { $0.updatedAt > $1.updatedAt }
    }
    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                HStack {
                    Image(systemName: "waveform.path").foregroundStyle(ChatPalette.accent)
                    Text("MultiVibe").font(.title3.weight(.semibold))
                    Spacer()
                    Button { store.newConversation(); composing = true } label: { Image(systemName: "square.and.pencil") }
                        .buttonStyle(.borderless).help("Nouvelle conversation (⌘N)")
                }.padding()
                TextField("Rechercher", text: $search).textFieldStyle(.roundedBorder).padding(.horizontal).padding(.bottom, 12)
                ScrollView {
                    LazyVStack(spacing: 4) {
                    ForEach(visible) { conversation in
                        Button { store.selection = conversation.id } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(conversation.title).lineLimit(2).foregroundStyle(.primary)
                                Text(conversation.updatedAt, style: .date).font(.caption).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(10)
                            .background(store.selection == conversation.id ? ChatPalette.accent.opacity(0.14) : Color.clear, in: RoundedRectangle(cornerRadius: 9))
                        }.buttonStyle(.plain).contextMenu {
                            Button("Supprimer", role: .destructive) { deleteID = conversation.id }.disabled(store.generating == conversation.id)
                        }
                    }
                    }.padding(.horizontal, 8)
                }
                Divider()
                Button { openDashboard() } label: { Label("Dashboard du Host", systemImage: "slider.horizontal.3").frame(maxWidth: .infinity, alignment: .leading) }
                    .buttonStyle(.plain).padding()
                Text("Historique conservé sur ce Mac").font(.caption2).foregroundStyle(.secondary).padding(.bottom, 12)
            }.navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 340)
        } detail: {
            VStack(spacing: 0) {
                header
                Divider()
                if let conversation = store.current, !conversation.messages.isEmpty { transcript(conversation) }
                else { welcome }
                if let error = store.error {
                    HStack(alignment: .top) {
                        Image(systemName: "exclamationmark.circle")
                        Text(error).textSelection(.enabled)
                        Spacer()
                        Button { store.error = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain).help("Masquer l’erreur")
                    }.font(.callout).foregroundStyle(.red).padding(12)
                }
                composer
            }.background(Color(nsColor: .textBackgroundColor))
        }
        .tint(ChatPalette.accent)
        .frame(minWidth: 760, minHeight: 500)
        .task {
            if store.current == nil { store.newConversation() }
            await loadModels()
        }
        .onChange(of: store.selection) { _ in speech.stopSpeaking(at: .immediate) }
        .alert("Supprimer cette conversation ?", isPresented: Binding(get: { deleteID != nil }, set: { if !$0 { deleteID = nil } })) {
            Button("Annuler", role: .cancel) { deleteID = nil }
            Button("Supprimer", role: .destructive) { if let id = deleteID { store.delete(id) }; deleteID = nil; if store.current == nil { store.newConversation() } }
        } message: { Text("Elle sera supprimée de l’historique de ce Mac.") }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.plainText, .sourceCode, .json], allowsMultipleSelection: false) { result in
            do {
                guard let url = try result.get().first else { return }
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= 100_000 else { throw HostAssistantError.invalidInput }
                let text = try String(contentsOf: url, encoding: .utf8)
                let combined = draft.wrappedValue + "\n\nDocument : \(url.lastPathComponent)\n\(text)"
                guard combined.count <= 32_000 else { throw HostAssistantError.invalidInput }
                draft.wrappedValue = combined
                composing = true
            } catch { store.error = "Import impossible : \(error.localizedDescription)" }
        }
    }
    private var header: some View {
        HStack {
            Text(store.current?.title ?? "Nouvelle conversation").font(.headline).lineLimit(1)
            Spacer()
            Picker("Modèle", selection: model) {
                Text(loading ? "Chargement…" : "Choisir un modèle").tag("")
                if let selected = store.current?.model, !selected.isEmpty, !models.contains(where: { $0.id == selected }) { Text("\(selected) — indisponible").tag(selected) }
                ForEach(models) { Text($0.id).tag($0.id) }
            }.labelsHidden().frame(maxWidth: 300).disabled(store.generating == store.selection)
            Button { Task { await loadModels() } } label: { Image(systemName: "arrow.clockwise") }.help("Actualiser les modèles").disabled(loading)
        }.padding(16)
    }
    private var welcome: some View {
        VStack(spacing: 22) {
            Spacer()
            Image(systemName: "waveform.path").font(.system(size: 48, weight: .light)).foregroundStyle(ChatPalette.accent)
            Text("Que souhaitez-vous explorer ?").font(.system(size: 26, weight: .semibold))
            VStack(spacing: 10) {
                suggestion("Trouver l’inspiration", icon: "lightbulb", text: "Aide-moi à trouver des idées pour ")
                suggestion("M’aider à écrire", icon: "pencil.line", text: "Aide-moi à rédiger ")
                suggestion("Comprendre un sujet", icon: "text.book.closed", text: "Explique-moi simplement ")
            }.frame(maxWidth: 320)
            if !loading && models.isEmpty {
                Button("Connecter un fournisseur dans le dashboard") { openDashboard() }.buttonStyle(.link)
            }
            Spacer()
        }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private func suggestion(_ title: String, icon: String, text: String) -> some View {
        Button { draft.wrappedValue = text; composing = true } label: {
            HStack { Image(systemName: icon).frame(width: 24).foregroundStyle(ChatPalette.accent); Text(title); Spacer(); Image(systemName: "arrow.up.left").foregroundStyle(.secondary) }.padding(12)
                .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 12))
        }.buttonStyle(.plain)
    }
    private func transcript(_ conversation: NativeChatConversation) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    ForEach(conversation.messages) { message in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(message.role == "user" ? "Vous" : "MultiVibe").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                Spacer()
                                if !message.content.isEmpty {
                                    Button { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(message.content, forType: .string) } label: { Image(systemName: "doc.on.doc") }.help("Copier")
                                    if message.role == "assistant" {
                                        Button { if speech.isSpeaking { speech.stopSpeaking(at: .immediate) } else { speech.speak(AVSpeechUtterance(string: message.content)) } } label: { Image(systemName: "speaker.wave.2") }.help("Lire ou arrêter la lecture")
                                    }
                                }
                            }.buttonStyle(.borderless)
                            if message.content.isEmpty && store.generating == conversation.id && message.role == "assistant" { ProgressView().controlSize(.small) }
                            else { Text(markdown(message.content)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).font(.system(size: 15)).lineSpacing(5) }
                            if message.interrupted && store.generating != conversation.id {
                                HStack { Text("Réponse interrompue").font(.caption).foregroundStyle(.secondary); if message.id == conversation.messages.last?.id { Button("Réessayer") { store.send(retry: true) }.disabled(store.generating != nil) } }
                            }
                        }.padding(16).background(message.role == "user" ? ChatPalette.accent.opacity(0.08) : Color.clear, in: RoundedRectangle(cornerRadius: 16)).id(message.id)
                    }
                    Color.clear.frame(height: 1).id("end")
                }.padding(20).frame(maxWidth: 850).frame(maxWidth: .infinity)
            }
            .onChange(of: conversation.messages.count) { _ in proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: conversation.id) { _ in proxy.scrollTo("end", anchor: .bottom) }
        }
    }
    private var composer: some View {
        VStack(spacing: 10) {
            TextEditor(text: draft).font(.system(size: 15)).scrollContentBackground(.hidden).focused($composing)
                .frame(minHeight: 64, maxHeight: 140).padding(8).accessibilityLabel("Message à MultiVibe")
            HStack {
                Button { importing = true } label: { Image(systemName: "paperclip") }.help("Joindre un document texte")
                Text("⌘↵ pour envoyer").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if store.generating != nil {
                    Button("Arrêter", systemImage: "stop.fill") { store.stop() }
                } else {
                    Button { store.send() } label: { Label("Envoyer", systemImage: "arrow.up") }
                        .buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command)
                        .disabled(draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !models.contains { $0.id == model.wrappedValue })
                }
            }.padding(.horizontal, 8).padding(.bottom, 8)
        }.padding(8).background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(ChatPalette.accent.opacity(store.generating == store.selection ? 0.6 : 0.15), lineWidth: 1))
            .padding(.horizontal, 20).padding(.top, 8)
            .safeAreaInset(edge: .bottom) { Text("Les messages et documents sont transmis au modèle choisi via le Host.").font(.caption2).foregroundStyle(.secondary).padding(.vertical, 8) }
    }
    private func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
    private func loadModels() async {
        guard !loading else { return }
        loading = true; defer { loading = false }
        do { models = try await HostAssistantClient.shared.models() }
        catch { store.error = error.localizedDescription }
    }
    private func openDashboard() { (NSApplication.shared.delegate as? MultiVibeMenuBarApp)?.openDashboard() }
}
