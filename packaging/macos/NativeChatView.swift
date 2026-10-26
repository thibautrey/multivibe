import AppKit
import SwiftUI
import UniformTypeIdentifiers
import AVFoundation

private enum SidebarConversationLayout: String {
    case flat
    case grouped
}

// Intercept before SwiftUI button shortcuts, while preserving the field editor's
// selection, undo stack and normal text-change notifications on macOS 13+.
private struct ComposerNewlineShortcut: NSViewRepresentable {
    func makeNSView(context: Context) -> ShortcutView { ShortcutView() }
    func updateNSView(_ nsView: ShortcutView, context: Context) {}

    final class ShortcutView: NSView {
        private var monitor: Any?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, let window = self.window, event.window === window,
                      event.keyCode == 36 || event.keyCode == 76,
                      event.modifierFlags.intersection(.deviceIndependentFlagsMask)
                        .subtracting([.capsLock, .numericPad, .function]) == .command,
                      let editor = window.firstResponder as? NSTextView,
                      editor.isEditable, !editor.hasMarkedText(),
                      let field = editor.delegate as? NSTextField,
                      self.convert(self.bounds, to: nil).intersects(field.convert(field.bounds, to: nil))
                else { return event }
                editor.insertNewlineIgnoringFieldEditor(nil)
                return nil
            }
        }

        deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
    }
}

// SwiftUI's contextMenu requires a second choice after the secondary click.
// This monitor keeps the primary Button behavior intact and opens the editor directly.
private struct SecondaryClickAction: NSViewRepresentable {
    let action: () -> Void

    func makeNSView(context: Context) -> MonitorView {
        let view = MonitorView()
        view.action = action
        return view
    }

    func updateNSView(_ nsView: MonitorView, context: Context) { nsView.action = action }

    final class MonitorView: NSView {
        var action: (() -> Void)?
        private var monitor: Any?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .rightMouseDown) { [weak self] event in
                guard let self, let window = self.window, event.window === window,
                      self.convert(self.bounds, to: nil).contains(event.locationInWindow) else { return event }
                self.action?()
                return nil
            }
        }

        deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
    }
}

private struct NativeChatSuggestionEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State private var draft: NativeChatSuggestion
    let defaultSuggestion: NativeChatSuggestion?
    let save: (NativeChatSuggestion) -> Void
    let reset: (NativeChatSuggestion) -> Void

    init(
        suggestion: NativeChatSuggestion,
        defaultSuggestion: NativeChatSuggestion?,
        save: @escaping (NativeChatSuggestion) -> Void,
        reset: @escaping (NativeChatSuggestion) -> Void
    ) {
        _draft = State(initialValue: suggestion)
        self.defaultSuggestion = defaultSuggestion
        self.save = save
        self.reset = reset
    }

    private var iconIsValid: Bool {
        NSImage(systemSymbolName: draft.systemImage.trimmingCharacters(in: .whitespacesAndNewlines), accessibilityDescription: nil) != nil
    }
    private var isValid: Bool {
        !draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !draft.subtitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && iconIsValid
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Carte") {
                    TextField("Titre", text: $draft.title)
                    TextField("Sous-titre", text: $draft.subtitle)
                    HStack(spacing: 12) {
                        Image(systemName: iconIsValid ? draft.systemImage.trimmingCharacters(in: .whitespacesAndNewlines) : "questionmark.square.dashed")
                            .foregroundStyle(iconIsValid ? ChatPalette.accent : .secondary)
                            .frame(width: 24)
                        TextField("Icône SF Symbols", text: $draft.systemImage)
                    }
                    if !draft.systemImage.isEmpty && !iconIsValid {
                        Label("Cette icône SF Symbols n’existe pas sur ce Mac.", systemImage: "exclamationmark.triangle")
                            .font(.caption).foregroundStyle(.orange)
                    }
                }
                Section("Texte inséré dans le message") {
                    TextEditor(text: $draft.text)
                        .font(.body)
                        .frame(minHeight: 112)
                        .accessibilityLabel("Texte inséré dans le message")
                    Text("Un clic principal sur la carte placera ce texte dans le champ de rédaction sans l’envoyer.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let defaultSuggestion, draft != defaultSuggestion {
                    Section {
                        Button("Rétablir cette carte", systemImage: "arrow.counterclockwise") {
                            reset(defaultSuggestion)
                            dismiss()
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Modifier la suggestion")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annuler") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Enregistrer") {
                        save(draft)
                        dismiss()
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isValid)
                }
            }
        }
        .frame(width: 520, height: 455)
    }
}

@MainActor struct NativeChatView: View {
    @ObservedObject var store: NativeChatStore
    @ObservedObject private var desktopAgent: ComputerUseController
    @ObservedObject private var browser: ChromiumBrowser
    @StateObject private var agent: NativeChatAgentCoordinator
    @StateObject private var identity: NativeDesktopIdentity
    @State private var cloudConsent = false
    @State private var instancePairing = false
    @State private var cloudMode = false
    @State private var cloudSelection: UUID?
    @State private var cloudModel = ""
    @State private var cloudDraft = ""
    @State private var cloudSending = false
    @State private var cloudTask: Task<Void, Never>?
    @State private var selectedImports: Set<UUID> = []
    @State private var search = ""
    @State private var showingArchives = false
    @AppStorage("assistantConversationListLayout") private var conversationListLayout: SidebarConversationLayout = .flat
    @State private var renameID: UUID?
    @State private var renameTitle = ""
    @State private var targets: [DesktopHarnessTarget] = [.local]
    @State private var followsTranscript = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage("desktopInteractiveAnswers") private var interactiveAnswers = true
    @State private var models: [HostAssistantModel] = []
    @State private var harnesses: [NativeConversationHarness] = [.native]
    @State private var configuringRemoteHarness: String?
    @State private var choosingHarness = false
    @State private var choosingModel = false
    @State private var choosingEffort = false
    @State private var modelSource = "multivibe"
    @State private var modelQuery = ""
    @State private var harnessModels: [DesktopHarnessModel] = []
    @State private var harnessEffort: DesktopHarnessEffort?
    @State private var loadedEffortKey = ""
    @State private var loadingEffort = false
    @State private var effortError: String?
    @State private var changingEffort = false
    @State private var harnessDefaultModel: String?
    @State private var harnessDefaultProvider: String?
    @State private var loadingHarnessModels = false
    @State private var harnessModelsError: String?
    @State private var loadedHarnessModelsKey = ""
    @State private var projects: [DesktopHarnessProject] = []
    @State private var loadingProjects = false
    @State private var projectsError: String?
    @State private var projectQuery = ""
    @State private var choosingProject = false
    @State private var loadedProjectsKey = ""
    @State private var installingHarness: NativeConversationHarness?
    @State private var installationLogs: [String] = []
    @State private var installationRunning = false
    @State private var installationError: String?
    @State private var showingInstallationLogs = false
    @State private var harnessLastUsedAt: [String: Double] = UserDefaults.standard.dictionary(forKey: "assistantHarnessLastUsedAt") as? [String: Double] ?? [:]
    @State private var loading = false
    @State private var importing = false
    @State private var showingAddMenu = false
    @State private var featureCatalog: DesktopHarnessFeatureCatalog?
    @State private var featureQuery = ""
    @State private var featureCatalogKey = ""
    @State private var loadingFeatures = false
    @State private var featureError: String?
    @State private var showingGoal = false
    @State private var goalText = ""
    @State private var goalBusy = false
    @State private var fileDropTargeted = false
    @State private var showingHarnessInspector = false
    @State private var inspectorSubject = "capabilities"
    @State private var selectedUtilityPanel: NativeChatUtilityPanel = .conversation
    @State private var deleteID: UUID?
    @State private var speech = AVSpeechSynthesizer()
    @State private var suggestionCards = NativeChatSuggestionStore.load()
    @State private var editingWelcomeSuggestion: NativeChatSuggestion?
    @FocusState private var composing: Bool

    init(store: NativeChatStore, agent: NativeChatAgentCoordinator? = nil) {
        self.store = store
        _desktopAgent = ObservedObject(wrappedValue: store.computer)
        _browser = ObservedObject(wrappedValue: store.computer.browser)
        let coordinator = agent ?? NativeChatAgentCoordinator()
        _agent = StateObject(wrappedValue: coordinator)
        _identity = StateObject(wrappedValue: NativeDesktopIdentity(agent: coordinator))
    }

