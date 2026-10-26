import AVFoundation
import ContactsUI
import EventKit
import EventKitUI
import MapKit
import SwiftUI
import SafariServices
import UniformTypeIdentifiers
import WebKit

private struct SelectableMessage: Identifiable { let id: UUID; let text: String }

private enum SidebarConversationLayout: String {
    case flat
    case grouped
}

private struct SidebarConversationItem: Identifiable {
    enum Source { case local(Conversation), remote(RemoteChat) }
    let id: String
    let title: String
    let updatedAt: Date
    let harnessID: String
    let harnessName: String
    let source: Source
}

private struct SidebarConversationSection: Identifiable {
    let id: String
    let title: String
    let harnessID: String?
    let items: [SidebarConversationItem]
}

private struct WelcomeExecutionAnchorKey: PreferenceKey {
    nonisolated(unsafe) static let defaultValue: Anchor<CGRect>? = nil
    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = nextValue() ?? value
    }
}

private struct WelcomeExecutionGlassSurface: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular, in: shape)
        } else {
            content.background(.regularMaterial, in: shape)
        }
    }
}

@MainActor
private struct WelcomeExecutionOverlayModifier: ViewModifier {
    let isPresented: Bool
    let panel: (CGFloat) -> AnyView

    func body(content: Content) -> some View {
        content.overlayPreferenceValue(WelcomeExecutionAnchorKey.self) { anchor in
            GeometryReader { proxy in
                if isPresented, let anchor {
                    let selectorFrame = proxy[anchor]
                    let panelWidth = min(310, max(0, proxy.size.width - 32))
                    let panelLeading = min(
                        max(16, selectorFrame.midX - panelWidth / 2),
                        max(16, proxy.size.width - panelWidth - 16)
                    )
                    let panelHeight = max(180, min(520, proxy.size.height - selectorFrame.maxY - 24))
                    panel(panelHeight)
                        .frame(width: panelWidth)
                        .offset(x: panelLeading, y: selectorFrame.maxY + 10)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                        .zIndex(100)
                }
            }
            .allowsHitTesting(isPresented)
        }
    }
}

struct ChatView: View {
    @Environment(ConversationManager.self) private var manager
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var voice: VoiceController { manager.voice }
    @State private var text = ""
    @State private var shortcutDraftConversation: UUID?
    @State private var preferredColumn: NavigationSplitViewColumn = .detail
    @State private var search = ""
    @AppStorage("chat.sidebarConversationLayout") private var sidebarConversationLayout: SidebarConversationLayout = .flat
    @FocusState private var sidebarSearchFocused: Bool
    @State private var conversationToDelete: Conversation?
    @State private var confirmGuestImport = false
    @State private var confirmHistorySync = false
    @State private var confirmHistoryConflict = false
    @State private var retryTarget: RetryTarget?
    private struct RetryTarget { let conversation: UUID; let message: UUID }
    @State private var documentsPresented = false
    @State private var cloudAgentBrowserPresented = false
    @State private var cloudHermesConsentPresented = false
    @State private var privacyPresented = false
    @State private var profilePresented = false
    @State private var authenticateAfterProfile = false
    @State private var suggestions = HomeSuggestionStore.load()
    @State private var suggestionsPresented = false
    @State private var highlightedSuggestion: UUID?
    @State private var selectionContent: SelectableMessage?
    @State private var followsLatest = true
    @State private var userScrolling = false
    @State private var hapticMessage: UUID?
    @State private var hapticCharacterCount = 0
    @State private var pendingHapticCharacters = 0
    @State private var lastStreamingHaptic = Date.distantPast
    @State private var voiceConversationPresented = false
    @State private var voiceConversationPreparing = false
    @State private var composerContextExpanded = false
    @State private var instances = RemoteInstances.shared
    @State private var remoteConversationToDelete: RemoteChat?
    @State private var remoteConfigurationError: String?
    @State private var remoteInstancesPresented = false
    @State private var remoteProjectPickerPresented = false
    @AppStorage("chat.welcomeExecutionListExpanded") private var welcomeExecutionListExpanded = false
    @FocusState private var composerFocused: Bool
    private let latestMessageAnchor = "latest-message"

