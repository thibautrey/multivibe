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
    static let surface = Color(nsColor: .controlBackgroundColor)
    static let canvas = Color(nsColor: .textBackgroundColor)
    static let elevated = Color(nsColor: .windowBackgroundColor)
    static let hairline = Color(nsColor: .separatorColor).opacity(0.55)
}

private struct HarnessLogo: View {
    @Environment(\.colorScheme) private var colorScheme
    let id: String
    let name: String
    var size: CGFloat

    private var resource: (String, String) {
        switch id {
        case "hermes-agent": return (colorScheme == .dark ? "hermes-dark" : "hermes-light", "png")
        case "pi": return ("pi", "svg")
        default: return ("multivibe", "png")
        }
    }

    var body: some View {
        Group {
            if id == "computer-use" {
                Image(systemName: "cursorarrow.motionlines").resizable().scaledToFit().foregroundStyle(.secondary)
            } else if let url = Bundle.main.url(forResource: resource.0, withExtension: resource.1, subdirectory: "harnesses"),
               let image = NSImage(contentsOf: url) {
                Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
            } else {
                Text(name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased())
                    .font(.system(size: size * 0.32, weight: .bold, design: .rounded))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

@MainActor struct NativeChatView: View {
    @ObservedObject var store: NativeChatStore
    @StateObject private var agent: NativeChatAgentCoordinator
    @State private var cloudConsent = false
    @State private var cloudMode = false
    @State private var cloudSelection: UUID?
    @State private var cloudModel = ""
    @State private var cloudDraft = ""
    @State private var cloudSending = false
    @State private var cloudTask: Task<Void, Never>?
    @State private var selectedImports: Set<UUID> = []
    @State private var search = ""
    @AppStorage("desktopInteractiveAnswers") private var interactiveAnswers = true
    @State private var models: [HostAssistantModel] = []
    @State private var harnesses: [NativeConversationHarness] = [.native, .computerUse]
    @State private var choosingHarness = false
    @State private var installingHarness: NativeConversationHarness?
    @State private var installationLogs: [String] = []
    @State private var installationRunning = false
    @State private var installationError: String?
    @State private var showingInstallationLogs = false
    @State private var harnessLastUsedAt: [String: Double] = UserDefaults.standard.dictionary(forKey: "assistantHarnessLastUsedAt") as? [String: Double] ?? [:]
    @State private var loading = false
    @State private var importing = false
    @State private var deleteID: UUID?
    @State private var speech = AVSpeechSynthesizer()
    @FocusState private var composing: Bool

    init(store: NativeChatStore, agent: NativeChatAgentCoordinator? = nil) {
        self.store = store
        _agent = StateObject(wrappedValue: agent ?? NativeChatAgentCoordinator())
    }

    private var draft: Binding<String> { Binding(get: { cloudMode ? cloudDraft : (store.current?.draft ?? "") }, set: { value in
        if cloudMode { cloudDraft = value } else { store.edit { $0.draft = value } }
    }) }
    private var model: Binding<String> { Binding(get: { store.current?.model ?? "" }, set: { value in store.edit { $0.model = value }; HostAssistantClient.shared.defaultModel = value }) }
    private var harness: Binding<String> { Binding(get: { store.current?.harnessID ?? "native" }, set: { value in
        store.edit { conversation in
            conversation.harnessID = value == "native" ? nil : value
            conversation.harnessSessionID = nil
        }
        NativeChatStore.defaultHarnessID = value
        if value != "native", selectedLocalModel?.local == true, let remote = models.first(where: { $0.local != true }) {
            model.wrappedValue = remote.id
        } else if value != "native", selectedLocalModel?.local == true {
            store.error = "Ce harness nécessite un modèle fourni par le Host. Connectez un fournisseur ou choisissez MultiVibe natif."
        }
    }) }
    private var visible: [NativeChatConversation] {
        store.conversations.filter { (!$0.messages.isEmpty || !$0.draft.isEmpty) && (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) || $0.messages.contains { $0.content.localizedCaseInsensitiveContains(search) }) }
            .sorted { $0.updatedAt > $1.updatedAt }
    }
    private var selectedLocalModel: HostAssistantModel? {
        models.first { $0.id == model.wrappedValue }
    }
    private var selectedCloudModel: NativeAgentCatalogModel? {
        agent.models.first { $0.id == cloudModel }
    }
    private var selectedHarness: NativeConversationHarness {
        harnesses.first { $0.id == harness.wrappedValue } ?? .init(
            id: harness.wrappedValue, name: harness.wrappedValue, available: false, configured: false,
            description: "Ce harness n’est plus disponible sur ce Mac.",
            capabilities: .init(sessions: true, streaming: true, tools: false, longTermMemory: false),
            unavailableReason: "Ce harness n’est plus disponible sur ce Mac.", canInstall: false, compatible: false,
            detected: false, conversationCapable: false, category: nil, popularityRank: nil
        )
    }
    private var selectedModelName: String {
        if cloudMode { return selectedCloudModel?.name ?? selectedCloudModel?.id ?? "Choisir un modèle" }
        return selectedLocalModel?.displayName ?? (model.wrappedValue.isEmpty ? "Choisir un modèle" : model.wrappedValue)
    }
    private var conversationSubtitle: String {
        if cloudMode { return "Hermes Cloud" }
        if harness.wrappedValue != "native" { return "Orchestré par \(selectedHarness.name) · sur ce Mac" }
        if selectedLocalModel?.local == true { return "Privée · sur ce Mac" }
        return "Privée · via le Host"
    }
    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                sidebarHeader
                sidebarPrimaryActions
                HStack {
                    Text(cloudMode ? "ESPACE CLOUD" : "RÉCENTES").font(.caption2.weight(.semibold)).foregroundStyle(.tertiary)
                    Spacer()
                }.padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 7)
                ScrollView {
                    LazyVStack(spacing: 4) {
                    if cloudMode {
                        let cloudVisible = agent.cloudConversations.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) }
                        if cloudVisible.isEmpty {
                            Text(search.isEmpty ? "Aucune conversation Cloud" : "Aucun résultat")
                                .font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(10)
                        }
                        ForEach(cloudVisible) { conversation in
                            Button { cloudSelection = conversation.id } label: {
                                HStack(alignment: .top, spacing: 8) {
                                    Image(systemName: "cloud").font(.caption).foregroundStyle(.secondary).padding(.top, 2)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(conversation.title).lineLimit(2)
                                        if conversation.conflicted { Text("Conflit à résoudre").font(.caption2).foregroundStyle(.orange) }
                                    }
                                }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 9).padding(.vertical, 8)
                                    .background(cloudSelection == conversation.id ? ChatPalette.accent.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                            }.buttonStyle(.plain)
                        }
                    } else {
                    if visible.isEmpty {
                        Text(search.isEmpty ? "Aucune conversation pour le moment" : "Aucun résultat")
                            .font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(10)
                    }
                    ForEach(visible) { conversation in
                        Button { store.selection = conversation.id } label: {
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: "bubble.left").font(.caption).foregroundStyle(.secondary).padding(.top, 2)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(conversation.title).lineLimit(2).foregroundStyle(.primary)
                                    Text(conversation.updatedAt, style: .relative).font(.caption2).foregroundStyle(.secondary)
                                }
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 9).padding(.vertical, 8)
                            .background(store.selection == conversation.id ? ChatPalette.accent.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                        }.buttonStyle(.plain).contextMenu {
                            Button("Supprimer", role: .destructive) { deleteID = conversation.id }.disabled(store.generating == conversation.id)
                        }
                    }
                    }
                    }.padding(.horizontal, 8)
                }
                Divider()
                sidebarFooter
            }
            .background(ChatPalette.elevated)
            .navigationSplitViewColumnWidth(min: 224, ideal: 252, max: 310)
        } detail: {
            VStack(spacing: 0) {
                header
                Divider()
                if cloudMode { cloudTranscript }
                else if let conversation = store.current, !conversation.messages.isEmpty { transcript(conversation) }
                else { welcome }
                if let error = store.error {
                    HStack(alignment: .top) {
                        Image(systemName: "exclamationmark.circle")
                        Text(error).textSelection(.enabled)
                        Spacer()
                        Button { store.error = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain).help("Masquer l’erreur")
                    }.font(.callout).foregroundStyle(.red).padding(12)
                }
                if !cloudMode, harness.wrappedValue == "computer-use" {
                    ComputerUsePanel(controller: store.computer, conversation: store.selection,
                        savedEvents: store.current?.computerUseEvents ?? [], stop: { store.stop() })
                }
                composer
            }.background(ChatPalette.canvas)
        }
        .tint(ChatPalette.accent)
        .frame(minWidth: 760, minHeight: 500)
        .task {
            if store.current == nil { store.newConversation() }
            await agent.restore()
            await loadModels()
            await loadHarnesses()
        }
        .sheet(isPresented: $cloudConsent) { consentSheet }
        .sheet(item: $installingHarness) { item in harnessInstallationSheet(item) }
        .onChange(of: agent.accountID) { _ in
            cloudTask?.cancel(); cloudSending = false; cloudDraft = ""; cloudModel = ""; cloudSelection = nil
            if agent.accountID == nil { cloudMode = false }
        }
        .onChange(of: cloudSelection) { _ in cloudDraft = "" }
        .onChange(of: cloudMode) { enabled in
            if enabled && store.computer.running { store.stop() }
            if enabled { Task { do { try await agent.loadModels(); cloudModel = agent.models.first?.id ?? ""; cloudSelection = agent.cloudConversations.first?.id } catch { agent.error = error.localizedDescription } } }
        }
        .onChange(of: store.selection) { selection in
            speech.stopSpeaking(at: .immediate)
            if store.computer.running && store.computer.conversationID != selection { store.stop() }
        }
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
    private var sidebarHeader: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 9).fill(ChatPalette.accent.opacity(0.13))
                    Image(systemName: "waveform.path").font(.system(size: 15, weight: .semibold)).foregroundStyle(ChatPalette.accent)
                }.frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text("MultiVibe").font(.headline.weight(.semibold))
                    Text(cloudMode ? "Espace agent" : "Host personnel").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Button { openDashboard() } label: { Image(systemName: "gearshape") }
                    .buttonStyle(.plain).foregroundStyle(.secondary).help("Réglages du Host")
            }
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass").font(.caption).foregroundStyle(.tertiary)
                TextField("Rechercher", text: $search).textFieldStyle(.plain)
                if !search.isEmpty {
                    Button { search = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 10).frame(height: 30)
            .background(ChatPalette.surface, in: RoundedRectangle(cornerRadius: 8))
        }.padding(.horizontal, 12).padding(.top, 13).padding(.bottom, 7)
    }
    private var sidebarPrimaryActions: some View {
        VStack(spacing: 2) {
            sidebarAction("Nouvelle conversation", systemImage: "square.and.pencil") {
                if cloudMode { Task { do { cloudSelection = try await agent.newCloudConversation() } catch { agent.error = error.localizedDescription } } }
                else { store.newConversation() }
                composing = true
            }
            sidebarAction("Modèles et fournisseurs", systemImage: "square.grid.2x2") { openDashboard() }
        }.padding(.horizontal, 8)
    }
    private func sidebarAction(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 9).padding(.vertical, 8)
                .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
    private var sidebarFooter: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 9) {
                ZStack {
                    Circle().fill(ChatPalette.accent.opacity(0.13))
                    Image(systemName: agent.accountID == nil ? "desktopcomputer" : "person.crop.circle.badge.checkmark")
                        .font(.caption).foregroundStyle(ChatPalette.accent)
                }.frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 1) {
                    Text(agent.accountID == nil ? "Sur ce Mac" : "Cloud connecté").font(.caption.weight(.semibold))
                    Text(agent.accountID == nil ? "Historique local" : "Hermes disponible").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if agent.busy { ProgressView().controlSize(.mini) }
            }
            if agent.accountID == nil {
                Button("Connecter MultiVibe Cloud") {
                    guard let window = NSApp.keyWindow else { return }
                    Task { await agent.connect(window: window) }
                }.buttonStyle(.borderless)
            } else {
                HStack {
                    Button("Gérer le Cloud") { selectedImports = []; cloudConsent = true }.buttonStyle(.borderless)
                    Spacer()
                    Menu("Actions") {
                        Button("Synchroniser l’espace Cloud") {
                            Task { do { try await agent.synchronize(); try await agent.recoverRuns() } catch { agent.error = error.localizedDescription } }
                        }.disabled(agent.consent?.cloudEnabled != true)
                        Button("Réessayer les imports autorisés") { Task { await agent.retryImports() } }
                        ForEach(agent.orderedRuns.filter { $0.state != .completed && $0.state != .cancelled }, id: \.runId) { run in
                            Button("Annuler le run \(run.runId.prefix(8))") {
                                Task { do { try await agent.cancel(runID: run.runId) } catch { agent.error = error.localizedDescription } }
                            }
                        }
                        Divider()
                        Button("Déconnecter le Cloud") { Task { await agent.disconnect() } }
                    }.menuStyle(.borderlessButton)
                }
            }
            if let error = agent.error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
        }.padding(.horizontal, 12).padding(.top, 11).padding(.bottom, 16).disabled(agent.busy)
    }
    private var consentSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Espace agent Cloud").font(.title2.bold())
            Text("En autorisant l’espace Cloud, ses données peuvent être lues par le serveur pour exécuter l’agent. Elles sont chiffrées au repos. Sélectionnez uniquement les conversations de ce Mac que vous souhaitez copier vers votre compte.")
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(store.conversations) { conversation in
                        Toggle(conversation.title, isOn: Binding(get: { selectedImports.contains(conversation.id) }, set: { checked in
                            if checked { selectedImports.insert(conversation.id) } else { selectedImports.remove(conversation.id) }
                        })).disabled(agent.importedConversationIDs.contains(conversation.id))
                        if agent.importedConversationIDs.contains(conversation.id) { Text("Déjà importée").font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }.frame(maxHeight: 240)
            Text("Aucune conversation n’est cochée par défaut. Les clés du Host ne sont jamais transférées.").font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Annuler", role: .cancel) { cloudConsent = false }
                Spacer()
                Button("Autoriser et importer la sélection") {
                    let selected = store.conversations.filter { selectedImports.contains($0.id) }
                    cloudConsent = false
                    Task { await agent.enableCloud(import: selected) }
                }.buttonStyle(.borderedProminent).disabled(agent.busy || agent.consent == nil)
            }
        }.padding(24).frame(width: 520)
    }
    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(cloudMode ? (agent.cloudConversations.first { $0.id == cloudSelection }?.title ?? "Nouvelle conversation Cloud") : (store.current?.title ?? "Nouvelle conversation"))
                    .font(.headline).lineLimit(1)
                Text(conversationSubtitle)
                    .font(.caption2).foregroundStyle(.secondary)
            }.frame(minWidth: 180, maxWidth: .infinity, alignment: .leading)
            if !cloudMode {
                Toggle(isOn: $interactiveAnswers) { Image(systemName: "slider.horizontal.below.rectangle") }
                    .toggleStyle(.button).help("Réponses interactives · OpenIntelligentUI")
                    .accessibilityLabel("Réponses interactives")
            }
            if cloudMode {
                Picker("Projet Hermes", selection: Binding(get: { agent.selectedWorkspaceProject(cloudSelection) }, set: { value in
                    do { try agent.selectWorkspaceProject(value, conversation: cloudSelection) } catch { agent.error = error.localizedDescription }
                })) {
                    Text("Aucun projet").tag("")
                    let selected = agent.selectedWorkspaceProject(cloudSelection)
                    if !selected.isEmpty && !agent.cloudProjects.contains(where: { $0.id == selected }) { Text("Projet indisponible").tag(selected) }
                    ForEach(agent.cloudProjects) { project in Text(project.title).tag(project.id) }
                }
                .labelsHidden().frame(maxWidth: 170).controlSize(.small)
                .disabled(cloudSending || agent.busy || cloudSelection == nil)
            }
            if agent.accountID != nil {
                Picker("Exécution", selection: $cloudMode) {
                    Label("Mac", systemImage: "desktopcomputer").tag(false)
                    Label("Cloud", systemImage: "cloud").tag(true)
                }
                .labelsHidden().pickerStyle(.segmented).frame(width: 142)
                .disabled(cloudSending || store.generating != nil)
            } else {
                Label("Sur ce Mac", systemImage: "lock.fill")
                    .font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    .padding(.horizontal, 9).padding(.vertical, 5)
                    .background(ChatPalette.surface, in: Capsule())
            }
        }
        .padding(.horizontal, 18).padding(.vertical, 10)
        .background(ChatPalette.elevated)
    }
    private var welcome: some View {
        VStack(spacing: 16) {
            Spacer()
            ZStack {
                RoundedRectangle(cornerRadius: 15).fill(ChatPalette.accent.opacity(0.11))
                Image(systemName: "waveform.path").font(.system(size: 24, weight: .medium)).foregroundStyle(ChatPalette.accent)
            }.frame(width: 52, height: 52)
            Text("Comment puis-je vous aider ?").font(.system(size: 25, weight: .semibold))
            Text("Posez une question, rédigez ou explorez une idée.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            HStack(spacing: 10) {
                suggestion("Trouver l’inspiration", icon: "lightbulb", text: "Aide-moi à trouver des idées pour ")
                suggestion("M’aider à écrire", icon: "pencil.line", text: "Aide-moi à rédiger ")
                suggestion("Créer un outil", icon: "slider.horizontal.3", text: "Crée un calculateur interactif pour partager une addition, avec pourboire et nombre de personnes modifiables.")
            }.frame(maxWidth: 760)
            if !loading && models.isEmpty {
                Button("Connecter un fournisseur dans le dashboard") { openDashboard() }.buttonStyle(.link)
            }
            Spacer()
        }.padding(.horizontal, 24).padding(.top, 24).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private func suggestion(_ title: String, icon: String, text: String) -> some View {
        Button { draft.wrappedValue = text; composing = true } label: {
            HStack(spacing: 8) { Image(systemName: icon).foregroundStyle(ChatPalette.accent); Text(title).lineLimit(1) }.padding(.horizontal, 13).padding(.vertical, 10)
                .background(ChatPalette.surface, in: Capsule())
                .overlay(Capsule().stroke(.quaternary, lineWidth: 1))
        }.buttonStyle(.plain)
    }
    private func transcript(_ conversation: NativeChatConversation) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    ForEach(conversation.messages) { message in
                        messageRow(message, conversation: conversation).id(message.id)
                    }
                    Color.clear.frame(height: 1).id("end")
                }.padding(.horizontal, 24).padding(.vertical, 22).frame(maxWidth: 900).frame(maxWidth: .infinity)
            }
            .onChange(of: conversation.messages.count) { _ in proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: conversation.id) { _ in proxy.scrollTo("end", anchor: .bottom) }
        }
    }
    @ViewBuilder private func messageRow(_ message: NativeChatMessage, conversation: NativeChatConversation) -> some View {
        let isUser = message.role == "user"
        HStack(alignment: .top, spacing: 10) {
            if isUser { Spacer(minLength: 80) }
            if !isUser {
                ZStack {
                    RoundedRectangle(cornerRadius: 8).fill(ChatPalette.accent.opacity(0.12))
                    Image(systemName: "waveform.path").font(.caption.weight(.semibold)).foregroundStyle(ChatPalette.accent)
                }.frame(width: 30, height: 30)
            }
            VStack(alignment: isUser ? .trailing : .leading, spacing: 7) {
                HStack(spacing: 8) {
                    if !isUser { Text("MultiVibe").font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
                    if !message.content.isEmpty {
                        Button { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(message.content, forType: .string) } label: { Image(systemName: "doc.on.doc") }.help("Copier")
                        if !isUser {
                            Button { if speech.isSpeaking { speech.stopSpeaking(at: .immediate) } else { speech.speak(AVSpeechUtterance(string: message.content)) } } label: { Image(systemName: "speaker.wave.2") }.help("Lire ou arrêter la lecture")
                        }
                    }
                }.buttonStyle(.borderless).foregroundStyle(.secondary)
                Group {
                    if message.content.isEmpty && store.generating == conversation.id && !isUser {
                        HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Réflexion…").font(.caption).foregroundStyle(.secondary) }
                    } else {
                        if isUser { Text(markdown(message.content)).textSelection(.enabled).font(.system(size: 15)).lineSpacing(5) }
                        else { NativeInteractiveAnswerView(content: message.content, streaming: store.generating == conversation.id && message.id == conversation.messages.last?.id) { text in
                            guard store.selection == conversation.id, store.generating == nil else { return }
                            store.edit { $0.draft = text }; composing = true
                        } }
                    }
                }
                if message.interrupted && store.generating != conversation.id {
                    HStack(spacing: 8) {
                        Label("Réponse interrompue", systemImage: "pause.circle").font(.caption).foregroundStyle(.secondary)
                        if message.id == conversation.messages.last?.id { Button("Réessayer") { store.send(retry: true, interactiveAnswers: interactiveAnswers) }.disabled(store.generating != nil) }
                    }
                }
            }
            .padding(isUser ? 13 : 0)
            .background(isUser ? ChatPalette.accent.opacity(0.10) : Color.clear, in: RoundedRectangle(cornerRadius: 15))
            if !isUser { Spacer(minLength: 24) }
        }.frame(maxWidth: .infinity)
    }
    private var composer: some View {
        VStack(spacing: 7) {
            VStack(spacing: 5) {
                TextField("Message à MultiVibe", text: draft, axis: .vertical)
                    .textFieldStyle(.plain).font(.system(size: 15)).lineLimit(1...6)
                    .fixedSize(horizontal: false, vertical: true)
                    .focused($composing).accessibilityLabel("Message à MultiVibe")
                    .padding(.horizontal, 12).padding(.top, 11).padding(.bottom, 7)
                HStack(spacing: 7) {
                    Button { importing = true } label: {
                        Image(systemName: "paperclip").frame(width: 26, height: 26)
                    }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .background(ChatPalette.surface, in: Circle())
                    .help("Joindre un document texte").disabled(cloudMode)
                    if !cloudMode { harnessSelector }
                    modelSelector
                    Spacer(minLength: 12)
                    if cloudMode {
                        Button { sendCloud() } label: { Image(systemName: "arrow.up").font(.system(size: 13, weight: .bold)).frame(width: 25, height: 25) }
                            .buttonStyle(.borderedProminent).clipShape(Circle()).help("Envoyer à Hermes (⌘↵)").keyboardShortcut(.return, modifiers: .command)
                            .disabled(cloudSelection == nil || cloudSending || agent.busy || agent.consent?.cloudEnabled != true || cloudDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !agent.models.contains { $0.id == cloudModel && $0.available != false })
                    } else if store.generating != nil {
                        Button { store.stop() } label: { Image(systemName: "stop.fill").font(.system(size: 11)).frame(width: 25, height: 25) }
                            .buttonStyle(.borderedProminent).clipShape(Circle()).tint(.secondary).help("Arrêter")
                    } else {
                        Button { store.send(interactiveAnswers: interactiveAnswers) } label: { Image(systemName: "arrow.up").font(.system(size: 13, weight: .bold)).frame(width: 25, height: 25) }
                            .buttonStyle(.borderedProminent).clipShape(Circle()).help("Envoyer (⌘↵)").keyboardShortcut(.return, modifiers: .command)
                            .disabled(draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                || !models.contains { $0.id == model.wrappedValue }
                                || !selectedHarness.available
                                || (harness.wrappedValue != "native" && selectedLocalModel?.local == true))
                    }
                }.padding(.horizontal, 8).padding(.bottom, 7)
            }
            .background(ChatPalette.elevated, in: RoundedRectangle(cornerRadius: 17))
            .overlay(RoundedRectangle(cornerRadius: 17).stroke(store.generating == store.selection ? ChatPalette.accent.opacity(0.55) : ChatPalette.hairline, lineWidth: 1))
            .shadow(color: .black.opacity(0.055), radius: 12, y: 4)
            Label(composerPrivacyText, systemImage: composerPrivacyIcon)
                .font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
        }
        .frame(maxWidth: 900).frame(maxWidth: .infinity)
        .padding(.horizontal, 22).padding(.top, 9).padding(.bottom, 16)
    }
    private var harnessSelector: some View {
        Button { choosingHarness = true } label: {
            HStack(spacing: 6) {
                HarnessLogo(id: selectedHarness.id, name: selectedHarness.name, size: 18)
                Text(selectedHarness.name).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 8, weight: .semibold)).foregroundStyle(.tertiary)
            }
            .font(.caption.weight(.medium)).foregroundStyle(.secondary)
            .padding(.horizontal, 9).frame(height: 28)
            .background(ChatPalette.surface, in: Capsule())
        }
        .buttonStyle(.plain).tint(.secondary)
        .fixedSize(horizontal: false, vertical: true).frame(maxWidth: 190, alignment: .leading)
        .help(selectedHarness.description)
        .disabled(store.current?.messages.isEmpty == false || store.generating == store.selection)
        .popover(isPresented: $choosingHarness, arrowEdge: .bottom) { harnessGrid }
    }
    private var harnessGrid: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Moteur de conversation").font(.headline)
                    Text("MultiVibe garde l’interface. Le moteur sélectionné orchestre les réponses.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { Task { await loadHarnesses() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).help("Actualiser les harnesses détectés")
            }
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                    ForEach(sortedHarnesses) { item in harnessCard(item) }
                }
            }
            .frame(maxHeight: 530)
        }
        .padding(18).frame(width: 720)
    }
    private var sortedHarnesses: [NativeConversationHarness] {
        harnesses.sortedForDisplay(lastUsedAt: harnessLastUsedAt)
    }
    private func recordHarnessUse(_ id: String) {
        harnessLastUsedAt[id] = Date().timeIntervalSince1970
        UserDefaults.standard.set(harnessLastUsedAt, forKey: "assistantHarnessLastUsedAt")
    }
    private func harnessCard(_ item: NativeConversationHarness) -> some View {
        Button {
            if item.available {
                harness.wrappedValue = item.id
                recordHarnessUse(item.id)
                choosingHarness = false
            } else if item.canInstall == true {
                choosingHarness = false
                beginInstallation(item)
            }
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .controlBackgroundColor))
                        HarnessLogo(id: item.id, name: item.name, size: 42)
                    }.frame(width: 56, height: 56)
                    Spacer()
                    if item.id == harness.wrappedValue {
                        Image(systemName: "checkmark.circle.fill").font(.title3).foregroundStyle(ChatPalette.accent)
                    } else {
                        Circle().fill(item.available ? ChatPalette.accent : Color.secondary.opacity(0.45)).frame(width: 8, height: 8)
                    }
                }
                Text(item.name).font(.callout.weight(.semibold)).foregroundStyle(.primary)
                Text(item.description).font(.caption2).foregroundStyle(.secondary).lineLimit(3, reservesSpace: true)
                if item.available && item.capabilities.longTermMemory {
                    Label("Mémoire longue durée", systemImage: "brain.head.profile")
                        .font(.caption2.weight(.medium)).foregroundStyle(ChatPalette.accent)
                } else if item.available && item.id == "computer-use" {
                    Label("Navigateur et applications", systemImage: "cursorarrow.motionlines")
                        .font(.caption2.weight(.medium)).foregroundStyle(ChatPalette.accent)
                } else if item.available && item.id == "pi" {
                    Label("Session persistante", systemImage: "clock.arrow.circlepath")
                        .font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                } else if item.available {
                    Label("Conversation directe", systemImage: "bolt.horizontal")
                        .font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                } else if item.detected == true {
                    Label(item.configured ? "Détecté et configuré" : "Détecté sur ce Mac", systemImage: "checkmark.circle")
                        .font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                } else {
                    Label("Disponible sur macOS", systemImage: "laptopcomputer")
                        .font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                }
                if !item.available && item.canInstall == true {
                    Label("Installer", systemImage: "arrow.down.circle.fill")
                        .font(.caption.weight(.semibold)).foregroundStyle(ChatPalette.accent)
                }
            }
            .padding(13).frame(maxWidth: .infinity, minHeight: 205, alignment: .topLeading)
            .background(item.id == harness.wrappedValue ? ChatPalette.accent.opacity(0.10) : ChatPalette.elevated,
                        in: RoundedRectangle(cornerRadius: 15))
            .overlay(RoundedRectangle(cornerRadius: 15).stroke(
                item.id == harness.wrappedValue ? ChatPalette.accent.opacity(0.8) : ChatPalette.hairline,
                lineWidth: item.id == harness.wrappedValue ? 1.5 : 1))
        }
        .buttonStyle(.plain).disabled(!item.available && item.canInstall != true)
        .opacity(item.available || item.canInstall == true ? 1 : 0.55)
        .accessibilityLabel("\(item.name), \(item.description)\(item.id == harness.wrappedValue ? ", sélectionné" : "")")
    }
    private func beginInstallation(_ item: NativeConversationHarness) {
        installingHarness = item
        installationLogs = []
        installationError = nil
        showingInstallationLogs = false
        installationRunning = true
        Task {
            do {
                try await NativeHarnessClient.shared.install(harnessID: item.id) { line in installationLogs.append(line) }
                await loadHarnesses()
            } catch is CancellationError {
                installationError = "Installation annulée."
            } catch {
                installationError = error.localizedDescription
            }
            installationRunning = false
        }
    }
    private func harnessInstallationSheet(_ item: NativeConversationHarness) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 14) {
                HarnessLogo(id: item.id, name: item.name, size: 48)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Installation de \(item.name)").font(.title3.weight(.semibold))
                    Text(installationRunning ? "Installation en cours…" : installationError == nil ? "Installation terminée" : "L’installation a échoué")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if installationRunning { ProgressView().controlSize(.small) }
                else { Image(systemName: installationError == nil ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(installationError == nil ? ChatPalette.accent : .red) }
            }
            if let installationError { Text(installationError).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            Button(showingInstallationLogs ? "Hide logs" : "Show logs") { showingInstallationLogs.toggle() }
                .buttonStyle(.link)
            if showingInstallationLogs {
                ScrollView {
                    Text(installationLogs.isEmpty ? "En attente du programme d’installation…" : installationLogs.joined(separator: "\n"))
                        .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(10).frame(height: 210)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            }
            HStack {
                Spacer()
                Button(installationRunning ? "Fermer en arrière-plan" : "Fermer") { installingHarness = nil }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(22).frame(width: 520)
        .interactiveDismissDisabled(installationRunning)
    }
    private var modelSelector: some View {
        Menu {
            if cloudMode {
                if agent.models.isEmpty { Text("Aucun modèle disponible") }
                ForEach(agent.models) { item in
                    Button {
                        cloudModel = item.id
                    } label: {
                        Label(
                            (item.source == "relay" ? "Relay · " : "Cloud · ") + (item.name ?? item.id) + (item.available == false ? " — hors ligne" : ""),
                            systemImage: item.id == cloudModel ? "checkmark" : (item.source == "relay" ? "desktopcomputer" : "cloud")
                        )
                    }
                    .disabled(item.available == false)
                }
            } else {
                if loading { Text("Chargement…") }
                else if models.isEmpty { Text("Aucun modèle disponible") }
                if let selected = store.current?.model, !selected.isEmpty, !models.contains(where: { $0.id == selected }) {
                    Text("\(selected) — indisponible")
                }
                ForEach(models) { item in
                    Button {
                        model.wrappedValue = item.id
                    } label: {
                        Label(item.displayName, systemImage: item.id == model.wrappedValue ? "checkmark" : (item.local == true ? "apple.logo" : "network"))
                    }
                    .disabled(harness.wrappedValue != "native" && item.local == true)
                }
            }
            Divider()
            Button("Actualiser les modèles", systemImage: "arrow.clockwise") {
                Task {
                    if cloudMode { do { try await agent.loadModels() } catch { agent.error = error.localizedDescription } }
                    else { await loadModels() }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: cloudMode ? (selectedCloudModel?.source == "relay" ? "desktopcomputer" : "cloud") : (selectedLocalModel?.local == true ? "apple.logo" : "cpu"))
                Text(selectedModelName).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 8, weight: .semibold)).foregroundStyle(.tertiary)
            }
            .font(.caption.weight(.medium)).foregroundStyle(.secondary)
            .padding(.horizontal, 9).frame(height: 28)
            .background(ChatPalette.surface, in: Capsule())
        }
        .menuStyle(.borderlessButton).tint(.secondary)
        .fixedSize(horizontal: false, vertical: true).frame(maxWidth: 260, alignment: .leading)
        .disabled(cloudMode ? cloudSending : store.generating == store.selection)
    }
    private var composerPrivacyText: String {
        if cloudMode { return "Exécuté dans votre espace Hermes Cloud" }
        if harness.wrappedValue == "computer-use" { return "Captures transmises au modèle choisi · autorisations par cible · arrêt à tout moment" }
        if harness.wrappedValue == "hermes-agent" { return "Orchestré par Hermes · mémoire longue durée active" }
        if harness.wrappedValue == "pi" { return "Orchestré par Pi · session persistante sur ce Mac" }
        if selectedLocalModel?.local == true { return "Traité localement sur ce Mac" }
        return "Transmis au modèle sélectionné via votre Host"
    }
    private var composerPrivacyIcon: String {
        if cloudMode { return "cloud" }
        if harness.wrappedValue == "hermes-agent" { return "brain.head.profile" }
        if harness.wrappedValue == "pi" { return "point.3.connected.trianglepath.dotted" }
        return selectedLocalModel?.local == true ? "lock.fill" : "shield.lefthalf.filled"
    }
    private var cloudTranscript: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if agent.consent?.cloudEnabled != true {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Espace Hermes Cloud", systemImage: "cloud") .font(.headline)
                        Text("Autorisez votre espace Cloud pour démarrer une conversation Hermes.").foregroundStyle(.secondary)
                        Button("Configurer le consentement…") { selectedImports = []; cloudConsent = true }
                    }.padding(16).background(ChatPalette.surface, in: RoundedRectangle(cornerRadius: 14))
                } else if cloudSelection == nil {
                    Text("Sélectionnez une conversation Cloud ou créez-en une nouvelle.")
                    Button("Nouvelle conversation Cloud") { Task { do { cloudSelection = try await agent.newCloudConversation() } catch { agent.error = error.localizedDescription } } }
                }
                ForEach(agent.synchronizedMessages(cloudSelection)) { message in
                    VStack(alignment: .leading, spacing: 7) {
                        Text(message.role == "user" ? "Vous" : "MultiVibe").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        if message.role == "assistant" {
                            NativeInteractiveAnswerView(content: message.content) { cloudDraft = $0; composing = true }
                        } else { Text(markdown(message.content)).textSelection(.enabled).lineSpacing(5) }
                    }
                    .padding(message.role == "user" ? 13 : 0)
                    .background(message.role == "user" ? ChatPalette.accent.opacity(0.10) : Color.clear, in: RoundedRectangle(cornerRadius: 15))
                    .frame(maxWidth: message.role == "user" ? 620 : .infinity, alignment: message.role == "user" ? .trailing : .leading)
                }
                ForEach(agent.orderedRuns.filter { $0.sessionId == cloudSelection?.uuidString.lowercased() }, id: \.runId) { run in
                    VStack(alignment: .leading, spacing: 9) {
                        Text(agent.runPrompt(run.runId)).font(.headline).textSelection(.enabled)
                        if let response = agent.responseText(run) { NativeInteractiveAnswerView(content: response) { cloudDraft = $0; composing = true } }
                        else { Text(run.state == .awaiting_resolution ? "Une action nécessite votre vérification. Elle ne sera pas rejouée automatiquement." : "État : \(run.state.rawValue)").foregroundStyle(.secondary) }
                        if run.state != .completed && run.state != .cancelled {
                            Button("Annuler") { Task { do { try await agent.cancel(runID: run.runId) } catch { agent.error = error.localizedDescription } } }
                                .disabled(agent.busy)
                        }
                    }
                    .padding(15).background(ChatPalette.surface, in: RoundedRectangle(cornerRadius: 14))
                }
                if cloudSending { ProgressView("Hermes travaille…") }
            }.padding(.horizontal, 24).padding(.vertical, 22).frame(maxWidth: 900).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func sendCloud() {
        guard let conversationID = cloudSelection, !cloudSending, agent.models.contains(where: { $0.id == cloudModel }) else { return }
        let prompt = cloudDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, prompt.count <= 32_000 else { agent.error = "Saisissez entre 1 et 32 000 caractères."; return }
        let epoch = agent.loginEpoch, modelID = cloudModel
        let source: NativeAgentRunInput.Model.Source = agent.models.first(where: { $0.id == modelID })?.source == "relay" ? .relay : .cloud
        cloudSending = true
        cloudTask = Task {
            defer { if agent.loginEpoch == epoch { cloudSending = false; cloudTask = nil } }
            do {
                let run = try await agent.execute(modelID: modelID, source: source, conversationID: conversationID, message: prompt)
                guard agent.loginEpoch == epoch else { return }
                if cloudSelection == conversationID && cloudDraft.trimmingCharacters(in: .whitespacesAndNewlines) == prompt { cloudDraft = "" }
                _ = try await agent.poll(runID: run.runId)
            } catch {
                if agent.loginEpoch == epoch && !Task.isCancelled { agent.error = "Hermes : \(error.localizedDescription). Synchronisez pour retrouver une exécution déjà créée." }
            }
        }
    }
    private func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
    private func loadModels() async {
        guard !loading else { return }
        loading = true; defer { loading = false }
        do {
            models = try await HostAssistantClient.shared.models()
            if store.current?.model.isEmpty == true, let first = models.first {
                model.wrappedValue = first.id
            }
        }
        catch { store.error = error.localizedDescription }
    }
    private func loadHarnesses() async {
        do {
            let detected = try await NativeHarnessClient.shared.harnesses()
            harnesses = (detected.isEmpty ? [.native] : detected.filter { $0.id != "computer-use" }) + [.computerUse]
        } catch {
            harnesses = [.native, .computerUse]
            if harness.wrappedValue != "native" { store.error = error.localizedDescription }
        }
    }
    private func openDashboard() { (NSApplication.shared.delegate as? MultiVibeMenuBarApp)?.openDashboard() }
}