    private var draft: Binding<String> { Binding(get: { cloudMode ? cloudDraft : (store.current?.draft ?? "") }, set: { value in
        if cloudMode { cloudDraft = value } else { store.edit { $0.draft = value } }
    }) }
    private var model: Binding<String> { Binding(get: { store.current?.model ?? "" }, set: { value in
        store.edit { $0.model = value }; HostAssistantClient.shared.defaultModel = value
        store.rememberCurrentModel()
        if let conversation = store.current, conversation.runtimeSessionID != nil {
            var settings: [String: HarnessJSON] = ["model": .string(value)]
            if conversation.harnessID == "pi", conversation.authMode == "multivibe" { settings["provider"] = .string("multivibe") }
            store.runtimeCommand(conversation.id, type: "configure", value: .object(settings))
        }
    }) }
    private var harness: Binding<String> { Binding(get: { store.current?.harnessID ?? "native" }, set: { value in
        store.selectHarness(value)
    }) }
    private var visible: [NativeChatConversation] {
        store.conversations.filter { ($0.archived == true) == showingArchives && (!$0.messages.isEmpty || !$0.draft.isEmpty || $0.runtimeSessionID != nil || $0.remoteChatID != nil) && (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) || $0.messages.contains { $0.content.localizedCaseInsensitiveContains(search) }) }
            .sorted { if ($0.pinned == true) != ($1.pinned == true) { return $0.pinned == true }; return $0.updatedAt > $1.updatedAt }
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
            capabilities: .init(sessions: true, streaming: true, tools: false, longTermMemory: false, projects: false),
            unavailableReason: "Ce harness n’est plus disponible sur ce Mac.", canInstall: false, compatible: false,
            detected: false, conversationCapable: false, category: nil, popularityRank: nil
        )
    }
    private var selectedModelName: String {
        if cloudMode { return selectedCloudModel?.name ?? selectedCloudModel?.id ?? "Choisir un modèle" }
        if harness.wrappedValue != "native", store.current?.authMode != "multivibe" {
            let id = selectedHarnessModelID
            return harnessModels.first { $0.id == id && ($0.provider == selectedHarnessModelProvider || $0.provider == nil) }?.name ?? id ?? (loadingHarnessModels ? "Chargement des modèles…" : "Choisir un modèle")
        }
        return selectedLocalModel?.displayName ?? (model.wrappedValue.isEmpty ? "Choisir un modèle" : model.wrappedValue)
    }
    private var targetName: String {
        let id = store.current?.executionTargetID ?? "local"
        return targets.first { $0.id == id }?.name ?? (id == "local" ? "Ce Mac" : "Machine distante")
    }
    private var conversationSubtitle: String {
        cloudMode ? "Hermes · Cloud" : "\(selectedHarness.name) · \(targetName)"
    }
    private var working: Bool { cloudMode ? cloudSending : store.isGenerating(store.selection) }
    private var conversationState: String? {
        guard !cloudMode else { return cloudSending ? "Hermes travaille…" : nil }
        if let state = store.current?.runtimeSession?.state, state != "idle" { return HarnessPresentation.state(state) }
        return working ? "Réponse en cours…" : nil
    }
    var body: some View {
        GeometryReader { geometry in
            HSplitView {
            NavigationSplitView {
            VStack(spacing: 0) {
                sidebarHeader
                sidebarPrimaryActions
                sidebarSearchControls
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        if cloudMode { cloudConversationList }
                        else if visible.isEmpty { sidebarEmptyState }
                        else if conversationListLayout == .flat {
                            ForEach(ChatConversationSection.sections(visible)) { section in
                                Text(section.title).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                                    .padding(.horizontal, 10).padding(.top, 16).padding(.bottom, 4)
                                ForEach(section.conversations) { conversation in conversationLink(conversation) }
                            }
                        } else {
                            ForEach(ChatHarnessConversationSection.sections(visible)) { section in
                                HStack(spacing: 7) {
                                    HarnessLogo(id: section.id, name: harnessName(section.id), size: 16)
                                    Text(harnessName(section.id))
                                    Spacer(minLength: 0)
                                    Text("\(section.conversations.count)").foregroundStyle(.tertiary)
                                }
                                .font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                                .padding(.horizontal, 10).padding(.top, 16).padding(.bottom, 4)
                                ForEach(section.conversations) { conversation in conversationLink(conversation, showsHarnessLogo: false) }
                            }
                        }
                    }.padding(.horizontal, 10).padding(.bottom, 12)
                }.frame(minHeight: 0, maxHeight: .infinity).layoutPriority(-1)
                if !cloudMode && !store.remoteSyncErrors.isEmpty {
                    Label("Synchronisation à rétablir", systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption).foregroundStyle(.orange)
                        .help(store.remoteSyncErrors.values.sorted().joined(separator: "\n"))
                        .padding(.horizontal, 12).padding(.vertical, 6)
                }
                if !cloudMode && (showingArchives || store.conversations.contains { $0.archived == true }) {
                    Button { toggleArchives() } label: {
                        HStack(spacing: 9) {
                            Image(systemName: showingArchives ? "arrow.left" : "archivebox")
                            Text(showingArchives ? "Toutes les conversations" : "Archives")
                            Spacer()
                            if !showingArchives { Text("\(store.conversations.filter { $0.archived == true }.count)").foregroundStyle(.secondary) }
                        }.font(.system(size: 12)).padding(10)
                    }.buttonStyle(ChatActionStyle(selected: showingArchives)).padding(.horizontal, 10).padding(.bottom, 8)
                }
                Divider()
                sidebarFooter
            }
            .background(ChatPalette.elevated)
            .frame(height: geometry.size.height, alignment: .top).clipped()
            .navigationSplitViewColumnWidth(min: 224, ideal: 252, max: 310)
        } detail: {
            VStack(spacing: 0) {
                header
                Divider()
                Group {
                    if cloudMode { cloudTranscript }
                    else if let conversation = store.current, !conversation.messages.isEmpty { transcript(conversation) }
                    else { welcome }
                }
                .frame(minHeight: 0, maxHeight: .infinity)
                .layoutPriority(-1).clipped()
                if let error = store.error {
                    let presented = ChatPresentedError(error)
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Une action nécessite votre attention").font(.system(size: 12, weight: .semibold))
                            Text(presented.summary).font(.system(size: 11)).foregroundStyle(.secondary).textSelection(.enabled)
                            if let details = presented.details {
                                DisclosureGroup("Détails techniques") {
                                    ScrollView {
                                        Text(details).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.secondary)
                                            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 5)
                                    }.frame(maxHeight: 120)
                                }.font(.system(size: 10.5, weight: .medium)).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        ChatIconButton(title: "Masquer le message", icon: "xmark") { store.error = nil }
                    }
                    .padding(12).frame(maxWidth: 820)
                    .background(Color.red.opacity(0.055), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.red.opacity(0.18), lineWidth: 0.5))
                    .padding(.horizontal, 28).padding(.top, 8)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
                if !cloudMode { AgentAccessView(controller: desktopAgent, conversation: store.selection, stop: { store.stop() }) }
                if !cloudMode { NativeHarnessConversationControls(store: store).frame(maxWidth: 820).frame(maxWidth: .infinity) }
                composer.fixedSize(horizontal: false, vertical: true).layoutPriority(2)
            }.background(ChatPalette.canvas)
            .frame(maxWidth: .infinity, minHeight: geometry.size.height, maxHeight: geometry.size.height, alignment: .top).clipped()
            .animation(ChatPalette.motion(reduceMotion), value: store.error != nil)
            .onDrop(of: [UTType.fileURL], isTargeted: $fileDropTargeted, perform: importDroppedFiles)
            .overlay {
                if fileDropTargeted && !cloudMode {
                    RoundedRectangle(cornerRadius: 17)
                        .fill(ChatPalette.accent.opacity(0.08))
                        .overlay(RoundedRectangle(cornerRadius: 17).strokeBorder(ChatPalette.accent, style: StrokeStyle(lineWidth: 2, dash: [8])))
                        .overlay {
                            Label(harness.wrappedValue == "native" ? "Joindre des documents texte" : "Joindre ces fichiers", systemImage: "doc.badge.plus")
                                .font(.headline).padding(18)
                                .background(ChatPalette.elevated, in: RoundedRectangle(cornerRadius: 12))
                        }
                        .padding(10).allowsHitTesting(false)
                }
            }
        }
        .frame(minWidth: 680, minHeight: geometry.size.height, maxHeight: geometry.size.height)
        if showingUtilityPanel {
            NativeChatUtilityPanelView(
                store: store,
                browser: browser,
                showsConversation: showingHarnessInspector,
                inspectorSubject: inspectorSubject,
                selection: $selectedUtilityPanel,
                closeConversation: closeHarnessInspector,
                closeBrowser: closeBrowserPanel
            )
        }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
        .tint(ChatPalette.accent)
        .frame(minWidth: showingUtilityPanel ? 1080 : 760, maxWidth: .infinity, minHeight: 500, maxHeight: .infinity)
        .disabled(identity.requiresSelection)
        .accessibilityHidden(identity.requiresSelection)
        .overlay {
            if identity.requiresSelection {
                ZStack {
                    ChatPalette.canvas
                    VStack(spacing: 15) {
                        Image(systemName: "person.crop.circle").font(.system(size: 46, weight: .light)).foregroundStyle(ChatPalette.accent)
                        Text("Votre espace vous attend").font(.title2.weight(.semibold))
                        Button("Choisir mon compte") { identity.openPicker() }.buttonStyle(.borderedProminent)
                    }
                }
            }
        }
        .background(NativeIdentityWindowActivity(identity: identity))
        .sheet(isPresented: $identity.showsPicker) { NativeAccountPickerView(identity: identity) }
        .task {
            if store.current == nil { store.newConversation() }
            await loadNativeChatDependencies(
                restoreCloud: { await agent.restore() },
                loadModels: { await loadModels() },
                loadHarnesses: { await loadHarnesses() }
            )
        }
        .task(id: harnessModelsKey) { await loadHarnessModels() }
        .task(id: effortKey) { await loadHarnessEffort() }
        .task(id: store.current?.executionTargetID ?? "local") { await store.runRemoteSynchronization() }
        .task(id: projectCatalogKey) { await loadProjects() }
        .sheet(isPresented: $cloudConsent) { consentSheet }
        .sheet(isPresented: $instancePairing) { NativeInstancePairingView(agent: agent) }
        .sheet(isPresented: Binding(get: { configuringRemoteHarness != nil }, set: { if !$0 { configuringRemoteHarness = nil } })) {
            let remoteID = configuringRemoteHarness ?? "librechat"
            RemoteHarnessConnectionSheet(harnessID: remoteID, target: store.current?.executionTargetID ?? "local") {
                await loadHarnesses()
                harness.wrappedValue = remoteID
                recordHarnessUse(remoteID)
                await store.synchronizeRemoteChats(force: true)
            }
        }
        .sheet(item: $installingHarness) { item in harnessInstallationSheet(item) }
        .sheet(item: $editingWelcomeSuggestion) { suggestion in
            NativeChatSuggestionEditor(
                suggestion: suggestion,
                defaultSuggestion: NativeChatSuggestion.defaults.first { $0.id == suggestion.id },
                save: saveWelcomeSuggestion,
                reset: resetWelcomeSuggestion
            )
        }
        .sheet(isPresented: $showingGoal) { goalSheet }
        .onChange(of: browser.isVisible) { visible in
            if visible { selectedUtilityPanel = .browser }
            else if showingHarnessInspector { selectedUtilityPanel = .conversation }
        }
        .onChange(of: agent.accountID) { _ in
            cloudTask?.cancel(); cloudSending = false; cloudDraft = ""; cloudModel = ""; cloudSelection = nil
            if agent.accountID == nil { cloudMode = false }
        }
        .onChange(of: identity.requiresSelection) { required in
            if required {
                cloudTask?.cancel(); cloudTask = nil; cloudSending = false
                speech.stopSpeaking(at: .immediate)
                if store.computer.running { store.computer.stop() }
                cloudConsent = false; instancePairing = false
                configuringRemoteHarness = nil; installingHarness = nil; editingWelcomeSuggestion = nil
                showingGoal = false; goalText = ""; renameID = nil; renameTitle = ""; deleteID = nil
                showingAddMenu = false; choosingHarness = false; choosingModel = false
                choosingEffort = false; choosingProject = false
                identity.showsPicker = true
            }
        }
        .onChange(of: cloudSelection) { _ in cloudDraft = "" }
        .onChange(of: cloudMode) { enabled in
            if enabled && store.computer.running { store.stop() }
            if enabled && showingHarnessInspector { closeHarnessInspector() }
            if enabled { Task { do { try await agent.loadModels(); cloudModel = agent.models.first?.id ?? ""; cloudSelection = agent.cloudConversations.first?.id } catch { agent.error = error.localizedDescription } } }
        }
        .onChange(of: store.selection) { selection in
            speech.stopSpeaking(at: .immediate)
            followsTranscript = true
        }
        .alert("Renommer la conversation", isPresented: Binding(get: { renameID != nil }, set: { if !$0 { renameID = nil } })) {
            TextField("Titre", text: $renameTitle)
            Button("Annuler", role: .cancel) { renameID = nil }
            Button("Enregistrer") {
                if let index = store.conversations.firstIndex(where: { $0.id == renameID }), !renameTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    store.updateMetadata(store.conversations[index].id, title: renameTitle.trimmingCharacters(in: .whitespacesAndNewlines))
                }
                renameID = nil
            }
        }
        .alert("Supprimer cette conversation ?", isPresented: Binding(get: { deleteID != nil }, set: { if !$0 { deleteID = nil } })) {
            Button("Annuler", role: .cancel) { deleteID = nil }
            Button("Supprimer", role: .destructive) { if let id = deleteID { store.delete(id) }; deleteID = nil; if store.current == nil { store.newConversation() } }
        } message: { Text(store.conversations.first(where: { $0.id == deleteID })?.remoteChatID != nil ? "Elle sera également supprimée du serveur et de ses autres clients." : "Elle sera supprimée de l’historique de ce Mac.") }
        .fileImporter(isPresented: $importing, allowedContentTypes: harness.wrappedValue == "native" ? [.plainText, .sourceCode, .json] : [.item], allowsMultipleSelection: true) { result in
            do { importFiles(try result.get(), conversationID: store.selection) }
            catch { store.error = "Import impossible : \(error.localizedDescription)" }
        }
    }

    private func importFiles(_ urls: [URL], conversationID: UUID?) {
        guard let conversationID,
              let conversation = store.conversations.first(where: { $0.id == conversationID }) else { return }
        do {
            if conversation.harnessID != nil && conversation.harnessID != "native" {
                var files: [URL] = [], folders: [URL] = []
                for url in urls {
                    let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey])
                    if values.isRegularFile == true { files.append(url) }
                    else if values.isDirectory == true { folders.append(url) }
                    else { throw DesktopHarnessError.rejected("\(url.lastPathComponent) cannot be attached.") }
                }
                if !folders.isEmpty {
                    guard conversation.executionTargetID == nil || conversation.executionTargetID == "local" else {
                        throw DesktopHarnessError.rejected("A local folder path cannot be attached to a remote harness.")
                    }
                    guard let index = store.conversations.firstIndex(where: { $0.id == conversationID }) else { return }
                    let references = folders.map { "Folder available to the harness: \($0.path)" }.joined(separator: "\n")
                    store.conversations[index].draft += (store.conversations[index].draft.isEmpty ? "" : "\n\n") + references
                    store.save()
                }
                if !files.isEmpty { try store.stageAttachments(files, conversationID: conversationID) }
                if store.selection == conversationID { composing = true }
                return
            }
            let combined = try NativeChatFileImport.appending(urls, to: conversation.draft)
            // The drop belongs to the conversation where it started, even after navigation.
            guard let index = store.conversations.firstIndex(where: { $0.id == conversationID }) else { return }
            store.conversations[index].draft = combined
            store.save()
            if !cloudMode && store.selection == conversationID { composing = true }
        } catch { store.error = "Import impossible : \(error.localizedDescription)" }
    }

    private func importDroppedFiles(_ providers: [NSItemProvider]) -> Bool {
        guard !cloudMode, let conversationID = store.selection else { return false }
        let files = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
        guard !files.isEmpty else { return false }
        Task { @MainActor in
            do {
                var urls: [URL] = []
                for provider in files {
                    let data: Data = try await withCheckedThrowingContinuation { continuation in
                        provider.loadDataRepresentation(forTypeIdentifier: UTType.fileURL.identifier) { data, error in
                            if let data { continuation.resume(returning: data) }
                            else { continuation.resume(throwing: error ?? HostAssistantError.invalidInput) }
                        }
                    }
                    guard let url = URL(dataRepresentation: data, relativeTo: nil), url.isFileURL else {
                        throw HostAssistantError.invalidInput
                    }
                    urls.append(url)
                }
                importFiles(urls, conversationID: conversationID)
            } catch { store.error = "Import impossible : \(error.localizedDescription)" }
        }
        return true
    }

    private var sidebarHeader: some View {
        HStack(spacing: 10) {
            HarnessLogo(id: "native", name: "MultiVibe", size: 30)
            Text("MultiVibe").font(.system(size: 16, weight: .semibold))
            Spacer()
            ChatIconButton(title: "Réglages du Host", icon: "gearshape", action: openDashboard)
        }.padding(.horizontal, 16).padding(.top, 44).padding(.bottom, 18)
    }
    private var sidebarEmptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(search.isEmpty ? (showingArchives ? "Aucune archive" : "Votre espace de travail") : "Aucun résultat").font(.system(size: 12, weight: .medium))
            Text(search.isEmpty ? "Vos conversations apparaîtront ici." : "Essayez un autre mot ou un extrait de message.").font(.system(size: 12)).foregroundStyle(.secondary)
        }.padding(.horizontal, 10).padding(.top, 22)
    }
    private func conversationLink(_ conversation: NativeChatConversation, showsHarnessLogo: Bool = true) -> some View {
        Button { store.selection = conversation.id } label: {
            HStack(spacing: 9) {
                if showsHarnessLogo {
                    let harnessID = conversation.harnessID ?? "native"
                    HarnessLogo(id: harnessID, name: harnessName(harnessID), size: 18)
                }
                Text(conversation.title).font(.system(size: 13)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                if conversation.pinned == true {
                    Image(systemName: "pin").font(.system(size: 10)).foregroundStyle(.secondary).accessibilityLabel("Conversation épinglée")
                }
                if conversation.runtimeSession?.state == "waiting_user" {
                    Image(systemName: "questionmark.bubble.fill").font(.system(size: 11)).foregroundStyle(.orange).accessibilityLabel("Votre réponse est attendue")
                } else if store.isGenerating(conversation.id) || conversation.remoteActive == true {
                    ProgressView().controlSize(.mini).tint(ChatPalette.accent).accessibilityLabel("Travail en cours")
                }
            }.padding(.horizontal, 10).padding(.vertical, 10)
        }.buttonStyle(ChatActionStyle(selected: store.selection == conversation.id))
            .help(conversation.title).accessibilityAddTraits(store.selection == conversation.id ? .isSelected : [])
            .contextMenu {
                Button("Renommer") { renameID = conversation.id; renameTitle = conversation.title }
                Button(conversation.pinned == true ? "Désépingler" : "Épingler") { updateConversation(conversation.id) { $0.pinned = conversation.pinned != true } }
                Button(conversation.archived == true ? "Désarchiver" : "Archiver") { updateConversation(conversation.id) { $0.archived = conversation.archived != true } }
                Divider()
                Button("Supprimer", role: .destructive) { deleteID = conversation.id }.disabled(store.isGenerating(conversation.id))
            }
    }
    private func harnessName(_ id: String) -> String {
        if id == "native" { return "MultiVibe" }
        return harnesses.first { $0.id == id }?.name ?? id
    }
    private func updateConversation(_ id: UUID, change: (inout NativeChatConversation) -> Void) {
        guard let index = store.conversations.firstIndex(where: { $0.id == id }) else { return }
        var next = store.conversations[index]; change(&next)
        store.updateMetadata(id, pinned: next.pinned, archived: next.archived)
    }
    private func toggleArchives() {
        withAnimation(ChatPalette.motion(reduceMotion)) {
            showingArchives.toggle()
            let candidates = store.conversations.filter { ($0.archived == true) == showingArchives }
                .sorted { $0.updatedAt > $1.updatedAt }
            if let current = store.current, (current.archived == true) != showingArchives { store.selection = candidates.first?.id }
        }
    }
    private var cloudConversationList: some View {
        let items = agent.cloudConversations.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) }
        return Group {
            Text("Espace Cloud").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary).padding(.horizontal, 10).padding(.top, 16)
            if items.isEmpty { Text(search.isEmpty ? "Aucune conversation Cloud" : "Aucun résultat").font(.caption).foregroundStyle(.secondary).padding(10) }
            ForEach(items) { conversation in
                Button { cloudSelection = conversation.id } label: {
                    HStack(spacing: 9) {
                        Image(systemName: "cloud").font(.caption).foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(conversation.title).lineLimit(1)
                            if conversation.conflicted { Text("Conflit à résoudre").font(.caption2).foregroundStyle(.orange) }
                        }
                        Spacer(minLength: 0)
                    }.font(.system(size: 13)).padding(10)
                }.buttonStyle(ChatActionStyle(selected: cloudSelection == conversation.id))
            }
        }
    }
    private var sidebarSearchControls: some View {
        HStack(spacing: 8) {
            sidebarSearchField
            if !cloudMode { sidebarConversationLayoutPicker }
        }
        .padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 4)
    }
    private var sidebarSearchField: some View {
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
        .frame(maxWidth: .infinity)
    }
    private var sidebarConversationLayoutPicker: some View {
        Picker("Organisation des conversations", selection: $conversationListLayout) {
            Image(systemName: "list.bullet").tag(SidebarConversationLayout.flat)
                .accessibilityLabel("Liste à plat")
            Image(systemName: "square.stack.3d.up").tag(SidebarConversationLayout.grouped)
                .accessibilityLabel("Grouper par harness")
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(width: 70)
        .help(conversationListLayout == .flat ? "Liste à plat" : "Conversations groupées par harness")
    }
    private var sidebarPrimaryActions: some View {
        VStack(spacing: 2) {
            sidebarAction("Nouvelle conversation", systemImage: "square.and.pencil") {
                if cloudMode { Task { do { cloudSelection = try await agent.newCloudConversation() } catch { agent.error = error.localizedDescription } } }
                else {
                    showingArchives = false; store.newConversation()
                    if store.current?.model.isEmpty == true, let first = models.first { model.wrappedValue = first.id }
                }
                composing = true
            }
            sidebarAction("Modèles et fournisseurs", systemImage: "square.grid.2x2") { openDashboard() }
        }.padding(.horizontal, 8)
    }
    private func sidebarAction(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .frame(maxWidth: .infinity, alignment: .leading)
                .font(.system(size: 13, weight: title == "Nouvelle conversation" ? .medium : .regular))
                .padding(.horizontal, 9).padding(.vertical, 10).contentShape(Rectangle())
        }.buttonStyle(ChatActionStyle())
    }
    private var sidebarFooter: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { identity.openPicker() } label: { HStack(spacing: 9) {
                ZStack {
                    Circle().fill(ChatPalette.accent.opacity(0.13))
                    Image(systemName: agent.accountID == nil ? "desktopcomputer" : "person.crop.circle.badge.checkmark")
                        .font(.caption).foregroundStyle(ChatPalette.accent)
                }.frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 1) {
                    Text(identity.displayName).font(.caption.weight(.semibold)).lineLimit(1)
                    Text(identity.profiles.isEmpty ? "Historique local" : "Changer de compte").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if agent.busy { ProgressView().controlSize(.mini) }
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .medium)).foregroundStyle(.secondary)
            }.contentShape(Rectangle()) }.buttonStyle(.plain).accessibilityLabel("Compte : \(identity.displayName). Choisir un compte")
            if agent.accountID == nil {
                Button("Connecter MultiVibe Cloud") {
                    Task { await identity.addAccount() }
                }.buttonStyle(.borderless)
            } else {
                HStack {
                    Button("Gérer le Cloud") { selectedImports = []; cloudConsent = true }.buttonStyle(.borderless)
                    Spacer()
                    Menu("Actions") {
                        Button("Connecter un iPhone à ce Mac…") { instancePairing = true }
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
                        Button("Changer de compte…") { identity.openPicker() }
                        Button("Verrouiller le compte") { identity.lock() }
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
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(cloudMode ? (agent.cloudConversations.first { $0.id == cloudSelection }?.title ?? "Nouvelle conversation Cloud") : (store.current?.title ?? "Nouvelle conversation"))
                    .font(.system(size: 14, weight: .semibold)).lineLimit(1)
                HStack(spacing: 6) {
                    Text(conversationSubtitle).lineLimit(1)
                    if let state = conversationState {
                        Circle().fill(ChatPalette.accent).frame(width: 4, height: 4)
                        Text(state).lineLimit(1).foregroundStyle(ChatPalette.accent)
                    }
                }.font(.system(size: 11)).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
            if cloudMode {
                Picker("Projet Hermes", selection: Binding(get: { agent.selectedWorkspaceProject(cloudSelection) }, set: { value in
                    do { try agent.selectWorkspaceProject(value, conversation: cloudSelection) } catch { agent.error = error.localizedDescription }
                })) {
                    Text("Aucun projet").tag("")
                    let selected = agent.selectedWorkspaceProject(cloudSelection)
                    if !selected.isEmpty && !agent.cloudProjects.contains(where: { $0.id == selected }) { Text("Projet indisponible").tag(selected) }
                    ForEach(agent.cloudProjects) { project in Text(project.title).tag(project.id) }
                }.labelsHidden().frame(maxWidth: 160).controlSize(.small).disabled(cloudSending || agent.busy || cloudSelection == nil)
            }
            if agent.accountID != nil {
                Picker("Exécution", selection: $cloudMode) {
                    Label("Mac", systemImage: "desktopcomputer").tag(false)
                    Label("Cloud", systemImage: "cloud").tag(true)
                }.labelsHidden().pickerStyle(.segmented).frame(width: 134).disabled(cloudSending || store.isGenerating(store.selection))
            }
            if !cloudMode {
                Button(action: openHarnessInspector) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 13, weight: .medium))
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(ChatActionStyle(selected: showingHarnessInspector && selectedUtilityPanel == .conversation))
                .foregroundStyle(.secondary)
                .help("Réglages de la conversation")
                .accessibilityLabel("Réglages de la conversation")
                Menu {
                    Toggle("Réponses interactives", isOn: $interactiveAnswers)
                    Divider()
                    Button("Réglages de la conversation") { openHarnessInspector() }
                    Button("Réglages du Host") { openDashboard() }
                } label: { Image(systemName: "ellipsis").frame(width: 24, height: 30) }
                    .menuStyle(.borderlessButton).fixedSize().help("Options de la conversation").accessibilityLabel("Options de la conversation")
            }
        }
        .padding(.horizontal, 24).frame(height: 70).background(ChatPalette.canvas)
        .animation(ChatPalette.motion(reduceMotion), value: conversationState)
    }
    private var showingUtilityPanel: Bool { showingHarnessInspector || browser.isVisible }
    private func openHarnessInspector() {
        openHarnessInspector(subject: "capabilities")
    }
    private func openHarnessInspector(subject: String) {
        inspectorSubject = subject
        showingHarnessInspector = true
        selectedUtilityPanel = .conversation
    }
    private func closeHarnessInspector() {
        showingHarnessInspector = false
        if browser.isVisible { selectedUtilityPanel = .browser }
        Task { await loadHarnesses() }
    }
    private func closeBrowserPanel() {
        browser.hide()
        if showingHarnessInspector { selectedUtilityPanel = .conversation }
    }
    private var welcome: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 28)
            HarnessLogo(id: "native", name: "MultiVibe", size: 52).padding(.bottom, 22)
            Text("Un espace pour vos idées.")
                .font(.system(size: 29, weight: .semibold, design: .rounded)).tracking(-0.6).fixedSize(horizontal: false, vertical: true)
            Text("Explorez, écrivez et avancez avec votre assistant.")
                .font(.system(size: 14)).foregroundStyle(.secondary).padding(.top, 10).padding(.bottom, 28)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { welcomeSuggestions }
                VStack(spacing: 8) { welcomeSuggestions }
            }
            if !loading && models.isEmpty && harness.wrappedValue == "native" {
                Button { openDashboard() } label: { Label("Connecter un modèle pour commencer", systemImage: "plus.circle") }
                    .buttonStyle(.borderless).font(.callout).padding(.top, 20)
            }
            Spacer(minLength: 28)
        }.frame(maxWidth: 660, alignment: .leading).padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    @ViewBuilder private var welcomeSuggestions: some View {
        ForEach(suggestionCards) { suggestion in suggestionCard(suggestion) }
    }
    private func suggestionCard(_ suggestion: NativeChatSuggestion) -> some View {
        Button { draft.wrappedValue = suggestion.text; composing = true } label: {
            VStack(alignment: .leading, spacing: 10) {
                Image(systemName: suggestion.systemImage).font(.system(size: 16)).foregroundStyle(ChatPalette.accent)
                VStack(alignment: .leading, spacing: 5) {
                    Text(suggestion.title).font(.system(size: 12, weight: .medium)).lineLimit(1)
                    Text(suggestion.subtitle).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                }
            }.frame(minWidth: 152, maxWidth: .infinity, alignment: .leading).padding(14)
                .background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(ChatPalette.hairline, lineWidth: 0.5))
        }
        .buttonStyle(ChatActionStyle())
        .background(SecondaryClickAction { editingWelcomeSuggestion = suggestion })
        .help("Clic droit pour modifier cette suggestion")
        .accessibilityAction(named: "Modifier cette suggestion") { editingWelcomeSuggestion = suggestion }
    }
    private func saveWelcomeSuggestion(_ suggestion: NativeChatSuggestion) {
        guard let index = suggestionCards.firstIndex(where: { $0.id == suggestion.id }) else { return }
        suggestionCards[index] = suggestion.normalized
        NativeChatSuggestionStore.save(suggestionCards)
        editingWelcomeSuggestion = nil
    }
    private func resetWelcomeSuggestion(_ suggestion: NativeChatSuggestion) {
        saveWelcomeSuggestion(suggestion)
    }
    private func transcript(_ conversation: NativeChatConversation) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 30) {
                    ForEach(conversation.messages) { message in messageRow(message, conversation: conversation).id(message.id) }
                    NativeHarnessTimeline(events: unmatchedRuntimeEvents(in: conversation), sessionID: conversation.runtimeSessionID, target: conversation.executionTargetID ?? "local", running: store.isGenerating(conversation.id))
                    Color.clear.frame(height: 1).id("end")
                }.padding(.horizontal, 28).padding(.vertical, 28).frame(maxWidth: 820).frame(maxWidth: .infinity)
                    .background(ChatScrollPositionReader { followsTranscript = $0 })
            }
            .overlay(alignment: .bottom) {
                if !followsTranscript {
                    Button { followsTranscript = true; withAnimation(ChatPalette.motion(reduceMotion)) { proxy.scrollTo("end", anchor: .bottom) } } label: {
                        Label("Derniers messages", systemImage: "arrow.down").font(.caption.weight(.medium)).padding(.horizontal, 13).padding(.vertical, 9)
                            .background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 8)).overlay(Capsule().strokeBorder(ChatPalette.hairline, lineWidth: 1)).shadow(color: .black.opacity(0.08), radius: 8, y: 3)
                    }.buttonStyle(.plain).padding(.bottom, 12).transition(.opacity)
                }
            }
            .onAppear { proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: conversation.messages.last?.content) { _ in if followsTranscript { proxy.scrollTo("end", anchor: .bottom) } }
            .onChange(of: conversation.messages.count) { _ in if followsTranscript { proxy.scrollTo("end", anchor: .bottom) } }
            .onChange(of: conversation.runtimeEvents?.count) { _ in if followsTranscript { proxy.scrollTo("end", anchor: .bottom) } }
            .onChange(of: conversation.id) { _ in followsTranscript = true; proxy.scrollTo("end", anchor: .bottom) }
        }
    }
    @ViewBuilder private func messageRow(_ message: NativeChatMessage, conversation: NativeChatConversation) -> some View {
        let isUser = message.role == "user"
        let streaming = store.isGenerating(conversation.id) && message.id == conversation.messages.last?.id
        let turnEvents = message.runtimeTurnID.map { turnID in (conversation.runtimeEvents ?? []).filter { $0.turnId == turnID } } ?? []
        let hasInlineActivity = !HarnessPresentation.activities(turnEvents).isEmpty
        HStack(alignment: .top, spacing: 12) {
            if isUser { Spacer(minLength: 48) }
            if !isUser { HarnessLogo(id: conversation.harnessID ?? "native", name: selectedHarness.name, size: 26).padding(.top, 1) }
            VStack(alignment: isUser ? .trailing : .leading, spacing: 10) {
                if !isUser { Text(selectedHarness.name).font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary) }
                if message.content.isEmpty && streaming && !isUser && !hasInlineActivity {
                    HStack(spacing: 9) { ProgressView().controlSize(.small); Text("Préparation de la réponse…").font(.callout).foregroundStyle(.secondary) }.padding(.vertical, 4)
                } else if isUser {
                    Text(markdown(message.content)).textSelection(.enabled).font(.system(size: 15)).lineSpacing(5)
                        .padding(.horizontal, 16).padding(.vertical, 13).background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 16))
                } else {
                    if hasInlineActivity {
                        NativeHarnessTurnContent(message: message, events: turnEvents, sessionID: conversation.runtimeSessionID, target: conversation.executionTargetID ?? "local", running: store.isGenerating(conversation.id), streaming: streaming) { text in
                            guard store.selection == conversation.id, !store.isGenerating(conversation.id) else { return }
                            store.edit { $0.draft = text }; composing = true
                        }
                    } else {
                        NativeInteractiveAnswerView(content: message.content, streaming: streaming) { text in
                            guard store.selection == conversation.id, !store.isGenerating(conversation.id) else { return }
                            store.edit { $0.draft = text }; composing = true
                        }
                    }
                }
                if let sessionID = conversation.runtimeSessionID, let files = message.attachedFiles { NativeHarnessAttachments(files: files, sessionID: sessionID, target: conversation.executionTargetID ?? "local") }
                if message.interrupted && !store.isGenerating(conversation.id) {
                    HStack(spacing: 8) {
                        Label("Réponse interrompue", systemImage: "pause.circle").font(.caption).foregroundStyle(.secondary)
                        if message.id == conversation.messages.last?.id { Button("Réessayer") { sendMessage(retry: true) }.disabled(store.isGenerating(conversation.id)) }
                    }
                }
                if !message.content.isEmpty && !streaming { ChatMessageActions(content: message.content, isUser: isUser, speech: speech) }
            }
            if !isUser { Spacer(minLength: 0) }
        }.frame(maxWidth: .infinity).transition(.opacity)
    }
    private var desiredFeatureCatalogKey: String {
        [store.selection?.uuidString ?? "", harness.wrappedValue, store.current?.executionTargetID ?? "local",
         store.current?.workspace ?? "", store.current?.runtimeSessionID ?? "", store.current?.authMode ?? "native",
         store.current?.nativeModelID ?? store.current?.model ?? ""].joined(separator: "|")
    }
    private var addMenu: some View {
        NativeHarnessAddMenu(
            harnessName: selectedHarness.name,
            catalog: featureCatalog,
            loading: loadingFeatures,
            error: featureError,
            query: $featureQuery,
            addFiles: {
                showingAddMenu = false
                DispatchQueue.main.async { importing = true }
            },
            retry: { Task { await loadFeatureCatalog(force: true) } },
            select: handleFeature
        )
        .task(id: desiredFeatureCatalogKey) { await loadFeatureCatalog() }
    }
    private func loadFeatureCatalog(force: Bool = false) async {
        let key = desiredFeatureCatalogKey
        if !force, featureCatalogKey == key, featureCatalog != nil { return }
        featureCatalogKey = key; featureCatalog = nil; featureError = nil
        guard !cloudMode, harness.wrappedValue != "native", let id = store.selection else { return }
        loadingFeatures = true
        defer { if featureCatalogKey == key { loadingFeatures = false } }
        do {
            let catalog = try await store.featureCatalog(id)
            guard !Task.isCancelled, featureCatalogKey == key else { return }
            featureCatalog = catalog
        } catch {
            guard !Task.isCancelled, featureCatalogKey == key else { return }
            featureError = error.localizedDescription
        }
    }
    private func handleFeature(_ item: DesktopHarnessFeatureItem) {
        guard let id = store.selection else { return }
        switch item.action {
        case "insert":
            guard let value = item.value else { return }
            store.edit { $0.draft += ($0.draft.isEmpty || $0.draft.last?.isWhitespace == true ? "" : " ") + value }
            showingAddMenu = false; composing = true
        case "configure":
            guard let value = item.value else { return }
            showingAddMenu = false
            Task { @MainActor in
                do { _ = try await store.command(id, type: "configure", value: .object(["mode": .string(value)])); try await store.refreshRuntime(id) }
                catch { if store.selection == id { store.error = error.localizedDescription } }
            }
        case "compact":
            showingAddMenu = false; store.runtimeCommand(id, type: "compact")
        case "goal":
            showingAddMenu = false; showingGoal = true; goalText = ""
            Task { await loadGoal(id) }
        case "inspect":
            showingAddMenu = false
            let subject = item.subject ?? item.section
            DispatchQueue.main.async { openHarnessInspector(subject: subject) }
        default: break
        }
    }
    private var goalSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Goal").font(.title3.weight(.semibold))
                    Text("The harness keeps pursuing this objective across turns.").font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                if goalBusy { ProgressView().controlSize(.small) }
            }
            TextEditor(text: $goalText).font(.body).scrollContentBackground(.hidden)
                .padding(10).frame(minHeight: 130)
                .background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(ChatPalette.hairline))
            HStack {
                Button("Clear goal", role: .destructive) { Task { await saveGoal(clear: true) } }.disabled(goalBusy)
                Spacer()
                Button("Cancel") { showingGoal = false }.keyboardShortcut(.cancelAction)
                Button("Set goal") { Task { await saveGoal(clear: false) } }
                    .keyboardShortcut(.defaultAction).disabled(goalBusy || goalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(20).frame(width: 500)
    }
    private func loadGoal(_ id: UUID) async {
        goalBusy = true; defer { goalBusy = false }
        do {
            let receipt = try await store.command(id, type: "native", value: .object(["method": .string("thread/goal/get"), "params": .object([:])]))
            guard store.selection == id else { return }
            let result = receipt.result ?? .null
            goalText = result["goal"]["objective"].string ?? result["objective"].string ?? result["goal"].string ?? ""
        } catch { if store.selection == id { store.error = error.localizedDescription } }
    }
    private func saveGoal(clear: Bool) async {
        guard let id = store.selection else { return }
        goalBusy = true; defer { goalBusy = false }
        do {
            let method = clear ? "thread/goal/clear" : "thread/goal/set"
            let parameters: HarnessJSON = clear ? .object([:]) : .object(["objective": .string(goalText.trimmingCharacters(in: .whitespacesAndNewlines))])
            _ = try await store.command(id, type: "native", value: .object(["method": .string(method), "params": parameters]))
            showingGoal = false
        } catch { if store.selection == id { store.error = error.localizedDescription } }
    }
    private var composer: some View {
        VStack(spacing: 9) {
            VStack(alignment: .leading, spacing: 10) {
                TextField(working ? "Ajouter un message à la file…" : "Écrivez votre message…", text: draft, axis: .vertical)
                    .textFieldStyle(.plain).font(.system(size: 15)).lineLimit(2...8)
                    .fixedSize(horizontal: false, vertical: true).focused($composing).accessibilityLabel("Message à MultiVibe")
                    .onSubmit(submitComposer)
                    .background(ComposerNewlineShortcut())
                    .padding(.horizontal, 16).padding(.top, 16)
                HStack(spacing: 5) {
                    ChatIconButton(title: "Ajouter des fichiers ou des fonctions du harness", icon: "plus") {
                        featureQuery = ""; showingAddMenu = true
                    }
                    .disabled(cloudMode)
                    .popover(isPresented: $showingAddMenu, arrowEdge: .top) { addMenu }
                    if !cloudMode { harnessSelector }
                    modelSelector
                    if supportsProjects { projectSelector }
                    Spacer(minLength: 4)
                    composerActions
                }.padding(.horizontal, 9).padding(.bottom, 9)
            }
            .background(ChatPalette.elevated, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(composing ? ChatPalette.accent.opacity(0.6) : ChatPalette.hairline, lineWidth: 1))
            .shadow(color: .black.opacity(composing ? 0.07 : 0.035), radius: 12, y: 4)
            .animation(ChatPalette.motion(reduceMotion), value: composing)
            .animation(ChatPalette.motion(reduceMotion), value: working)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 14) {
                    Label(composerPrivacyText, systemImage: composerPrivacyIcon)
                    Spacer(minLength: 0)
                    Text("⌘ ↵ Nouvelle ligne").help("Commande + Entrée insère un retour à la ligne")
                }
                Label(composerPrivacyText, systemImage: composerPrivacyIcon)
            }.font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1).padding(.horizontal, 3)
        }
        .frame(maxWidth: 764).frame(maxWidth: .infinity)
        .padding(.horizontal, 28).padding(.top, 12).padding(.bottom, 20)
    }
    @ViewBuilder private var composerActions: some View {
        if cloudMode {
            sendButton(icon: "arrow.up", title: "Envoyer à Hermes", action: sendCloud)
                .disabled(!canSendCloud)
        } else {
            if working {
                if store.current?.runtimeSession?.capabilities["steer"]?.available == true {
                    ChatIconButton(title: "Intervenir dans le travail en cours", icon: "arrow.triangle.branch") { store.steer() }.disabled(!canSend)
                }
                ChatIconButton(title: "Arrêter le tour et suspendre la file", icon: "stop.fill") { store.stop() }
                    .disabled(store.current?.runtimeSession?.capabilities["interrupt"]?.support == "unsupported")
            }
            sendButton(icon: working ? "text.badge.plus" : "arrow.up", title: working ? "Ajouter à la file d’attente" : "Envoyer", action: { sendMessage() }).disabled(!canSend)
        }
    }
    private func unmatchedRuntimeEvents(in conversation: NativeChatConversation) -> [DesktopHarnessEvent] {
        let renderedTurns = Set(conversation.messages.compactMap { $0.role == "assistant" ? $0.runtimeTurnID : nil })
        return (conversation.runtimeEvents ?? []).filter { event in
            guard let turnID = event.turnId else { return true }
            return !renderedTurns.contains(turnID)
        }
    }
    private func sendButton(icon: String, title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: icon).font(.system(size: 14, weight: .semibold)).frame(width: 34, height: 34) }
            .buttonStyle(ChatActionStyle(prominent: true)).help(title).accessibilityLabel(title)
    }
    private var canSendCloud: Bool {
        cloudSelection != nil && !cloudSending && !agent.busy && agent.consent?.cloudEnabled == true &&
        !cloudDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && agent.models.contains { $0.id == cloudModel && $0.available != false }
    }
    private func submitComposer() {
        if cloudMode { if canSendCloud { sendCloud() } }
        else if canSend { sendMessage() }
    }
    private var canSend: Bool {
        let hasInput = !draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.current?.draftAttachments?.isEmpty == false
        guard hasInput else { return false }
        if harness.wrappedValue == "native" { return models.contains { $0.id == model.wrappedValue } }
        if store.current?.authMode == "multivibe" { return selectedHarness.available && models.contains { $0.id == model.wrappedValue && $0.local != true } }
        return selectedHarness.available
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
            .background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(ChatActionStyle()).tint(.secondary)
        .frame(maxWidth: 160, alignment: .leading).fixedSize(horizontal: true, vertical: true)
        .help(selectedHarness.description)
        .disabled(store.current?.messages.isEmpty == false || store.current?.runtimeSessionID != nil || store.isGenerating(store.selection))
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
        var items = harnesses
        for (id, name) in [("librechat", "LibreChat"), ("openwebui", "Open WebUI")] where !items.contains(where: { $0.id == id }) {
            items.append(.init(id: id, name: name, available: false, configured: false, description: harnessDescription(id), capabilities: .init(sessions: true, streaming: true, tools: true, longTermMemory: false, projects: false), unavailableReason: "Connexion requise", canInstall: false, compatible: true, detected: false, conversationCapable: true, category: "agent", popularityRank: 10))
        }
        return items.sortedForDisplay(lastUsedAt: harnessLastUsedAt)
    }
    private func recordHarnessUse(_ id: String) {
        harnessLastUsedAt[id] = Date().timeIntervalSince1970
        UserDefaults.standard.set(harnessLastUsedAt, forKey: "assistantHarnessLastUsedAt")
    }
    private func sendMessage(retry: Bool = false) {
        recordHarnessUse(harness.wrappedValue)
        store.send(retry: retry, interactiveAnswers: interactiveAnswers)
    }
    private func harnessCard(_ item: NativeConversationHarness) -> some View {
        Button {
            if ["librechat", "openwebui"].contains(item.id) {
                choosingHarness = false
                if item.configured {
                    harness.wrappedValue = item.id
                    recordHarnessUse(item.id)
                } else { configuringRemoteHarness = item.id }
            } else if item.available {
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
                Text(item.description).font(.caption2).foregroundStyle(.secondary).lineLimit(2, reservesSpace: true)
                if item.available && item.capabilities.longTermMemory {
                    Label("Mémoire longue durée", systemImage: "brain.head.profile")
                        .font(.caption2.weight(.medium)).foregroundStyle(ChatPalette.accent)
                } else if item.available && item.id == "pi" {
                    Label("Session persistante", systemImage: "clock.arrow.circlepath")
                        .font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                } else if item.available && item.capabilities.tools {
                    Label("Outils et sessions", systemImage: "wrench.and.screwdriver")
                        .font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                } else if item.available {
                    Label("Session persistante", systemImage: "clock.arrow.circlepath")
                        .font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                } else if item.detected == true {
                    Label(item.configured ? "Détecté et configuré" : "Détecté sur ce Mac", systemImage: "checkmark.circle")
                        .font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                } else {
                    Label("Disponible sur macOS", systemImage: "laptopcomputer")
                        .font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                }
                if ["librechat", "openwebui"].contains(item.id) {
                    Label(item.configured ? "Connecté · conversations synchronisées" : "Connecter une instance", systemImage: "network")
                        .font(.caption.weight(.semibold)).foregroundStyle(ChatPalette.accent)
                }
                if !item.available && item.canInstall == true {
                    Label("Installer", systemImage: "arrow.down.circle.fill")
                        .font(.caption.weight(.semibold)).foregroundStyle(ChatPalette.accent)
                }
            }
            .padding(13).frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
            .background(item.id == harness.wrappedValue ? ChatPalette.accent.opacity(0.10) : ChatPalette.elevated,
                        in: RoundedRectangle(cornerRadius: 15))
            .overlay(RoundedRectangle(cornerRadius: 15).stroke(
                item.id == harness.wrappedValue ? ChatPalette.accent.opacity(0.8) : ChatPalette.hairline,
                lineWidth: item.id == harness.wrappedValue ? 1.5 : 1))
        }
        .buttonStyle(.plain).disabled(!item.available && item.canInstall != true && !["librechat", "openwebui"].contains(item.id))
        .opacity(item.available || item.canInstall == true || ["librechat", "openwebui"].contains(item.id) ? 1 : 0.72)
        .contextMenu {
            if ["librechat", "openwebui"].contains(item.id) {
                Button("Configurer la connexion…") { choosingHarness = false; configuringRemoteHarness = item.id }
            }
        }
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
                try await NativeHarnessClient.shared.install(harnessID: item.id, connectToMultiVibe: false) { line in installationLogs.append(line) }
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
            Button(showingInstallationLogs ? "Masquer les journaux" : "Afficher les journaux") { showingInstallationLogs.toggle() }
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
    private var supportsProjects: Bool {
        !cloudMode && harness.wrappedValue != "native" && selectedHarness.capabilities.projects == true
    }
    private var projectCatalogKey: String {
        [store.selection?.uuidString ?? "", harness.wrappedValue, store.current?.executionTargetID ?? "local", String(supportsProjects)].joined(separator: "|")
    }
    private var availableProjects: [DesktopHarnessProject] {
        loadedProjectsKey == projectCatalogKey ? projects : []
    }
    private var visibleProjects: [DesktopHarnessProject] {
        availableProjects.filter { $0.matches(search: projectQuery) }
    }
    private var selectedProject: DesktopHarnessProject? {
        guard let workspace = store.current?.workspace else { return nil }
        return availableProjects.first { $0.path == workspace }
    }
    private var selectedProjectName: String {
        if let selectedProject { return selectedProject.name }
        guard let workspace = store.current?.workspace, !workspace.isEmpty else { return "Aucun projet" }
        return (workspace as NSString).lastPathComponent.isEmpty ? workspace : (workspace as NSString).lastPathComponent
    }
    private var projectSelectionLocked: Bool {
        store.current?.messages.isEmpty == false || store.current?.runtimeSessionID != nil || store.isGenerating(store.selection)
    }
    private var projectSelector: some View {
        Button { projectQuery = ""; choosingProject = true } label: {
            HStack(spacing: 6) {
                if loadingProjects { ProgressView().controlSize(.mini) }
                else { Image(systemName: store.current?.workspace == nil ? "folder" : "folder.fill") }
                Text(selectedProjectName).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 8, weight: .semibold)).foregroundStyle(.tertiary)
            }
            .font(.caption.weight(.medium)).foregroundStyle(.secondary)
            .padding(.horizontal, 9).frame(height: 28)
            .background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(ChatActionStyle()).tint(.secondary)
        .frame(maxWidth: 180, alignment: .leading).fixedSize(horizontal: true, vertical: true)
        .help(projectSelectionLocked ? "Le projet est attaché à cette conversation." : availableProjects.isEmpty ? "Aucun projet détecté pour ce harness." : "Choisir le dossier de projet de cette conversation")
        .disabled(projectSelectionLocked || loadingProjects)
        .popover(isPresented: $choosingProject, arrowEdge: .bottom) { projectPicker }
    }
    private var projectPicker: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Choisir un projet").font(.headline)
                    Text("Le harness démarrera dans le dossier sélectionné.").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { Task { await loadProjects() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).help("Actualiser les projets")
            }
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Rechercher un projet…", text: $projectQuery)
                    .textFieldStyle(.plain).accessibilityLabel("Rechercher un projet par nom ou chemin")
                if !projectQuery.isEmpty {
                    Button { projectQuery = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                        .buttonStyle(.plain).help("Effacer la recherche de projets")
                        .accessibilityLabel("Effacer la recherche de projets")
                }
            }
            .padding(9).background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 9))
            if let projectsError {
                Label(projectsError, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.red)
            }
            ScrollView {
                VStack(spacing: 7) {
                    projectRow(title: "Aucun projet", path: "Nouvelle conversation sans dossier associé", icon: "folder.badge.minus", selected: store.current?.workspace == nil) {
                        store.edit { $0.workspace = nil }; choosingProject = false
                    }
                    if let workspace = store.current?.workspace, selectedProject == nil {
                        projectRow(title: selectedProjectName, path: workspace, icon: "folder.badge.questionmark", selected: true) {}
                            .disabled(true).opacity(0.65)
                    }
                    ForEach(visibleProjects) { project in
                        projectRow(title: project.name, path: project.path, icon: "folder", selected: project.path == store.current?.workspace) {
                            store.edit { $0.workspace = project.path }; choosingProject = false
                        }
                    }
                    if availableProjects.isEmpty {
                        Text("Aucun projet existant n’a été détecté pour \(selectedHarness.name).")
                            .font(.caption).foregroundStyle(.secondary).padding(.vertical, 14)
                    } else if visibleProjects.isEmpty {
                        Text("Aucun projet ne correspond à votre recherche.")
                            .font(.caption).foregroundStyle(.secondary).padding(.vertical, 14)
                    }
                }.padding(1)
            }.frame(maxHeight: 360)
        }
        .padding(18).frame(width: 520)
    }
    private func projectRow(title: String, path: String, icon: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon).foregroundStyle(ChatPalette.accent).frame(width: 28, height: 28)
                    .background(ChatPalette.accent.opacity(0.09), in: RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.callout.weight(.medium)).foregroundStyle(.primary).lineLimit(1)
                    Text(path).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 0)
                if selected { Image(systemName: "checkmark.circle.fill").foregroundStyle(ChatPalette.accent) }
            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(selected ? ChatPalette.accent.opacity(0.08) : ChatPalette.elevated, in: RoundedRectangle(cornerRadius: 11))
        }.buttonStyle(.plain).accessibilityLabel("\(title), \(path)").accessibilityValue(selected ? "Sélectionné" : "")
    }
    private func loadProjects() async {
        let key = projectCatalogKey
        projects = []; projectsError = nil; loadedProjectsKey = key
        guard supportsProjects else { loadingProjects = false; return }
        loadingProjects = true
        do {
            let encoded = harness.wrappedValue.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? harness.wrappedValue
            let response = try await DesktopHarnessClient.shared.call("/projects?harnessId=\(encoded)", target: store.current?.executionTargetID ?? "local")
            let values = try response["projects"].decode([DesktopHarnessProject].self)
            guard !Task.isCancelled, key == projectCatalogKey else { return }
            projects = values
        } catch {
            guard !Task.isCancelled, key == projectCatalogKey else { return }
            projectsError = error.localizedDescription
        }
        if key == projectCatalogKey { loadingProjects = false }
    }
    private func openModelPicker() {
        modelSource = cloudMode ? (selectedCloudModel?.source == "relay" ? "relay" : "cloud") : (harness.wrappedValue != "native" && store.current?.authMode != "multivibe" ? "harness" : "multivibe")
        modelQuery = ""
        choosingModel = true
    }
    private var modelSelector: some View {
        Button {
            if showsEffortControl { choosingEffort = true }
            else { openModelPicker() }
        } label: {
            HStack(spacing: 6) {
                if !cloudMode && harness.wrappedValue != "native" && store.current?.authMode != "multivibe" {
                    HarnessLogo(id: selectedHarness.id, name: selectedHarness.name, size: 16)
                } else {
                    Image(systemName: cloudMode ? (selectedCloudModel?.source == "relay" ? "desktopcomputer" : "cloud") : (selectedLocalModel?.local == true ? "apple.logo" : "cpu"))
                }
                Text(selectedModelName).lineLimit(1)
                if showsEffortControl, let option = selectedEffortOption {
                    Text(effortDisplayName(option)).foregroundStyle(.tertiary).lineLimit(1)
                }
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold)).foregroundStyle(.tertiary)
            }
            .font(.caption.weight(.medium)).foregroundStyle(.secondary)
            .padding(.horizontal, 9).frame(height: 28)
            .background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(ChatActionStyle()).tint(.secondary)
        .frame(maxWidth: 320, alignment: .leading).fixedSize(horizontal: true, vertical: true)
        .disabled(cloudMode ? cloudSending : store.isGenerating(store.selection))
        .popover(isPresented: $choosingModel, arrowEdge: .bottom) { modelPicker }
        .popover(isPresented: $choosingEffort, arrowEdge: .top) { effortPopover }
        .accessibilityLabel(showsEffortControl ? "Modèle et effort" : "Modèle")
        .accessibilityValue(showsEffortControl ? "\(selectedModelName), \(selectedEffortOption.map(effortDisplayName) ?? "")" : selectedModelName)
    }
    private var effortKey: String {
        let update = store.current?.runtimeEvents?.last(where: { $0.type == "configuration" })?.seq ?? 0
        return harnessModelsKey + "|" + (store.current?.effortContext ?? "") + "|" + String(update)
    }
    private var effectiveEffort: String? {
        // Live harness state is authoritative after a session has started.
        if store.current?.runtimeSessionID != nil { return harnessEffort?.currentValue }
        return store.current?.selectedEffort ?? harnessEffort?.currentValue
    }
    private var showsEffortControl: Bool {
        !cloudMode && harness.wrappedValue != "native" && loadedEffortKey == effortKey && harnessEffort?.options.isEmpty == false
    }
    private var selectedEffortOption: DesktopHarnessEffort.Option? {
        guard let effort = harnessEffort else { return nil }
        return effort.options.first { $0.value == effectiveEffort } ?? effort.options.first { $0.value == effort.defaultValue }
    }
    private func effortDisplayName(_ option: DesktopHarnessEffort.Option) -> String {
        if option.label != option.value { return option.label }
        switch option.value.lowercased() {
        case "none", "off": return "None"
        case "minimal": return "Minimal"
        case "low": return "Low"
        case "medium": return "Medium"
        case "high": return "High"
        case "xhigh": return "Extra High"
        case "max": return "Max"
        case "ultra": return "Ultra"
        default: return option.label
        }
    }
    private var effortPopover: some View {
        VStack(spacing: 18) {
            ZStack(alignment: .trailing) {
                Button {
                    choosingEffort = false
                    DispatchQueue.main.async { openModelPicker() }
                } label: {
                    VStack(spacing: 4) {
                        Text(selectedEffortOption.map(effortDisplayName) ?? "Select effort")
                            .font(.title3.weight(.medium)).foregroundStyle(ChatPalette.accent)
                        HStack(spacing: 4) {
                            Text(selectedModelName).lineLimit(1)
                            Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
                        }.font(.callout).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity)
                }.buttonStyle(.plain).help("Choisir un autre modèle")
                if let effort = harnessEffort, effort.defaultValue != nil {
                    Button { resetEffort(effort) } label: {
                        Image(systemName: "arrow.counterclockwise").font(.system(size: 18, weight: .medium))
                            .frame(width: 32, height: 32)
                    }.buttonStyle(.plain).foregroundStyle(.secondary)
                        .disabled(changingEffort || effectiveEffort == effort.defaultValue)
                        .help("Revenir au niveau d’effort par défaut")
                        .accessibilityLabel("Réinitialiser l’effort")
                }
            }
            if let effort = harnessEffort {
                effortScale(effort)
            }
        }
        .padding(18).frame(width: 380)
    }
    private func effortScale(_ effort: DesktopHarnessEffort) -> some View {
        let options = effort.options
        let selected = max(0, options.firstIndex(where: { $0.value == effectiveEffort }) ?? options.firstIndex(where: { $0.value == effort.defaultValue }) ?? 0)
        return GeometryReader { geometry in
            let inset: CGFloat = 22
            let available = max(0, geometry.size.width - inset * 2)
            let step = options.count > 1 ? available / CGFloat(options.count - 1) : 0
            let thumbX = inset + step * CGFloat(selected)
            ZStack(alignment: .leading) {
                Capsule().fill(ChatPalette.subtle)
                    .overlay(Capsule().stroke(ChatPalette.hairline, lineWidth: 1))
                Capsule().fill(ChatPalette.accent)
                    .frame(width: max(44, thumbX + inset))
                HStack(spacing: 0) {
                    ForEach(Array(options.enumerated()), id: \.element.id) { index, option in
                        Button { selectEffort(option, from: effort) } label: {
                            Circle().fill(.white.opacity(index <= selected ? 0.38 : 0.30)).frame(width: 7, height: 7)
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }.buttonStyle(.plain).disabled(changingEffort)
                            .accessibilityLabel(effortDisplayName(option))
                            .accessibilityValue(index == selected ? "Sélectionné" : "")
                    }
                }.padding(.horizontal, inset - 3)
                Circle().fill(.white).frame(width: 42, height: 42)
                    .shadow(color: .black.opacity(0.16), radius: 3, y: 1)
                    .offset(x: thumbX - 21)
                    .allowsHitTesting(false)
            }
            .contentShape(Capsule())
            .gesture(DragGesture(minimumDistance: 0).onEnded { value in
                guard !changingEffort, !options.isEmpty else { return }
                let raw = step > 0 ? (value.location.x - inset) / step : 0
                let index = min(options.count - 1, max(0, Int(raw.rounded())))
                selectEffort(options[index], from: effort)
            })
        }
        .frame(height: 48)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Niveau d’effort")
    }
    private func selectEffort(_ option: DesktopHarnessEffort.Option, from effort: DesktopHarnessEffort) {
        guard let id = store.selection, !changingEffort, option.value != effectiveEffort else { return }
        changingEffort = true
        Task { @MainActor in
            defer { changingEffort = false }
            do {
                try await store.selectEffort(option.value, catalog: effort, conversationID: id)
                if store.selection == id { await loadHarnessEffort() }
            } catch { if store.selection == id { store.error = error.localizedDescription } }
        }
    }
    private func resetEffort(_ effort: DesktopHarnessEffort) {
        guard let id = store.selection, !changingEffort else { return }
        changingEffort = true
        Task { @MainActor in
            defer { changingEffort = false }
            do {
                try await store.resetEffort(catalog: effort, conversationID: id)
                if store.selection == id { await loadHarnessEffort() }
            } catch { if store.selection == id { store.error = error.localizedDescription } }
        }
    }
    private func loadHarnessEffort() async {
        let key = effortKey
        harnessEffort = nil; effortError = nil; loadedEffortKey = key
        guard !cloudMode, harness.wrappedValue != "native", let id = store.selection else { loadingEffort = false; return }
        loadingEffort = true
        defer { if key == effortKey { loadingEffort = false } }
        do {
            let effort = try await store.effortCatalog(id)
            guard !Task.isCancelled, key == effortKey else { return }
            harnessEffort = effort
        } catch {
            guard !Task.isCancelled, key == effortKey else { return }
            effortError = error.localizedDescription
        }
    }
    private var modelPicker: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Choisir un modèle").font(.headline)
                    Text(modelPickerSubtitle).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { Task { await refreshModels() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).help("Actualiser les modèles")
            }
            if showsModelSourceTabs {
                Picker("Source", selection: $modelSource) {
                    if cloudMode {
                        if hasCloudModels { Text("Cloud").tag("cloud") }
                        if hasRelayModels { Text("Relay").tag("relay") }
                    } else {
                        Text("MultiVibe").tag("multivibe")
                        Text(selectedHarness.name).tag("harness")
                    }
                }.labelsHidden().pickerStyle(.segmented).frame(maxWidth: 320)
            }
            if !cloudMode && modelSourceLocked && (modelSource == "multivibe") != (store.current?.authMode == "multivibe") {
                Label("La source du modèle est attachée à cette conversation.", systemImage: "lock")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !cloudMode && modelSource == "harness" { harnessModelChoices }
            else {
                if showsModelSearch { modelSearch }
                modelCards
            }
        }
        .padding(18).frame(width: 620)
    }
    private var modelPickerSubtitle: String {
        if cloudMode { return "Sélectionnez le modèle utilisé dans votre espace Hermes Cloud." }
        if harness.wrappedValue != "native" { return "Choisissez parmi les modèles disponibles de \(selectedHarness.name) ou de MultiVibe." }
        return "Sélectionnez le modèle qui répondra dans cette conversation."
    }
    private var hasCloudModels: Bool { agent.models.contains { $0.source != "relay" } }
    private var hasRelayModels: Bool { agent.models.contains { $0.source == "relay" } }
    private var showsModelSourceTabs: Bool {
        cloudMode ? hasCloudModels && hasRelayModels : harness.wrappedValue != "native"
    }
    private var modelSourceLocked: Bool {
        store.current?.messages.isEmpty == false || store.current?.runtimeSessionID != nil
    }
    private var availableHostModels: [HostAssistantModel] {
        harness.wrappedValue == "native" ? models : models.filter { $0.local != true }
    }
    private var availableCloudModels: [NativeAgentCatalogModel] {
        agent.models.filter { modelSource == "relay" ? $0.source == "relay" : $0.source != "relay" }
    }
    private var modelSearchTerms: [String] {
        modelQuery.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }
    private func matchesModelQuery(_ values: String...) -> Bool {
        modelSearchTerms.allSatisfy { term in values.contains { $0.localizedCaseInsensitiveContains(term) } }
    }
    private var visibleHostModels: [HostAssistantModel] {
        availableHostModels.filter {
            matchesModelQuery($0.displayName, $0.id, $0.local == true ? "Sur ce Mac Apple local" : "MultiVibe Host réseau")
        }
    }
    private var visibleCloudModels: [NativeAgentCatalogModel] {
        availableCloudModels.filter {
            matchesModelQuery($0.name ?? "", $0.id, $0.source ?? "", $0.machineName ?? "", $0.source == "relay" ? "Relay" : "Hermes Cloud")
        }
    }
    private var availableModelCount: Int { cloudMode ? availableCloudModels.count : modelSource == "harness" ? harnessModels.count : availableHostModels.count }
    private var visibleModelCount: Int { cloudMode ? visibleCloudModels.count : modelSource == "harness" ? visibleHarnessModels.count : visibleHostModels.count }
    private var showsModelSearch: Bool { availableModelCount > 6 || !modelQuery.isEmpty }
    private var modelSearch: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Rechercher par nom, identifiant ou source", text: $modelQuery)
                    .textFieldStyle(.plain)
                    .accessibilityLabel("Rechercher un modèle")
                if !modelQuery.isEmpty {
                    Button { modelQuery = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary) }
                        .buttonStyle(.plain).help("Effacer la recherche").accessibilityLabel("Effacer la recherche")
                }
            }
            .padding(.horizontal, 11).frame(height: 34)
            .background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 9))
            HStack {
                Text(modelQuery.isEmpty ? "\(availableModelCount) modèles" : "\(visibleModelCount) sur \(availableModelCount) modèles")
                    .font(.caption2).foregroundStyle(.secondary)
                Spacer()
                if !modelQuery.isEmpty { Text("Recherche instantanée").font(.caption2).foregroundStyle(.tertiary) }
            }
        }
    }
    @ViewBuilder private var modelCards: some View {
        if loading && !cloudMode {
            HStack { Spacer(); ProgressView().controlSize(.small); Text("Chargement des modèles…").foregroundStyle(.secondary); Spacer() }.padding(.vertical, 30)
        } else if availableModelCount == 0 {
            VStack(spacing: 8) {
                Image(systemName: "cpu").font(.title2).foregroundStyle(.secondary)
                Text("Aucun modèle disponible").font(.callout.weight(.semibold))
                Text("Actualisez le catalogue ou vérifiez la connexion du Host.").font(.caption).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, minHeight: 180)
        } else if visibleModelCount == 0 {
            VStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.title2).foregroundStyle(.secondary)
                Text("Aucun modèle ne correspond").font(.callout.weight(.semibold))
                Text("Essayez un nom, un identifiant ou une autre source.").font(.caption).foregroundStyle(.secondary)
                Button("Effacer la recherche") { modelQuery = "" }.buttonStyle(.link)
            }.frame(maxWidth: .infinity, minHeight: 180)
        } else {
            ScrollView {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible())], spacing: 8) {
                    if cloudMode {
                        if !cloudModel.isEmpty && !agent.models.contains(where: { $0.id == cloudModel }) {
                            modelCard(title: cloudModel, detail: "Indisponible", identifier: cloudModel, icon: "exclamationmark.triangle", selected: true, disabled: true) {}
                        }
                        ForEach(visibleCloudModels) { cloudModelCard($0) }
                    } else {
                        if !model.wrappedValue.isEmpty && !models.contains(where: { $0.id == model.wrappedValue }) {
                            modelCard(title: model.wrappedValue, detail: "Indisponible", identifier: model.wrappedValue, icon: "exclamationmark.triangle", selected: true, disabled: true) {}
                        }
                        ForEach(visibleHostModels) { hostModelCard($0) }
                    }
                }
            }.frame(maxHeight: 420)
        }
    }
    private func hostModelCard(_ item: HostAssistantModel) -> some View {
        let selected = store.current?.authMode != "native" && item.id == model.wrappedValue || harness.wrappedValue == "native" && item.id == model.wrappedValue
        let sourceChangeBlocked = harness.wrappedValue != "native" && modelSourceLocked && store.current?.authMode != "multivibe"
        return modelCard(title: item.displayName, detail: item.local == true ? "Sur ce Mac" : "Via MultiVibe Host", identifier: item.id,
                         icon: item.local == true ? "apple.logo" : "network", selected: selected, disabled: sourceChangeBlocked) {
            if harness.wrappedValue != "native" { store.edit { $0.authMode = "multivibe" } }
            model.wrappedValue = item.id
            choosingModel = false
        }
    }
    private func cloudModelCard(_ item: NativeAgentCatalogModel) -> some View {
        modelCard(title: item.name ?? item.id, detail: item.source == "relay" ? (item.machineName ?? "Relay") : "Hermes Cloud", identifier: item.id,
                  icon: item.source == "relay" ? "desktopcomputer" : "cloud", selected: item.id == cloudModel, disabled: item.available == false) {
            cloudModel = item.id
            choosingModel = false
        }
    }
    private var harnessModelsKey: String {
        [store.selection?.uuidString ?? "", harness.wrappedValue, store.current?.executionTargetID ?? "local", store.current?.workspace ?? "", store.current?.runtimeSessionID ?? "", store.current?.authMode ?? "native", String(cloudMode)].joined(separator: "|")
    }
    private var selectedHarnessModelID: String? {
        store.current?.nativeModelID ?? store.current?.runtimeSession?.model ?? (loadedHarnessModelsKey == harnessModelsKey ? harnessDefaultModel : nil)
    }
    private var selectedHarnessModelProvider: String? {
        store.current?.nativeModelProvider ?? (loadedHarnessModelsKey == harnessModelsKey ? harnessDefaultProvider : nil)
    }
    private var visibleHarnessModels: [DesktopHarnessModel] {
        harnessModels.filter { matchesModelQuery($0.name, $0.id, $0.provider ?? "", $0.description ?? "") }
    }
    @ViewBuilder private var harnessModelChoices: some View {
        if loadingHarnessModels { HStack { ProgressView().controlSize(.small); Text("Chargement des modèles de \(selectedHarness.name)…").font(.callout) }.padding(.vertical, 20) }
        else if let error = harnessModelsError {
            VStack(alignment: .leading, spacing: 10) {
                Label("Impossible de charger les modèles", systemImage: "exclamationmark.triangle").font(.callout.weight(.medium))
                Text(error).font(.caption).foregroundStyle(.secondary)
                Button("Réessayer") { Task { await loadHarnessModels() } }
            }.padding(.vertical, 12)
        } else if harnessModels.isEmpty {
            Label("Ce harness ne publie aucun modèle disponible. Vérifiez sa connexion et ses réglages.", systemImage: "info.circle").font(.callout).foregroundStyle(.secondary).padding(.vertical, 16)
        } else {
            if showsModelSearch { modelSearch }
            if visibleHarnessModels.isEmpty { Text("Aucun modèle ne correspond à votre recherche.").font(.callout).foregroundStyle(.secondary).padding(.vertical, 16) }
            else {
                ScrollView {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible())], spacing: 10) {
                        ForEach(visibleHarnessModels, id: \.key) { item in
                            modelCard(title: item.name, detail: item.provider ?? item.description ?? selectedHarness.name, identifier: item.id, icon: "cpu",
                                      selected: store.current?.authMode != "multivibe" && item.id == selectedHarnessModelID && (item.provider == nil || item.provider == selectedHarnessModelProvider),
                                      disabled: modelSourceLocked && store.current?.authMode == "multivibe" || store.current?.runtimeSessionID != nil && ["librechat", "openwebui"].contains(harness.wrappedValue)) {
                                Task { await selectHarnessModel(item) }
                            }
                        }
                    }.padding(2)
                }.frame(maxHeight: 420)
            }
        }
    }
    private func loadHarnessModels() async {
        let key = harnessModelsKey
        harnessModels = []; harnessDefaultModel = nil; harnessDefaultProvider = nil; harnessModelsError = nil; loadedHarnessModelsKey = key
        guard !cloudMode, harness.wrappedValue != "native", let id = store.selection else { loadingHarnessModels = false; return }
        loadingHarnessModels = true
        do {
            let catalog = try await store.modelCatalog(id)
            guard !Task.isCancelled, key == harnessModelsKey else { return }
            harnessModels = catalog.models; harnessDefaultModel = catalog.currentModelId; harnessDefaultProvider = catalog.provider
            if store.current?.authMode != "multivibe", store.current?.nativeModelID == nil,
               store.current?.messages.isEmpty == true, store.current?.runtimeSessionID == nil,
               let defaultModel = catalog.currentModelId {
                store.edit { $0.nativeModelID = defaultModel; $0.nativeModelProvider = catalog.provider }
            }
        } catch {
            guard !Task.isCancelled, key == harnessModelsKey else { return }
            harnessModelsError = error.localizedDescription
        }
        loadingHarnessModels = false
    }
    private func selectHarnessModel(_ item: DesktopHarnessModel) async {
        guard let id = store.selection else { return }
        do {
            if store.current?.runtimeSessionID != nil {
                var settings: [String: HarnessJSON] = ["model": .string(item.id)]
                if let provider = item.provider { settings["provider"] = .string(provider) }
                _ = try await store.command(id, type: "configure", value: .object(settings))
            }
            guard store.selection == id else { return }
            store.edit { $0.authMode = "native"; $0.nativeModelID = item.id; $0.nativeModelProvider = item.provider }
            store.rememberCurrentModel()
            choosingModel = false
        } catch { harnessModelsError = error.localizedDescription }
    }
    private func modelCard(title: String, detail: String, identifier: String, icon: String, selected: Bool, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: icon).font(.system(size: 16, weight: .medium)).foregroundStyle(ChatPalette.accent)
                    .frame(width: 36, height: 36).background(ChatPalette.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.callout.weight(.semibold)).foregroundStyle(.primary).lineLimit(2)
                    Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    if identifier != title { Text(identifier).font(.caption2.monospaced()).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.middle) }
                }
                Spacer(minLength: 0)
                if selected { Image(systemName: "checkmark.circle.fill").font(.title3).foregroundStyle(ChatPalette.accent) }
            }
            .padding(11).frame(maxWidth: .infinity, minHeight: 76, alignment: .topLeading)
            .background(selected ? ChatPalette.accent.opacity(0.10) : ChatPalette.elevated, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(selected ? ChatPalette.accent.opacity(0.8) : ChatPalette.hairline, lineWidth: selected ? 1.5 : 1))
        }.buttonStyle(.plain).disabled(disabled).opacity(disabled ? 0.55 : 1)
            .accessibilityLabel("\(title), \(detail)")
            .accessibilityValue(selected ? "Sélectionné" : "")
    }
    private func refreshModels() async {
        if cloudMode {
            do { try await agent.loadModels() } catch { agent.error = error.localizedDescription }
        } else if modelSource == "harness" { await loadHarnessModels() }
        else { await loadModels() }
    }
    private var composerPrivacyText: String {
        if cloudMode { return "Dans votre espace Hermes Cloud" }
        if harness.wrappedValue != "native" { return "\(targetName) · \(store.current?.authMode == "multivibe" ? "Modèles MultiVibe" : "Accès du harness")" }
        if selectedLocalModel?.local == true { return "Traité localement sur ce Mac" }
        return "Via votre Host · modèle sélectionné"
    }
    private var composerPrivacyIcon: String { cloudMode ? "cloud" : "lock" }
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
                    let isUser = message.role == "user"
                    HStack(alignment: .top, spacing: 12) {
                        if isUser { Spacer(minLength: 48) }
                        if !isUser { HarnessLogo(id: "hermes-agent", name: "Hermes", size: 26).padding(.top, 1) }
                        VStack(alignment: isUser ? .trailing : .leading, spacing: 10) {
                            if !isUser { Text("Hermes").font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary) }
                            if isUser {
                                Text(markdown(message.content)).textSelection(.enabled).font(.system(size: 15)).lineSpacing(5)
                                    .padding(.horizontal, 16).padding(.vertical, 13).background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 16))
                            } else {
                                NativeInteractiveAnswerView(content: message.content) { cloudDraft = $0; composing = true }
                            }
                            if !message.content.isEmpty { ChatMessageActions(content: message.content, isUser: isUser, speech: speech) }
                        }
                        if !isUser { Spacer(minLength: 0) }
                    }
                    .frame(maxWidth: .infinity)
                }
                ForEach(agent.orderedRuns.filter { $0.sessionId == cloudSelection?.uuidString.lowercased() }, id: \.runId) { run in
                    VStack(alignment: .leading, spacing: 9) {
                        Label("Exécution Cloud", systemImage: "cloud").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        Text(agent.runPrompt(run.runId)).font(.headline).textSelection(.enabled)
                        if let response = agent.responseText(run) { NativeInteractiveAnswerView(content: response) { cloudDraft = $0; composing = true } }
                        else { Text(run.state == .awaiting_resolution ? "Une action nécessite votre vérification. Elle ne sera pas rejouée automatiquement." : cloudRunState(run.state.rawValue)).foregroundStyle(.secondary) }
                        if run.state != .completed && run.state != .cancelled {
                            Button("Annuler") { Task { do { try await agent.cancel(runID: run.runId) } catch { agent.error = error.localizedDescription } } }
                                .disabled(agent.busy)
                        }
                    }
                    .padding(15).background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(ChatPalette.hairline, lineWidth: 0.5))
                }
                if cloudSending { HStack(spacing: 9) { ProgressView().controlSize(.small); Text("Hermes travaille…") }.font(.caption).foregroundStyle(.secondary) }
            }.padding(.horizontal, 28).padding(.vertical, 28).frame(maxWidth: 820).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func cloudRunState(_ value: String) -> String {
        ["queued": "En attente", "running": "Travail en cours", "completed": "Terminé", "cancelled": "Annulé", "failed": "Échec"][value] ?? "État à confirmer"
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
        if let response = try? await DesktopHarnessClient.shared.call("/targets"), let values = try? response["targets"].decode([DesktopHarnessTarget].self) { targets = values }
        do {
            let detected = try await NativeHarnessClient.shared.harnesses()
            harnesses = detected.isEmpty ? [.native] : detected.filter { $0.id != "computer-use" }
            let catalog = try await DesktopHarnessClient.shared.call("/catalog", target: store.current?.executionTargetID ?? "local")
            let runtimes = try catalog["harnesses"].decode([DesktopHarnessDescriptor].self)
            for item in runtimes {
                let old = harnesses.first { $0.id == item.id }
                let priorDescription = old?.description.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let view = NativeConversationHarness(id: item.id, name: item.name, available: item.available, configured: item.configured,
                    description: priorDescription.isEmpty ? harnessDescription(item.id) : priorDescription, capabilities: .init(sessions: true, streaming: true, tools: item.capabilities["tools"]?.available == true, longTermMemory: item.capabilities["memory"]?.available == true, projects: item.capabilities["projects"]?.available == true),
                    unavailableReason: item.reason, canInstall: old?.canInstall, compatible: true, detected: item.detected, conversationCapable: true, category: old?.category ?? "agent", popularityRank: old?.popularityRank ?? 100)
                if let index = harnesses.firstIndex(where: { $0.id == item.id }) { harnesses[index] = view } else { harnesses.append(view) }
            }
        } catch {
            if harnesses.isEmpty { harnesses = [.native] }
            if harness.wrappedValue != "native" { store.error = error.localizedDescription }
        }
    }
    private func harnessDescription(_ id: String) -> String {
        switch id {
        case "openwebui": return "Modèles et outils de votre serveur Open WebUI."
        case "librechat": return "Agents et outils de votre serveur LibreChat."
        case "hermes-agent": return "Agent autonome avec mémoire et outils."
        case "pi": return "Agent de codage léger et extensible."
        case "openai-codex": return "Agent de développement OpenAI."
        case "claude-code": return "Agent de développement Anthropic."
        case "opencode": return "Agent de développement open source."
        case "gemini-cli": return "Agent de développement Google."
        default: return "Utilisez ce moteur dans l’interface MultiVibe."
        }
    }
    private func openDashboard() { (NSApplication.shared.delegate as? MultiVibeMenuBarApp)?.openDashboard() }
}