    var body: some View {
        @Bindable var manager = manager
        NavigationSplitView(preferredCompactColumn: $preferredColumn) {
            List {
                Section {
                    HStack(spacing: 12) {
                        Image("MultiVibeMark")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 34, height: 34)
                            .accessibilityHidden(true)
                        Text("MultiVibe")
                            .font(.title2.bold())
                        Spacer()
                        Button("Rechercher", systemImage: "magnifyingglass") { sidebarSearchFocused = true }
                            .labelStyle(.iconOnly)
                            .font(.title2.weight(.medium))
                            .frame(width: 44, height: 44)
                            .background(.regularMaterial, in: Circle())
                            .overlay(Circle().stroke(.primary.opacity(0.10), lineWidth: 0.7))
                            .contentShape(Circle())
                            .accessibilityIdentifier("searchConversations")
                        Menu("Plus d’options", systemImage: "ellipsis") {
                            Button("Synchroniser l’historique", systemImage: "arrow.triangle.2.circlepath") {
                                if manager.session == nil { manager.authenticationPresented = true } else { confirmHistorySync = true }
                            }
                            .disabled(manager.isSynchronizing || manager.isStreaming || manager.isRestoring)
                            if manager.session != nil {
                                Button("Importer les conversations invitées") { confirmGuestImport = true }
                                if manager.automaticSync {
                                    Button("Désactiver la synchronisation automatique") { manager.disableAutomaticSync() }
                                }
                            }
                            Button("Confidentialité et données", systemImage: "hand.raised") { privacyPresented = true }
                            Button("Documents et outils locaux", systemImage: "doc") { documentsPresented = true }
                        }
                        .labelStyle(.iconOnly)
                        .font(.title2.weight(.medium))
                        .frame(width: 44, height: 44)
                        .background(.regularMaterial, in: Circle())
                        .overlay(Circle().stroke(.primary.opacity(0.10), lineWidth: 0.7))
                        .accessibilityIdentifier("sidebarMoreOptions")
                    }
                    .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }

                Section {
                    if manager.session != nil {
                        NavigationLink {
                            SDKApplicationsView().id(manager.session?.accountId)
                        } label: {
                            SidebarShortcutLabel(title: "Applications", systemImage: "square.grid.2x2")
                        }
                        .accessibilityIdentifier("openApplications")
                    }
                    NavigationLink { AutomationsView().id(manager.session?.accountId ?? "guest") } label: {
                        SidebarShortcutLabel(title: "Automatisations", systemImage: "clock")
                    }
                    .accessibilityIdentifier("openAutomations")
                    Button { manager.memoryPresented = true } label: {
                        SidebarShortcutLabel(title: "Mémoire", systemImage: "brain")
                    }
                    .accessibilityIdentifier("openMemory")
                    Button { documentsPresented = true } label: {
                        SidebarShortcutLabel(title: "Documents et outils", systemImage: "folder")
                    }
                    .accessibilityIdentifier("openDocuments")
                    if manager.session != nil {
                        Button { cloudAgentBrowserPresented = true } label: {
                            SidebarShortcutLabel(title: "Environnement Cloud", systemImage: "cloud")
                        }
                        .accessibilityIdentifier("openCloudHermesState")
                    }
                }
                .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                .listRowSeparator(.hidden)

                Section {
                    HStack(spacing: 10) {
                        HStack(spacing: 8) {
                            Image(systemName: "magnifyingglass")
                                .foregroundStyle(.tertiary)
                                .accessibilityHidden(true)
                            TextField("Rechercher", text: $search)
                                .textFieldStyle(.plain)
                                .focused($sidebarSearchFocused)
                                .accessibilityLabel("Rechercher dans les conversations")
                            if !search.isEmpty {
                                Button("Effacer la recherche", systemImage: "xmark.circle.fill") { search = "" }
                                    .labelStyle(.iconOnly)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .padding(.horizontal, 12)
                        .frame(height: 42)
                        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 13, style: .continuous))

                        Picker("Organisation des conversations", selection: $sidebarConversationLayout) {
                            Image(systemName: "list.bullet").tag(SidebarConversationLayout.flat)
                                .accessibilityLabel("Liste à plat")
                                .accessibilityIdentifier("flatConversationLayout")
                            Image(systemName: "square.stack.3d.up").tag(SidebarConversationLayout.grouped)
                                .accessibilityLabel("Grouper par harness")
                                .accessibilityIdentifier("groupedConversationLayout")
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .frame(width: 88)
                        .accessibilityIdentifier("conversationLayoutPicker")
                    }
                    .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }

                if sidebarConversationItems.isEmpty {
                    Section {
                        ContentUnavailableView(search.isEmpty ? "Aucune conversation" : "Aucun résultat",
                            systemImage: search.isEmpty ? "bubble.left.and.bubble.right" : "magnifyingglass",
                            description: Text(search.isEmpty ? "Vos conversations apparaîtront ici après le premier message." : "Essayez un autre titre, harness ou nom de machine."))
                    }
                    .listRowBackground(Color.clear)
                } else if sidebarConversationLayout == .flat {
                    ForEach(sidebarRecencySections) { section in
                        Section(section.title) {
                            ForEach(section.items) { item in sidebarConversationRow(item, showsHarnessLogo: true) }
                        }
                    }
                } else {
                    ForEach(sidebarHarnessSections) { section in
                        Section {
                            ForEach(section.items) { item in sidebarConversationRow(item, showsHarnessLogo: false) }
                        } header: {
                            HStack(spacing: 8) {
                                HarnessIdentityLogo(id: section.harnessID ?? "native", name: section.title, size: 20)
                                Text(section.title)
                                Spacer(minLength: 0)
                                Text("\(section.items.count)").foregroundStyle(.tertiary)
                            }
                            .textCase(nil)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .listSectionSpacing(6)
            .scrollContentBackground(.hidden)
            .background(Color(uiColor: .systemBackground).ignoresSafeArea())
            .navigationTitle("")
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 10) {
                    if let status = manager.historyStatus, status != "Historique synchronisé avec votre compte." {
                        VStack {
                            Text(status).font(.caption)
                            if manager.hasHistoryConflict {
                                Button("Conserver les deux versions") { confirmHistoryConflict = true }
                                    .disabled(manager.isSynchronizing || manager.isStreaming || manager.isRestoring)
                            }
                        }
                    }
                    sidebarFooterActions
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
        } detail: {
            VStack(spacing: 0) {
                if isNewConversation {
                    welcome
                } else {
                    GeometryReader { transcriptGeometry in
                    ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 20) {
                            ForEach(displayMessages) { message in
                                VStack(alignment: message.role == "user" ? .trailing : .leading, spacing: 8) {
                                    if message.role == "user" {
                                        Text(message.content).textSelection(.enabled)
                                            .padding(.horizontal, 18).padding(.vertical, 12)
                                            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                                            .padding(.leading, 36)
                                    } else {
                                        if let events = message.localEvents?.filter({ $0.tool != "hermes_agent" }), !events.isEmpty {
                                            AgentActivityView(events: events, completion: message.completion)
                                        } else if message.completion == .streaming && message.content.isEmpty {
                                            HStack(spacing: 8) {
                                                ProgressView().controlSize(.small)
                                                Text("L’assistant travaille…").font(.subheadline).foregroundStyle(.secondary)
                                            }.accessibilityIdentifier("agentWorking")
                                        }
                                        if !message.content.isEmpty || message.nativeContent != nil {
                                            VStack(alignment: .leading, spacing: 14) {
                                                if let payload = message.nativeContent, payload.version == NativeContentPayload.currentVersion {
                                                    NativeContentView(payload: payload)
                                                        .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
                                                }
                                                NativeMessageContent(content: message.content)
                                            }
                                            .padding(.vertical, 2)
                                        }
                                        if let completion = message.completion, completion != .completed, completion != .streaming {
                                            Text(completion == .stopped ? "Réponse arrêtée" : "Réponse interrompue")
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                        if let references = message.memoryReferences, !references.isEmpty {
                                            DisclosureGroup("Souvenirs consultés (\(references.count))") {
                                                ForEach(references) { reference in
                                                    if let source = manager.source(for: reference), let evidence = source.evidence {
                                                        VStack(alignment: .leading) {
                                                            Text(source.topic).font(.caption.bold())
                                                            Text(evidence.quote).font(.caption).textSelection(.enabled)
                                                            Text("Noté ou confirmé le " + evidence.date.formatted()).font(.caption2)
                                                            Text("Source déclarée ou confirmée par vous ; pas une vérification externe.").font(.caption2)
                                                        }
                                                    } else { Text("Source oubliée ou indisponible sur cet appareil.").font(.caption) }
                                                }
                                            }
                                        }
                                        HStack(spacing: 4) {
                                            if !message.content.isEmpty {
                                                Button("Copier", systemImage: "doc.on.doc") { copyMessage(message.content) }
                                                ShareLink(item: message.content) { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("Partager le message")
                                                Menu("Plus d’actions", systemImage: "ellipsis") {
                                                    Button("Lire à voix haute", systemImage: "speaker.wave.2") { voice.speak(message.content) }
                                                    Button("Sélectionner le texte", systemImage: "selection.pin.in.out") {
                                                        selectionContent = SelectableMessage(id: message.id, text: message.content)
                                                    }
                                                    if !isRemoteConversation && message.canRetry && manager.current?.messages.last?.id == message.id {
                                                        Button("Réessayer", systemImage: "arrow.clockwise") {
                                                            if let conversation = manager.selection { retryTarget = RetryTarget(conversation: conversation, message: message.id) }
                                                        }.disabled(isGenerating)
                                                    }
                                                }
                                            }
                                        }.labelStyle(.iconOnly).buttonStyle(.borderless).controlSize(.large)
                                            .foregroundStyle(.secondary)
                                    }
                                }.frame(maxWidth: .infinity, alignment: message.role == "user" ? .trailing : .leading)
                                    .contextMenu {
                                        Button("Copier tout", systemImage: "doc.on.doc") { copyMessage(message.content) }
                                        Button("Sélectionner le texte", systemImage: "selection.pin.in.out") {
                                            selectionContent = SelectableMessage(id: message.id, text: message.content)
                                        }
                                        ShareLink(item: message.content) { Label("Partager", systemImage: "square.and.arrow.up") }
                                    }
                                    .transition(.opacity.combined(with: .move(edge: .bottom)))

                            }
                            Color.clear.frame(height: 1).id(latestMessageAnchor)
                        }.padding(.horizontal, 14).padding(.vertical, 18)
                            .frame(minHeight: transcriptGeometry.size.height, alignment: .bottom)
                            .animation(reduceMotion ? nil : .spring(duration: 0.38, bounce: 0.12), value: displayMessages.count)
                    }
                    .defaultScrollAnchor(.bottom)
                    .onScrollPhaseChange { _, phase in
                        userScrolling = phase == .tracking || phase == .interacting || phase == .decelerating
                    }
                    .onScrollGeometryChange(for: Bool.self) { geometry in
                        geometry.contentSize.height + geometry.contentInsets.bottom -
                            geometry.contentOffset.y - geometry.containerSize.height < 80
                    } action: { _, nearBottom in
                        if userScrolling { followsLatest = nearBottom }
                    }
                    .onChange(of: manager.streamingTextRevision) { _, _ in
                        if followsLatest && !userScrolling { proxy.scrollTo(latestMessageAnchor, anchor: .bottom) }
                        playStreamingHaptic()
                    }
                    .onChange(of: displayMessages.count) { _, _ in
                        scrollToLatest(proxy)
                    }
                    .onChange(of: displayMessages.last?.localEvents) { _, _ in scrollToLatest(proxy) }
                    .onChange(of: displayMessages.last?.content) { _, _ in scrollToLatest(proxy) }
                    .onChange(of: manager.selection) { _, _ in
                        followsLatest = true
                        proxy.scrollTo(latestMessageAnchor, anchor: .bottom)
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if !followsLatest {
                            Button("Dernier message", systemImage: "arrow.down") {
                                followsLatest = true
                                withAnimation { proxy.scrollTo(latestMessageAnchor, anchor: .bottom) }
                            }
                            .buttonStyle(.borderedProminent).padding()
                        }
                    }
                    // The first send replaces the welcome view. Its onChange can fire before this
                    // ScrollView has a laid-out anchor, leaving a restored offset
                    // outside the content until navigation recreates the view.
                    .task(id: displayMessages.count) {
                        await Task.yield()
                        scrollToLatest(proxy)
                    }
                    }
                    }
                }
                if voice.speaking {
                    Button("Arrêter la lecture", systemImage: "stop.circle") { voice.silence() }.padding(.horizontal)
                }
                if let error = isRemoteConversation ? (remoteConfigurationError ?? instances.error ?? instances.synchronizationError) : manager.error {
                    MultiVibeStatusMessage(message: error)
                        .padding(.horizontal)
                        .accessibilityIdentifier("chatError")
                }
                if !isRemoteConversation, let error = manager.modelsError, !ModelExecution(manager.selectedModel).isLocal {
                    MultiVibeStatusMessage(message: error, actionTitle: "Réessayer") {
                        Task { await manager.reloadModels() }
                    }
                    .padding(.horizontal)
                    .allowsHitTesting(!manager.isLoadingModels && !manager.isStreaming)
                }
                if !isRemoteConversation && manager.isLoadingModels && !ModelExecution(manager.selectedModel).isLocal { ProgressView("Chargement des modèles…").padding(.horizontal) }
            }
            .background(Color(uiColor: .systemBackground).ignoresSafeArea())
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !voiceConversationPreparing && !voiceConversationPresented && !modalIsActive {
                    composer
                }
            }
            .modifier(welcomeExecutionOverlay)
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Afficher les conversations", systemImage: "line.3.horizontal") {
                        preferredColumn = .sidebar
                    }
                    .accessibilityIdentifier("openConversationHistory")
                }
                ToolbarItem(placement: .principal) {
                    if !isNewConversation { conversationExecutionSelector }
                }
                ToolbarItem(placement: .primaryAction) {
                    ControlGroup {
                        Button("Nouvelle conversation", systemImage: "square.and.pencil") { openNewConversation() }
                        Menu("Plus d’options", systemImage: "ellipsis") {
                            Button("Profil", systemImage: "person.crop.circle") { profilePresented = true }
                            Button("Documents et outils locaux", systemImage: "doc") { documentsPresented = true }
                            Button("Confidentialité et données", systemImage: "hand.raised") { privacyPresented = true }
                            if manager.session == nil {
                                Button("Se connecter", systemImage: "person.badge.key") { manager.authenticationPresented = true }
                                    .accessibilityIdentifier("openAuthentication")
                            }
                        }
                    }
                }
            }

        }
        .overlay {
            if isGenerating {
                AgentThinkingGlow()
                    .transition(.opacity.animation(reduceMotion ? nil : .easeOut(duration: 0.45)))
            }
        }
        .sheet(item: Binding(get: { manager.internetApproval }, set: { _ in })) { request in
            InternetPermissionView(request: request)
                .interactiveDismissDisabled()
        }
        .fullScreenCover(isPresented: $voiceConversationPresented, onDismiss: {
            voiceConversationPreparing = false
            composerFocused = false
        }) {
            RealtimeVoiceView(remoteChatID: remoteChat?.id).environment(manager)
        }
        .alert("Résultat d’action inconnu", isPresented: Binding(
            get: { manager.hermesRecovery != nil }, set: { if !$0 { manager.hermesRecovery = nil } }
        ), presenting: manager.hermesRecovery) { recovery in
            Button("J’ai vérifié, poursuivre sans rejouer") { Task { await manager.resolveHermesRecovery(recovery) } }
            Button("Plus tard", role: .cancel) { manager.hermesRecovery = nil }
        } message: { recovery in
            Text(recovery.detail + " Vérifiez les documents, services ou actions concernés. Continuer conservera ce résultat comme inconnu et ignorera ces actions.")
        }
        .alert("Supprimer cette conversation ?", isPresented: Binding(
            get: { conversationToDelete != nil },
            set: { if !$0 { conversationToDelete = nil } }
        ), presenting: conversationToDelete) { conversation in
            Button("Supprimer", role: .destructive) {
                manager.delete(conversation.id)
                conversationToDelete = nil
            }
            Button("Annuler", role: .cancel) { conversationToDelete = nil }
        } message: { conversation in
            Text("« \(conversation.title) » sera supprimée de cet appareil. Cette action est irréversible.")
        }
        .alert("Supprimer cette conversation distante ?", isPresented: Binding(
            get: { remoteConversationToDelete != nil }, set: { if !$0 { remoteConversationToDelete = nil } }
        ), presenting: remoteConversationToDelete) { conversation in
            Button("Supprimer", role: .destructive) { try? instances.delete(conversation.id); remoteConversationToDelete = nil }
            Button("Annuler", role: .cancel) { remoteConversationToDelete = nil }
        } message: { conversation in
            Text("« \(conversation.title) » sera supprimée de cet iPhone. La session reste dans le journal local du Mac.")
        }
        .confirmationDialog("Remplacer cette réponse ?", isPresented: Binding(
            get: { retryTarget != nil }, set: { if !$0 { retryTarget = nil } }
        ), titleVisibility: .visible) {
            Button("Remplacer et réessayer", role: .destructive) {
                if let target = retryTarget { _ = manager.retry(conversation: target.conversation, message: target.message) }
                retryTarget = nil
            }
            Button("Annuler", role: .cancel) { retryTarget = nil }
        } message: {
            Text(ModelExecution(manager.current?.model ?? "").isLocal ? "La réponse partielle sera remplacée et la demande sera reprise sur cet iPhone. Les documents déjà créés sont conservés." : "La réponse partielle sera remplacée. Votre message ne sera pas ajouté une seconde fois. Cette nouvelle demande peut consommer des crédits.")
        }
        .confirmationDialog("Copier l’historique invité dans ce compte ?", isPresented: $confirmGuestImport, titleVisibility: .visible) {
            Button("Importer") { manager.importGuestHistory() }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Les conversations invitées seront copiées dans le compte connecté et envoyées au serveur si la synchronisation est activée. Les originaux restent sur cet appareil.")
        }
        .confirmationDialog("Synchroniser avec votre compte ?", isPresented: $confirmHistorySync, titleVisibility: .visible) {
            Button("Activer la synchronisation automatique") {
                manager.enableAutomaticSync()
                Task { await manager.synchronizeHistory() }
            }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Les conversations de ce compte seront synchronisées avec MultiVibe maintenant et au retour du réseau. Les échanges invités restent séparés tant que vous ne les importez pas. Elles ne sont pas chiffrées de bout en bout. Les modifications concurrentes ne seront pas écrasées automatiquement.")
        }
        .confirmationDialog("Conserver les versions du compte et les copies locales ?", isPresented: $confirmHistoryConflict, titleVisibility: .visible) {
            Button("Conserver les deux versions") { Task { await manager.synchronizeHistory(keepingBothVersions: true) } }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Les conversations modifiées sur cet appareil seront ajoutées comme copies locales. Les versions du compte seront conservées ; les suppressions locales ne seront pas appliquées au compte pendant cette résolution.")
        }
        .sheet(item: $manager.requestedAccessModel) { model in
            NavigationStack { ModelAccessView(model: model) }
        }
        .sheet(isPresented: $manager.memoryPresented) { MemoryView() }
        .sheet(item: Binding(get: { manager.memoryPresented ? nil : manager.memoryDraft }, set: { manager.memoryDraft = $0 })) { draft in MemoryEditor(draft: draft) }
        .sheet(isPresented: $documentsPresented) { LocalDocumentsView() }
        .sheet(isPresented: $cloudAgentBrowserPresented) { CloudAgentBrowserView() }
        .sheet(isPresented: $cloudHermesConsentPresented) { CloudHermesConsentView() }
        .sheet(isPresented: $privacyPresented) { NativePrivacyView() }
        .sheet(isPresented: $profilePresented, onDismiss: {
            if authenticateAfterProfile {
                authenticateAfterProfile = false
                manager.authenticationPresented = true
            }
        }) {
            AccountProfileView(
                close: { profilePresented = false },
                authenticate: {
                    authenticateAfterProfile = true
                    profilePresented = false
                }
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.hidden)
            .presentationCornerRadius(44)
        }
        .sheet(isPresented: $remoteInstancesPresented) { RemoteInstancesView().environment(manager) }
        .sheet(isPresented: $remoteProjectPickerPresented) { if let chat = remoteChat { RemoteHarnessProjectPicker(chatID: chat.id) } }
        .sheet(isPresented: $suggestionsPresented) {
            SuggestionsEditor(suggestions: $suggestions, highlighted: highlightedSuggestion) {
                HomeSuggestionStore.save(suggestions)
            }
        }
        .sheet(item: $selectionContent) { SelectableMessageSheet(message: $0) }
        .onChange(of: manager.selection) { _, selection in
            if shortcutDraftConversation != selection { text = "" }
            if selection != nil {
                instances.select(nil)
                preferredColumn = .detail
            }
        }
        .onChange(of: instances.selection) { _, selection in
            if selection != nil { text = ""; voice.silence(); profilePresented = false; preferredColumn = .detail }
        }
        .onChange(of: voice.transcript) { _, value in text = value }
        .onChange(of: manager.wantsNewConversation) { _, _ in consumeIntent() }
        .onChange(of: manager.wantsVoiceConversation) { _, _ in consumeIntent() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { voice.silence(); if phase == .background && ModelExecution(manager.selectedModel).isLocal { manager.stop() } } else { manager.foreground(); consumeIntent() }
        }
        .onAppear { consumeIntent() }
        .modifier(RemoteConversationSynchronization(accountID: manager.session?.accountId))
        .task(id: instances.selection) {
            guard let chat = remoteChat, chat.source == nil else { return }
            do { try await instances.prepare(chat.machine, harness: chat.harness) }
            catch is CancellationError { }
            catch { remoteConfigurationError = "Configuration distante indisponible. Actualisez les modèles ou vérifiez la connexion au Mac." }
        }
        .onChange(of: manager.nativeShortcut) { _, _ in consumeIntent() }
        .onChange(of: manager.isRestoring) { _, _ in consumeIntent() }
        .onChange(of: manager.wantsVoice) { _, _ in consumeIntent() }
        .onChange(of: manager.pendingDraft) { _, _ in consumeIntent() }
        .onDisappear { voice.silence() }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in voice.silence() }
    }

    private func playStreamingHaptic() {
        guard !isRemoteConversation else { return }
        guard let message = manager.current?.messages.last, message.role == "assistant",
              message.completion == .streaming else { return }
        if hapticMessage != message.id {
            hapticMessage = message.id
            hapticCharacterCount = 0
            pendingHapticCharacters = 0
            lastStreamingHaptic = .distantPast
        }
        let count = message.content.count
        pendingHapticCharacters += max(0, count - hapticCharacterCount)
        hapticCharacterCount = count
        let now = Date()
        guard pendingHapticCharacters >= 3, now.timeIntervalSince(lastStreamingHaptic) >= 0.08 else { return }
        UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.2)
        pendingHapticCharacters = 0
        lastStreamingHaptic = now
    }

    private func scrollToLatest(_ proxy: ScrollViewProxy) {
        guard followsLatest && !userScrolling else { return }
        proxy.scrollTo(latestMessageAnchor, anchor: .bottom)
    }

    private func copyMessage(_ content: String) {
        UIPasteboard.general.setItems([["public.utf8-plain-text": content]], options: [.localOnly: true])
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    @ViewBuilder private var sidebarFooterActions: some View {
        if #available(iOS 26.0, *) {
            HStack {
                Button(action: openNewConversation) { sidebarNewConversationLabel }
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.capsule)
                    .accessibilityLabel("Nouvelle conversation")
                Spacer()
                Button("Profil et réglages", systemImage: "gearshape") { profilePresented = true }
                    .labelStyle(.iconOnly)
                    .font(.title2.weight(.semibold))
                    .frame(width: 52, height: 52)
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .accessibilityIdentifier("openProfile")
            }
        } else {
            HStack {
                Button(action: openNewConversation) { sidebarNewConversationLabel }
                    .foregroundStyle(.primary)
                    .background(.regularMaterial, in: Capsule())
                    .overlay(Capsule().stroke(.primary.opacity(0.12), lineWidth: 0.7))
                    .accessibilityLabel("Nouvelle conversation")
                Spacer()
                Button("Profil et réglages", systemImage: "gearshape") { profilePresented = true }
                    .labelStyle(.iconOnly)
                    .font(.title2.weight(.semibold))
                    .frame(width: 52, height: 52)
                    .background(.regularMaterial, in: Circle())
                    .overlay(Circle().stroke(.primary.opacity(0.12), lineWidth: 0.7))
                    .accessibilityIdentifier("openProfile")
            }
            .buttonStyle(.plain)
        }
    }

    private var sidebarNewConversationLabel: some View {
        Label("Chat", systemImage: "square.and.pencil")
            .font(.headline)
            .padding(.horizontal, 20)
            .frame(height: 52)
    }

    private var sidebarConversationItems: [SidebarConversationItem] {
        let localItems = manager.historyConversations.map { conversation in
            let local = ModelExecution(conversation.model).isLocal
            return SidebarConversationItem(
                id: "local:\(conversation.id.uuidString)",
                title: conversation.title,
                updatedAt: conversation.updatedAt,
                harnessID: local ? "native" : "hermes-cloud",
                harnessName: local ? "Sur cet iPhone" : "MultiVibe Cloud",
                source: .local(conversation)
            )
        }
        let remoteCount = instances.chats.count
        let legacyDateAnchor = Date()
        let remoteItems = instances.chats.enumerated().compactMap { index, conversation -> SidebarConversationItem? in
            guard !conversation.messages.isEmpty || conversation.source != nil else { return nil }
            let harnessName = instances.harnesses[conversation.machine]?.first { $0.id == conversation.harness }?.name
                ?? harnessDisplayName(conversation.harness)
            return SidebarConversationItem(
                id: "remote:\(conversation.id.uuidString)",
                title: conversation.title,
                updatedAt: conversation.updatedAt ?? legacyDateAnchor.addingTimeInterval(-Double(remoteCount - index)),
                harnessID: conversation.harness,
                harnessName: harnessName,
                source: .remote(conversation)
            )
        }
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return (localItems + remoteItems)
            .filter { item in
                guard !query.isEmpty else { return true }
                let machineName: String
                if case .remote(let conversation) = item.source {
                    machineName = [instances.machines.first { $0.id == conversation.machine }?.name, conversation.environmentName].compactMap { $0 }.joined(separator: " · ")
                } else {
                    machineName = ""
                }
                return item.title.localizedCaseInsensitiveContains(query)
                    || item.harnessName.localizedCaseInsensitiveContains(query)
                    || machineName.localizedCaseInsensitiveContains(query)
            }
            .sorted {
                if $0.updatedAt != $1.updatedAt { return $0.updatedAt > $1.updatedAt }
                return $0.id < $1.id
            }
    }

    private var sidebarRecencySections: [SidebarConversationSection] {
        let calendar = Calendar.autoupdatingCurrent
        let today = calendar.startOfDay(for: Date())
        let sevenDaysAgo = calendar.date(byAdding: .day, value: -6, to: today) ?? today
        let sections = [
            ("today", "Aujourd’hui", sidebarConversationItems.filter { $0.updatedAt >= today }),
            ("week", "7 derniers jours", sidebarConversationItems.filter { $0.updatedAt >= sevenDaysAgo && $0.updatedAt < today }),
            ("older", "Plus anciennes", sidebarConversationItems.filter { $0.updatedAt < sevenDaysAgo })
        ]
        return sections.compactMap { id, title, items in
            items.isEmpty ? nil : SidebarConversationSection(id: id, title: title, harnessID: nil, items: items)
        }
    }

    private var sidebarHarnessSections: [SidebarConversationSection] {
        Dictionary(grouping: sidebarConversationItems, by: \.harnessID)
            .map { harnessID, items in
                SidebarConversationSection(
                    id: "harness:\(harnessID)",
                    title: items.first?.harnessName ?? harnessDisplayName(harnessID),
                    harnessID: harnessID,
                    items: items
                )
            }
            .sorted {
                let lhsDate = $0.items.first?.updatedAt ?? .distantPast
                let rhsDate = $1.items.first?.updatedAt ?? .distantPast
                if lhsDate != rhsDate { return lhsDate > rhsDate }
                return $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
            }
    }

    private func sidebarConversationRow(_ item: SidebarConversationItem, showsHarnessLogo: Bool) -> some View {
        Button { selectSidebarConversation(item) } label: {
            HStack(spacing: 11) {
                if showsHarnessLogo {
                    HarnessIdentityLogo(id: item.harnessID, name: item.harnessName, size: 28)
                }
                Text(item.title)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowSeparator(.hidden)
        .listRowBackground(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(sidebarConversationIsSelected(item) ? Color(uiColor: .secondarySystemBackground) : .clear)
        )
        .accessibilityLabel(item.title)
        .accessibilityValue(item.harnessName)
        .accessibilityAddTraits(sidebarConversationIsSelected(item) ? .isSelected : [])
        .swipeActions(allowsFullSwipe: false) {
            Button("Supprimer", role: .destructive) { deleteSidebarConversation(item) }
        }
    }

    private func sidebarConversationIsSelected(_ item: SidebarConversationItem) -> Bool {
        switch item.source {
        case .local(let conversation):
            return instances.selection == nil && manager.selection == conversation.id
        case .remote(let conversation):
            return instances.selection == conversation.id
        }
    }

    private func selectSidebarConversation(_ item: SidebarConversationItem) {
        switch item.source {
        case .local(let conversation):
            instances.select(nil)
            manager.selection = conversation.id
        case .remote(let conversation):
            manager.stop()
            instances.select(conversation.id)
        }
        preferredColumn = .detail
    }

    private func deleteSidebarConversation(_ item: SidebarConversationItem) {
        switch item.source {
        case .local(let conversation): conversationToDelete = conversation
        case .remote(let conversation): remoteConversationToDelete = conversation
        }
    }

    private var remoteChat: RemoteChat? { instances.current }
    private var isRemoteConversation: Bool { remoteChat != nil }
    private var displayMessages: [ChatMessage] { remoteChat?.messages ?? manager.current?.messages ?? [] }
    private var isGenerating: Bool { if let id = remoteChat?.id { return instances.activeChat == id }; return manager.isStreaming }
    private var remoteMachine: RemoteMachine? { remoteChat.flatMap { chat in instances.machines.first { $0.id == chat.machine } } }
    private var remoteHarnessName: String {
        remoteChat.flatMap { chat in instances.harnesses[chat.machine]?.first { $0.id == chat.harness }?.name }
            ?? remoteChat.map { harnessDisplayName($0.harness) } ?? "Harness"
    }
    private var localExecutionName: String { ModelExecution(manager.selectedModel).isLocal ? "Sur cet iPhone" : "MultiVibe Cloud" }
    private var pickerModels: [ModelOption] {
        guard let chat = remoteChat else { return manager.models }
        let catalog = instances.modelCatalog[instances.modelKey(chat.machine, harness: chat.harness)] ?? []
        var values = catalog.map { model in
            let provider = normalizedRemoteProvider(model.provider, modelID: model.id, harnessID: chat.harness)
            return ModelOption(id: model.selectionID, name: model.displayName, author: provider, description: "Modèle fourni par \(remoteHarnessName).", logoPublisher: provider)
        }
        let selected = (chat.provider ?? "") + ":" + chat.model
        if !chat.model.isEmpty, !values.contains(where: { $0.id == selected }) {
            let provider = normalizedRemoteProvider(chat.provider, modelID: chat.model, harnessID: chat.harness)
            values.insert(ModelOption(id: selected, name: chat.model, author: provider, description: "Modèle conservé dans cette conversation.", logoPublisher: provider), at: 0)
        }
        return values
    }
    private var pickerSelectedModel: String {
        remoteChat.map { ($0.provider ?? "") + ":" + $0.model } ?? manager.selectedModel
    }
    private var pickerScope: ModelPickerScope { isRemoteConversation ? .harness(remoteHarnessName) : .catalog }
    private var pickerEffort: ModelPickerEffort? {
        guard let chat = remoteChat else { return nil }
        let effort = instances.effortCatalog[chat.machine + ":" + chat.harness + ":" + chat.model]
        guard effort?.options.isEmpty == false || chat.effort != nil else { return nil }
        return ModelPickerEffort(options: effort?.options.map { .init(value: $0.value, label: $0.label) } ?? [], selected: chat.effort ?? effort?.currentValue,
            defaultValue: effort?.defaultValue, disabled: chat.command != nil || chat.pendingConfiguration != nil || isGenerating || instances.busy) { value in
                try await instances.chooseEffort(value, machine: chat.machine)
            }
    }
    private var pickerIsLoading: Bool { isRemoteConversation ? instances.busy : manager.isLoadingModels }
    private var pickerIsDisabled: Bool {
        if let chat = remoteChat { return chat.canContinue == false || chat.command != nil || chat.pendingConfiguration != nil || isGenerating || instances.busy }
        return manager.isStreaming
    }
    private var welcome: some View {
        ChatWelcomeView(suggestions: suggestions, execute: executeSuggestion, edit: { suggestion in
            highlightedSuggestion = suggestion.id
            suggestionsPresented = true
        }) {
            VStack(spacing: 12) {
                welcomeExecutionSelector
                if isRemoteConversation { remoteProjectSelector }
            }
        }
    }

    private func harnessDisplayName(_ identifier: String) -> String {
        switch identifier {
        case "openai-codex": return "OpenAI Codex"
        case "claude-code": return "Claude Code"
        case "hermes-agent": return "Hermes Agent"
        case "gemini-cli": return "Gemini CLI"
        case "opencode": return "OpenCode"
        case "pi": return "Pi"
        default: return identifier.replacingOccurrences(of: "-", with: " ").capitalized
        }
    }

    private func normalizedRemoteProvider(_ provider: String?, modelID: String, harnessID: String) -> String? {
        let value = provider?.lowercased() ?? ""
        if value.contains("openai") { return "openai" }
        if value.contains("anthropic") || value.contains("claude") { return "anthropic" }
        if value.contains("google") || value.contains("gemini") { return "google" }
        if value.contains("mistral") { return "mistral" }
        if value.contains("deepseek") { return "deepseek" }
        if value.contains("meta") || value.contains("llama") { return "meta" }
        let model = modelID.lowercased()
        if harnessID == "openai-codex" || model.hasPrefix("gpt-") || model.contains("openai") { return "openai" }
        if harnessID == "claude-code" || model.contains("claude") { return "anthropic" }
        if harnessID == "gemini-cli" || model.contains("gemini") { return "google" }
        return provider
    }

    private func selectPickerModel(_ option: ModelOption) async throws {
        guard let chat = remoteChat else { await manager.chooseModel(option); return }
        let key = instances.modelKey(chat.machine, harness: chat.harness)
        guard let model = instances.modelCatalog[key]?.first(where: { $0.selectionID == option.id }) else { throw APIError.noModel }
        remoteConfigurationError = nil
        try await instances.choose(chat.machine, harness: chat.harness, model: model)
        do { try await instances.efforts(chat.machine, harness: chat.harness, model: model.id, provider: model.provider) }
        catch { remoteConfigurationError = "Le modèle est sélectionné ; son catalogue d’effort est momentanément indisponible." }
    }

    private func reloadPickerModels() async {
        guard let chat = remoteChat else { await manager.reloadModels(); return }
        do { try await instances.prepare(chat.machine, harness: chat.harness); remoteConfigurationError = nil }
        catch { remoteConfigurationError = "Catalogue indisponible sur cette instance." }
    }

    private var isNewConversation: Bool { displayMessages.isEmpty }

    private var modalIsActive: Bool {
        manager.authenticationPresented || manager.internetApproval != nil || manager.memoryPresented || manager.memoryDraft != nil ||
            documentsPresented || privacyPresented || suggestionsPresented || selectionContent != nil
    }

    private func executeSuggestion(_ suggestion: HomeSuggestion) {
        var prompt = suggestion.instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        if suggestion.inputSource == .clipboard {
            guard let clipboard = UIPasteboard.general.string, !clipboard.isEmpty else {
                text = prompt; return
            }
            prompt += prompt.isEmpty ? clipboard : ": " + clipboard
        } else if suggestion.behavior == .prepare { prompt += prompt.isEmpty ? "" : " " }
        if suggestion.behavior == .send {
            if let chat = remoteChat, instances.send(prompt, chat: chat.id) {
                text = ""; dismissKeyboardAfterSend(); return
            }
            if remoteChat == nil, manager.send(prompt) { text = ""; dismissKeyboardAfterSend(); return }
        }
        text = prompt
    }

    private func sendComposerMessage() {
        if let chat = remoteChat {
            guard instances.send(text, chat: chat.id) else { return }
        } else { guard manager.send(text) else { return } }
        text = ""
        dismissKeyboardAfterSend()
    }

    private func dismissKeyboardAfterSend() {
        // Release the keyboard while keeping the input panel visible.
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            composerFocused = false
        }
    }

    private var composer: some View {
        @Bindable var manager = manager
        return VStack(alignment: .leading, spacing: 8) {
            if !isRemoteConversation && !ModelExecution(manager.selectedModel).isLocal && manager.session != nil {
                DisclosureGroup(isExpanded: $composerContextExpanded) {
                    VStack(alignment: .leading, spacing: 8) {
                        if ModelExecution(manager.selectedModel).isLocal {
                            Text(HermesOnDeviceCapabilities.current.summary)
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if manager.session != nil {
                            Button(manager.currentCloudHermesAuthorized ? "Gérer les autorisations de cette conversation" : "Autoriser Hermes pour cette conversation") { cloudHermesConsentPresented = true }
                        }
                        if let status = manager.currentCloudHermesStatus {
                            Text("Exécution : " + status.replacingOccurrences(of: "_", with: " ")).font(.caption)
                        }
                        if manager.currentCloudHermesPending {
                            Text("La reprise vérifie la même exécution. Aucune commande incertaine ne sera rejouée automatiquement.").font(.caption).foregroundStyle(.secondary)
                            HStack {
                                Button("Vérifier la reprise") { Task { await manager.resumeCloudHermes() } }
                                Button("Annuler l’exécution", role: .destructive) { Task { await manager.cancelPendingCloudHermes() } }
                            }.disabled(manager.isStreaming)
                        }
                        if manager.currentCloudHermesStatus == "awaiting_resolution" {
                            Text("Des effets restent à vérifier. Examinez l’environnement avant de recommencer ; annuler ne revient pas sur les commandes déjà exécutées.").font(.caption).foregroundStyle(.orange)
                        }
                    }
                    .padding(.top, 6)
                } label: {
                    Label("Statut et autorisations", systemImage: "lock.shield")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 12)
                .accessibilityIdentifier("cloudHermesStatus")
            }
            if isRemoteConversation { remoteConfigurationControls }
            if !isRemoteConversation, let error = voice.error {
                Text(error).font(.callout).foregroundStyle(.red)
                    .lineLimit(3).accessibilityIdentifier("dictationError")
            } else if !isRemoteConversation && voice.recording {
                Label("Écoute…", systemImage: "mic.fill")
                    .font(.callout).foregroundStyle(.red)
                    .accessibilityIdentifier("dictationListening")
            } else if !isRemoteConversation && voice.starting {
                Label("Démarrage de la dictée…", systemImage: "mic")
                    .font(.callout).foregroundStyle(.secondary)
                    .accessibilityIdentifier("dictationStarting")
            }
            if !isRemoteConversation, let access = manager.selectedAccess {
                Button {
                    Task { await manager.chooseModel(manager.models.first { $0.id == access.modelId } ?? ModelOption(id: access.modelId), force: true) }
                } label: {
                    Text(access.label).font(.caption).lineLimit(1)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .accessibilityLabel("Changer de mode d’accès : \(access.label)")
                .disabled(manager.isStreaming)
            }
            VStack(alignment: .leading, spacing: 2) {
                TextField("Écrire à MultiVibe", text: $text, axis: .vertical)
                    .focused($composerFocused)
                    .submitLabel(.send)
                    .onSubmit(sendComposerMessage)
                    .accessibilityLabel("Message")
                    .lineLimit(1...4)
                    .padding(.horizontal, 12)
                    .padding(.top, 12)
                    .padding(.bottom, 6)
                HStack(spacing: 8) {
                    if isRemoteConversation {
                        Image(systemName: "desktopcomputer").font(.title3).foregroundStyle(.secondary).frame(width: 40, height: 40)
                    } else {
                        Menu("Ajouter", systemImage: "plus") {
                            Button("Documents et outils", systemImage: "folder") { documentsPresented = true }
                            Button("Mémoire", systemImage: "brain") { manager.memoryPresented = true }
                            Button("Confidentialité et données", systemImage: "hand.raised") { privacyPresented = true }
                        }
                        .labelStyle(.iconOnly)
                        .font(.title2.weight(.regular))
                        .frame(width: 40, height: 40)
                    }
                    ModelPickerButton(models: pickerModels, selectedModel: pickerSelectedModel, scope: pickerScope, effort: pickerEffort,
                                      isLoading: pickerIsLoading, isDisabled: pickerIsDisabled,
                                      compact: dynamicTypeSize.isAccessibilitySize,
                                      reload: reloadPickerModels, select: selectPickerModel)
                    Spacer(minLength: 0)
                    composerActionControls
                }
                .dynamicTypeSize(.small ... .accessibility1)
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.plain)
            .padding(6)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(.primary.opacity(0.08), lineWidth: 0.7))
            .shadow(color: .black.opacity(0.06), radius: 12, y: 4)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .frame(maxWidth: 780)
        .frame(maxWidth: .infinity)
    }

    // This high-churn control tree is type-erased at the composer boundary.
    // It keeps SwiftUI from recursively resolving the entire ChatView generic
    // graph when a remote voice turn changes the available actions.
    private var composerActionControls: AnyView {
        if isGenerating {
            return AnyView(composerCircleButton("Arrêter", systemImage: "stop.fill", foreground: .white, background: .primary, size: 36) {
                if let chat = remoteChat {
                    Task { do { try await instances.interrupt(chat.id) } catch { remoteConfigurationError = "L’arrêt n’a pas été confirmé. Reprenez le suivi pour vérifier l’exécution." } }
                } else { manager.stop() }
            })
        }
        if voice.recording {
            return AnyView(composerCircleButton("Terminer la dictée", systemImage: "stop.fill", foreground: .white, background: .red, size: 36) { voice.stop() }
                .accessibilityIdentifier("stopDictation"))
        }
        if voice.starting {
            return AnyView(ProgressView().frame(width: 36, height: 36).accessibilityLabel("Démarrage de la dictée"))
        }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let voiceButton = composerCircleButton("Démarrer une conversation vocale", systemImage: "waveform", foreground: .white,
                                                   background: MultiVibeTheme.accent, size: 36) { startVoiceConversation() }
                .accessibilityIdentifier("startVoiceConversation")
            if isRemoteConversation { return AnyView(voiceButton) }
            return AnyView(HStack(spacing: 0) {
                Button("Dicter sur cet appareil", systemImage: "mic") { startVoiceInput() }
                    .accessibilityIdentifier("startDictation")
                    .font(.title3.weight(.medium)).frame(width: 36, height: 36)
                voiceButton
            })
        }
        return AnyView(composerCircleButton("Envoyer", systemImage: "arrow.up", foreground: .white, background: MultiVibeTheme.accent, size: 36) { sendComposerMessage() }
            .disabled(isRemoteConversation ? (remoteChat?.canContinue == false || remoteChat?.model.isEmpty != false || remoteChat?.command != nil || remoteChat?.pendingConfiguration != nil || instances.busy) :
                (manager.selectedModel.isEmpty || (manager.isSynchronizing && !ModelExecution(manager.selectedModel).isLocal))))
    }

    @ViewBuilder private var executionMenuItems: some View {
        Button { selectLocalExecution() } label: {
            Label("Cet iPhone", systemImage: instances.selection == nil && ModelExecution(manager.selectedModel).isLocal ? "checkmark" : "iphone")
        }
        Button { selectLocalExecution(cloud: true) } label: {
            HStack {
                Image("MultiVibeMark").resizable().scaledToFit().frame(width: 18, height: 18)
                Text("MultiVibe Cloud")
                if instances.selection == nil && !ModelExecution(manager.selectedModel).isLocal {
                    Image(systemName: "checkmark")
                }
            }
        }
        ForEach(instances.machines.filter { instances.paired.contains($0.id) }) { machine in
            Menu(machine.name) {
                let available = instances.harnesses[machine.id]?.filter { $0.available } ?? []
                if available.isEmpty {
                    Button("Charger les harness…") { Task { try? await instances.catalog(machine.id) } }
                } else {
                    ForEach(available) { harness in
                        Button {
                            selectRemoteExecution(machine: machine, harness: harness)
                        } label: {
                            Label(harness.name, systemImage: remoteChat?.machine == machine.id && remoteChat?.harness == harness.id ? "checkmark" : "cpu")
                        }.disabled(!machine.online || instances.busy)
                    }
                }
            }
        }
        Divider()
        Button("Actualiser les instances", systemImage: "arrow.clockwise") { Task { await instances.reload() } }
        Button("Gérer les instances…", systemImage: "desktopcomputer.and.iphone") { remoteInstancesPresented = true }
    }

    private var selectedExecutionHarnessID: String {
        remoteChat?.harness ?? (ModelExecution(manager.selectedModel).isLocal ? "native" : "hermes-cloud")
    }
    private var selectedExecutionName: String { isRemoteConversation ? remoteHarnessName : localExecutionName }
    private var welcomeExecutionOverlay: WelcomeExecutionOverlayModifier {
        WelcomeExecutionOverlayModifier(isPresented: welcomeExecutionListExpanded) { maxHeight in
            AnyView(welcomeExecutionList(maxHeight: maxHeight))
        }
    }

    private var welcomeExecutionSelector: some View {
        Button {
            withAnimation(.snappy) { welcomeExecutionListExpanded.toggle() }
        } label: {
            VStack(spacing: 7) {
                HarnessIdentityLogo(id: selectedExecutionHarnessID, name: selectedExecutionName, size: 64)
                HStack(spacing: 5) {
                    Text(selectedExecutionName).lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(welcomeExecutionListExpanded ? 180 : 0))
                }
                .font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                if let machine = remoteMachine { Text(machine.name).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
            .frame(minWidth: 132).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Lieu d’exécution et harness")
        .accessibilityIdentifier("welcomeExecutionPicker")
        .accessibilityValue((isRemoteConversation ? (remoteMachine?.name ?? "Instance") + ", " + remoteHarnessName : localExecutionName) + (welcomeExecutionListExpanded ? ", liste ouverte" : ", liste fermée"))
        .anchorPreference(key: WelcomeExecutionAnchorKey.self, value: .bounds) { $0 }
        .dynamicTypeSize(.small ... .accessibility1)
    }

    private func welcomeExecutionList(maxHeight: CGFloat) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                welcomeExecutionRow(id: "native", name: "Cet iPhone",
                                    selected: instances.selection == nil && ModelExecution(manager.selectedModel).isLocal) {
                    selectLocalExecution()
                }
                welcomeExecutionRow(id: "hermes-cloud", name: "MultiVibe Cloud",
                                    selected: instances.selection == nil && !ModelExecution(manager.selectedModel).isLocal) {
                    selectLocalExecution(cloud: true)
                }

                ForEach(instances.machines.filter { instances.paired.contains($0.id) }) { machine in
                    Divider().padding(.vertical, 5)
                    Text(machine.name)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 10)
                        .padding(.bottom, 2)
                    let available = instances.harnesses[machine.id]?.filter { $0.available } ?? []
                    if available.isEmpty {
                        Button("Charger les harness…", systemImage: "arrow.clockwise") {
                            Task { try? await instances.catalog(machine.id) }
                        }
                        .font(.subheadline)
                        .padding(.horizontal, 10)
                        .frame(minHeight: 42)
                        .disabled(!machine.online || instances.busy)
                    } else {
                        ForEach(available) { harness in
                            welcomeExecutionRow(id: harness.id, name: harness.name,
                                                selected: remoteChat?.machine == machine.id && remoteChat?.harness == harness.id,
                                                disabled: !machine.online || instances.busy) {
                                selectRemoteExecution(machine: machine, harness: harness)
                            }
                        }
                    }
                }

                Divider().padding(.vertical, 5)
                Button("Gérer les instances…", systemImage: "desktopcomputer.and.iphone") { remoteInstancesPresented = true }
            }
            .padding(8)
        }
        .scrollBounceBehavior(.basedOnSize)
        .font(.subheadline)
        .buttonStyle(.plain)
        .frame(maxHeight: maxHeight, alignment: .top)
        .fixedSize(horizontal: false, vertical: true)
        .modifier(WelcomeExecutionGlassSurface())
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(.primary.opacity(0.1), lineWidth: 0.7))
        .shadow(color: .black.opacity(0.18), radius: 24, y: 12)
        .accessibilityIdentifier("welcomeExecutionList")
    }

    private func welcomeExecutionRow(id: String, name: String, selected: Bool, disabled: Bool = false,
                                     action: @escaping () -> Void) -> some View {
        Button {
            withAnimation(.snappy) { welcomeExecutionListExpanded = false }
            action()
        } label: {
            HStack(spacing: 10) {
                HarnessIdentityLogo(id: id, name: name, size: 30)
                Text(name).foregroundStyle(.primary).lineLimit(1)
                Spacer(minLength: 12)
                if selected { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(MultiVibeTheme.accent) }
            }
            .padding(.horizontal, 8)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .disabled(disabled)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var conversationExecutionSelector: some View {
        Menu { executionMenuItems } label: {
            HStack(spacing: 7) {
                HarnessIdentityLogo(id: selectedExecutionHarnessID, name: selectedExecutionName, size: 22)
                Text(selectedExecutionName).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold)).foregroundStyle(.tertiary)
            }
            .font(.caption.weight(.semibold)).foregroundStyle(.secondary).frame(maxWidth: 170)
        }
        .accessibilityLabel("Lieu d’exécution et harness")
        .accessibilityIdentifier("executionPicker")
        .accessibilityValue(isRemoteConversation ? (remoteMachine?.name ?? "Instance") + ", " + remoteHarnessName : localExecutionName)
    }

    @ViewBuilder private var remoteProjectSelector: some View {
        if let chat = remoteChat {
            HStack(spacing: 8) {
                Button { remoteProjectPickerPresented = true } label: {
                    Label(chat.projectName ?? "Aucun projet", systemImage: chat.projectId == nil ? "folder" : "folder.fill")
                }
                .disabled(chat.source != nil || !chat.messages.isEmpty || isGenerating || instances.busy)
                .accessibilityIdentifier("integratedRemoteProjectPicker")
                if instances.busy { ProgressView().controlSize(.small) }
            }
            .font(.caption.weight(.medium)).buttonStyle(.bordered).controlSize(.small)
        }
    }

    @ViewBuilder private var remoteConfigurationControls: some View {
        if let chat = remoteChat {
            if chat.canContinue == false {
                Text("Historique en lecture seule : ce harness ne permet pas de reprendre cette conversation depuis iOS.")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 12)
            }
            if chat.pendingConfiguration != nil {
                Button("Vérifier le changement de configuration", systemImage: "arrow.clockwise") {
                    Task { do { try await instances.configure(chat.id); remoteConfigurationError = nil } catch { remoteConfigurationError = "La configuration reste à vérifier sur cette instance." } }
                }.font(.caption).padding(.horizontal, 12).disabled(instances.busy)
            }
            if chat.command != nil && !isGenerating {
                HStack {
                    Button("Reprendre le suivi", systemImage: "arrow.clockwise") { instances.send("", chat: chat.id, recover: true) }
                    Button("Arrêter", systemImage: "stop.fill") { Task { try? await instances.interrupt(chat.id) } }
                }.font(.caption).padding(.horizontal, 12).disabled(instances.busy)
            }
        }
    }

    private func composerCircleButton(_ title: String, systemImage: String, foreground: Color,
                                      background: Color, size: CGFloat = 44,
                                      action: @escaping () -> Void) -> some View {
        Button(title, systemImage: systemImage, action: action)
            .font(.headline.weight(.semibold))
            .foregroundStyle(foreground)
            .frame(width: size, height: size)
            .background(background, in: Circle())
    }

    private func openNewConversation() {
        if let chat = remoteChat { do { _ = try instances.newChat(chat.machine, harness: chat.harness) } catch { remoteConfigurationError = error.localizedDescription } }
        else { manager.newConversation() }
        preferredColumn = .detail
    }
    private func selectLocalExecution(cloud: Bool = false) {
        instances.select(nil)
        remoteConfigurationError = nil
        if cloud && manager.session == nil { manager.authenticationPresented = true; return }
        if ModelExecution(manager.selectedModel).isLocal == cloud {
            if let conversation = manager.historyConversations.first(where: { ModelExecution($0.model).isLocal != cloud }) {
                manager.selection = conversation.id
            } else {
                manager.newConversation()
                if let model = manager.models.first(where: { ModelExecution($0.id).isLocal != cloud }) {
                    Task { await manager.chooseModel(model) }
                }
            }
        }
        if manager.selection == nil { manager.newConversation() }
        preferredColumn = .detail
    }
    private func selectRemoteExecution(machine: RemoteMachine, harness: RemoteHarness) {
        guard harness.available, instances.paired.contains(machine.id) else { return }
        manager.stop(); voice.silence(); remoteConfigurationError = nil
        do { _ = try instances.newChat(machine.id, harness: harness.id) }
        catch { remoteConfigurationError = error.localizedDescription; return }
        preferredColumn = .detail
    }

    private func consumeIntent() {
        guard scenePhase == .active, !manager.isRestoring else { return }
        do {
            if let request = try manager.applyNativeShortcut() {
                voice.silence()
                documentsPresented = false; privacyPresented = false
                manager.memoryPresented = false
                switch request.destination {
                case .history: preferredColumn = .sidebar
                case .documents: documentsPresented = true
                case .memory: manager.memoryPresented = true
                case .privacy: privacyPresented = true
                case .synchronization:
                    if manager.session == nil { manager.authenticationPresented = true }
                    else { confirmHistorySync = true }
                case nil: preferredColumn = .detail
                }
            }
        } catch { manager.error = error.localizedDescription }
        if manager.wantsNewConversation {
            manager.wantsNewConversation = false
            openNewConversation()
        }
        if manager.wantsVoiceConversation {
            manager.wantsVoiceConversation = false
            startVoiceConversation()
        }
        if let draft = manager.pendingDraft {
            shortcutDraftConversation = manager.selection
            text = draft; manager.pendingDraft = nil
        }
        if manager.wantsVoice {
            manager.wantsVoice = false
            startVoiceInput()
        }
    }

    private func startVoiceInput() {
        preferredColumn = .detail
        Task {
            await voice.start()
            manager.wantsImmediateVoiceCapture = false
        }
    }
    private func startVoiceConversation() {
        preferredColumn = .detail
        voice.silence()
        if manager.session == nil { manager.authenticationPresented = true; return }
        if remoteChat == nil { manager.newConversation() }
        // The compact composer is itself a sheet. Dismiss it before presenting
        // the full-screen voice UI so UIKit never restores it at a large detent.
        voiceConversationPreparing = true
        composerFocused = false
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(180))
            guard voiceConversationPreparing else { return }
            voiceConversationPresented = true
            voiceConversationPreparing = false
        }
    }
}


private enum ModelPickerScope {
    case catalog
    case harness(String)
    var title: String { if case .harness(let name) = self { "Modèle et effort · \(name)" } else { "Changer de modèle" } }
    var dismissesAfterSelection: Bool { if case .catalog = self { true } else { false } }
    var includesMarketplace: Bool { if case .catalog = self { true } else { false } }
}

struct ModelPickerEffort {
    struct Option: Identifiable { let value: String; let label: String; var id: String { value } }
    let options: [Option]
    let selected: String?
    let defaultValue: String?
    let disabled: Bool
    let select: @MainActor (String?) async throws -> Void
    var selectedLabel: String? { options.first { $0.value == selected }?.label ?? options.first { $0.value == defaultValue }?.label ?? selected }
}

private struct ModelPickerButton: View {
    let models: [ModelOption]
    let selectedModel: String
    let scope: ModelPickerScope
    let effort: ModelPickerEffort?
    let isLoading: Bool
    let isDisabled: Bool
    var compact = false
    let reload: @MainActor () async -> Void
    let select: @MainActor (ModelOption) async throws -> Void
    @State private var presented = false
    @State private var detent: PresentationDetent = .medium
    @State private var favorites = ModelFavoriteStore.load()

    var body: some View {
        Button {
            favorites = ModelFavoriteStore.load()
            detent = .medium
            presented = true
            if models.isEmpty { Task { await reload() } }
        } label: {
            if compact {
                if let model = models.first(where: { $0.id == selectedModel }) {
                    ModelProviderLogo(provider: model.presentation.provider, publisher: model.logoPublisher ?? model.author, size: 28)
                        .frame(width: 44, height: 44)
                } else {
                    Image(systemName: "cpu")
                        .font(.title3.weight(.medium))
                        .frame(width: 44, height: 44)
                }
            } else {
                HStack(spacing: 6) {
                    if let model = models.first(where: { $0.id == selectedModel }) {
                        ModelProviderLogo(provider: model.presentation.provider, publisher: model.logoPublisher ?? model.author, size: 22)
                    }
                    Text(models.first(where: { $0.id == selectedModel })?.displayName ?? "Choisir un modèle")
                        .lineLimit(1)
                    if let label = effort?.selectedLabel {
                        Text(label).foregroundStyle(.tertiary).lineLimit(1)
                    }
                    Image(systemName: "chevron.down").font(.caption2)
                }.font(.subheadline).frame(minHeight: 44)
            }
        }
        .disabled(isDisabled)
        .accessibilityIdentifier("unifiedModelPicker")
        .accessibilityLabel(effort == nil ? "Modèle" : "Modèle et effort")
        .accessibilityValue([models.first(where: { $0.id == selectedModel })?.displayName, effort?.selectedLabel].compactMap { $0 }.joined(separator: ", "))
        .sheet(isPresented: $presented) {
            NavigationStack {
                ModelQuickPicker(models: models, selectedModel: selectedModel, favorites: $favorites,
                                 scope: scope, effort: effort, isLoading: isLoading, reload: reload,
                                 expand: { detent = .large }, close: { presented = false }, select: select)
            }
            .presentationDetents([.medium, .large], selection: $detent)
            .presentationDragIndicator(.visible)
            .presentationCornerRadius(30)
        }
    }
}

private struct ModelQuickPicker: View {
    let models: [ModelOption]
    let selectedModel: String
    @Binding var favorites: Set<String>
    let scope: ModelPickerScope
    let effort: ModelPickerEffort?
    let isLoading: Bool
    let reload: @MainActor () async -> Void
    let expand: () -> Void
    let close: () -> Void
    let select: @MainActor (ModelOption) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @State private var changing = false
    @State private var failure: String?
    private var selected: ModelOption? { models.first { $0.id == selectedModel } }
    private var visibleModels: [ModelOption] { models.filter { $0.id != selectedModel && (search.isEmpty || $0.displayName.localizedCaseInsensitiveContains(search) || $0.id.localizedCaseInsensitiveContains(search)) } }
    private var favoriteModels: [ModelOption] { visibleModels.filter { favorites.contains($0.id) } }

    var body: some View {
        modelList
            .navigationTitle(scope.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fermer") { close(); dismiss() } } }
            .overlay { if changing || isLoading { ProgressView().padding(14).background(.regularMaterial, in: Capsule()) } }
            .searchable(text: $search, prompt: scope.includesMarketplace ? "Rechercher dans cette liste" : "Rechercher un modèle du harness")
    }

    private var modelList: some View {
        List {
            if let failure { Section { Text(failure).foregroundStyle(.red) } }
            if let selected {
                Section("Modèle actuel") {
                    ModelPickerRow(model: selected, favorite: favorites.contains(selected.id), trailing: "checkmark")
                }
            }
            if let effort, !effort.options.isEmpty {
                Section("Effort") {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Text("Niveau de raisonnement").font(.subheadline.weight(.medium))
                            Spacer()
                            Text(effort.selectedLabel ?? "Par défaut").font(.subheadline).foregroundStyle(.secondary)
                            if effort.defaultValue != nil {
                                Button("Réinitialiser", systemImage: "arrow.counterclockwise") { chooseEffort(effort.defaultValue) }
                                    .labelStyle(.iconOnly).disabled(effort.disabled || changing || (effort.selected ?? effort.defaultValue) == effort.defaultValue)
                            }
                        }
                        ModelEffortScale(effort: effort, disabled: changing || effort.disabled, select: chooseEffort)
                    }.padding(.vertical, 5)
                }
            }
            if scope.includesMarketplace && !favoriteModels.isEmpty {
                Section("Favoris") {
                    ForEach(favoriteModels) { model in
                        Button { choose(model) } label: { ModelPickerRow(model: model, favorite: true) }
                    }
                }
            }
            if scope.includesMarketplace && !LocalModelLibrary.shared.installed.isEmpty {
                Section("Sur cet appareil") {
                    ForEach(LocalModelLibrary.shared.installed) { model in
                        Button { choose(model.option) } label: { ModelPickerRow(model: model.option, favorite: favorites.contains(model.id)) }
                    }
                }
            }
            if !scope.includesMarketplace && !visibleModels.isEmpty {
                Section("Modèles du harness") {
                    ForEach(visibleModels) { model in Button { choose(model) } label: { ModelPickerRow(model: model, favorite: false) } }
                }
            }
            Section {
                if scope.includesMarketplace {
                    NavigationLink {
                        ModelMarketplaceView(models: models, favorites: $favorites, select: choose).onAppear(perform: expand)
                    } label: {
                        Label("Explorer tous les modèles", systemImage: "sparkles.rectangle.stack")
                            .font(.body.weight(.semibold)).foregroundStyle(MultiVibeTheme.accent)
                    }
                }
                Button { Task { await reload() } } label: {
                    Label("Actualiser les modèles", systemImage: "arrow.clockwise")
                }.disabled(isLoading || changing)
            }
        }
        .overlay {
            if selected == nil && visibleModels.isEmpty && models.isEmpty && !isLoading {
                ContentUnavailableView("Aucun modèle disponible", systemImage: "cpu",
                                       description: Text("Actualisez le catalogue ou connectez-vous à votre compte."))
                    .allowsHitTesting(false)
            }
        }
    }

    private func choose(_ model: ModelOption) {
        guard !changing else { return }; changing = true; failure = nil
        Task { @MainActor in
            do { try await select(model); if scope.dismissesAfterSelection { close() } }
            catch { failure = error.localizedDescription }
            changing = false
        }
    }
    private func chooseEffort(_ value: String?) {
        guard !changing, let effort else { return }; changing = true; failure = nil
        Task { @MainActor in
            do { try await effort.select(value) }
            catch { failure = error.localizedDescription }
            changing = false
        }
    }
}

struct ModelEffortScale: View {
    let effort: ModelPickerEffort
    let disabled: Bool
    let select: (String?) -> Void
    private var selectedIndex: Int {
        effort.options.firstIndex { $0.value == effort.selected } ?? effort.options.firstIndex { $0.value == effort.defaultValue } ?? 0
    }
    var body: some View {
        GeometryReader { geometry in
            let inset: CGFloat = 22
            let available = max(0, geometry.size.width - inset * 2)
            let step = effort.options.count > 1 ? available / CGFloat(effort.options.count - 1) : 0
            let thumbX = inset + step * CGFloat(selectedIndex)
            ZStack(alignment: .leading) {
                Capsule().fill(Color(uiColor: .secondarySystemBackground))
                    .overlay(Capsule().stroke(.primary.opacity(0.08), lineWidth: 1))
                Capsule().fill(MultiVibeTheme.accent).frame(width: max(44, thumbX + inset))
                HStack(spacing: 0) {
                    ForEach(Array(effort.options.enumerated()), id: \.element.id) { index, option in
                        Button { select(option.value) } label: {
                            Circle().fill(.white.opacity(index <= selectedIndex ? 0.52 : 0.38)).frame(width: 7, height: 7)
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }.buttonStyle(.plain).disabled(disabled)
                            .accessibilityLabel(option.label).accessibilityValue(index == selectedIndex ? "Sélectionné" : "")
                    }
                }.padding(.horizontal, inset - 3)
                Circle().fill(.white).frame(width: 42, height: 42)
                    .shadow(color: .black.opacity(0.16), radius: 3, y: 1).offset(x: thumbX - 21).allowsHitTesting(false)
            }
            .contentShape(Capsule())
            .gesture(DragGesture(minimumDistance: 0).onEnded { value in
                guard !disabled, !effort.options.isEmpty else { return }
                let raw = step > 0 ? (value.location.x - inset) / step : 0
                let index = min(effort.options.count - 1, max(0, Int(raw.rounded())))
                select(effort.options[index].value)
            })
        }
        .frame(height: 48).accessibilityElement(children: .contain).accessibilityLabel("Niveau d’effort")
    }
}

private struct ModelPickerRow: View {
    let model: ModelOption
    let favorite: Bool
    var trailing: String? = nil
    var body: some View {
        HStack(spacing: 12) {
            ModelProviderLogo(provider: model.presentation.provider, publisher: model.logoPublisher ?? model.author, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.displayName).font(.body.weight(.medium)).foregroundStyle(.primary)
                Text(ModelExecution(model.id).isLocal ? "Sur cet appareil" : model.author ?? "Catalogue MultiVibe")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let trailing { Image(systemName: trailing).foregroundStyle(MultiVibeTheme.accent) }
            else if favorite { Image(systemName: "star.fill").foregroundStyle(.orange) }
        }.contentShape(Rectangle())
    }
}

private struct ModelMarketplaceView: View {
    @Environment(ConversationManager.self) private var manager
    enum Tab: Hashable { case discover, categories, favorites, providers, device }
    let models: [ModelOption]
    @Binding var favorites: Set<String>
    let select: (ModelOption) -> Void
    @State private var tab: Tab = .discover
    @State private var search = ""
    @State private var entries: [ModelOption] = []
    @State private var cursor: String?
    @State private var loading = false
    @State private var catalogError: String?
    private var filtered: [ModelOption] {
        uniqueMarketplaceModels(search.isEmpty ? [LocalModel.option] + entries : entries)
    }
    private func load(reset: Bool) async {
        let query = search
        loading = true
        defer { if query == search { loading = false } }
        do {
            let token = try await manager.validSession().accessToken
            let page = try await ChatAPI.shared.catalog(search: query, cursor: reset ? "" : cursor ?? "", token: token)
            guard query == search, !Task.isCancelled else { return }
            let received = page.data.map(\.option).filter { $0.id != LocalModel.id }
            entries = uniqueMarketplaceModels(reset ? received : entries + received)
            cursor = page.nextCursor; catalogError = nil
            for model in entries where !manager.models.contains(where: { $0.id == model.id }) { manager.models.append(model) }
        } catch { if !Task.isCancelled { catalogError = error.localizedDescription } }
    }
    var body: some View {
        TabView(selection: $tab) {
            ModelDiscoverView(models: filtered, favorites: $favorites, select: select)
                .tabItem { Label("Découvrir", systemImage: "sparkles") }.tag(Tab.discover)
            ModelCategoriesView(models: filtered, favorites: $favorites, select: select)
                .tabItem { Label("Catégories", systemImage: "square.grid.2x2") }.tag(Tab.categories)
            ModelListView(title: "Favoris", models: (search.isEmpty ? manager.models : filtered).filter { favorites.contains($0.id) }, favorites: $favorites, select: select)
                .tabItem { Label("Favoris", systemImage: "star") }.tag(Tab.favorites)
            LocalModelsView(search: search, select: select)
                .tabItem { Label("Sur cet appareil", systemImage: "iphone") }.tag(Tab.device)
            ModelProvidersView(models: filtered)
                .tabItem { Label("Fournisseurs", systemImage: "person.2.badge.gearshape") }.tag(Tab.providers)
        }
        .navigationTitle("Modèles")
        .navigationBarTitleDisplayMode(.large)
        .searchable(text: $search, prompt: "Modèles, fournisseurs et usages")
        .task(id: search + String(describing: tab)) { guard tab != .device, manager.session != nil else { return }; try? await Task.sleep(for: .milliseconds(300)); guard !Task.isCancelled else { return }; await load(reset: true) }
        .safeAreaInset(edge: .bottom) {
            if tab != .providers && tab != .device && (catalogError != nil || (!loading && cursor != nil)) {
                VStack {
                    if let catalogError { Text(catalogError).font(.caption); Button("Réessayer") { Task { await load(reset: true) } } }
                    if cursor != nil { Button("Charger plus de modèles") { Task { await load(reset: false) } }.padding(8) }
                }.frame(maxWidth: .infinity).background(.regularMaterial)
            }
        }
    }
}

func uniqueMarketplaceModels(_ models: [ModelOption]) -> [ModelOption] {
    var identifiers = Set<String>()
    return models.filter { identifiers.insert($0.id).inserted }
}

private struct ModelDiscoverView: View {
    let models: [ModelOption]
    @Binding var favorites: Set<String>
    let select: (ModelOption) -> Void
    private var popular: [ModelOption] {
        models.sorted {
            $0.presentation.popularity == $1.presentation.popularity ? $0.displayName < $1.displayName : $0.presentation.popularity > $1.presentation.popularity
        }
    }
    private var coding: [ModelOption] { popular.filter { $0.presentation.useCases.contains(.coding) } }
    private var free: [ModelOption] { popular.filter { !$0.presentation.usesCloudCredit } }
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                if let featured = coding.first ?? popular.first {
                    NavigationLink { ModelDetailView(model: featured, favorite: favoriteBinding(featured), select: select) }
                    label: { FeaturedModelCard(model: featured) }.buttonStyle(.plain)
                }
                LocalModelDiscoveryShelf(select: select)
                ModelShelf(title: "Les plus populaires", models: Array(popular.prefix(5)), favorites: $favorites, select: select, ranked: true)
                if !free.isEmpty { ModelShelf(title: "Gratuits · sans crédit Cloud", models: free, favorites: $favorites, select: select) }
                ModelShelf(title: "Tous les modèles", models: models, favorites: $favorites, select: select)
                if !coding.isEmpty { ModelShelf(title: "Indispensables pour coder", models: coding, favorites: $favorites, select: select) }
            }.padding()
        }
        .background(MultiVibeTheme.softAccent)
        .overlay { if models.isEmpty { ContentUnavailableView("Aucun résultat", systemImage: "magnifyingglass") } }
    }
    private func favoriteBinding(_ model: ModelOption) -> Binding<Bool> {
        Binding(get: { favorites.contains(model.id) }, set: { setFavorite(model.id, $0, in: &favorites) })
    }
}

private struct FeaturedModelCard: View {
    let model: ModelOption
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("SÉLECTION MULTIVIBE").font(.caption2.bold()).tracking(1).foregroundStyle(.white.opacity(0.75))
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(model.presentation.useCases.contains(.coding) ? "Des modèles qui savent vraiment coder." : "Le bon modèle pour commencer.")
                        .font(.title2.bold()).foregroundStyle(.white)
                    Text(model.presentation.summary).font(.callout).foregroundStyle(.white.opacity(0.85)).lineLimit(3)
                }
                Spacer(minLength: 12)
                ModelProviderLogo(provider: model.presentation.provider, publisher: model.logoPublisher ?? model.author, size: 58, prominent: true)
            }
            Text("Voir la fiche").font(.callout.bold()).padding(.horizontal, 13).padding(.vertical, 8)
                .foregroundStyle(MultiVibeTheme.accent).background(.white, in: Capsule())
        }
        .padding(20)
        .background(LinearGradient(colors: [MultiVibeTheme.accent, MultiVibeTheme.accent.opacity(0.72)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 24))
    }
}

private struct ModelShelf: View {
    let title: String
    let models: [ModelOption]
    @Binding var favorites: Set<String>
    let select: (ModelOption) -> Void
    var ranked = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.title3.bold())
            VStack(spacing: 0) {
                ForEach(Array(models.enumerated()), id: \.element.id) { index, model in
                    NavigationLink { ModelDetailView(model: model, favorite: favoriteBinding(model), select: select) } label: {
                        HStack(spacing: 10) {
                            if ranked { Text("\(index + 1)").font(.headline).foregroundStyle(.secondary).frame(width: 18) }
                            ModelProviderLogo(provider: model.presentation.provider, publisher: model.logoPublisher ?? model.author, size: 42)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(model.displayName).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
                                Text(ModelExecution(model.id).isLocal ? "Sur cet appareil" : model.author ?? "Catalogue MultiVibe")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Utiliser") { select(model) }.buttonStyle(.bordered).controlSize(.small)
                        }.padding(.vertical, 9)
                    }.buttonStyle(.plain)
                    if model.id != models.last?.id { Divider().padding(.leading, ranked ? 70 : 52) }
                }
            }.padding(.horizontal, 12).background(.background.opacity(0.9), in: RoundedRectangle(cornerRadius: 18))
        }
    }
    private func favoriteBinding(_ model: ModelOption) -> Binding<Bool> {
        Binding(get: { favorites.contains(model.id) }, set: { setFavorite(model.id, $0, in: &favorites) })
    }
}

private struct ModelCategoriesView: View {
    let models: [ModelOption]
    @Binding var favorites: Set<String>
    let select: (ModelOption) -> Void
    var body: some View {
        ScrollView {
            LazyVGrid(columns: [.init(.flexible()), .init(.flexible())], spacing: 12) {
                ForEach(ModelUseCase.allCases) { useCase in
                    let matching = models.filter { $0.presentation.useCases.contains(useCase) }
                    NavigationLink { ModelListView(title: useCase.title, models: matching, favorites: $favorites, select: select) } label: {
                        VStack(alignment: .leading, spacing: 12) {
                            Image(systemName: useCase.systemImage).font(.title2)
                            Spacer()
                            Text(useCase.title).font(.headline)
                            Text("\(matching.count) modèle\(matching.count > 1 ? "s" : "")").font(.caption).opacity(0.75)
                        }.foregroundStyle(.white).padding(16).frame(maxWidth: .infinity, minHeight: 130, alignment: .leading)
                            .background(categoryColor(useCase), in: RoundedRectangle(cornerRadius: 20))
                    }.buttonStyle(.plain)
                }
            }.padding()
        }.background(MultiVibeTheme.softAccent)
    }
    private func categoryColor(_ value: ModelUseCase) -> Color {
        switch value { case .writing: .purple; case .coding: .teal; case .analysis: .blue; case .creation: .orange; case .local: MultiVibeTheme.accent }
    }
}