@MainActor private struct ChatMessageActions: View {
    let content: String
    let isUser: Bool
    let speech: AVSpeechSynthesizer
    @State private var copied = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(spacing: 1) {
            ChatIconButton(title: copied ? "Copié" : "Copier le message", icon: copied ? "checkmark" : "doc.on.doc") {
                NSPasteboard.general.clearContents(); NSPasteboard.general.setString(content, forType: .string)
                withAnimation(ChatPalette.motion(reduceMotion)) { copied = true }
            }
            if !isUser {
                ChatIconButton(title: "Lire ou arrêter la lecture", icon: "speaker.wave.2") {
                    if speech.isSpeaking { speech.stopSpeaking(at: .immediate) }
                    else { speech.speak(AVSpeechUtterance(string: content)) }
                }
            }
            if copied { Text("Copié").font(.system(size: 11)).foregroundStyle(ChatPalette.accent).padding(.horizontal, 4).transition(.opacity) }
        }.foregroundStyle(.secondary)
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            guard !Task.isCancelled else { return }
            withAnimation(ChatPalette.motion(reduceMotion)) { copied = false }
        }
    }
}


@MainActor private struct RemoteHarnessConnectionSheet: View {
    let harnessID: String
    private var serviceName: String { harnessID == "openwebui" ? "Open WebUI" : "LibreChat" }
    private var isOpenWebUI: Bool { harnessID == "openwebui" }
    let target: String
    let saved: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var endpoint = ""
    @State private var apiKey = ""
    @State private var agentID = ""
    @State private var agents: [RemoteHarnessChoice] = []
    @State private var hasApiKey = false
    @State private var hasUserSession = false
    @State private var email = ""
    @State private var password = ""
    @State private var userToken = ""
    @State private var showingSessionToken = false
    @State private var twoFactorToken = ""
    @State private var twoFactorCode = ""
    @State private var connectionAttemptID = ""
    @State private var usingBackupCode = false
    @FocusState private var focusedField: Field?
    @State private var busy = false
    @State private var error: String?
    private enum Field { case twoFactorCode }
    private struct RemoteHarnessChoice: Decodable, Identifiable { let id: String; let name: String }
    private var awaitingTwoFactor: Bool { !twoFactorToken.isEmpty }
    private var validTwoFactorResponse: Bool {
        if usingBackupCode { return !twoFactorCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return twoFactorCode.utf8.count == 6 && twoFactorCode.utf8.allSatisfy { (48...57).contains($0) }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Connexion \(serviceName)").font(.title2.weight(.semibold))
            Text(isOpenWebUI ? "Connectez votre serveur puis choisissez le modèle qui répondra dans MultiVibe." : "Connectez votre serveur puis choisissez l’agent qui répondra dans MultiVibe.")
                .font(.callout).foregroundStyle(.secondary)
            TextField("Endpoint (https://chat.example.com)", text: $endpoint)
                .textFieldStyle(.roundedBorder).onChange(of: endpoint) { _ in agents = []; resetTwoFactor() }.disabled(busy || awaitingTwoFactor)
            if isOpenWebUI {
            SecureField(hasApiKey ? "Clé API (laisser vide pour la conserver)" : "Clé API \(serviceName)", text: $apiKey)
                .textFieldStyle(.roundedBorder).onChange(of: apiKey) { _ in agents = [] }.disabled(busy)
            } else if awaitingTwoFactor {
                VStack(alignment: .leading, spacing: 10) {
                    Label("Vérification en deux étapes", systemImage: "lock.shield")
                        .font(.headline)
                    Text(usingBackupCode ? "Saisissez un code de secours LibreChat." : "Saisissez le code à 6 chiffres de votre application d’authentification.")
                        .font(.caption).foregroundStyle(.secondary)
                    TextField(usingBackupCode ? "Code de secours" : "Code à 6 chiffres", text: $twoFactorCode)
                        .textFieldStyle(.roundedBorder).focused($focusedField, equals: .twoFactorCode).disabled(busy)
                    Button(usingBackupCode ? "Utiliser l’application d’authentification" : "Utiliser un code de secours") {
                        usingBackupCode.toggle(); twoFactorCode = ""; focusedField = .twoFactorCode
                    }.buttonStyle(.link).disabled(busy)
                }
            } else {
                TextField("Email LibreChat", text: $email).textFieldStyle(.roundedBorder).disabled(busy)
                SecureField(hasUserSession ? "Mot de passe (laisser vide pour conserver la session)" : "Mot de passe LibreChat", text: $password)
                    .textFieldStyle(.roundedBorder).disabled(busy)
                DisclosureGroup("Connexion avec une session existante", isExpanded: $showingSessionToken) {
                    SecureField("Jeton de session utilisateur LibreChat", text: $userToken).textFieldStyle(.roundedBorder).disabled(busy)
                    Text("Pour un compte SSO ou pour reprendre une session déjà ouverte. La reconnexion sera nécessaire à l’expiration du jeton.").font(.caption).foregroundStyle(.secondary)
                }.font(.caption)
            }
            Text(isOpenWebUI ? "Autorisez la clé API à accéder aux modèles et aux conversations. Vos chats seront synchronisés avec le serveur." : awaitingTwoFactor ? "Le code et le jeton temporaire ne sont pas enregistrés." : connectionAttemptID.isEmpty ? "Connectez votre compte pour retrouver ses agents et ses conversations. Le mot de passe n’est pas enregistré." : "Authentification validée. Choisissez l’agent puis enregistrez la connexion.")
                .font(.caption).foregroundStyle(.secondary)
            if !agents.isEmpty {
                Picker(isOpenWebUI ? "Modèle" : "Agent", selection: $agentID) {
                    ForEach(agents) { agent in Text(agent.name).tag(agent.id) }
                }
            }
            if let error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("Annuler") { dismiss() }.keyboardShortcut(.cancelAction)
                if awaitingTwoFactor { Button("Recommencer") { resetTwoFactor(); password = "" } }
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button(isOpenWebUI ? "Charger les modèles" : awaitingTwoFactor ? "Vérifier le code" : "Charger les agents") { Task { await connect(discover: true) } }
                    .disabled(busy || endpoint.isEmpty || (isOpenWebUI ? apiKey.isEmpty && !hasApiKey : awaitingTwoFactor ? !validTwoFactorResponse : connectionAttemptID.isEmpty && !hasUserSession && userToken.isEmpty && (email.isEmpty || password.isEmpty)))
                Button("Enregistrer") { Task { await connect(discover: false) } }
                    .keyboardShortcut(.defaultAction).disabled(busy || agents.isEmpty || agentID.isEmpty)
            }
        }.padding(24).frame(width: 520)
        .onChange(of: email) { _ in agents = []; connectionAttemptID = "" }
        .onChange(of: password) { _ in agents = []; connectionAttemptID = "" }
        .onChange(of: userToken) { _ in agents = []; connectionAttemptID = "" }
        .task {
            busy = true
            do {
                let value = try await DesktopHarnessClient.shared.call("/" + harnessID, target: target)
                endpoint = value["endpoint"].string ?? ""
                agentID = value["agentId"].string ?? ""
                hasApiKey = value["hasApiKey"] == .bool(true)
                hasUserSession = value["hasUserSession"] == .bool(true)
            } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
    private func connect(discover: Bool) async {
        busy = true; error = nil
        defer { busy = false }
        do {
            var fields: [String: HarnessJSON] = ["endpoint": .string(endpoint), "apiKey": .string(apiKey), "agentId": .string(agentID), "discover": .bool(discover), "email": .string(email), "password": .string(password), "userToken": .string(userToken), "twoFactorToken": .string(twoFactorToken), "connectionAttemptId": .string(connectionAttemptID)]
            fields[usingBackupCode ? "twoFactorBackupCode" : "twoFactorCode"] = .string(twoFactorCode.trimmingCharacters(in: .whitespacesAndNewlines))
            let result = try await DesktopHarnessClient.shared.call("/" + harnessID, method: "POST", target: target,
                body: .object(fields))
            if result["twoFactorRequired"] == .bool(true), let token = result["twoFactorToken"].string, !token.isEmpty {
                twoFactorToken = token; twoFactorCode = ""; password = ""; userToken = ""; usingBackupCode = false
                focusedField = .twoFactorCode
                return
            }
            agents = try result["agents"].decode([RemoteHarnessChoice].self)
            connectionAttemptID = result["connectionAttemptId"].string ?? connectionAttemptID
            twoFactorToken = ""; twoFactorCode = ""
            if !agents.contains(where: { $0.id == agentID }) { agentID = agents.first?.id ?? "" }
            if agents.isEmpty { error = isOpenWebUI ? "Aucun modèle accessible avec cette clé API." : "Aucun agent accessible avec cette clé API." }
            if !discover { apiKey = ""; password = ""; userToken = ""; connectionAttemptID = ""; await saved(); dismiss() }
        } catch { self.error = error.localizedDescription }
    }
    private func resetTwoFactor() {
        twoFactorToken = ""; twoFactorCode = ""; connectionAttemptID = ""; usingBackupCode = false; error = nil
    }
}