private struct ModelListView: View {
    let title: String
    let models: [ModelOption]
    @Binding var favorites: Set<String>
    let select: (ModelOption) -> Void
    var body: some View {
        List(models) { model in
            NavigationLink {
                ModelDetailView(model: model, favorite: Binding(get: { favorites.contains(model.id) }, set: { setFavorite(model.id, $0, in: &favorites) }), select: select)
            } label: { ModelPickerRow(model: model, favorite: favorites.contains(model.id)) }
            .swipeActions(edge: .trailing) {
                Button(favorites.contains(model.id) ? "Retirer" : "Favori", systemImage: favorites.contains(model.id) ? "star.slash" : "star") {
                    setFavorite(model.id, !favorites.contains(model.id), in: &favorites)
                }.tint(.orange)
            }
        }
        .navigationTitle(title)
        .overlay { if models.isEmpty { ContentUnavailableView("Aucun modèle", systemImage: "cpu") } }
    }
}

private struct ModelDetailView: View {
    @Environment(ConversationManager.self) private var manager
    let model: ModelOption
    @State private var detail: ModelOption?
    @State private var detailError: String?
    @Binding var favorite: Bool
    let select: (ModelOption) -> Void
    var body: some View {
        List {
            Section {
                VStack(spacing: 12) {
                    ModelProviderLogo(provider: model.presentation.provider, publisher: model.logoPublisher ?? model.author, size: 76, prominent: true)
                    Text(model.displayName).font(.largeTitle.bold()).multilineTextAlignment(.center)
                    Text(model.author ?? model.presentation.provider.displayName).foregroundStyle(.secondary)
                    HStack { ForEach(model.presentation.badges, id: \.self) { Text($0).font(.caption.bold()).padding(.horizontal, 8).padding(.vertical, 5).background(.secondary.opacity(0.1), in: Capsule()) } }
                    Button(favorite ? "Retirer des favoris" : "Ajouter aux favoris", systemImage: favorite ? "star.fill" : "star") { favorite.toggle() }
                        .buttonStyle(.bordered).tint(.orange)
                }.frame(maxWidth: .infinity).padding(.vertical, 16)
            }.listRowBackground(Color.clear)
            Section("À quoi sert ce modèle ?") { Text((detail ?? model).presentation.summary) }
            Section("Accès") {
                LabeledContent("Créateur", value: model.presentation.provider.displayName)
                LabeledContent("Accès", value: ModelExecution(model.id).isLocal ? "Sur cet appareil" : "Au choix selon disponibilité")
                if let context = (detail ?? model).metadata?.contextLength { LabeledContent("Contexte", value: "\(context) tokens") }
                if let output = (detail ?? model).metadata?.maxOutputTokens { LabeledContent("Sortie maximale", value: "\(output) tokens") }
                if let license = (detail ?? model).metadata?.license { LabeledContent("Licence", value: license) }
                if ModelExecution(model.id).isLocal { Label("Traitement sur cet appareil", systemImage: "lock.iphone") }
            }
            Section {
                if ModelExecution(model.id) == .downloaded, let downloadable = LocalModelLibrary.shared.model(model.id) {
                    LocalModelCard(model: downloadable, select: select)
                } else { Button("Utiliser \(model.displayName)") { select(model) }.buttonStyle(.borderedProminent).frame(maxWidth: .infinity) }
            }
        }
        .navigationTitle("Détails").navigationBarTitleDisplayMode(.inline)
        .task {
            guard !ModelExecution(model.id).isLocal else { return }
            do {
                let token = try await manager.validSession().accessToken
                let entry: CatalogEntry = try await ChatAPI.shared.providerRequest("catalog-detail", fields: ["model": model.id], token: token)
                detail = entry.option
            } catch { detailError = error.localizedDescription }
        }
        .safeAreaInset(edge: .bottom) { if let detailError { Text(detailError).font(.caption).padding().background(.regularMaterial) } }
    }
}

private struct ModelProvidersView: View {
    let models: [ModelOption]
    var body: some View { ProviderConnectionsView() }
}

struct ModelProviderLogo: View {
    let provider: ModelProvider
    var publisher: String? = nil
    let size: CGFloat
    var prominent = false
    var body: some View {
        Group {
            if let publisher = ModelPublisher.canonical(publisher),
               let image = UIImage(named: "Publisher-" + publisher) {
                Image(uiImage: image).resizable().scaledToFit().padding(size * 0.15)
                    .frame(width: size, height: size).background(.white)
            }
            else if let asset = provider.assetName { Image(asset).resizable().renderingMode(.template).scaledToFit().padding(size * 0.24) }
            else if provider == .multivibe { Image("MultiVibeMark").resizable().scaledToFit().padding(size * 0.16) }
            else { Image(systemName: "cpu").resizable().scaledToFit().padding(size * 0.25) }
        }
        .foregroundStyle(prominent ? .white : .primary)
        .frame(width: size, height: size)
        .background(prominent ? Color.black.opacity(0.22) : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: size * 0.28))
        .clipShape(RoundedRectangle(cornerRadius: size * 0.28))
        .accessibilityHidden(true)
    }
}

@MainActor private func setFavorite(_ identifier: String, _ enabled: Bool, in favorites: inout Set<String>) {
    if enabled { favorites.insert(identifier) } else { favorites.remove(identifier) }
    ModelFavoriteStore.save(favorites)
}


struct NativePrivacyView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var configuration: NativeAuthConfiguration?
    @State private var loading = false
    @State private var failed = false
    var body: some View {
        NavigationStack {
            List {
                Section("Compte et messages envoyés") {
                    Text("Votre adresse e-mail et vos identifiants sont transmis pour créer votre compte ou vous connecter. Les jetons de connexion sont conservés dans le trousseau de cet appareil.")
                    Text("Apple Foundation Local et les modèles téléchargés traitent les messages sur cet appareil, sans compte et sans Internet. Les modèles distants transmettent le message et son contexte à MultiVibe et peuvent consommer des crédits. Aucun basculement vers un modèle distant n’est automatique.")
                }
                Section("Outils et Internet") {
                    Text("L’accès web est demandé une seule fois par conversation. Autoriser permet les lectures HTTPS ; refuser conserve les outils hors ligne. Les sites reçoivent votre adresse IP et les URL demandées, sans les identifiants ni cookies de votre compte MultiVibe. Le modèle reste sur l’appareil.")
                    Text("Le calendrier, les rappels et les contacts nécessitent une demande explicite et les autorisations iOS. Les cartes permettent ensuite d’ouvrir les fiches système et d’effectuer les modifications que vous choisissez. Une suppression demande toujours confirmation.")
                }
                Section("Mémoire") {
                    Text("La mémoire est locale par défaut. Les souvenirs sont validés explicitement avec leur source. L’option Synchroniser la mémoire envoie les souvenirs validés, leurs citations et les oublis au compte ; elle est distincte de la synchronisation des conversations. Les modèles distants ne reçoivent pas automatiquement les souvenirs. Ce stockage serveur n’est pas chiffré de bout en bout.")
                }
                Section("Historique") {
                    Text("L’app conserve une copie des conversations sur cet appareil. La synchronisation automatique, activée avec votre confirmation, envoie les conversations du compte au retour du réseau et télécharge celles du compte. Les conversations invitées nécessitent un import explicite. Les documents importés restent sur cet appareil ; les passages cités dans une réponse font partie de la conversation synchronisée. Ce stockage n’est pas chiffré de bout en bout.")
                    Text("Supprimer une conversation dans l’app retire sa copie locale et oublie les souvenirs qui en proviennent. Cela ne constitue pas une suppression de compte ni une demande d’effacement de toutes les données détenues par le service.")
                }
                Section("Dictée, lecture et raccourcis") {
                    Text("La dictée exige la reconnaissance sur l’appareil : l’app ne transmet pas l’enregistrement audio à MultiVibe. Vérifiez le texte avant d’appuyer sur Envoyer. La lecture vocale utilise la synthèse vocale du système.")
                    Text("La conversation vocale transmet temporairement le son au moteur vocal indiqué afin de répondre en direct. MultiVibe conserve uniquement les transcriptions finales dans le fil ; l’audio et les transcriptions partielles ne sont pas enregistrés.")
                    Text("Les raccourcis préparent une action dans l’app au premier plan. Ils n’envoient pas automatiquement votre brouillon. Partager un message utilise la feuille de partage iOS ; vous choisissez sa destination.")
                    Text("Les suggestions personnalisées restent sur cet iPhone. Une suggestion configurée avec le presse-papiers le lit uniquement lorsque vous touchez ce bouton ; iOS peut alors demander votre autorisation de coller.")
                }
                Section("Documents du service") {
                    if let configuration, configuration.hasValidDocuments,
                       let privacy = configuration.privacyUrl, let terms = configuration.termsUrl {
                        Link("Politique de confidentialité", destination: privacy)
                        Link("Conditions d’utilisation", destination: terms)
                    } else {
                        Text(failed ? "Les documents sont indisponibles. Réessayez avec une connexion réseau." : "Chargement des liens officiels du service…")
                        if loading { ProgressView() }
                        Button("Réessayer") { Task { await load() } }.disabled(loading)
                    }
                }
            }
            .scrollContentBackground(.hidden).background(MultiVibeTheme.softAccent.ignoresSafeArea())
            .navigationTitle("Confidentialité")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Terminé") { dismiss() } } }
            .task { await load() }
        }
    }
    private func load() async {
        guard !loading else { return }
        loading = true; failed = false
        defer { loading = false }
        do {
            let value = try await ChatAPI.shared.authenticationConfiguration()
            guard !Task.isCancelled else { return }
            configuration = value; failed = !value.hasValidDocuments
        } catch { if !Task.isCancelled { failed = true } }
    }
}


/// System text and controls only: no HTML, remote images or embedded browser.
struct NativeMessageContent: View {
    let content: String
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(OpenUIPresentation.segments(content).enumerated()), id: \.offset) { _, segment in
                if segment.ui, let html = OpenUIPresentation.html {
                    OfflineOpenUIView(content: segment.text, streaming: segment.streaming, html: html)
                } else { MarkdownMessageContent(content: segment.text) }
            }
        }
    }
}

private struct OfflineOpenUIView: View {
    let content: String
    let streaming: Bool
    let html: String
    @State private var height: CGFloat = 120
    var body: some View {
        OfflineOpenUIWebView(content: content, streaming: streaming, html: html, height: $height)
            .frame(height: height)
    }
}

/// A local, nonpersistent presentation sandbox. No model HTML or remote scripts.
private struct OfflineOpenUIWebView: UIViewRepresentable {
    let content: String
    let streaming: Bool
    let html: String
    @Binding var height: CGFloat
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(context.coordinator, name: "openuiHeight")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false; view.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.loadHTMLString(html, baseURL: nil)
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.ready { context.coordinator.render(view) }
    }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "openuiHeight")
        view.navigationDelegate = nil; view.stopLoading()
    }
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: OfflineOpenUIWebView
        var ready = false
        init(_ parent: OfflineOpenUIWebView) { self.parent = parent }
        func render(_ view: WKWebView) {
            // Arguments cross as data, never interpolated executable JavaScript.
            Task { @MainActor in
                _ = try? await view.callAsyncJavaScript("window.renderOpenUI(text, streaming)",
                    arguments: ["text": parent.content, "streaming": parent.streaming],
                    in: nil, contentWorld: .page)
            }
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { ready = true; render(webView) }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "openuiHeight", let number = message.body as? NSNumber else { return }
            let value = number.doubleValue
            guard value.isFinite, value > 0 else { return }
            parent.height = CGFloat(min(value, 1500))
            message.webView?.scrollView.isScrollEnabled = value > 1500
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(action.request.url?.absoluteString == "about:blank" && action.navigationType == .other ? .allow : .cancel)
        }
    }
}

private struct MarkdownMessageContent: View {
    let content: String
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(MessageBlock.parse(content).enumerated()), id: \.offset) { _, block in
                switch block {
                case .prose(let text):
                    Text(MessageBlock.inline(text)).textSelection(.enabled)
                case .heading(let text, let level):
                    Text(MessageBlock.inline(text))
                        .font(level <= 2 ? .title3 : .headline)
                        .accessibilityAddTraits(.isHeader).textSelection(.enabled)
                case .bullet(let text):
                    HStack(alignment: .firstTextBaseline) {
                        Text("•").accessibilityHidden(true)
                        Text(MessageBlock.inline(text)).textSelection(.enabled)
                    }
                case .checklist(let text, let checked):
                    Label { Text(MessageBlock.inline(text)).textSelection(.enabled) } icon: {
                        Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(checked ? MultiVibeTheme.accent : .secondary)
                    }
                case .quote(let text):
                    Text(MessageBlock.inline(text)).italic().textSelection(.enabled)
                        .padding(.leading, 12).overlay(alignment: .leading) {
                            Capsule().fill(MultiVibeTheme.accent).frame(width: 3)
                        }
                case .table(let rows):
                    MarkdownTable(rows: rows)
                case .code(let text, let language):
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(language.isEmpty ? "Code" : language).font(.caption)
                            Spacer()
                            Button("Copier le code", systemImage: "doc.on.doc") {
                                UIPasteboard.general.setItems([["public.utf8-plain-text": text]],
                                    options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(300)])
                            }.font(.caption)
                        }
                        ScrollView(.horizontal) {
                            Text(verbatim: text).font(.system(.body, design: .monospaced))
                                .textSelection(.enabled).fixedSize(horizontal: true, vertical: false)
                        }
                    }.padding().background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
    }
}

private struct MarkdownTable: View {
    let rows: [[String]]
    private var columnCount: Int { max(rows.map(\.count).max() ?? 0, 1) }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            table.fixedSize(horizontal: true, vertical: false)
            ScrollView(.horizontal) { table }
                .scrollIndicators(.hidden)
        }
    }

    private var table: some View {
        Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { row, cells in
                GridRow(alignment: .firstTextBaseline) {
                    ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                        Text(MessageBlock.inline(cell))
                            .font(.subheadline)
                            .fontWeight(row == 0 ? .semibold : .regular)
                            .padding(.vertical, row == 0 ? 7 : 8)
                            .textSelection(.enabled)
                    }
                }
                if row < rows.count - 1 {
                    Divider().gridCellColumns(columnCount)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
        .background(Color(uiColor: .secondarySystemBackground),
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}

struct NativeContentView: View {
    let payload: NativeContentPayload
    var body: some View {
        VStack(spacing: 12) {
            ForEach(payload.blocks) { block in
                switch block {
                case .agenda(let title, let events): AgendaCard(title: title, events: events)
                case .reminders(let title, let items): RemindersCard(title: title, items: items)
                case .contacts(let title, let items): ContactsCard(title: title, items: items)
                case .location(let location): LocationCard(location: location)
                case .web(let source): WebSourceCard(source: source)
                case .document(let document): DocumentResultCard(document: document)
                }
            }
        }
    }
}

private struct EditorialCard<Content: View>: View {
    let icon: String
    let title: String
    @ViewBuilder let content: Content
    init(icon: String, title: String, @ViewBuilder content: () -> Content) { self.icon = icon; self.title = title; self.content = content() }
    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Label(title, systemImage: icon).font(.headline).foregroundStyle(MultiVibeTheme.accent)
            content
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(MultiVibeTheme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(MultiVibeTheme.accent.opacity(0.12)))
    }
}

private struct AgendaCard: View {
    let title: String
    let events: [NativeContentBlock.CalendarEvent]
    @State private var selected: String?
    @State private var editing = false
    var grouped: [(Date, [NativeContentBlock.CalendarEvent])] {
        Dictionary(grouping: events) { Calendar.current.startOfDay(for: $0.start) }.sorted { $0.key < $1.key }
    }
    var body: some View {
        EditorialCard(icon: "calendar", title: title) {
            if events.isEmpty { ContentUnavailableView("Aucun événement", systemImage: "calendar.badge.checkmark") }
            ForEach(grouped, id: \.0) { day, items in
                Text(day.formatted(.dateTime.weekday(.wide).day().month())).font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
                ForEach(items) { event in
                    Button { selected = event.id } label: {
                        HStack(alignment: .top, spacing: 12) {
                            RoundedRectangle(cornerRadius: 2).fill(MultiVibeTheme.accent).frame(width: 4, height: 44)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(event.title).font(.body.weight(.semibold)).foregroundStyle(.primary)
                                Text(event.isAllDay ? "Toute la journée" : "\(event.start.formatted(date: .omitted, time: .shortened)) – \(event.end.formatted(date: .omitted, time: .shortened))")
                                    .font(.caption).foregroundStyle(.secondary)
                                if let location = event.location, !location.isEmpty { Label(location, systemImage: "location").font(.caption2).foregroundStyle(.secondary) }
                            }
                            Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityHint("Ouvre la fiche native de l’événement")
                }
            }
            Button("Nouvel événement", systemImage: "plus") { editing = true }.buttonStyle(.bordered)
        }
        .sheet(item: Binding(get: { selected.map(CalendarSelection.init) }, set: { selected = $0?.id })) { value in CalendarEventController(identifier: value.id) }
        .sheet(isPresented: $editing) { CalendarEditController() }
    }
    private struct CalendarSelection: Identifiable { let id: String }
}

private struct RemindersCard: View {
    let title: String
    @State var items: [NativeContentBlock.Reminder]
    @State private var editing = false
    @State private var editingItem: NativeContentBlock.Reminder?
    @State private var deletingItem: NativeContentBlock.Reminder?
    init(title: String, items: [NativeContentBlock.Reminder]) { self.title = title; _items = State(initialValue: items) }
    var body: some View {
        EditorialCard(icon: "checklist", title: title) {
            ForEach($items) { $item in
                Button {
                    item.isCompleted.toggle()
                    let newValue = item.isCompleted
                    Task { @MainActor in
                        let store = EKEventStore()
                        guard let reminder = store.calendarItem(withIdentifier: item.id) as? EKReminder else { return }
                        reminder.isCompleted = newValue
                        try? store.save(reminder, commit: true)
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                    }
                } label: {
                    HStack { Image(systemName: item.isCompleted ? "checkmark.circle.fill" : "circle").contentTransition(.symbolEffect(.replace)); VStack(alignment: .leading) { Text(item.title); Text(item.due?.formatted(date: .abbreviated, time: .shortened) ?? item.list).font(.caption).foregroundStyle(.secondary) }; Spacer() }
                }.buttonStyle(.plain).foregroundStyle(item.isCompleted ? .secondary : .primary)
                    .contextMenu {
                        Button("Modifier", systemImage: "pencil") { editingItem = item }
                        Button("Supprimer", systemImage: "trash", role: .destructive) { deletingItem = item }
                    }
            }
            Button("Nouveau rappel", systemImage: "plus") { editing = true }.buttonStyle(.bordered)
        }
        .sheet(isPresented: $editing) { ReminderEditController(item: nil) }
        .sheet(item: $editingItem) { ReminderEditController(item: $0) }
        .confirmationDialog("Supprimer ce rappel ?", isPresented: Binding(get: { deletingItem != nil }, set: { if !$0 { deletingItem = nil } }), titleVisibility: .visible) {
            Button("Supprimer", role: .destructive) {
                guard let deletingItem else { return }
                let store = EKEventStore()
                if let reminder = store.calendarItem(withIdentifier: deletingItem.id) as? EKReminder { try? store.remove(reminder, commit: true) }
                withAnimation(.snappy) { items.removeAll { $0.id == deletingItem.id } }
                self.deletingItem = nil
            }
        }
    }
}

private struct ContactsCard: View {
    let title: String; let items: [NativeContentBlock.Contact]
    @State private var selected: String?
    @State private var creating = false
    var body: some View {
        EditorialCard(icon: "person.2", title: title) {
            ForEach(items) { contact in Button { selected = contact.id } label: {
                HStack { Text(String(contact.name.prefix(1))).font(.headline).frame(width: 38, height: 38).background(MultiVibeTheme.accent.opacity(0.14), in: Circle()); VStack(alignment: .leading) { Text(contact.name).fontWeight(.semibold); Text(contact.phones.first ?? contact.emails.first ?? "Fiche contact").font(.caption).foregroundStyle(.secondary) }; Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary) }
            }.buttonStyle(.plain) }
            Button("Nouveau contact", systemImage: "person.badge.plus") { creating = true }.buttonStyle(.bordered)
        }
        .sheet(item: Binding(get: { selected.map(ContactSelection.init) }, set: { selected = $0?.id })) { ContactController(identifier: $0.id) }
        .sheet(isPresented: $creating) { ContactController(identifier: nil) }
    }
    private struct ContactSelection: Identifiable { let id: String }
}

private struct LocationCard: View {
    let location: NativeContentBlock.Location
    var coordinate: CLLocationCoordinate2D { .init(latitude: location.latitude, longitude: location.longitude) }
    var body: some View { EditorialCard(icon: "map", title: "Position") {
        Map(initialPosition: .region(.init(center: coordinate, span: .init(latitudeDelta: 0.02, longitudeDelta: 0.02)))) { Marker("Position mesurée", coordinate: coordinate) }.frame(height: 190).clipShape(RoundedRectangle(cornerRadius: 14)).allowsHitTesting(false)
        HStack { Text("Précision ±\(Int(location.accuracy)) m").font(.caption).foregroundStyle(.secondary); Spacer(); Button("Ouvrir dans Plans") { MKMapItem(placemark: .init(coordinate: coordinate)).openInMaps() } }
    }}
}

private struct WebSourceCard: View {
    let source: NativeContentBlock.WebSource
    @State private var browserPresented = false

    private var canOpenSource: Bool {
        ["http", "https"].contains(source.url.scheme?.lowercased() ?? "") && source.url.host != nil
    }

    var body: some View {
        Button { browserPresented = true } label: {
            EditorialCard(icon: "safari", title: source.url.host ?? "Source web") {
                Text(source.excerpt).font(.subheadline).lineLimit(4)
                Label("Ouvrir la source", systemImage: "safari")
                    .foregroundStyle(MultiVibeTheme.accent)
                Text("HTTP \(source.status) · \(source.contentType)")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!canOpenSource)
        .accessibilityIdentifier("openWebSource")
        .sheet(isPresented: $browserPresented) {
            InAppBrowser(url: source.url)
                .ignoresSafeArea()
        }
    }
}

private struct DocumentResultCard: View { let document: NativeContentBlock.Document; var body: some View { EditorialCard(icon: "doc.text", title: document.name) { Text(document.excerpt).font(.subheadline).lineLimit(6).textSelection(.enabled); ShareLink(item: document.excerpt) { Label("Partager l’extrait", systemImage: "square.and.arrow.up") } } } }

private struct CalendarEventController: UIViewControllerRepresentable {
    let identifier: String
    func makeUIViewController(context: Context) -> UINavigationController {
        let store = EKEventStore()
        guard let event = store.event(withIdentifier: identifier) else {
            return UINavigationController(rootViewController: UIHostingController(rootView: ContentUnavailableView("Événement indisponible", systemImage: "calendar.badge.exclamationmark", description: Text("Il a peut-être été déplacé ou supprimé dans Calendrier."))))
        }
        let controller = EKEventViewController(); controller.event = event; controller.allowsEditing = true; controller.allowsCalendarPreview = true
        return UINavigationController(rootViewController: controller)
    }
    func updateUIViewController(_ controller: UINavigationController, context: Context) {}
}
private struct CalendarEditController: UIViewControllerRepresentable {
    @Environment(\.dismiss) private var dismiss
    final class Coordinator: NSObject, EKEventEditViewDelegate { let dismiss: DismissAction; init(_ dismiss: DismissAction) { self.dismiss = dismiss }; func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) { dismiss() } }
    func makeCoordinator() -> Coordinator { Coordinator(dismiss) }
    func makeUIViewController(context: Context) -> EKEventEditViewController { let controller = EKEventEditViewController(); controller.eventStore = EKEventStore(); controller.editViewDelegate = context.coordinator; return controller }
    func updateUIViewController(_ controller: EKEventEditViewController, context: Context) {}
}
private struct ReminderEditController: UIViewControllerRepresentable {
    @Environment(\.dismiss) private var dismiss
    let item: NativeContentBlock.Reminder?
    func makeUIViewController(context: Context) -> UINavigationController { UINavigationController(rootViewController: UIHostingController(rootView: ReminderCreator(dismiss: dismiss, item: item))) }
    func updateUIViewController(_ controller: UINavigationController, context: Context) {}
}
private struct ReminderCreator: View {
    let dismiss: DismissAction
    let item: NativeContentBlock.Reminder?
    @State private var title: String
    init(dismiss: DismissAction, item: NativeContentBlock.Reminder?) { self.dismiss = dismiss; self.item = item; _title = State(initialValue: item?.title ?? "") }
    var body: some View { Form { TextField("Titre", text: $title); Button(item == nil ? "Créer" : "Enregistrer") {
        let store = EKEventStore()
        let reminder = item.flatMap { store.calendarItem(withIdentifier: $0.id) as? EKReminder } ?? EKReminder(eventStore: store)
        reminder.title = title
        if reminder.calendar == nil { reminder.calendar = store.defaultCalendarForNewReminders() }
        try? store.save(reminder, commit: true); dismiss()
    }.disabled(title.trimmingCharacters(in: .whitespaces).isEmpty) }.navigationTitle(item == nil ? "Nouveau rappel" : "Modifier le rappel").toolbar { Button("Annuler") { dismiss() } } }
}
private struct ContactController: UIViewControllerRepresentable {
    let identifier: String?
    func makeUIViewController(context: Context) -> UINavigationController {
        let controller: CNContactViewController
        if let identifier, let contact = try? CNContactStore().unifiedContact(withIdentifier: identifier, keysToFetch: [CNContactViewController.descriptorForRequiredKeys()]) { controller = CNContactViewController(for: contact); controller.allowsEditing = true; controller.allowsActions = true }
        else { controller = CNContactViewController(forNewContact: nil) }
        return UINavigationController(rootViewController: controller)
    }
    func updateUIViewController(_ controller: UINavigationController, context: Context) {}
}

private struct HarnessIdentityLogo: View {
    let id: String
    let name: String
    let size: CGFloat
    var body: some View {
        Group {
            switch id {
            case "native":
                Image("MultiVibeMark").resizable().scaledToFit().padding(size * 0.12)
            case "openai-codex":
                Image("ProviderOpenAI").resizable().renderingMode(.template).scaledToFit().padding(size * 0.2)
            case "claude-code":
                Image("ProviderAnthropic").resizable().renderingMode(.template).scaledToFit().padding(size * 0.2)
            case "gemini-cli":
                Image("ProviderGemini").resizable().renderingMode(.template).scaledToFit().padding(size * 0.2)
            case "hermes-cloud":
                Image("MultiVibeMark").resizable().scaledToFit().padding(size * 0.12)
            case "hermes-agent":
                Image("HarnessHermes").resizable().scaledToFit().padding(size * 0.12)
            case "pi":
                Image("HarnessPi").resizable().scaledToFit().padding(size * 0.16)
            case "opencode":
                Image("HarnessOpenCode").resizable().scaledToFit().padding(size * 0.18)
            case "librechat":
                Image("HarnessLibreChat").resizable().scaledToFit().padding(size * 0.14)
            case "openclaw":
                Image("HarnessOpenClaw").resizable().scaledToFit().padding(size * 0.1)
            case "goose":
                Image("HarnessGoose").resizable().scaledToFit().padding(size * 0.12)
            case "openhands":
                Image("HarnessOpenHands").resizable().scaledToFit().padding(size * 0.12)
            default:
                Text(name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased())
                    .font(.system(size: size * 0.3, weight: .bold, design: .rounded))
            }
        }
        .foregroundStyle(MultiVibeTheme.accent)
        .frame(width: size, height: size)
        .background(Color(uiColor: .secondarySystemBackground).opacity(id == "native" ? 0 : 1), in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
        .accessibilityHidden(true)
    }
}

struct ChatWelcomeView<ExecutionSelector: View>: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let suggestions: [HomeSuggestion]
    let execute: (HomeSuggestion) -> Void
    let edit: (HomeSuggestion) -> Void
    let executionSelector: ExecutionSelector
    init(suggestions: [HomeSuggestion], execute: @escaping (HomeSuggestion) -> Void,
         edit: @escaping (HomeSuggestion) -> Void, @ViewBuilder executionSelector: () -> ExecutionSelector) {
        self.suggestions = suggestions; self.execute = execute; self.edit = edit; self.executionSelector = executionSelector()
    }
    var body: some View {
        ScrollView {
            VStack(spacing: dynamicTypeSize.isAccessibilitySize ? 16 : 24) {
                Spacer(minLength: dynamicTypeSize.isAccessibilitySize ? 12 : 64)
                executionSelector
                VStack(spacing: 8) {
                    Text("Comment puis-je vous aider ?")
                        .font((dynamicTypeSize.isAccessibilitySize ? Font.headline : Font.title2).bold())
                        .accessibilityAddTraits(.isHeader)
                    Text(dynamicTypeSize.isAccessibilitySize
                        ? "Discutez, analysez et agissez."
                        : "Discutez, analysez et agissez avec le modèle de votre choix.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 20)
                Spacer(minLength: dynamicTypeSize.isAccessibilitySize ? 8 : 24)
                LazyVGrid(columns: dynamicTypeSize.isAccessibilitySize
                    ? [GridItem(.flexible())]
                    : [GridItem(.adaptive(minimum: 150, maximum: 300), spacing: 10)], spacing: 10) {
                    ForEach(suggestions) { suggestionButton($0) }
                }
                .padding(.horizontal, 20)
            }
            .frame(maxWidth: 720, minHeight: dynamicTypeSize.isAccessibilitySize ? 0 : 480)
            .padding(.bottom, 20)
            .frame(maxWidth: .infinity)
        }.scrollDismissesKeyboard(.interactively)
    }

    private func suggestionButton(_ suggestion: HomeSuggestion) -> some View {
        Button { execute(suggestion) } label: {
            HStack(spacing: 8) {
                Image(systemName: suggestion.systemImage)
                    .foregroundStyle(.primary)
                    .frame(width: 20)
                Text(suggestion.title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
            .padding(.vertical, dynamicTypeSize.isAccessibilitySize ? 8 : 0)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(.primary.opacity(0.07), lineWidth: 0.7))
            .contentShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
        .buttonStyle(.plain)
        // Recognize a hold before Button consumes it as an ordinary activation.
        .highPriorityGesture(
            LongPressGesture(minimumDuration: 0.45)
                .onEnded { _ in
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    edit(suggestion)
                }
        )
        .accessibilityAction(named: "Modifier cette suggestion") { edit(suggestion) }
    }
}

private struct SuggestionsEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var suggestions: [HomeSuggestion]
    let highlighted: UUID?
    let save: () -> Void
    @State private var editing: HomeSuggestion?
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Les suggestions et les instructions restent sur cet iPhone. Le presse-papiers n’est lu que lorsque vous touchez un bouton configuré pour l’utiliser.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Suggestions") {
                    ForEach(suggestions) { item in
                        Button { editing = item } label: {
                            HStack { Image(systemName: item.systemImage).frame(width: 28).foregroundStyle(MultiVibeTheme.accent); VStack(alignment: .leading) { Text(item.title).foregroundStyle(.primary); Text(item.instruction).font(.caption).foregroundStyle(.secondary).lineLimit(2) }; Spacer(); Image(systemName: "chevron.right").foregroundStyle(.tertiary) }
                        }
                    }
                    .onDelete { suggestions.remove(atOffsets: $0); save() }
                    .onMove { suggestions.move(fromOffsets: $0, toOffset: $1); save() }
                }
            }
            .scrollContentBackground(.hidden).background(MultiVibeTheme.softAccent.ignoresSafeArea())
            .navigationTitle("Suggestions")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Terminé") { save(); dismiss() } }
                ToolbarItemGroup(placement: .primaryAction) {
                    EditButton()
                    Button("Ajouter", systemImage: "plus") {
                        editing = .init(id: UUID(), title: "Nouvelle suggestion", systemImage: "sparkles", instruction: "", inputSource: .none, behavior: .prepare)
                    }.disabled(suggestions.count >= 12)
                }
            }
            .sheet(item: $editing) { item in
                SuggestionEditor(item: item) { updated in
                    if let index = suggestions.firstIndex(where: { $0.id == updated.id }) { suggestions[index] = updated }
                    else if suggestions.count < 12 { suggestions.append(updated) }
                    save(); editing = nil
                }
            }
            .onAppear { if let highlighted, let value = suggestions.first(where: { $0.id == highlighted }) { editing = value } }
        }
    }
}

private struct SuggestionEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var item: HomeSuggestion
    let save: (HomeSuggestion) -> Void
    var valid: Bool { !item.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !item.instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var body: some View {
        NavigationStack {
            Form {
                Section("Bouton") { TextField("Titre", text: $item.title); TextField("Icône SF Symbols", text: $item.systemImage) }
                Section("Requête") {
                    TextField("Instructions", text: $item.instruction, axis: .vertical).lineLimit(2...6)
                    Picker("Contenu ajouté", selection: $item.inputSource) { Text("Aucun").tag(HomeSuggestion.InputSource.none); Text("Presse-papiers").tag(HomeSuggestion.InputSource.clipboard) }
                    Picker("Au toucher", selection: $item.behavior) { Text("Préparer le message").tag(HomeSuggestion.Behavior.prepare); Text("Envoyer immédiatement").tag(HomeSuggestion.Behavior.send) }
                }
                if item.inputSource == .clipboard { Section { Text("La requête sera composée sous la forme « Instructions : contenu du presse-papiers ». iOS peut demander l’autorisation de coller.").font(.footnote) } }
            }
            .navigationTitle("Modifier la suggestion")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Annuler") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Enregistrer") { save(item); dismiss() }.disabled(!valid) } }
        }
    }
}

private struct SelectableMessageSheet: View {
    @Environment(\.dismiss) private var dismiss
    let message: SelectableMessage
    var body: some View {
        NavigationStack {
            ScrollView { Text(message.text).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled).padding(20) }
                .navigationTitle("Sélectionner le texte")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Terminé") { dismiss() } }
                    ToolbarItem(placement: .primaryAction) { Button("Copier tout", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text } }
                }
        }
    }
}


struct LocalDocumentsView: View {
    @Environment(ConversationManager.self) private var manager
    @Environment(\.dismiss) private var dismiss
    @State private var importing = false
    @State private var failure: String?
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Ces fichiers sont disponibles hors ligne pour Apple Foundation Local. Importez un fichier texte de 100 Ko maximum. Les documents restent sur cet appareil.")
                    Button("Importer un document texte", systemImage: "square.and.arrow.down") { importing = true }
                        .disabled(manager.isStreaming)
                    if let failure { MultiVibeStatusMessage(message: failure) }
                }
                Section("Données de l’iPhone") {
                    Text("Le modèle local consulte ces données à votre demande. Les cartes interactives restent sur cet appareil ; seul leur résumé textuel fait partie de l’historique synchronisé.")
                    Text("L’agent demande la permission iOS lorsqu’une requête nécessite le calendrier, les rappels, les contacts ou la position. Les autorisations se gèrent dans Réglages iOS. Apple Mail ne permet pas la lecture de la boîte : importez le message dans les documents.").font(.footnote)
                    Button("Ouvrir les autorisations iOS") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }.disabled(manager.isStreaming)
                ForEach(manager.localDocuments) { document in
                    NavigationLink(document.name) {
                        ScrollView { Text(document.text).textSelection(.enabled).padding() }
                            .navigationTitle(document.name)
                            .toolbar { ShareLink(item: document.text) { Label("Partager", systemImage: "square.and.arrow.up") } }
                    }
                }
                if manager.localDocuments.isEmpty {
                    ContentUnavailableView("Aucun document importé", systemImage: "doc.text",
                        description: Text("Importez un fichier texte pour que le modèle local puisse le consulter."))
                }
            }
            .scrollContentBackground(.hidden).background(MultiVibeTheme.softAccent.ignoresSafeArea())
            .navigationTitle("Documents et outils")
            .toolbar { Button("Terminé") { dismiss() } }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.plainText]) { result in
                do {
                    let url = try result.get()
                    let granted = url.startAccessingSecurityScopedResource()
                    defer { if granted { url.stopAccessingSecurityScopedResource() } }
                    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard size <= 100_000 else { throw LocalAgentError.invalidInput }
                    let data = try Data(contentsOf: url)
                    guard data.count <= 100_000, let text = String(data: data, encoding: .utf8) else { throw LocalAgentError.invalidInput }
                    try manager.importDocument(name: url.lastPathComponent, text: text)
                } catch { failure = error.localizedDescription }
            }
        }
    }
}

private struct AgentThinkingGlow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        GeometryReader { proxy in
            let inset = 3.0
            let rect = CGRect(origin: .zero, size: proxy.size).insetBy(dx: inset, dy: inset)
            let shortSide = min(rect.width, rect.height)
            let radius = min(61.0, max(41.0, shortSide * 0.13))
            let path = RoundedRectangle(cornerRadius: radius, style: .continuous).path(in: rect)

            ZStack {
                path.stroke(MultiVibeTheme.accent.opacity(0.16), lineWidth: 2)

                TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: reduceMotion)) { timeline in
                    let time = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
                    Canvas(opaque: false, colorMode: .linear, rendersAsynchronously: true) { context, _ in
                        // Only a short dash is redrawn. The previous implementation re-rendered
                        // three full-screen angular gradients and large blurs on every frame.
                        let perimeter = max(1, 2 * (rect.width + rect.height) - 8 * radius + 2 * CGFloat.pi * radius)
                        let travel = CGFloat(time.truncatingRemainder(dividingBy: 4) / 4)
                        let phase = -travel * perimeter
                        let segment = perimeter * 0.20
                        let gap = perimeter - segment
                        let segmentStyle = StrokeStyle(lineWidth: reduceTransparency ? 6 : 5, lineCap: .round,
                            lineJoin: .round, dash: [segment, gap], dashPhase: phase)

                        if !reduceTransparency {
                            context.drawLayer { glow in
                                glow.addFilter(.blur(radius: 9))
                                glow.stroke(path, with: .color(MultiVibeTheme.accent.opacity(0.82)),
                                    style: StrokeStyle(lineWidth: 18, lineCap: .round, lineJoin: .round,
                                        dash: [segment, gap], dashPhase: phase))
                            }
                        }

                        context.stroke(path, with: .color(MultiVibeTheme.accent), style: segmentStyle)
                        context.stroke(path, with: .color(MultiVibeTheme.warmAccent),
                            style: StrokeStyle(lineWidth: reduceTransparency ? 5 : 4, lineCap: .round,
                                lineJoin: .round, dash: [perimeter * 0.035, perimeter * 0.965],
                                dashPhase: phase - segment * 0.78))
                    }
                }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}


struct InternetPermissionView: View {
    @Environment(ConversationManager.self) private var manager
    let request: InternetApprovalRequest
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                Label("Autoriser l’accès à Internet ?", systemImage: "network").font(.title2.bold())
                Text("L’agent souhaite consulter \(request.url.host ?? "un site web").")
                Text("Les sites contactés recevront votre adresse IP et les URL demandées. Le modèle continue de fonctionner sur cet iPhone.")
                Text("Votre choix est mémorisé pour cette conversation, y compris pour les autres sites demandés. Il ne change pas la synchronisation de l’historique.").foregroundStyle(.secondary)
                Button("Autoriser pour cette conversation") { manager.resolveInternetApproval(allow: true) }
                    .buttonStyle(.borderedProminent).accessibilityIdentifier("allowConversationInternet")
                Button("Rester hors ligne") { manager.resolveInternetApproval(allow: false) }
                    .buttonStyle(.bordered).accessibilityIdentifier("denyConversationInternet")
                Button("Arrêter la demande", role: .cancel) { manager.stop() }
                Spacer()
            }.padding().navigationTitle("Accès Internet").navigationBarTitleDisplayMode(.inline)
        }.presentationDetents([.large])
    }
}

private struct SidebarShortcutLabel: View {
    let title: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.title3.weight(.medium))
                .foregroundStyle(.primary)
                .frame(width: 24, height: 28)
                .accessibilityHidden(true)
            Text(title)
                .font(.body.weight(.medium))
                .foregroundStyle(.primary)
            Spacer(minLength: 0)
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
    }
}


private struct CloudBillingView: View {
    let accountId: String
    @Environment(ConversationManager.self) private var manager
    @Environment(\.dismiss) private var dismiss
    @State private var cookie: HTTPCookie?
    @State private var error: String?
    @State private var attempt = UUID()
    @State private var loading = true

    var body: some View {
        NavigationStack {
            ZStack {
                if let cookie {
                    CloudBillingWebView(cookie: cookie, loading: $loading, error: $error)
                        .id(attempt)
                }
                if let error {
                    ContentUnavailableView {
                        Label("Page indisponible", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Réessayer") { cookie = nil; self.error = nil; attempt = UUID() }
                    }
                    .background(.background)
                } else if loading {
                    ProgressView("Ouverture de MultiVibe Cloud…")
                        .padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .navigationTitle("MultiVibe Cloud")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Fermer") { dismiss() } }
            }
            .task(id: attempt) {
                loading = true
                do {
                    let session = try await manager.validSession()
                    guard session.accountId == accountId else { throw CancellationError() }
                    let browserSession = try await ChatAPI.shared.billingSession(token: session.accessToken)
                    try Task.checkCancellation()
                    guard manager.session?.accountId == accountId else { return }
                    cookie = try browserSession.cookie()
                } catch {
                    guard !Task.isCancelled else { return }
                    self.error = "Impossible d’ouvrir la page de recharge. Réessayez dans un instant."
                    loading = false
                }
            }
        }
    }
}

/// Billing uses an isolated, temporary website session. The native bearer and
/// refresh token are never passed to WebKit, JavaScript, or a navigation URL.
private struct CloudBillingWebView: UIViewRepresentable {
    let cookie: HTTPCookie
    @Binding var loading: Bool
    @Binding var error: String?

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        context.coordinator.preparation = Task { @MainActor in
            await configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
            guard !Task.isCancelled else { return }
            webView.load(URLRequest(url: CloudBillingSession.pageURL))
        }
        return webView
    }
    func updateUIView(_ webView: WKWebView, context: Context) { context.coordinator.parent = self }
    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.preparation?.cancel()
        webView.stopLoading()
        webView.navigationDelegate = nil
    }
    @MainActor final class Coordinator: NSObject, WKNavigationDelegate {
        var parent: CloudBillingWebView
        var preparation: Task<Void, Never>?
        init(_ parent: CloudBillingWebView) { self.parent = parent }
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { parent.loading = true }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { parent.loading = false }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
        private func failed(_ error: Error) {
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            parent.loading = false
            parent.error = "La page n’a pas pu être chargée. Vérifiez votre connexion et réessayez."
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url, url.scheme == "https",
                  url.user == nil, url.password == nil else { decisionHandler(.cancel); return }
            if navigationAction.targetFrame == nil {
                decisionHandler(.cancel)
                webView.load(navigationAction.request)
            } else {
                decisionHandler(.allow)
            }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse,
               response.statusCode >= 400 {
                parent.loading = false
                parent.error = "La page de recharge est temporairement indisponible."
                decisionHandler(.cancel)
            } else { decisionHandler(.allow) }
        }
    }
}


private struct AccountProfileView: View {
    let close: () -> Void
    let authenticate: () -> Void

    @Environment(ConversationManager.self) private var manager
    @Environment(\.scenePhase) private var scenePhase
    @State private var profile: NativeAccountProfile?
    @State private var balance: CloudCreditBalance?
    @State private var loadingProfile = false
    @State private var loadingBalance = false
    @State private var profileFailed = false
    @State private var balanceFailed = false
    @State private var billingPresented = false
    @State private var legacyArchivesPresented = false
    @State private var remoteInstancesPresented = false

    private var isSignedIn: Bool { manager.session != nil }
    private var email: String? { profile?.email }
    private var displayName: String {
        guard let email, let prefix = email.split(separator: "@").first, !prefix.isEmpty else {
            return isSignedIn ? "Votre compte" : "Bienvenue"
        }
        return String(prefix).replacingOccurrences(of: ".", with: " ").capitalized
    }
    private var initials: String {
        let words = displayName.split(separator: " ").prefix(2)
        let value = words.compactMap(\.first).map(String.init).joined()
        return value.isEmpty ? "M" : value.uppercased()
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    profileHeader

                    if isSignedIn {
                        accountGroup
                        cloudGroup
                    } else {
                        guestGroup
                    }

                    Button { remoteInstancesPresented = true } label: {
                        AccountSettingsRow(icon: "desktopcomputer.and.iphone", title: "Instances", showsChevron: true)
                    }.buttonStyle(.plain).accessibilityIdentifier("openRemoteInstances")

                    sessionAction
                }
                .padding(.horizontal, 20)
                .padding(.top, 32)
                .padding(.bottom, 44)
            }
            .background(MultiVibeTheme.softAccent.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: close) {
                        Image(systemName: "xmark")
                            .font(.title2.weight(.medium))
                            .frame(width: 46, height: 46)
                            .background(.thinMaterial, in: Circle())
                            .overlay(Circle().stroke(.primary.opacity(0.08)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Fermer")
                }
            }
            .task(id: reloadKey) { await reload() }
            .sheet(isPresented: $billingPresented, onDismiss: { Task { await reloadBalance() } }) {
                if let accountId = manager.session?.accountId {
                    CloudBillingView(accountId: accountId)
                }
            }
            .sheet(isPresented: $legacyArchivesPresented) {
                if let accountId = manager.session?.accountId {
                    LegacyArchivesConsentView(accountID: accountId).id(accountId)
                }
            }
            .sheet(isPresented: $remoteInstancesPresented) { RemoteInstancesView().environment(manager) }
        }
    }

    private var reloadKey: String { (manager.session?.accountId ?? "guest") + "-" + String(describing: scenePhase) }

    private var profileHeader: some View {
        VStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(LinearGradient(colors: [MultiVibeTheme.accent, MultiVibeTheme.accent.opacity(0.62)], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 92, height: 92)
                    .shadow(color: MultiVibeTheme.accent.opacity(0.18), radius: 18, y: 8)
                Text(initials)
                    .font(.title.bold())
                    .foregroundStyle(.white)
            }
            .accessibilityHidden(true)

            Text(displayName)
                .font(.title2.bold())
            Text(isSignedIn ? (email ?? "Compte MultiVibe") : "Utilisez MultiVibe sans compte ou connectez-vous pour synchroniser vos données.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 16)
    }

    private var accountGroup: some View {
        AccountSettingsGroup(title: "Compte") {
            AccountSettingsRow(icon: "envelope", title: "E-mail", value: loadingProfile ? nil : (email ?? "Indisponible"), loading: loadingProfile)
                .accessibilityIdentifier("accountEmail")
            ForEach(profile?.teams ?? []) { team in
                AccountSettingsDivider()
                AccountSettingsRow(icon: "person.2", title: "Équipe", value: team.name)
                    .accessibilityIdentifier("accountTeam")
            }
            if profileFailed {
                AccountSettingsDivider()
                Button("Réessayer le chargement du compte", systemImage: "arrow.clockwise") {
                    Task { await reloadProfile() }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
            }
        }
    }

    private var cloudGroup: some View {
        AccountSettingsGroup(title: "MultiVibe Cloud") {
            if let accountId = manager.session?.accountId {
                NavigationLink {
                    CloudUsageView(accountId: accountId, initialBalance: balance).id(accountId)
                } label: {
                    AccountSettingsRow(
                        icon: "gauge.with.dots.needle.50percent",
                        title: "Crédits disponibles",
                        value: balance?.formatted ?? (balanceFailed ? "Indisponible" : nil),
                        loading: loadingBalance,
                        showsChevron: true
                    )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("cloudCreditBalance")
                .accessibilityHint("Afficher les graphiques et le détail de votre usage Cloud")
            }
            AccountSettingsDivider()
            RelayAccountRow().id(manager.session?.accountId)
            AccountSettingsDivider()
            Button {
                billingPresented = true
            } label: {
                AccountSettingsRow(icon: "plus.circle", title: "Recharger ou s’abonner", showsChevron: true)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("openCloudBilling")
            AccountSettingsDivider()
            Button { legacyArchivesPresented = true } label: {
                AccountSettingsRow(icon: "archivebox", title: "Archives de cet appareil", showsChevron: true)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("openLegacyArchivesConsent")
            if balanceFailed {
                AccountSettingsDivider()
                Button("Réessayer le chargement du solde", systemImage: "arrow.clockwise") {
                    Task { await reloadBalance() }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
            }
        }
    }

    private var guestGroup: some View {
        AccountSettingsGroup(title: "Compte") {
            AccountSettingsRow(icon: "person.crop.circle", title: "Statut", value: "Invité")
            AccountSettingsDivider()
            AccountSettingsRow(icon: "iphone", title: "Données", value: "Sur cet appareil")
        }
    }

    @ViewBuilder private var sessionAction: some View {
        if isSignedIn {
            Button(role: .destructive) {
                close()
                Task { await manager.logout() }
            } label: {
                Text("Se déconnecter")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 54)
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.roundedRectangle(radius: 22))
            .accessibilityIdentifier("signOut")
            .disabled(manager.isRestoring)
        } else {
            Button(action: authenticate) {
                Text("Se connecter")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 54)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.roundedRectangle(radius: 22))
            .accessibilityIdentifier("openAuthentication")
            .disabled(manager.isRestoring)
        }
    }

    @MainActor private func reload() async {
        guard scenePhase == .active, manager.session != nil else { return }
        async let profileTask: Void = reloadProfile()
        async let balanceTask: Void = reloadBalance()
        _ = await (profileTask, balanceTask)
    }

    @MainActor private func reloadProfile() async {
        guard let accountId = manager.session?.accountId else { return }
        loadingProfile = true
        profileFailed = false
        do {
            let session = try await manager.validSession()
            guard session.accountId == accountId else { throw CancellationError() }
            let result = try await ChatAPI.shared.accountProfile(token: session.accessToken)
            try Task.checkCancellation()
            guard manager.session?.accountId == accountId, result.accountId == accountId else { throw APIError.invalidResponse }
            profile = result
        } catch {
            guard !Task.isCancelled, manager.session?.accountId == accountId else { return }
            profileFailed = true
        }
        loadingProfile = false
    }

    @MainActor private func reloadBalance() async {
        guard let accountId = manager.session?.accountId else { return }
        loadingBalance = true
        balanceFailed = false
        do {
            let session = try await manager.validSession()
            guard session.accountId == accountId else { throw CancellationError() }
            let result = try await ChatAPI.shared.creditBalance(token: session.accessToken)
            try Task.checkCancellation()
            guard manager.session?.accountId == accountId else { return }
            balance = result
        } catch {
            guard !Task.isCancelled, manager.session?.accountId == accountId else { return }
            balanceFailed = true
        }
        loadingBalance = false
    }
}

private struct AccountSettingsGroup<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.title3.bold())
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
            VStack(spacing: 0) { content }
                .background(MultiVibeTheme.card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).stroke(.primary.opacity(0.04)))
        }
    }
}

private struct AccountSettingsRow: View {
    let icon: String
    let title: String
    var value: String? = nil
    var loading = false
    var showsChevron = false

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.body.weight(.medium))
                .frame(width: 26)
                .foregroundStyle(.primary)
            Text(title)
                .foregroundStyle(.primary)
            Spacer(minLength: 12)
            if loading {
                ProgressView().accessibilityLabel("Chargement")
            } else if let value {
                Text(value)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.trailing)
            }
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.caption.bold())
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(minHeight: 60)
        .padding(.horizontal, 16)
        .contentShape(Rectangle())
    }
}

private struct AccountSettingsDivider: View {
    var body: some View {
        Divider().padding(.leading, 56)
    }
}

private struct ProviderSetup: Identifiable {
    let id = UUID()
    let provider: String
    let name: String
    let method: String
    var replacing: String?
}

private struct ModelAccessView: View {
    let model: ModelOption
    @Environment(ConversationManager.self) private var manager
    @State private var reply: ModelAccessReply?
    @State private var error: String?
    @State private var loading = false
    @State private var setup: ProviderSetup?
    @State private var billing = false
    var body: some View {
        List {
            Section {
                Text(reply?.model.displayName ?? model.displayName).font(.title2.bold())
                if let notice = manager.accessNotice { Text(notice).font(.callout).foregroundStyle(.secondary) }
            }
            Section("Choisir un mode d’accès") {
                ForEach(reply?.data ?? []) { option in
                    Button {
                        if option.state == "connect" { setup = .init(provider: option.provider, name: option.label, method: option.method) }
                        else { Task { await select(option) } }
                    } label: {
                        HStack {
                            Image(systemName: option.method == "cloud" ? "cloud" : option.method == "api_key" ? "key" : "person.crop.circle")
                            VStack(alignment: .leading, spacing: 4) {
                                Text(option.label).foregroundStyle(.primary)
                                Text(option.billing).font(.caption).foregroundStyle(.secondary)
                                Text(option.state == "ready" ? "Utiliser" : option.state == "connect" ? "Connecter · accès au modèle à vérifier" : "Indisponible actuellement").font(.caption)
                            }
                            Spacer(); Image(systemName: "chevron.right")
                        }.padding(.vertical, 6)
                    }.disabled(loading || option.state == "unavailable")
                }
            }
            if let error { Section { Text(error).foregroundStyle(.red); Button("Réessayer") { Task { await load() } } } }
            Section { Button("Recharger les crédits MultiVibe") { billing = true } }
            if loading { ProgressView() }
        }
        .navigationTitle("Mode d’accès").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Fermer") { manager.requestedAccessModel = nil } } }
        .task { await load() }
        .sheet(item: $setup) { value in
            NavigationStack { ProviderConnectView(setup: value) { connectionID in
                setup = nil
                Task {
                    await load()
                    if let option = reply?.data.first(where: { $0.connectionId == connectionID && $0.state == "ready" }) { await select(option) }
                    else { error = "Compte connecté, mais ce modèle n’est pas accessible avec ce compte. Choisissez un autre accès." }
                }
            } }
        }
        .sheet(isPresented: $billing, onDismiss: { Task { await load() } }) {
            if let id = manager.session?.accountId { CloudBillingView(accountId: id) }
        }
    }
    private func load() async {
        loading = true; defer { loading = false }
        do { let token = try await manager.validSession().accessToken; reply = try await ChatAPI.shared.modelAccess(model: model.id, token: token); error = nil }
        catch { self.error = error.localizedDescription }
    }
    private func select(_ option: ModelAccessOption) async {
        loading = true; defer { loading = false }
        let account = manager.session?.accountId
        do {
            let token = try await manager.validSession().accessToken
            try await ChatAPI.shared.saveModelAccess(option.selection, token: token)
            guard manager.session?.accountId == account else { return }
            manager.applyAccess(option.selection)
        } catch { self.error = error.localizedDescription }
    }
}

private struct ProviderConnectionsView: View {
    @Environment(ConversationManager.self) private var manager
    @State private var capabilities: [ProviderCapability] = []
    @State private var connections: [ProviderConnection] = []
    @State private var setup: ProviderSetup?
    @State private var addingProvider = false
    @State private var error: String?
    @State private var removing: ProviderConnection?
    var body: some View {
        List {
            Section("Mes connexions") {
                if connections.isEmpty { Text("Connectez un compte ou une clé API pour retrouver vos modèles sur vos appareils.").foregroundStyle(.secondary) }
                ForEach(connections) { connection in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(connection.displayName).font(.headline)
                        Text("\(connection.provider) · \(connection.models.count) modèles · \(connection.state == "connected" ? "Connecté" : "En attente")").font(.caption)
                        HStack {
                            Button("Reconnecter") { setup = .init(provider: connection.provider, name: connection.displayName, method: connection.authenticationMethod, replacing: connection.id) }
                            Spacer()
                            Button("Déconnecter", role: .destructive) { removing = connection }
                        }.buttonStyle(.borderless)
                    }.padding(.vertical, 5)
                }
            }
            Section {
                Button { addingProvider = true } label: {
                    Label("Ajouter une connexion", systemImage: "plus.circle.fill")
                        .font(.headline)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 6)
                }
            } footer: {
                Text("Choisissez d’abord un fournisseur, puis la manière de connecter votre compte.")
            }
            if let error { Section { Text(error).foregroundStyle(.red); Button("Réessayer") { Task { await load() } } } }
        }
        .task { await load() }.refreshable { await load() }
        .sheet(item: $setup) { value in NavigationStack { ProviderConnectView(setup: value) { _ in setup = nil; Task { await load() } } } }
        .sheet(isPresented: $addingProvider) {
            ProviderOnboardingView(capabilities: capabilities) { _ in
                addingProvider = false
                Task { await load() }
            }
        }
        .confirmationDialog("Déconnecter ce compte ?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            Button("Déconnecter", role: .destructive) {
                guard let connection = removing else { return }; removing = nil
                Task {
                    do { let token = try await manager.validSession().accessToken; let _: [String: Bool] = try await ChatAPI.shared.providerRequest("providers/\(connection.id)/disconnect", fields: [:], token: token); await load() }
                    catch { self.error = error.localizedDescription }
                }
            }
        } message: { Text("Les conversations sont conservées. Cet accès ne pourra plus envoyer de messages.") }
    }
    private func load() async {
        do {
            let token = try await manager.validSession().accessToken
            let caps: ProviderCapabilities = try await ChatAPI.shared.providerRequest("providers/capabilities", token: token)
            let list: ProviderConnections = try await ChatAPI.shared.providerRequest("providers", token: token)
            capabilities = caps.providers; connections = list.data; error = nil
        } catch { self.error = error.localizedDescription }
    }
}

private struct ProviderOnboardingView: View {
    let capabilities: [ProviderCapability]
    let connected: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Choisissez votre fournisseur")
                            .font(.title2.bold())
                        Text("Vous choisirez ensuite une méthode de connexion proposée par ce fournisseur.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                    .accessibilityElement(children: .combine)
                }

                Section("Fournisseurs disponibles") {
                    ForEach(capabilities) { provider in
                        NavigationLink {
                            ProviderMethodView(provider: provider, connected: connected)
                        } label: {
                            HStack(spacing: 14) {
                                Text(providerInitials(provider.name))
                                    .font(.headline)
                                    .foregroundStyle(.tint)
                                    .frame(width: 42, height: 42)
                                    .background(.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                                    .accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(provider.name).font(.headline)
                                    Text(methodSummary(provider.authenticationMethods))
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 5)
                        }
                    }
                }
            }
            .navigationTitle("Nouvelle connexion")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Annuler") { dismiss() } } }
        }
    }

    private func providerInitials(_ name: String) -> String {
        name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }

    private func methodSummary(_ methods: [String]) -> String {
        methods.map { $0 == "api_key" ? "Clé API" : "Abonnement" }.joined(separator: " et ")
    }
}

private struct ProviderMethodView: View {
    let provider: ProviderCapability
    let connected: (String) -> Void

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(provider.name).font(.title2.bold())
                    Text("Comment souhaitez-vous accéder aux modèles de ce fournisseur ?")
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 8)
                .accessibilityElement(children: .combine)
            }

            Section("Méthodes disponibles") {
                ForEach(provider.authenticationMethods, id: \.self) { method in
                    NavigationLink {
                        ProviderConnectView(
                            setup: .init(provider: provider.id, name: provider.name, method: method),
                            connected: connected
                        )
                    } label: {
                        HStack(alignment: .top, spacing: 14) {
                            Image(systemName: method == "api_key" ? "key.fill" : "person.crop.circle.fill")
                                .font(.title2)
                                .foregroundStyle(.tint)
                                .frame(width: 34)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 5) {
                                Text(method == "api_key" ? "Utiliser une clé API" : "Connecter mon abonnement")
                                    .font(.headline)
                                Text(method == "api_key"
                                     ? "Vos usages sont facturés directement par le fournisseur."
                                     : "Utilise votre compte fournisseur pour les modèles compatibles.")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 7)
                    }
                }
            }

            Section {
                Label("Vos identifiants sont enregistrés dans le coffre sécurisé de votre compte MultiVibe.", systemImage: "lock.shield")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Mode de connexion")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct InAppBrowser: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
private struct ProviderConnectView: View {
    let setup: ProviderSetup
    let connected: (String) -> Void
    @Environment(ConversationManager.self) private var manager
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @State private var name = ""
    @State private var key = ""
    @State private var challenge: ProviderChallenge?
    @State private var browser = false
    @State private var busy = false
    @State private var error: String?
    @State private var polling: Task<Void, Never>?
    @State private var accountID: String?
    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(setup.method == "api_key" ? "Connecter une clé API" : "Connecter un abonnement")
                        .font(.title2.bold())
                    Text(setup.name).font(.headline).foregroundStyle(.tint)
                    Text(setup.method == "api_key"
                         ? "Donnez un nom à cette connexion, puis saisissez la clé fournie par \(setup.name)."
                         : "Donnez un nom à cette connexion. Un code vous permettra ensuite de l’autoriser sur le site de \(setup.name).")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 6)
                .accessibilityElement(children: .combine)
            }
            Section("Votre connexion") {
                TextField("Nom de la connexion", text: $name).disabled(challenge != nil || busy)
                if setup.method == "api_key" {
                    SecureField("Clé API", text: $key).textInputAutocapitalization(.never).autocorrectionDisabled().disabled(busy)
                    Text("La clé est envoyée au coffre sécurisé MultiVibe. Elle n’est pas conservée sur cet iPhone.").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let challenge {
                Section("Autoriser la connexion") {
                    Text(challenge.userCode).font(.title.monospaced()).textSelection(.enabled)
                    Button("Copier le code") { UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: challenge.userCode]], options: [.localOnly: true, .expirationDate: challenge.expiry]) }
                    Button("Ouvrir la page du provider") { browser = true }
                    Text("Valable jusqu’à \(challenge.expiry.formatted(date: .omitted, time: .shortened))").font(.caption)
                    ProgressView("En attente d’autorisation…")
                    if error != nil { Button("Vérifier la connexion") { error = nil; beginPolling(challenge) } }
                }
            } else {
                Section {
                    Button(setup.method == "api_key" ? "Valider la clé et connecter" : "Continuer avec \(setup.name)") { Task { await start() } }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .frame(maxWidth: .infinity)
                        .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (setup.method == "api_key" && key.isEmpty))
                }
            }
            if busy { ProgressView() }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }
        .navigationTitle("Configurer").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Annuler") { Task { await cancel(); dismiss() } } } }
        .interactiveDismissDisabled(busy || challenge != nil)
        .onAppear { name = setup.name; accountID = manager.session?.accountId }
        .onDisappear { key = ""; polling?.cancel(); if let challenge { Task { await cancelFlow(challenge) } } }
        .onChange(of: phase) { _, value in if value == .active, let challenge { beginPolling(challenge) } else if value == .background { polling?.cancel() } }
        .sheet(isPresented: $browser) { if let challenge { InAppBrowser(url: challenge.verificationUrl) } }
    }
    private func start() async {
        busy = true; error = nil; defer { busy = false; key = "" }
        do {
            let token = try await manager.validSession().accessToken
            if setup.method == "api_key" {
                let connection: ProviderConnection = try await ChatAPI.shared.providerRequest("providers", fields: ["provider": setup.provider, "displayName": name, "apiKey": key], token: token)
                try await finish(connection.id)
            } else {
                let value: ProviderChallenge = try await ChatAPI.shared.providerRequest("providers/device/start", fields: ["provider": setup.provider, "displayName": name], token: token)
                guard value.verificationUrl.scheme == "https", value.verificationUrl.user == nil, value.verificationUrl.password == nil else { throw APIError.invalidResponse }
                challenge = value; browser = true; beginPolling(value)
            }
        } catch { self.error = error.localizedDescription }
    }
    private func beginPolling(_ value: ProviderChallenge) {
        polling?.cancel()
        polling = Task {
            var interval = value.intervalSeconds
            do {
                while Date() < value.expiry {
                    try await Task.sleep(for: .seconds(max(1, min(300, interval))))
                    let token = try await manager.validSession().accessToken
                    guard manager.session?.accountId == accountID else { return }
                    let result: ProviderPoll = try await ChatAPI.shared.providerRequest("providers/device/poll", fields: ["flowToken": value.flowToken], token: token)
                    try Task.checkCancellation()
                    if result.status == "connected", let id = result.providerId { challenge = nil; browser = false; try await finish(id); return }
                    interval = result.intervalSeconds ?? interval
                }
                await cancelFlow(value); challenge = nil; error = "Le code a expiré. Vous pouvez recommencer."
            } catch is CancellationError {} catch { self.error = error.localizedDescription }
        }
    }
    private func finish(_ id: String) async throws {
        guard manager.session?.accountId == accountID else { throw APIError.authenticationRequired }
        if let replacing = setup.replacing {
            let token = try await manager.validSession().accessToken
            let _: [String: Bool] = try await ChatAPI.shared.providerRequest("providers/\(replacing)/disconnect", fields: [:], token: token)
        }
        connected(id)
    }
    private func cancelFlow(_ value: ProviderChallenge) async {
        guard manager.session?.accountId == accountID, let token = try? await manager.validSession().accessToken else { return }
        let _: [String: Bool]? = try? await ChatAPI.shared.providerRequest("providers/device/cancel", fields: ["flowToken": value.flowToken], token: token)
    }
    private func cancel() async { polling?.cancel(); key = ""; if let value = challenge { await cancelFlow(value) }; challenge = nil }
}


/// Account-wide archive publication is separate from per-conversation inference authorization.
private struct LegacyArchivesConsentView: View {
    let accountID: String
    @Environment(ConversationManager.self) private var manager
    @Environment(\.dismiss) private var dismiss
    @State private var discovery: ConversationManager.LegacyExportDiscovery?
    @State private var selected: Set<String> = []
    @State private var busy = false
    @State private var error: String?
    @State private var status: String?
    @State private var requestID = UUID()

    private var families: [ConversationManager.LegacyExportSource] {
        discovery?.sources.filter { $0.id != "legacy-guest" } ?? []
    }
    private var guest: ConversationManager.LegacyExportSource? {
        discovery?.sources.first { $0.id == "legacy-guest" }
    }
    private var canSelectGuest: Bool {
        families.contains { selected.contains($0.id) && $0.guestCount > 0 }
    }
    private var unavailableApprovals: Bool {
        guard let discovery else { return false }
        return !Set(discovery.approvedSources).subtracting(Set(discovery.sources.map(\.id))).isEmpty
    }
    private func selection(_ source: String) -> Binding<Bool> {
        Binding(get: { selected.contains(source) }, set: { checked in
            if checked { selected.insert(source) } else { selected.remove(source) }
            if !canSelectGuest { selected.remove("legacy-guest") }
            status = nil
        })
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Conserver vos archives dans Cloud") {
                    Text("Choisissez les archives de ce compte que vous autorisez à envoyer. Les nouvelles catégories restent désactivées jusqu’à votre accord.")
                    Text("Les archives envoyées sont chiffrées au repos et lisibles par le serveur. Ce stockage n’est pas chiffré de bout en bout.")
                    Text("La conservation des archives n’autorise pas automatiquement leur utilisation pour l’inférence par les modèles. Cette autorisation reste distincte des réglages d’une conversation Hermes.")
                    Text("Une autorisation d’envoi active l’espace Cloud si nécessaire. Aucun appel de modèle ni aucune commande n’est lancé par cet écran.")
                }
                if let discovery {
                    if families.isEmpty {
                        Section { Text("Aucune archive disponible pour ce compte sur cet appareil.").foregroundStyle(.secondary) }
                    } else {
                        Section("Archives disponibles") {
                            ForEach(families) { source in
                                Toggle(isOn: selection(source.id)) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(source.title)
                                        Text("\(source.count) éléments conservés · \(source.exportableCount) pouvant être envoyés")
                                            .font(.caption).foregroundStyle(.secondary)
                                        if source.guestCount > 0 {
                                            Text("Dont \(source.guestCount) éléments provenant du mode invité")
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                        if source.exportableCount < source.count {
                                            Text("Les éléments trop volumineux ou non compatibles restent conservés sur cet appareil.")
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                }
                                .accessibilityIdentifier("legacyArchiveSource-" + source.id)
                                .disabled(busy)
                            }
                        }
                    }
                    if let guest {
                        Section("Archives provenant du mode invité") {
                            Toggle(isOn: selection("legacy-guest")) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("J’autorise aussi les archives du mode invité")
                                    Text("\(guest.count) éléments · \(guest.exportableCount) pouvant être envoyés")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .disabled(busy || !canSelectGuest)
                            .accessibilityIdentifier("legacyArchiveGuestConsent")
                            Text("Sélectionnez une catégorie contenant des archives invitées pour activer cette autorisation supplémentaire. Les archives invitées ne sont pas envoyées avec la seule autorisation de leur catégorie.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    if unavailableApprovals {
                        Section {
                            Text("Certaines autorisations concernent des archives absentes de cet appareil. Enregistrer retirera ces autorisations d’archives.")
                                .foregroundStyle(.secondary)
                        }
                    }
                    Section {
                        Button(busy ? "Enregistrement…" : "Enregistrer les autorisations") {
                            Task { await save(selected.sorted()) }
                        }
                        .disabled(busy || (selected.contains("legacy-guest") && !canSelectGuest))
                        .accessibilityIdentifier("saveLegacyArchivesConsent")
                        if !discovery.approvedSources.isEmpty {
                            Button("Retirer toutes les autorisations d’archives", role: .destructive) {
                                Task { await save([]) }
                            }
                            .disabled(busy)
                            .accessibilityIdentifier("revokeLegacyArchivesConsent")
                        }
                        Text("Retirer une autorisation arrête les nouveaux envois. Les archives déjà envoyées restent dans Cloud et les copies de cet appareil sont conservées.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                } else if busy { Section { ProgressView("Chargement des archives…") } }
                if let status { Section { Text(status).foregroundStyle(.secondary) } }
                if let error { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    Button("Actualiser les archives et les autorisations") { Task { await load() } }
                        .disabled(busy).accessibilityIdentifier("reloadLegacyArchivesConsent")
                }
            }
            .navigationTitle("Archives de cet appareil")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Fermer") { dismiss() }.disabled(busy) } }
            .interactiveDismissDisabled(busy)
            .task(id: accountID) { await load() }
            .onChange(of: manager.session?.accountId) { _, current in
                if current != accountID { requestID = UUID(); discovery = nil; selected = []; dismiss() }
            }
            .onDisappear { requestID = UUID() }
        }
    }
    @MainActor private func load() async {
        guard !busy, manager.session?.accountId == accountID else { return }
        let owner = UUID(); requestID = owner; busy = true; error = nil; status = nil
        defer { if requestID == owner { busy = false } }
        do {
            let result = try await manager.discoverLegacyExports()
            guard !Task.isCancelled, requestID == owner, manager.session?.accountId == accountID, result.accountID == accountID else { return }
            discovery = result
            selected = Set(result.approvedSources).intersection(Set(result.sources.map(\.id)))
        } catch {
            guard !Task.isCancelled, requestID == owner, manager.session?.accountId == accountID else { return }
            self.error = error.localizedDescription
        }
    }
    @MainActor private func save(_ sources: [String]) async {
        guard !busy, discovery?.accountID == accountID, manager.session?.accountId == accountID else { return }
        let owner = UUID(); requestID = owner; busy = true; error = nil; status = nil
        defer { if requestID == owner { busy = false } }
        do {
            let result = try await manager.setLegacyExportConsent(selectedSources: sources)
            guard !Task.isCancelled, requestID == owner, manager.session?.accountId == accountID, result.accountID == accountID else { return }
            discovery = result; selected = Set(result.approvedSources).intersection(Set(result.sources.map(\.id)))
            status = sources.isEmpty ? "Autorisations d’archives retirées." : "Autorisations d’archives enregistrées. Les envois autorisés reprendront avec la connexion."
        } catch {
            guard !Task.isCancelled, requestID == owner, manager.session?.accountId == accountID else { return }
            if case APIError.server(409, _) = error {
                self.error = "Les autorisations ont changé ailleurs. Actualisez-les avant de réessayer."
            } else { self.error = error.localizedDescription }
        }
    }
}

private struct CloudHermesConsentView: View {
    @Environment(ConversationManager.self) private var manager
    @Environment(\.dismiss) private var dismiss
    @State private var importApproved = false
    @State private var synchronizeLocalTurns = false
    @State private var memoryIDs: Set<String> = []
    @State private var memoryWritable = false
    @State private var skillIDs: Set<String> = []
    @State private var fileIDs: Set<String> = []
    @State private var projectID = ""
    @State private var busy = false
    @State private var error: String?
    @State private var accountID: String?
    @State private var conversationID: UUID?
    private var hasHistory: Bool { !(manager.current?.messages.isEmpty ?? true) }
    private func selectionBinding(_ id:String,in selected:Binding<Set<String>>) -> Binding<Bool> {
        Binding(get:{selected.wrappedValue.contains(id)},set:{checked in
            if checked { selected.wrappedValue.insert(id) } else { selected.wrappedValue.remove(id) }
        })
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Votre environnement Hermes") {
                    Text("Hermes reçoit vos messages dans un environnement Linux personnel. Les conversations, la mémoire et les fichiers qui lui sont envoyés sont lisibles par le serveur et chiffrés au repos.")
                    Text("Ce stockage n’est pas chiffré de bout en bout et reste distinct des conversations SDK chiffrées de bout en bout.")
                    Text("Les collections de contacts, documents et souvenirs locaux ne sont pas importées. Les transcriptions autorisées peuvent toutefois contenir les données privées déjà renvoyées par vos outils.")
                }
                if hasHistory {
                    Section("Import explicite") {
                        Toggle("J’autorise l’envoi des messages existants de cette conversation à Hermes",isOn:$importApproved)
                            .accessibilityIdentifier("cloudHermesImportConsent")
                    }
                }
                Section("Reprise après une utilisation locale") {
                    Toggle("Synchroniser les tours locaux de cette conversation",isOn:$synchronizeLocalTurns)
                        .accessibilityIdentifier("cloudHermesLocalTurnsConsent")
                    Text("Autorise les messages et résultats d’outils des modèles téléchargés et d’Apple Foundation, y compris les tours locaux déjà réalisés dans cette conversation. Ils seront envoyés au retour du réseau. Les résultats d’outils peuvent contenir des données privées. Aucune commande ne sera rejouée.")
                }
                Section("Contexte Cloud pour le modèle local") {
                    Text("Choisissez la mémoire, les skills et les fichiers texte accessibles au modèle local. Ses modifications des fichiers sélectionnés et les nouveaux fichiers qu’il crée dans le projet choisi sont enregistrés sur cet appareil puis synchronisés. Ces contenus restent des données non fiables. Les scripts des skills ne sont pas exécutés. Aucun document ou souvenir natif n’est importé.")
                    Button("Actualiser les objets") { Task { await manager.synchronizeCloudAgentState() } }.disabled(manager.cloudAgentSyncing)
                    ForEach(manager.cloudAgentObjects.filter { $0.kind == "memory" && !$0.deleted && !$0.conflicted && $0.value?.object?["type"]?.string == "hermes_core_memory" }) { item in
                        Toggle("Mémoire · \(item.title)",isOn:selectionBinding(item.id,in:$memoryIDs))
                    }
                    Toggle("Autoriser le modèle local à modifier les mémoires Hermes sélectionnées",isOn:$memoryWritable)
                        .disabled(memoryIDs.isEmpty)
                        .accessibilityIdentifier("cloudHermesMemoryWriteConsent")
                    Text("Ces modifications seront synchronisées au retour du réseau. Cette option n’importe pas vos souvenirs natifs.")
                    ForEach(manager.cloudAgentObjects.filter { $0.kind == "skill" && !$0.deleted && !$0.conflicted }) { item in
                        Toggle("Skill · \(item.title)",isOn:selectionBinding(item.id,in:$skillIDs))
                    }
                    Picker("Projet des fichiers",selection:$projectID) {
                        Text("Aucun").tag("")
                        ForEach(manager.cloudAgentObjects.filter { ["project","session"].contains($0.kind) && !$0.deleted && !$0.conflicted }) { item in Text(item.title).tag(item.id) }
                    }.onChange(of:projectID) { old,new in if old != new && !old.isEmpty { fileIDs=[] } }
                    ForEach(manager.cloudAgentObjects.filter { $0.kind == "file" && !$0.deleted && !$0.conflicted && $0.value?.object?["type"]?.string == "hermes_workspace_file" && $0.value?.object?["projectId"]?.string == projectID }) { item in
                        Toggle(item.value?.object?["path"]?.string ?? item.title,isOn:selectionBinding(item.id,in:$fileIDs))
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    Button(busy ? "Préparation…" : "Autoriser Hermes") {
                        guard accountID == manager.session?.accountId, conversationID == manager.selection else { error = "Le compte ou la conversation a changé. Fermez puis rouvrez cette autorisation."; return }
                        busy = true
                        Task { do { try await manager.authorizeHermesCloud(importExistingConversation:hasHistory && importApproved,synchronizeLocalTurns:synchronizeLocalTurns,memoryIDs:memoryIDs.sorted(),skillIDs:skillIDs.sorted(),fileIDs:fileIDs.sorted(),projectID:projectID.isEmpty ? nil : projectID,memoryWritable:memoryWritable); dismiss() }
                            catch { self.error = error.localizedDescription }; busy = false }
                    }.disabled(busy || (hasHistory && !importApproved)).accessibilityIdentifier("cloudHermesAuthorize")
                }
            }.navigationTitle("Autoriser Hermes")
                .onAppear {
                    accountID = manager.session?.accountId; conversationID = manager.selection
                    synchronizeLocalTurns=manager.currentLocalHermesExportApproved
                    let selected=manager.currentCloudContextSelection
                    memoryWritable=selected.memoryWritable
                    memoryIDs=Set(selected.memory);skillIDs=Set(selected.skills);fileIDs=Set(selected.files);projectID=selected.project ?? ""
                }
                .toolbar { ToolbarItem(placement:.cancellationAction) { Button("Annuler") { dismiss() }.disabled(busy) } }
                .interactiveDismissDisabled(busy)
        }
    }
}


private struct CloudAgentBrowserView: View {
    @Environment(ConversationManager.self) private var manager
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("État Hermes de votre compte. Cette liste est distincte des conversations de l’appareil et des historiques SDK chiffrés. Aucun contenu local n’est importé automatiquement.")
                    Button(manager.cloudAgentSyncing ? "Synchronisation…" : "Actualiser") { Task { await manager.synchronizeCloudAgentState() } }.disabled(manager.cloudAgentSyncing)
                    if let error=manager.cloudAgentSyncError { Text(error).foregroundStyle(.red) }
                }
                ForEach(["session","message","memory","project","file","skill","environment","task"],id:\.self) { kind in
                    let items=manager.cloudAgentObjects.filter{$0.kind == kind}
                    if !items.isEmpty {
                        Section(kind) {
                            ForEach(items) { object in
                                VStack(alignment:.leading,spacing:6) {
                                    if kind == "session", !object.deleted, !object.conflicted {
                                        NavigationLink(object.title) { RemoteHermesConversationView(sessionId:object.id,title:object.title,onLocalContinue:{ dismiss() }) }
                                    } else { Text(object.title).font(.headline) }
                                    if object.deleted { Text("Supprimé · contenu effacé").foregroundStyle(.secondary) }
                                    else if object.conflicted {
                                        Text("Versions concurrentes conservées. Résolvez le conflit avant une nouvelle exécution.").foregroundStyle(.orange)
                                        if CloudAgentState.resolvableKinds.contains(kind) {
                                            NavigationLink("Examiner les versions") { CloudConflictReviewView(objectId:object.id) }
                                        }
                                    }
                                    else if ["project","session"].contains(kind) {
                                        NavigationLink("Fichiers du projet") { CloudWorkspaceView(projectId:object.id,title:object.title) }
                                    }
                                    else if kind == "file", let project=object.value?.object?["projectId"]?.string {
                                        NavigationLink(object.value?.object?["path"]?.string ?? "Ouvrir les fichiers") { CloudWorkspaceView(projectId:project,title:"Fichiers") }
                                    }
                                    else if kind == "task", let id=object.value?.object?["runId"]?.string, let run=manager.discoveredCloudRuns[id] {
                                        Text(run.state.replacingOccurrences(of:"_",with:" ")).font(.caption)
                                        if let response=run.result?.response { Text(response).textSelection(.enabled) }
                                    }
                                    Text(object.id).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                                }
                            }
                        }
                    }
                }
            }.navigationTitle("Hermes Cloud")
                .toolbar { ToolbarItem(placement:.confirmationAction) { Button("Fermer") { dismiss() } } }
                .task { await manager.synchronizeCloudAgentState() }
        }
    }
}


enum CloudWorkspaceBrowserLayout: String, CaseIterable, Identifiable {
    case grid, list
    var id: String { rawValue }
    var title: String { self == .grid ? "Grille" : "Liste" }
    var symbol: String { self == .grid ? "square.grid.2x2" : "list.bullet" }
}

enum CloudWorkspaceBrowserFilter: String, CaseIterable, Identifiable {
    case all, folders, images, text
    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: "Tous"
        case .folders: "Dossiers"
        case .images: "Images"
        case .text: "Texte"
        }
    }
    var symbol: String {
        switch self {
        case .all: "sparkles"
        case .folders: "folder"
        case .images: "photo"
        case .text: "doc.text"
        }
    }
}

enum CloudWorkspaceBrowserSort: String, CaseIterable, Identifiable {
    case name, type, size
    var id: String { rawValue }
    var title: String {
        switch self {
        case .name: "Nom"
        case .type: "Type"
        case .size: "Taille"
        }
    }
}

struct CloudWorkspaceBrowserEntry: Identifiable {
    enum Kind { case folder, file }
    let id: String
    let name: String
    let path: String
    let kind: Kind
    let file: ConversationManager.CloudAgentSummary?
    let descendantCount: Int
    let pending: Bool

    var isFolder: Bool { kind == .folder }
    var isArtifact: Bool { file?.value?.object?["type"]?.string == "hermes_artifact_file" }
    var isText: Bool { !isFolder && !isArtifact }
    var conflicted: Bool { file?.conflicted == true }
    var deleted: Bool { file?.deleted == true }
    var fileExtension: String { (name as NSString).pathExtension.lowercased() }
    var isImage: Bool { ["avif", "gif", "heic", "heif", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"].contains(fileExtension) }
    var byteCount: Int? {
        if let value = file?.value?.object?["byteLength"]?.number, value.isFinite, value >= 0 { return Int(value) }
        return file?.value?.object?["content"]?.string?.utf8.count
    }
    var symbol: String {
        if isFolder { return "folder.fill" }
        if isImage { return "photo.fill" }
        switch fileExtension {
        case "pdf": return "doc.richtext.fill"
        case "zip", "gz", "tar", "7z": return "archivebox.fill"
        case "json", "js", "jsx", "py", "swift", "ts", "tsx": return "chevron.left.forwardslash.chevron.right"
        case "md", "txt", "rtf": return "doc.text.fill"
        default: return isArtifact ? "doc.fill" : "doc.text.fill"
        }
    }
    var color: Color {
        if isFolder { return MultiVibeTheme.accent }
        if conflicted { return .orange }
        if isImage { return .pink }
        switch fileExtension {
        case "pdf": return .red
        case "zip", "gz", "tar", "7z": return .purple
        case "json", "js", "jsx", "py", "swift", "ts", "tsx": return .blue
        default: return isArtifact ? .indigo : MultiVibeTheme.accent
        }
    }
    var detail: String {
        if isFolder { return descendantCount == 1 ? "1 élément" : "\(descendantCount) éléments" }
        if conflicted { return "Conflit à résoudre" }
        if deleted && pending { return "Suppression en attente" }
        if pending { return "Synchronisation en attente" }
        if let byteCount { return ByteCountFormatter.string(fromByteCount:Int64(byteCount),countStyle:.file) }
        return isArtifact ? "Fichier" : "Document texte"
    }
}

struct CloudWorkspaceBrowserIndex {
    private struct Record {
        let file: ConversationManager.CloudAgentSummary
        let path: String
        let components: [String]
    }
    private let records: [Record]
    private let pendingIDs: Set<String>

    init(files: [ConversationManager.CloudAgentSummary], pendingIDs: Set<String>) {
        self.pendingIDs = pendingIDs
        records = files.compactMap { file in
            let path = file.value?.object?["path"]?.string ?? file.title
            let components = path.split(separator:"/",omittingEmptySubsequences:true).map(String.init)
            return components.isEmpty ? nil : Record(file:file,path:path,components:components)
        }
    }

    func entries(directory: [String], search: String, filter: CloudWorkspaceBrowserFilter,
                 sort: CloudWorkspaceBrowserSort, ascending: Bool) -> [CloudWorkspaceBrowserEntry] {
        let scoped = records.filter { $0.components.count > directory.count && $0.components.starts(with:directory) }
        let query = search.trimmingCharacters(in:.whitespacesAndNewlines)
        var result: [CloudWorkspaceBrowserEntry] = []

        if filter == .all && query.isEmpty {
            result = directEntries(scoped,directory:directory,includeFiles:true)
        } else if filter == .folders && query.isEmpty {
            result = directEntries(scoped,directory:directory,includeFiles:false)
        } else {
            if filter == .all || filter == .folders {
                result += folderEntries(scoped,directory:directory,recursive:true).filter { query.isEmpty || matches($0.path,query) }
            }
            if filter != .folders {
                result += scoped.compactMap { record in
                    let entry=fileEntry(record)
                    guard query.isEmpty || matches(record.path,query) else { return nil }
                    switch filter {
                    case .images: return entry.isImage ? entry : nil
                    case .text: return entry.isText ? entry : nil
                    case .all: return entry
                    case .folders: return nil
                    }
                }
            }
        }
        return result.sorted { lhs,rhs in
            if lhs.isFolder != rhs.isFolder { return lhs.isFolder }
            let comparison: ComparisonResult
            switch sort {
            case .name: comparison=lhs.name.localizedStandardCompare(rhs.name)
            case .type: comparison=lhs.fileExtension.localizedStandardCompare(rhs.fileExtension)
            case .size: comparison=(lhs.byteCount ?? 0)==(rhs.byteCount ?? 0) ? lhs.name.localizedStandardCompare(rhs.name) : ((lhs.byteCount ?? 0)<(rhs.byteCount ?? 0) ? .orderedAscending:.orderedDescending)
            }
            if comparison == .orderedSame { return lhs.id < rhs.id }
            return ascending ? comparison == .orderedAscending : comparison == .orderedDescending
        }
    }

    private func directEntries(_ scoped:[Record],directory:[String],includeFiles:Bool) -> [CloudWorkspaceBrowserEntry] {
        var files:[CloudWorkspaceBrowserEntry]=[],folders=Set<String>()
        for record in scoped {
            if record.components.count == directory.count+1 {
                if includeFiles { files.append(fileEntry(record)) }
            } else {
                folders.insert((directory+[record.components[directory.count]]).joined(separator:"/"))
            }
        }
        return folderEntries(paths:folders)+files
    }

    private func folderEntries(_ scoped:[Record],directory:[String],recursive:Bool) -> [CloudWorkspaceBrowserEntry] {
        var paths=Set<String>()
        for record in scoped {
            let last=max(directory.count,record.components.count-1)
            guard directory.count < last else { continue }
            let range=recursive ? directory.count..<last : directory.count..<min(directory.count+1,last)
            for index in range { paths.insert(Array(record.components.prefix(index+1)).joined(separator:"/")) }
        }
        return folderEntries(paths:paths)
    }

    private func folderEntries(paths:Set<String>) -> [CloudWorkspaceBrowserEntry] {
        paths.map { path in
            let prefix=path.split(separator:"/").map(String.init)
            let count=records.filter{$0.components.starts(with:prefix)}.count
            return .init(id:"folder:"+path,name:prefix.last ?? path,path:path,kind:.folder,file:nil,descendantCount:count,pending:false)
        }
    }

    private func fileEntry(_ record:Record) -> CloudWorkspaceBrowserEntry {
        .init(id:record.file.id,name:record.components.last ?? record.path,path:record.path,kind:.file,file:record.file,
              descendantCount:0,pending:pendingIDs.contains(record.file.id))
    }

    private func matches(_ value:String,_ query:String) -> Bool {
        value.localizedCaseInsensitiveContains(query)
    }
}

private struct CloudWorkspaceEditorSelection: Identifiable {
    let id = UUID()
    let draft: ConversationManager.CloudWorkspaceDraft
    let suggestedPath: String?
}

private struct CloudWorkspaceArtifactSelection: Identifiable {
    let entry: CloudWorkspaceBrowserEntry
    var id: String { entry.id }
}

private struct CloudWorkspaceConflictSelection: Identifiable, Hashable {
    let id: String
}

private struct CloudWorkspaceView: View {
    @Environment(ConversationManager.self) private var manager
    let projectId: String
    let title: String
    @State private var account: String?
    @State private var editor: CloudWorkspaceEditorSelection?
    @State private var artifact: CloudWorkspaceArtifactSelection?
    @State private var conflict: CloudWorkspaceConflictSelection?
    @State private var error: String?
    @State private var importing = false
    @State private var importDirectory = ""
    @State private var importDraft: ConversationManager.CloudWorkspaceDraft?
    @State private var importBusy = false
    @State private var downloading: Set<String> = []
    @State private var downloaded: [String:URL] = [:]
    private var visible: Bool { account != nil && account == manager.session?.accountId }
    private var pending: [ConversationManager.CloudAgentSummary] { manager.cloudWorkspacePendingFiles(projectId:projectId) }
    private var files: [ConversationManager.CloudAgentSummary] { manager.cloudWorkspaceFiles(projectId:projectId) }

    private func open(_ id:String?,directory:String="") {
        do {
            let draft=try manager.cloudWorkspaceDraft(projectId:projectId,fileId:id)
            let suggested=id == nil ? (directory.isEmpty ? "nouveau-fichier.txt" : directory+"/nouveau-fichier.txt") : nil
            editor = .init(draft:draft,suggestedPath:suggested);error=nil
        } catch { self.error=error.localizedDescription }
    }
    private func beginImport(directory:String) {
        do {
            importDraft=try manager.cloudWorkspaceArtifactDraft(projectId:projectId,fileId:nil)
            importDirectory=directory;importing=true;error=nil
        } catch { self.error=error.localizedDescription }
    }
    private func download(_ entry:CloudWorkspaceBrowserEntry) {
        guard !entry.pending,!entry.deleted,!entry.conflicted,!downloading.contains(entry.id) else { return }
        downloading.insert(entry.id);error=nil
        Task {
            do { downloaded[entry.id]=try await manager.downloadCloudWorkspaceArtifact(projectId:projectId,fileId:entry.id) }
            catch { self.error=error.localizedDescription }
            downloading.remove(entry.id)
        }
    }
    var body: some View {
        Group {
            if visible {
                CloudWorkspaceBrowserScreen(title:title,files:files,pendingIDs:Set(pending.map(\.id)),syncing:manager.cloudAgentSyncing,importing:importBusy,
                    syncError:manager.cloudAgentSyncError,error:error,downloaded:downloaded,downloading:downloading,
                    openText:{open($0)},openArtifact:{artifact = .init(entry:$0)},openConflict:{conflict = .init(id:$0)},
                    refresh:{Task { await manager.synchronizeCloudAgentState() }},createText:{open(nil,directory:$0)},importFile:beginImport,download:download)
            } else {
                ContentUnavailableView("Projet indisponible",systemImage:"person.crop.circle.badge.exclamationmark",
                    description:Text("Reconnectez-vous au compte de ce projet pour afficher ses fichiers."))
            }
        }
        .onAppear { if account == nil { account=manager.session?.accountId } }
        .onChange(of:manager.session?.accountId) { _,_ in resetForAccountChange() }
        .onDisappear { releaseDownloads() }
        .fileImporter(isPresented:$importing,allowedContentTypes:[.data]) { result in
            guard let draft=importDraft else { return };importBusy=true;error=nil
            Task {
                do {
                    let source=try result.get(),granted=source.startAccessingSecurityScopedResource()
                    defer { if granted { source.stopAccessingSecurityScopedResource() } }
                    let path=importDirectory.isEmpty ? source.lastPathComponent : importDirectory+"/"+source.lastPathComponent
                    _=try await manager.beginCloudWorkspaceArtifactImport(draft,path:path,sourceURL:source)
                } catch { if manager.cloudWorkspaceDraftVisible(draft) { self.error=error.localizedDescription } }
                importBusy=false;importDraft=nil;importDirectory=""
            }
        }
        .sheet(item:$editor) { selection in CloudWorkspaceEditorView(draft:selection.draft,suggestedPath:selection.suggestedPath) }
        .sheet(item:$artifact) { selection in
            CloudWorkspaceArtifactDetailView(entry:selection.entry,url:downloaded[selection.id],downloading:downloading.contains(selection.id),
                download:{download(selection.entry)})
        }
        .navigationDestination(item:$conflict) { selection in CloudConflictReviewView(objectId:selection.id) }
    }
    private func releaseDownloads() {
        let old=Array(downloaded.values);downloaded=[:]
        Task { for url in old { await manager.releaseCloudWorkspaceArtifactDownload(url) } }
    }
    private func resetForAccountChange() {
        releaseDownloads();downloading=[];account=nil;editor=nil;artifact=nil;conflict=nil;importDraft=nil;importing=false;importDirectory="";error=nil
    }
}

struct CloudWorkspaceBrowserScreen: View {
    let title: String
    let files: [ConversationManager.CloudAgentSummary]
    let pendingIDs: Set<String>
    let syncing: Bool
    let importing: Bool
    let syncError: String?
    let error: String?
    let downloaded: [String:URL]
    let downloading: Set<String>
    let openText: (String) -> Void
    let openArtifact: (CloudWorkspaceBrowserEntry) -> Void
    let openConflict: (String) -> Void
    let refresh: () -> Void
    let createText: (String) -> Void
    let importFile: (String) -> Void
    let download: (CloudWorkspaceBrowserEntry) -> Void
    @State private var directory: [String] = []
    @State private var search = ""
    @State private var filter: CloudWorkspaceBrowserFilter = .all
    @State private var layout: CloudWorkspaceBrowserLayout = .grid
    @State private var sort: CloudWorkspaceBrowserSort = .name
    @State private var ascending = true
    @State private var information = false

    private var currentPath: String { directory.joined(separator:"/") }
    private var entries: [CloudWorkspaceBrowserEntry] {
        CloudWorkspaceBrowserIndex(files:files,pendingIDs:pendingIDs).entries(directory:directory,search:search,filter:filter,sort:sort,ascending:ascending)
    }
    private var itemSummary: String {
        let folders=entries.filter(\.isFolder).count,documents=entries.count-folders
        if folders>0 && documents>0 { return "\(folders) dossier\(folders == 1 ? "" : "s") · \(documents) fichier\(documents == 1 ? "" : "s")" }
        if folders>0 { return "\(folders) dossier\(folders == 1 ? "" : "s")" }
        return "\(documents) fichier\(documents == 1 ? "" : "s")"
    }
    var body: some View {
        ScrollView {
            LazyVStack(alignment:.leading,spacing:18) {
                header
                filters
                if !directory.isEmpty { breadcrumbs }
                if syncing { ProgressView("Synchronisation…").frame(maxWidth:.infinity,alignment:.leading) }
                if let syncError { MultiVibeStatusMessage(message:syncError,kind:.warning,actionTitle:"Réessayer",action:refresh) }
                if let error { MultiVibeStatusMessage(message:error) }
                if entries.isEmpty { emptyState.padding(.top,36) }
                else if layout == .grid { grid }
                else { list }
            }.padding(.horizontal,16).padding(.top,10).padding(.bottom,18)
        }
        .background(MultiVibeTheme.background.ignoresSafeArea())
        .navigationTitle(directory.last ?? title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement:.primaryAction) { optionsMenu } }
        .safeAreaInset(edge:.bottom) { bottomBar }
        .refreshable { refresh() }
        .sheet(isPresented:$information) { CloudWorkspaceInformationView(fileCount:files.count) }
        .onChange(of:files.map(\.id)) { _,_ in
            guard !directory.isEmpty else { return }
            let prefix=currentPath+"/"
            if !files.contains(where:{ ($0.value?.object?["path"]?.string ?? $0.title).hasPrefix(prefix) }) { directory=[] }
        }
    }

    private var header: some View {
        HStack(spacing:10) {
            Label(itemSummary,systemImage:directory.isEmpty ? "externaldrive.fill" : "folder.fill")
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength:0)
            Label(pendingIDs.isEmpty ? "À jour" : "\(pendingIDs.count) en attente",systemImage:pendingIDs.isEmpty ? "checkmark.circle.fill" : "arrow.triangle.2.circlepath")
                .foregroundStyle(pendingIDs.isEmpty ? MultiVibeTheme.accent : .orange)
                .lineLimit(1)
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal,4)
    }

    private var filters: some View {
        ScrollView(.horizontal,showsIndicators:false) {
            HStack(spacing:10) {
                ForEach(CloudWorkspaceBrowserFilter.allCases) { item in
                    Button { withAnimation(.snappy) { filter=item } } label: {
                        Label(item.title,systemImage:item.symbol).font(.subheadline.weight(.semibold)).padding(.horizontal,15).frame(height:42)
                            .foregroundStyle(filter == item ? Color.white : Color.primary)
                            .background(filter == item ? MultiVibeTheme.accent : Color(uiColor:.secondarySystemBackground),in:Capsule())
                    }.buttonStyle(.plain).accessibilityIdentifier("workspaceFilter-"+item.rawValue)
                }
            }
        }
    }

    private var breadcrumbs: some View {
        ScrollView(.horizontal,showsIndicators:false) {
            HStack(spacing:7) {
                Button { directory=[] } label: { Label(title,systemImage:"house").labelStyle(.titleAndIcon) }.buttonStyle(.plain)
                ForEach(Array(directory.indices),id:\.self) { index in
                    Image(systemName:"chevron.right").font(.caption2).foregroundStyle(.tertiary)
                    Button(directory[index]) { directory=Array(directory.prefix(index+1)) }.buttonStyle(.plain).fontWeight(index == directory.count-1 ? .semibold:.regular)
                }
            }.font(.subheadline).foregroundStyle(.secondary)
        }.accessibilityIdentifier("workspaceBreadcrumbs")
    }

    private var grid: some View {
        LazyVGrid(columns:[GridItem(.adaptive(minimum:145,maximum:230),spacing:14)],spacing:18) {
            ForEach(entries) { entry in gridCell(entry) }
        }.accessibilityIdentifier("workspaceGrid")
    }

    private var list: some View {
        LazyVStack(spacing:10) { ForEach(entries) { entry in listRow(entry) } }.accessibilityIdentifier("workspaceList")
    }

    private func gridCell(_ entry:CloudWorkspaceBrowserEntry) -> some View {
        Button { activate(entry) } label: {
            VStack(alignment:.leading,spacing:9) {
                ZStack(alignment:.topTrailing) {
                    RoundedRectangle(cornerRadius:21,style:.continuous).fill(entry.color.opacity(0.11))
                    Image(systemName:entry.symbol).font(.system(size:43,weight:.medium)).foregroundStyle(entry.color).frame(maxWidth:.infinity,maxHeight:.infinity)
                    statusBadge(entry).padding(10)
                }.aspectRatio(1.28,contentMode:.fit).overlay(RoundedRectangle(cornerRadius:21,style:.continuous).stroke(entry.color.opacity(0.16)))
                Text(entry.name).font(.headline).foregroundStyle(.primary).lineLimit(2).multilineTextAlignment(.leading)
                Text(entry.detail).font(.caption).foregroundStyle(entry.conflicted ? .orange:.secondary).lineLimit(1)
            }.frame(maxWidth:.infinity,alignment:.leading)
        }.buttonStyle(.plain).contextMenu { entryActions(entry) }
            .accessibilityElement(children:.combine).accessibilityLabel(entry.name+", "+entry.detail)
            .accessibilityHint(entry.isFolder ? "Ouvre le dossier" : entry.conflicted ? "Ouvre les versions en conflit" : entry.isArtifact ? "Affiche les détails du fichier" : "Modifie le document texte")
    }

    private func listRow(_ entry:CloudWorkspaceBrowserEntry) -> some View {
        Button { activate(entry) } label: {
            HStack(spacing:13) {
                ZStack {
                    RoundedRectangle(cornerRadius:13,style:.continuous).fill(entry.color.opacity(0.12)).frame(width:48,height:48)
                    Image(systemName:entry.symbol).font(.title3.weight(.semibold)).foregroundStyle(entry.color)
                }
                VStack(alignment:.leading,spacing:3) {
                    Text(entry.name).font(.body.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
                    Text(entry.path == entry.name ? entry.detail : entry.path+" · "+entry.detail).font(.caption).foregroundStyle(entry.conflicted ? .orange:.secondary).lineLimit(1)
                }
                Spacer(minLength:4);statusBadge(entry)
                Image(systemName:"chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
            }.padding(12).background(MultiVibeTheme.card,in:RoundedRectangle(cornerRadius:18,style:.continuous))
                .overlay(RoundedRectangle(cornerRadius:18,style:.continuous).stroke(.primary.opacity(0.06)))
        }.buttonStyle(.plain).contextMenu { entryActions(entry) }
    }

    @ViewBuilder private func statusBadge(_ entry:CloudWorkspaceBrowserEntry) -> some View {
        if entry.conflicted { Image(systemName:"exclamationmark.triangle.fill").foregroundStyle(.orange).accessibilityLabel("Conflit") }
        else if entry.pending { Image(systemName:entry.deleted ? "trash.circle.fill":"arrow.triangle.2.circlepath.circle.fill").foregroundStyle(.orange).accessibilityLabel(entry.detail) }
        else if downloaded[entry.id] != nil { Image(systemName:"checkmark.circle.fill").foregroundStyle(MultiVibeTheme.accent).accessibilityLabel("Téléchargé et vérifié") }
        else if downloading.contains(entry.id) { ProgressView().controlSize(.small).accessibilityLabel("Téléchargement") }
    }

    @ViewBuilder private func entryActions(_ entry:CloudWorkspaceBrowserEntry) -> some View {
        if entry.isFolder { Button("Ouvrir",systemImage:"folder") { openFolder(entry.path) } }
        else if entry.conflicted { Button("Examiner le conflit",systemImage:"exclamationmark.triangle") { openConflict(entry.id) } }
        else if entry.isArtifact {
            Button("Informations",systemImage:"info.circle") { openArtifact(entry) }
            if let url=downloaded[entry.id] { ShareLink(item:url) { Label("Partager",systemImage:"square.and.arrow.up") } }
            else { Button("Télécharger et vérifier",systemImage:"arrow.down.circle") { download(entry) }.disabled(entry.pending || entry.deleted) }
        } else {
            Button("Modifier",systemImage:"square.and.pencil") { openText(entry.id) }.disabled(entry.pending || entry.deleted)
        }
    }

    private func activate(_ entry:CloudWorkspaceBrowserEntry) {
        if entry.isFolder { openFolder(entry.path) }
        else if entry.conflicted { openConflict(entry.id) }
        else if entry.isArtifact { openArtifact(entry) }
        else if !entry.pending && !entry.deleted { openText(entry.id) }
    }
    private func openFolder(_ path:String) { withAnimation(.snappy) { directory=path.split(separator:"/").map(String.init);search="";filter = .all } }

    private var emptyState: some View {
        ContentUnavailableView(search.isEmpty ? (filter == .all ? "Dossier vide" : "Aucun élément") : "Aucun résultat",
            systemImage:search.isEmpty ? (filter == .folders ? "folder":"doc") : "magnifyingglass",
            description:Text(search.isEmpty ? "Créez un document texte ou importez un fichier dans cet emplacement." : "Essayez un autre nom ou un autre filtre."))
            .frame(maxWidth:.infinity).accessibilityIdentifier("workspaceEmptyState")
    }

    private var optionsMenu: some View {
        Menu {
            Picker("Présentation",selection:$layout) { ForEach(CloudWorkspaceBrowserLayout.allCases) { Label($0.title,systemImage:$0.symbol).tag($0) } }
            Menu("Trier par") { Picker("Tri",selection:$sort) { ForEach(CloudWorkspaceBrowserSort.allCases) { Text($0.title).tag($0) } } }
            Button(ascending ? "Ordre décroissant":"Ordre croissant",systemImage:ascending ? "arrow.down":"arrow.up") { ascending.toggle() }
            Divider()
            Button("Actualiser",systemImage:"arrow.clockwise",action:refresh).disabled(syncing)
            Button("Informations",systemImage:"info.circle") { information=true }
        } label: { Image(systemName:"ellipsis.circle").font(.title3) }
        .accessibilityLabel("Options d’affichage").accessibilityIdentifier("workspaceOptions")
    }

    private var bottomBar: some View {
        HStack(spacing:12) {
            HStack(spacing:9) {
                Image(systemName:"magnifyingglass").foregroundStyle(.secondary)
                TextField("Rechercher",text:$search).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("workspaceSearch")
                if !search.isEmpty { Button("Effacer",systemImage:"xmark.circle.fill") { search="" }.labelStyle(.iconOnly).foregroundStyle(.secondary) }
            }.padding(.horizontal,15).frame(height:50).background(.regularMaterial,in:Capsule()).overlay(Capsule().stroke(.primary.opacity(0.08)))
            Menu {
                Button("Nouveau fichier texte",systemImage:"doc.badge.plus") { createText(currentPath) }
                Button(importing ? "Importation…":"Importer un fichier",systemImage:"square.and.arrow.down") { importFile(currentPath) }.disabled(importing)
            } label: {
                Image(systemName:"plus").font(.title2.weight(.medium)).frame(width:50,height:50).background(.regularMaterial,in:Circle()).overlay(Circle().stroke(.primary.opacity(0.08)))
            }.accessibilityLabel("Ajouter").accessibilityIdentifier("workspaceAdd")
        }.padding(.horizontal,16).padding(.vertical,9).background(.bar)
    }
}

private struct CloudWorkspaceArtifactDetailView: View {
    @Environment(\.dismiss) private var dismiss
    let entry: CloudWorkspaceBrowserEntry
    let url: URL?
    let downloading: Bool
    let download: () -> Void
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing:22) {
                    ZStack {
                        RoundedRectangle(cornerRadius:28,style:.continuous).fill(entry.color.opacity(0.12)).frame(width:132,height:132)
                        Image(systemName:entry.symbol).font(.system(size:58,weight:.medium)).foregroundStyle(entry.color)
                    }
                    VStack(spacing:7) {
                        Text(entry.name).font(.title2.bold()).multilineTextAlignment(.center)
                        Text(entry.path).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                        Text(entry.detail).font(.subheadline.weight(.semibold)).foregroundStyle(entry.pending ? .orange:.secondary)
                    }
                    if let url { ShareLink(item:url) { Label("Partager le fichier vérifié",systemImage:"square.and.arrow.up").frame(maxWidth:.infinity) }.buttonStyle(.borderedProminent) }
                    else { Button(action:download) { Label(downloading ? "Téléchargement…":"Télécharger et vérifier",systemImage:"arrow.down.circle").frame(maxWidth:.infinity) }.buttonStyle(.borderedProminent).disabled(downloading || entry.pending || entry.deleted || entry.conflicted) }
                    Text("Le téléchargement vérifie l’intégrité du fichier avant de le rendre disponible au partage.").font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }.padding(24)
            }.background(MultiVibeTheme.background)
                .navigationTitle("Informations").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement:.confirmationAction) { Button("Fermer") { dismiss() } } }
        }.presentationDetents([.medium,.large])
    }
}

private struct CloudWorkspaceInformationView: View {
    @Environment(\.dismiss) private var dismiss
    let fileCount: Int
    var body: some View {
        NavigationStack {
            List {
                Section("Espace Hermes") { Label("\(fileCount) fichier\(fileCount == 1 ? "":"s")",systemImage:"doc.on.doc");Label("Synchronisé entre vos clients autorisés",systemImage:"arrow.triangle.2.circlepath") }
                Section("Limites") { LabeledContent("Documents texte",value:"64 Ko par fichier · 512 Ko par projet");LabeledContent("Autres fichiers",value:"64 Mio par fichier · 256 Mio par projet");LabeledContent("Nombre maximal",value:"200 fichiers") }
                Section { Text("Les dossiers sont construits à partir des chemins des fichiers. Les modifications enregistrées hors ligne sont synchronisées au retour du réseau.") }
            }.navigationTitle("À propos de cet espace").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement:.confirmationAction) { Button("Fermer") { dismiss() } } }
        }.presentationDetents([.medium,.large])
    }
}

#if DEBUG
struct CloudWorkspaceFixtureView: View {
    private let files:[ConversationManager.CloudAgentSummary] = [
        .init(id:"fixture-1",kind:"file",title:"Documents/Brief produit.md",conflicted:false,deleted:false,value:.object(["type":.string("hermes_workspace_file"),"path":.string("Documents/Brief produit.md"),"content":.string("# Brief produit\nUne interface claire et directe.")])),
        .init(id:"fixture-2",kind:"file",title:"Documents/Notes/Compte-rendu.txt",conflicted:false,deleted:false,value:.object(["type":.string("hermes_workspace_file"),"path":.string("Documents/Notes/Compte-rendu.txt"),"content":.string("Décisions et prochaines étapes")])),
        .init(id:"fixture-3",kind:"file",title:"Images/observatoire.jpg",conflicted:false,deleted:false,value:.object(["type":.string("hermes_artifact_file"),"path":.string("Images/observatoire.jpg"),"byteLength":.number(2_480_312)])),
        .init(id:"fixture-4",kind:"file",title:"Sources/App.swift",conflicted:false,deleted:false,value:.object(["type":.string("hermes_workspace_file"),"path":.string("Sources/App.swift"),"content":.string("import SwiftUI")])),
        .init(id:"fixture-5",kind:"file",title:"roadmap.pdf",conflicted:false,deleted:false,value:.object(["type":.string("hermes_artifact_file"),"path":.string("roadmap.pdf"),"byteLength":.number(824_120)])),
        .init(id:"fixture-6",kind:"file",title:"synchronisation.txt",conflicted:false,deleted:false,value:.object(["type":.string("hermes_workspace_file"),"path":.string("synchronisation.txt"),"content":.string("Modification locale")])),
        .init(id:"fixture-7",kind:"file",title:"Versions concurrentes",conflicted:true,deleted:false,value:nil)
    ]
    var body: some View {
        NavigationStack {
            CloudWorkspaceBrowserScreen(title:"Espace design",files:files,pendingIDs:["fixture-6"],syncing:false,importing:false,syncError:nil,error:nil,downloaded:[:],downloading:[],
                openText:{_ in},openArtifact:{_ in},openConflict:{_ in},refresh:{},createText:{_ in},importFile:{_ in},download:{_ in})
        }.tint(MultiVibeTheme.accent)
    }
}
#endif

private struct CloudWorkspaceEditorView: View {
    @Environment(ConversationManager.self) private var manager
    @Environment(\.dismiss) private var dismiss
    let draft: ConversationManager.CloudWorkspaceDraft
    @State private var path: String
    @State private var content: String
    @State private var version: String?
    @State private var busy=false
    @State private var error: String?
    @State private var discard=false
    @State private var deleting=false
    init(draft:ConversationManager.CloudWorkspaceDraft,suggestedPath:String?=nil) {
        self.draft=draft
        _path=State(initialValue:suggestedPath ?? draft.path);_content=State(initialValue:draft.content)
    }
    private var dirty: Bool { version == nil && (path != draft.path || content != draft.content) }
    private var visible: Bool { manager.cloudWorkspaceDraftVisible(draft) }
    private var status: String { version.map { manager.cloudWorkspaceWriteStatus(draft,version:$0) } ?? "" }
    private func save(delete:Bool=false) {
        busy=true;error=nil
        Task {
            do { version=try await manager.saveCloudWorkspaceFile(draft,path:path,content:delete ? draft.content : content,delete:delete) }
            catch { if visible { self.error=error.localizedDescription } }
            busy=false
        }
    }
    var body: some View {
        NavigationStack {
            Form {
                if visible {
                    if let version {
                        Section {
                            switch status {
                            case "synced": Text("Modification synchronisée.")
                            case "pending": Text("Modification enregistrée sur cet appareil. Elle sera synchronisée au retour du réseau.")
                            case "conflicted": Text("Une autre version existe. Examinez les versions depuis les fichiers du projet avant de poursuivre.").foregroundStyle(.orange)
                            default: Text("La confirmation est indisponible. Actualisez la synchronisation.").foregroundStyle(.orange)
                            }
                            Button("Actualiser la confirmation") { busy=true;Task { await manager.synchronizeCloudAgentState();busy=false } }.disabled(busy)
                            if let issue=manager.cloudAgentSyncError { Text(issue).foregroundStyle(.orange) }
                            Text(version).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                    }
                    Section("Chemin relatif") {
                        TextField("notes/exemple.md",text:$path).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .disabled(!draft.objectId.isEmpty || version != nil || busy)
                            .accessibilityIdentifier("hermesWorkspaceFilePath")
                    }
                    Section("Contenu") {
                        TextEditor(text:$content).font(.system(.body,design:.monospaced)).frame(minHeight:260)
                            .disabled(version != nil || busy).accessibilityIdentifier("hermesWorkspaceFileContent")
                        Text("\(content.utf8.count) / 65 536 octets").font(.caption).foregroundStyle(.secondary)
                    }
                    if let error { Section { Text(error).foregroundStyle(.red) } }
                    if version == nil {
                        Section {
                            Button(busy ? "Enregistrement…" : "Enregistrer") { save() }
                                .disabled(busy || path.isEmpty || content.utf8.count>65536)
                                .accessibilityIdentifier("hermesWorkspaceSaveFile")
                            if !draft.objectId.isEmpty {
                                Button("Supprimer le fichier",role:.destructive) { deleting=true }.disabled(busy)
                            }
                        }
                    }
                } else if version != nil && status == "synced" {
                    Text("Suppression synchronisée.")
                } else { Text("Ce fichier n’est plus disponible pour ce compte. Fermez puis rouvrez le projet.") }
            }.navigationTitle(draft.objectId.isEmpty ? "Nouveau fichier" : "Modifier le fichier")
                .toolbar { ToolbarItem(placement:.cancellationAction) {
                    Button("Fermer") { if dirty && visible { discard=true } else { dismiss() } }.disabled(busy)
                } }
                .interactiveDismissDisabled(busy || dirty)
                .confirmationDialog("Abandonner les modifications non enregistrées ?",isPresented:$discard,titleVisibility:.visible) {
                    Button("Abandonner",role:.destructive) { dismiss() }
                }
                .confirmationDialog("Supprimer ce fichier de tous les clients synchronisés ?",isPresented:$deleting,titleVisibility:.visible) {
                    Button("Supprimer",role:.destructive) { save(delete:true) }
                } message: { Text("Cette suppression efface aussi ses versions synchronisées. Le même chemin ne pourra pas être recréé.") }
                .onChange(of:manager.session?.accountId) { _,_ in path="";content="";error=nil;dismiss() }
        }
    }
}


private struct CloudConflictReviewView: View {
    @Environment(ConversationManager.self) private var manager
    let objectId: String
    @State private var review: ConversationManager.CloudConflictReview?
    @State private var inspected: Set<String> = []
    @State private var selected: String?
    @State private var histories:[ConversationManager.CloudHistoryChoice]=[]
    @State private var selectedHistory:String?
    @State private var pendingVersion: String?
    @State private var resolved = false
    @State private var confirming = false
    @State private var busy = false
    @State private var error: String?
    private func rendered(_ value: HistoryJSON?) -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted,.sortedKeys]
        guard let value, let data = try? encoder.encode(value) else { return "Contenu indisponible" }
        return String(decoding:data,as:UTF8.self)
    }
    var body: some View {
        List {
            Section {
                Text("Examinez chaque version puis choisissez celle à conserver. Les autres versions restent dans l’historique. Aucun outil ni commande ne sera exécuté.")
                if let error { Text(error).foregroundStyle(.red) }
                if resolved { Text("Résolution synchronisée.") }
                if review == nil || review.map({ !manager.cloudConflictReviewVisible($0) }) == true { Text("Conflit indisponible ou compte déconnecté.") }
            }
            if let review, manager.cloudConflictReviewVisible(review), !resolved {
                if let pendingVersion {
                    if manager.pendingCloudConflictVersion(review) == nil, manager.cloudConflictReview(objectId) != nil {
                        Text("De nouvelles versions concurrentes nécessitent un nouvel examen.")
                        Button("Examiner les versions actuelles") {
                            self.review=manager.cloudConflictReview(objectId)
                            inspected=[]; selected=nil; histories=[]; selectedHistory=nil; self.pendingVersion=nil; error=nil
                        }.disabled(busy)
                    } else {
                        Text("Résolution enregistrée sur cet appareil, en attente de confirmation Cloud. Aucun nouveau choix ne sera envoyé.")
                    }
                    if let issue = manager.cloudAgentSyncError { Text(issue).foregroundStyle(.orange) }
                    Button("Actualiser la confirmation") {
                        busy=true
                        Task { await manager.synchronizeCloudAgentState(); resolved=manager.cloudConflictResolved(review,version:pendingVersion); busy=false }
                    }.disabled(busy)
                }
                ForEach(review.versions,id:\.versionId) { version in
                    Section(version.versionId) {
                        Text("Appareil : "+version.deviceId).font(.caption)
                        Text(rendered(version.value)).font(.system(.caption,design:.monospaced)).textSelection(.enabled)
                        Toggle("J’ai examiné cette version",isOn:Binding(get:{inspected.contains(version.versionId)},set:{ if $0 { inspected.insert(version.versionId) } else { inspected.remove(version.versionId); selected=nil; histories=[]; selectedHistory=nil } }))
                        Button(selected == version.versionId ? "Version choisie" : "Choisir cette version") {
                            selected=version.versionId;histories=[];selectedHistory=nil
                            if version.kind == "session" {
                                busy=true
                                Task { do { histories=try await manager.cloudHistoryChoices(review,selectedHead:version.versionId) } catch { self.error=error.localizedDescription };busy=false }
                            }
                        }
                            .disabled(inspected.count != review.versions.count || busy || pendingVersion != nil)
                    }
                }
                if review.versions.first?.kind == "session", selected != nil {
                    Section("Choisir la continuation exacte") {
                        Text("Examinez l’historique complet, y compris les appels et résultats d’outils. La continuation choisie sera rattachée à une nouvelle branche ; aucune action ne sera rejouée.")
                        ForEach(histories) { choice in
                            Text(choice.id).font(.caption)
                            Text(rendered(.array(choice.history))).font(.system(.caption,design:.monospaced)).textSelection(.enabled)
                            Button(selectedHistory == choice.id ? "Historique choisi" : "J’ai examiné et je choisis cet historique") { selectedHistory=choice.id }
                                .disabled(busy || pendingVersion != nil)
                        }
                    }
                }
                Button("Confirmer la résolution") { confirming=true }.disabled(selected == nil || busy || inspected.count != review.versions.count || pendingVersion != nil || (review.versions.first?.kind == "session" && selectedHistory == nil))
                Text("Une exécution active, un résultat inconnu ou des échanges locaux en cours empêchent la résolution. Les données des autres versions restent conservées.").font(.caption)
            }
        }.navigationTitle("Versions concurrentes")
            .task { review=manager.cloudConflictReview(objectId); if let review { pendingVersion=manager.pendingCloudConflictVersion(review) } }
            .confirmationDialog("Conserver exactement la version choisie ?",isPresented:$confirming,titleVisibility:.visible) {
                Button("Conserver cette version") {
                    guard let review, manager.cloudConflictReviewVisible(review), let selected else { return }; busy=true
                    Task { do { let version=try await manager.resolveCloudConflict(review,selectedHead:selected,historyChoice:histories.first(where:{$0.id == selectedHistory})); pendingVersion=version; resolved=manager.cloudConflictResolved(review,version:version) } catch { self.error=error.localizedDescription }; busy=false }
                }
                Button("Annuler",role:.cancel) {}
            } message: { Text("Une nouvelle révision réunira toutes les versions examinées. Leur contenu ne sera pas fusionné.") }
    }
}

/// Keep every harness activity visible while details stay available on demand.
struct AgentActivityView: View {
    let events: [LocalAgentEvent]
    let completion: ChatMessage.Completion?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(events.filter { $0.tool != "hermes_agent" }) { event in
                if event.kind == "message" || event.tool == "hermes_message" {
                    Text(event.detail).font(.subheadline).foregroundStyle(.secondary).textSelection(.enabled)
                        .accessibilityIdentifier("agentIntermediateMessage")
                } else {
                    let running = event.status == "running" && completion == .streaming
                    let interrupted = event.status == "running" && completion != .streaming
                    DisclosureGroup {
                        VStack(alignment: .leading, spacing: 8) {
                            if !event.detail.isEmpty { Text(event.detail).font(.caption) }
                            if let input = event.input, !input.isEmpty {
                                Text("Paramètres").font(.caption.bold())
                                Text(input).font(.caption.monospaced())
                            }
                            if let output = event.output, !output.isEmpty {
                                Text("Résultat").font(.caption.bold())
                                Text(output).font(.caption)
                            }
                        }.textSelection(.enabled).padding(.top, 6)
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            if running { ProgressView().controlSize(.mini) }
                            else { Image(systemName: event.status == "error" ? "exclamationmark.circle" : interrupted || event.status == "stopped" ? "pause.circle" : "checkmark.circle")
                                .foregroundStyle(event.status == "error" ? Color.orange : Color.secondary) }
                            Text(event.tool.replacingOccurrences(of: "_", with: " ")).font(.subheadline.weight(.medium))
                            Spacer(minLength: 4)
                            Text(running ? "En cours" : interrupted || event.status == "stopped" ? "Interrompu" : event.status == "error" ? "Erreur" : event.status == "needs_input" ? "À préciser" : "Terminé")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }.accessibilityIdentifier("agentToolActivity")
                }
            }
            if completion == .streaming && !events.contains(where: { $0.status == "running" }) {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.mini)
                    Text("L’assistant travaille…").font(.caption).foregroundStyle(.secondary)
                }
            }
        }.padding(12)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct RemoteHermesConversationView: View {
    @Environment(ConversationManager.self) private var manager
    let sessionId: String
    let title: String
    var onLocalContinue: () -> Void = {}
    @State private var localModel = ""
    @State private var localConsent = false
    @State private var localPrepared = false
    @State private var model = ""
    @State private var workspaceProject = ""
    @State private var workspaceChanged = false
    @State private var draft = ""
    @State private var error: String?
    @State private var submitting = false
    @State private var account: String?
    private var available: Bool { manager.cloudAgentObjects.contains { $0.id == sessionId && !$0.deleted && !$0.conflicted } }
    var body: some View {
        List {
            Section {
                Text("Conversation de votre espace Cloud. « Continuer sur cet appareil » crée explicitement une copie locale pour utiliser un modèle installé.").font(.caption)
                Button("Actualiser") { Task { await manager.synchronizeCloudAgentState(); await manager.recoverRemoteHermes() } }
                    .disabled(manager.cloudAgentSyncing || manager.remoteHermesBusy)
                if !available { Text("Conversation supprimée ou en conflit. La continuation est bloquée.").foregroundStyle(.orange) }
                if let error = error ?? manager.remoteHermesError ?? manager.cloudAgentSyncError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            }
            Section("Continuer sur cet appareil") {
                Picker("Modèle local",selection:$localModel) {
                    Text("Choisir un modèle installé").tag("")
                    ForEach(manager.localHermesContinuationModels) { option in Text(option.displayName).tag(option.id) }
                }
                Text("L’historique sera disponible sur cet appareil. Aucun modèle n’est lancé avant votre prochain message. L’envoi des nouvelles réponses locales au Cloud nécessite une autorisation explicite.").font(.caption)
                Text(HermesOnDeviceCapabilities.current.summary).font(.caption).foregroundStyle(.secondary)
                Button("Continuer sur cet appareil") {
                    guard let account else { return }
                    do {
                        try manager.continueHermesOnDevice(sessionId:sessionId,model:localModel,accountId:account)
                        localPrepared=true;error=nil
                    } catch { self.error=error.localizedDescription }
                }.disabled(!available || localModel.isEmpty || submitting || manager.isStreaming || account != manager.session?.accountId)
                if localPrepared {
                    if !manager.currentLocalHermesExportApproved {
                        Text("Synchronisation des nouvelles réponses locales désactivée.").font(.caption)
                        Button("Configurer la synchronisation et le contexte") { localConsent=true }
                    }
                    Button("Ouvrir la conversation locale") { onLocalContinue() }
                }
            }
            Section("Conversation") {
                ForEach(Array(manager.remoteHermesTranscript(sessionId).enumerated()),id:\.offset) { _, message in
                    if let value = message.object, let role = value["role"]?.string, ["user","assistant"].contains(role), let content = value["content"]?.string, !content.isEmpty {
                        VStack(alignment:.leading) { Text(role == "user" ? "Vous" : "Hermes").font(.caption).foregroundStyle(.secondary); Text(content).textSelection(.enabled) }
                    }
                }
                ForEach(manager.remoteHermesRuns(sessionId),id:\.runId) { run in
                    if run.state != "completed" {
                        Text(manager.remoteHermesPrompt(sessionId:sessionId,runId:run.runId))
                        Text(run.state == "awaiting_resolution" ? "Une action doit être vérifiée. Aucune réexécution automatique." : run.state).font(.caption)
                        if run.state != "cancelled" {
                            Button("Annuler ce run",role:.destructive) { Task { do { try await manager.cancelRemoteHermes(sessionId:sessionId,runId:run.runId) } catch { self.error=error.localizedDescription } } }.disabled(manager.remoteHermesBusy)
                        }
                    }
                }
            }
            Section("Continuer avec Hermes") {
                Picker("Modèle Cloud ou Relay",selection:$model) {
                    Text("Choisir un modèle").tag("")
                    ForEach(manager.remoteHermesModels) { option in Text((option.id.hasPrefix("relay/") ? "Relay · " : "Cloud · ")+option.displayName).tag(option.id) }
                }
                Picker("Projet Hermes",selection:Binding(get:{workspaceProject},set:{workspaceProject=$0;workspaceChanged=true})) {
                    Text("Espace de cette conversation").tag(sessionId)
                    if workspaceProject != sessionId && !workspaceProject.isEmpty && !manager.cloudAgentObjects.contains(where: { $0.id == workspaceProject }) {
                        Text("Espace existant de cette session").tag(workspaceProject)
                    }
                    ForEach(manager.cloudAgentObjects.filter { $0.id != sessionId && ["project","session"].contains($0.kind) && !$0.deleted && !$0.conflicted }) { project in Text(project.title).tag(project.id) }
                }
                TextField("Message",text:$draft,axis:.vertical).lineLimit(3...8)
                Button(submitting ? "Envoi…" : "Envoyer") {
                    guard account == manager.session?.accountId else { return }
                    let message=draft, chosen=model, owner=account, project=workspaceChanged ? workspaceProject : ""
                    submitting=true;error=nil
                    Task {
                        defer { submitting=false }
                        do {
                            try await manager.sendRemoteHermes(sessionId:sessionId,model:chosen,message:message,workspaceProjectId:project.isEmpty ? nil : project)
                            if account == owner && manager.session?.accountId == owner && draft == message { draft="";workspaceChanged=false;workspaceProject=manager.remoteHermesWorkspaceProject(sessionId) }
                        } catch { if manager.session?.accountId == owner { self.error=error.localizedDescription } }
                    }
                }.disabled(!available || submitting || manager.remoteHermesBusy || model.isEmpty || draft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
            }
        }.navigationTitle(title)
            .sheet(isPresented:$localConsent) { CloudHermesConsentView() }
            .onAppear { account=manager.session?.accountId; workspaceProject=manager.remoteHermesWorkspaceProject(sessionId) }
            .onChange(of:manager.session?.accountId) { _,_ in draft="";model="";workspaceProject="";workspaceChanged=false;error=nil;account=nil;localPrepared=false;localModel="";localConsent=false }
            .task {
                await manager.synchronizeCloudAgentState(); await manager.recoverRemoteHermes()
                while !Task.isCancelled {
                    try? await Task.sleep(for:.seconds(2))
                    if Task.isCancelled { return }
                    await manager.synchronizeCloudAgentState(); await manager.recoverRemoteHermes()
                }
            }
    }
}


/// Keep synchronization tasks outside ChatView's large presentation modifier chain.
private struct RemoteConversationSynchronization: ViewModifier {
    let accountID: String?
    @Environment(\.scenePhase) private var scenePhase
    @State private var instances = RemoteInstances.shared
    private var accountKey: String { (accountID ?? "") + String(describing: scenePhase) }
    private var selectionKey: String { (instances.selection?.uuidString ?? "") + String(describing: scenePhase) }
    func body(content: Content) -> some View {
        content
            .task(id: accountKey) {
                instances.activate(accountID)
                guard scenePhase == .active, accountID != nil else { return }
                await instances.runSynchronization()
            }
            .task(id: selectionKey) {
                guard scenePhase == .active else { return }
                await instances.runSelectedSynchronization()
            }
    }
}
