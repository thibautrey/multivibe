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

struct ChatView: View {
    @Environment(ConversationManager.self) private var manager
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var voice: VoiceController { manager.voice }
    @State private var text = ""
    @State private var shortcutDraftConversation: UUID?
    @State private var preferredColumn: NavigationSplitViewColumn = .detail
    @State private var search = ""
    @State private var conversationToDelete: Conversation?
    @State private var confirmGuestImport = false
    @State private var confirmHistorySync = false
    @State private var confirmHistoryConflict = false
    @State private var retryTarget: RetryTarget?
    private struct RetryTarget { let conversation: UUID; let message: UUID }
    @State private var documentsPresented = false
    @State private var privacyPresented = false
    @State private var profilePresented = false
    @State private var authenticateAfterProfile = false
    @State private var suggestions = HomeSuggestionStore.load()
    @State private var suggestionsPresented = false
    @State private var highlightedSuggestion: UUID?
    @State private var selectionContent: SelectableMessage?
    @State private var followsLatest = true
    @State private var userScrolling = false
    @State private var composerPresented = true
    @State private var voiceConversationPresented = false
    @State private var voiceConversationPreparing = false
    @FocusState private var composerFocused: Bool
    private static let compactComposerHeight: CGFloat = 126
    private var composerDetent: PresentationDetent {
        .height(Self.compactComposerHeight + (voice.error != nil ? 76 : (voice.recording || voice.starting ? 28 : 0)))
    }
    private let latestMessageAnchor = "latest-message"

    var body: some View {
        @Bindable var manager = manager
        NavigationSplitView(preferredCompactColumn: $preferredColumn) {
            List(selection: $manager.selection) {
                Section {
                    ScrollView(.horizontal) {
                        LazyHStack(alignment: .top, spacing: 16) {
                            if manager.session != nil {
                                NavigationLink {
                                    SDKApplicationsView().id(manager.session?.accountId)
                                } label: {
                                    ConversationShortcutLabel(title: "Applications", systemImage: "square.grid.2x2.fill")
                                }
                                .accessibilityIdentifier("openApplications")
                            }
                            Button {
                                manager.memoryPresented = true
                            } label: {
                                ConversationShortcutLabel(title: "Mémoire", systemImage: "brain")
                            }
                            .accessibilityIdentifier("openMemory")
                        }
                        .padding(.horizontal, 4)
                        .padding(.vertical, 8)
                    }
                    .scrollIndicators(.hidden)
                    .fixedSize(horizontal: false, vertical: true)
                    .buttonStyle(.plain)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }

                ForEach(manager.historyConversations.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) }) { conversation in
                    Label(conversation.title, systemImage: conversation.id == manager.selection ? "bubble.left.fill" : "bubble.left")
                        .font(.body.weight(conversation.id == manager.selection ? .semibold : .regular)).tag(conversation.id)
                        .swipeActions(allowsFullSwipe: false) {
                            Button("Supprimer", role: .destructive) { conversationToDelete = conversation }
                        }
                }
            }
            .scrollContentBackground(.hidden)
            .background(MultiVibeTheme.softAccent.ignoresSafeArea())
            .searchable(text: $search, prompt: "Conversations sur cet appareil")
            .navigationTitle("")
            .safeAreaInset(edge: .bottom) {
                if let status = manager.historyStatus, status != "Historique synchronisé avec votre compte." {
                    VStack {
                        Text(status).font(.caption)
                        if manager.hasHistoryConflict {
                            Button("Conserver les deux versions") { confirmHistoryConflict = true }
                                .disabled(manager.isSynchronizing || manager.isStreaming || manager.isRestoring)
                        }
                    }.padding().background(.regularMaterial)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Profil", systemImage: "person.crop.circle") { profilePresented = true }
                        .accessibilityIdentifier("openProfile")
                }
                ToolbarItem(placement: .primaryAction) { Button("Nouvelle conversation", systemImage: "square.and.pencil") { openNewConversation() } }
                ToolbarItem(placement: .secondaryAction) {
                    Button("Synchroniser l’historique", systemImage: "arrow.triangle.2.circlepath") {
                        if manager.session == nil { manager.authenticationPresented = true } else { confirmHistorySync = true }
                    }
                        .disabled(manager.isSynchronizing || manager.isStreaming || manager.isRestoring)
                }
                ToolbarItem(placement: .secondaryAction) {
                    if manager.session != nil {
                        Button("Importer les conversations invitées") { confirmGuestImport = true }
                        if manager.automaticSync { Button("Désactiver la synchronisation automatique") { manager.disableAutomaticSync() } }
                    }
                }
                ToolbarItem(placement: .secondaryAction) { Button("Confidentialité et données", systemImage: "hand.raised") { privacyPresented = true } }
                ToolbarItem(placement: .secondaryAction) {
                    Button("Documents et outils locaux", systemImage: "doc") { documentsPresented = true }
                }
            }
        } detail: {
            VStack(spacing: 0) {
                if isNewConversation {
                    welcome
                } else {
                    ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 20) {
                            ForEach(manager.current?.messages ?? []) { message in
                                VStack(alignment: message.role == "user" ? .trailing : .leading, spacing: 8) {
                                    if message.role == "user" {
                                        Text(message.content).textSelection(.enabled)
                                            .padding(.horizontal, 18).padding(.vertical, 12)
                                            .background(MultiVibeTheme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 22))
                                            .padding(.leading, 36)
                                    } else {
                                        if !message.content.isEmpty || message.nativeContent != nil {
                                            VStack(alignment: .leading, spacing: 14) {
                                                if let payload = message.nativeContent, payload.version == NativeContentPayload.currentVersion {
                                                    NativeContentView(payload: payload)
                                                        .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
                                                }
                                                NativeMessageContent(content: message.content)
                                            }
                                            .padding(16)
                                            .background(.background.opacity(0.82), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                                            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(.primary.opacity(0.06)))
                                            .shadow(color: .black.opacity(0.05), radius: 18, y: 8)
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
                                                Button("Lire à voix haute", systemImage: "speaker.wave.2") { voice.speak(message.content) }
                                                ShareLink(item: message.content) { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("Partager le message")
                                            }
                                            if message.canRetry && manager.current?.messages.last?.id == message.id {
                                                Button("Réessayer", systemImage: "arrow.clockwise") {
                                                    if let conversation = manager.selection { retryTarget = RetryTarget(conversation: conversation, message: message.id) }
                                                }.disabled(manager.isStreaming)
                                            }
                                        }.labelStyle(.iconOnly).buttonStyle(.borderless).controlSize(.large)
                                            .foregroundStyle(.secondary)
                                    }
                                }.frame(maxWidth: .infinity, alignment: message.role == "user" ? .trailing : .leading)
                                    .contextMenu {
                                        Button("Copier tout", systemImage: "doc.on.doc") {
                                            UIPasteboard.general.setItems([["public.utf8-plain-text": message.content]], options: [.localOnly: true])
                                            UINotificationFeedbackGenerator().notificationOccurred(.success)
                                        }
                                        Button("Sélectionner le texte", systemImage: "selection.pin.in.out") {
                                            selectionContent = SelectableMessage(id: message.id, text: message.content)
                                        }
                                        ShareLink(item: message.content) { Label("Partager", systemImage: "square.and.arrow.up") }
                                    }
                                    .transition(.opacity.combined(with: .move(edge: .bottom)))

                            }
                            Color.clear.frame(height: 1).id(latestMessageAnchor)
                        }.padding(.horizontal, 14).padding(.vertical, 18)
                            .animation(reduceMotion ? nil : .spring(duration: 0.38, bounce: 0.12), value: manager.current?.messages.count)
                    }
                    .contentMargins(.bottom, composerPresented ? Self.compactComposerHeight : 0, for: .scrollContent)
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
                    .onChange(of: manager.current?.messages.last?.content) { _, _ in
                        if followsLatest && !userScrolling { proxy.scrollTo(latestMessageAnchor, anchor: .bottom) }
                    }
                    .onChange(of: manager.current?.messages.count) { _, _ in
                        if followsLatest && !userScrolling { proxy.scrollTo(latestMessageAnchor, anchor: .bottom) }
                    }
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
                    }
                }
                if voice.speaking {
                    Button("Arrêter la lecture", systemImage: "stop.circle") { voice.silence() }.padding(.horizontal)
                }
                if !composerRequested, let error = voice.error {
                    Text(error).font(.callout).foregroundStyle(.red).padding()
                }
                if let error = manager.error { Text(error).font(.callout).foregroundStyle(.red).padding() }
                if let error = manager.modelsError, manager.selectedModel != LocalModel.id {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(error).font(.callout)
                        Button("Réessayer le chargement des modèles", systemImage: "arrow.clockwise") {
                            Task { await manager.reloadModels() }
                        }.disabled(manager.isLoadingModels || manager.isStreaming)
                    }.padding(.horizontal)
                }
                if manager.isLoadingModels && manager.selectedModel != LocalModel.id { ProgressView("Chargement des modèles…").padding(.horizontal) }
            }
            .overlay(alignment: .bottomTrailing) {
                if !composerRequested {
                    Button("Afficher la saisie", systemImage: "text.cursor") { composerPresented = true }
                        .buttonStyle(.borderedProminent).labelStyle(.iconOnly).controlSize(.large)
                        .padding(18).accessibilityIdentifier("showComposerSheet")
                }
            }
            .background(MultiVibeTheme.softAccent.ignoresSafeArea())
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if manager.session == nil {
                        Button("Se connecter") { manager.authenticationPresented = true }.accessibilityIdentifier("openAuthentication")
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Nouvelle conversation", systemImage: "square.and.pencil") { openNewConversation() }
                }
            }

        }
        .overlay {
            if manager.isStreaming {
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
            composerPresented = true
            composerFocused = false
        }) {
            RealtimeVoiceView().environment(manager)
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
        .confirmationDialog("Remplacer cette réponse ?", isPresented: Binding(
            get: { retryTarget != nil }, set: { if !$0 { retryTarget = nil } }
        ), titleVisibility: .visible) {
            Button("Remplacer et réessayer", role: .destructive) {
                if let target = retryTarget { _ = manager.retry(conversation: target.conversation, message: target.message) }
                retryTarget = nil
            }
            Button("Annuler", role: .cancel) { retryTarget = nil }
        } message: {
            Text(manager.current?.model == LocalModel.id ? "La réponse partielle sera remplacée et la demande sera reprise sur cet iPhone. Les documents déjà créés sont conservés." : "La réponse partielle sera remplacée. Votre message ne sera pas ajouté une seconde fois. Cette nouvelle demande peut consommer des crédits.")
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
        .sheet(isPresented: $privacyPresented) { NativePrivacyView() }
        .sheet(isPresented: $profilePresented, onDismiss: {
            if authenticateAfterProfile {
                authenticateAfterProfile = false
                manager.authenticationPresented = true
            }
        }) {
            NavigationStack {
                Form {
                    if let accountId = manager.session?.accountId {
                        NativeAccountSection(accountId: accountId).id(accountId)
                        CloudCreditBalanceSection(accountId: accountId).id(accountId)
                    } else {
                        Section { LabeledContent("Compte", value: "Invité") }
                    }
                    Section {
                        if manager.session != nil {
                            Button("Déconnexion", role: .destructive) {
                                profilePresented = false
                                Task { await manager.logout() }
                            }
                            .accessibilityIdentifier("signOut")
                            .disabled(manager.isRestoring)
                        } else {
                            Button("Se connecter") {
                                authenticateAfterProfile = true
                                profilePresented = false
                            }
                            .accessibilityIdentifier("openAuthentication")
                            .disabled(manager.isRestoring)
                        }
                    }
                }
                .navigationTitle("Profil")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Fermer", systemImage: "xmark") { profilePresented = false }
                    }
                }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $suggestionsPresented) {
            SuggestionsEditor(suggestions: $suggestions, highlighted: highlightedSuggestion) {
                HomeSuggestionStore.save(suggestions)
            }
        }
        .sheet(item: $selectionContent) { SelectableMessageSheet(message: $0) }
        .sheet(isPresented: Binding(get: { composerRequested && preferredColumn == .detail && !modalIsActive }, set: { presented in
            if !presented && !isNewConversation && preferredColumn == .detail && !modalIsActive { composerPresented = false }
        })) {
            composer
            .interactiveDismissDisabled(isNewConversation)
            .presentationDetents([composerDetent])
            .presentationDragIndicator(.visible)
            .presentationContentInteraction(.scrolls)
            .presentationBackgroundInteraction(.enabled(upThrough: composerDetent))
            .presentationCornerRadius(30)
            .presentationBackground(.clear)
        }
        .onChange(of: modalIsActive) { _, active in
            if !active { Task { @MainActor in await Task.yield(); composerPresented = true } }
        }
        .onChange(of: manager.selection) { _, selection in
            if shortcutDraftConversation != selection { text = "" }
            if selection != nil {
                preferredColumn = .detail
                composerPresented = true
            }
        }
        .onChange(of: voice.transcript) { _, value in text = value }
        .onChange(of: manager.wantsNewConversation) { _, _ in consumeIntent() }
        .onChange(of: manager.wantsVoiceConversation) { _, _ in consumeIntent() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { voice.silence(); if phase == .background && manager.selectedModel == LocalModel.id { manager.stop() } } else { manager.foreground(); consumeIntent() }
        }
        .onAppear { consumeIntent() }
        .onChange(of: manager.nativeShortcut) { _, _ in consumeIntent() }
        .onChange(of: manager.isRestoring) { _, _ in consumeIntent() }
        .onChange(of: manager.wantsVoice) { _, _ in consumeIntent() }
        .onChange(of: manager.pendingDraft) { _, _ in consumeIntent() }
        .onDisappear { voice.silence() }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in voice.silence() }
    }
    private var welcome: some View {
        ChatWelcomeView(text: $text, suggestions: suggestions, execute: executeSuggestion, edit: { suggestion in
            highlightedSuggestion = suggestion.id
            suggestionsPresented = true
        })
    }

    private var isNewConversation: Bool { manager.current?.messages.isEmpty != false }

    // An empty conversation always needs its input. Navigation and competing
    // sheets may dismiss the presentation without changing that requirement.
    private var composerRequested: Bool {
        !voiceConversationPreparing && !voiceConversationPresented && (isNewConversation || composerPresented)
    }

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
        if suggestion.behavior == .send, manager.send(prompt) {
            text = ""
            collapseComposerAfterSend()
        } else { text = prompt }
    }

    private func sendComposerMessage() {
        guard manager.send(text) else { return }
        text = ""
        collapseComposerAfterSend()
    }

    private func collapseComposerAfterSend() {
        // Release the keyboard before dismissing its sheet. Both state changes
        // happen in the same transaction so the running conversation is visible
        // immediately instead of waiting for the keyboard animation.
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            composerFocused = false
            composerPresented = false
        }
    }

    private var composer: some View {
        @Bindable var manager = manager
        return VStack(alignment: .leading, spacing: 12) {
            if let error = voice.error {
                Text(error).font(.callout).foregroundStyle(.red)
                    .lineLimit(3).accessibilityIdentifier("dictationError")
            } else if voice.recording {
                Label("Écoute…", systemImage: "mic.fill")
                    .font(.callout).foregroundStyle(.red)
                    .accessibilityIdentifier("dictationListening")
            } else if voice.starting {
                Label("Démarrage de la dictée…", systemImage: "mic")
                    .font(.callout).foregroundStyle(.secondary)
                    .accessibilityIdentifier("dictationStarting")
            }
            TextField("Que souhaitez-vous savoir ?", text: $text, axis: .vertical)
                .focused($composerFocused)
                .submitLabel(.send)
                .onSubmit(sendComposerMessage)
                .accessibilityLabel("Message").lineLimit(1...4).padding(.horizontal, 6)
            HStack(spacing: 8) {
                ModelPickerButton(models: manager.models, selectedModel: $manager.selectedModel,
                                  isLoading: manager.isLoadingModels, isDisabled: manager.isStreaming) {
                    await manager.reloadModels()
                }
                if let access = manager.selectedAccess {
                    Button { Task { await manager.chooseModel(manager.models.first { $0.id == access.modelId } ?? ModelOption(id: access.modelId), force: true) } } label: {
                        Text(access.label).font(.caption).lineLimit(1)
                    }.accessibilityLabel("Changer de mode d’accès : \(access.label)").disabled(manager.isStreaming)
                }
                Spacer(minLength: 0)
                if manager.isStreaming {
                    Button("Arrêter", systemImage: "stop.circle.fill") { manager.stop() }.font(.title).frame(minWidth: 44, minHeight: 44)
                } else if voice.recording {
                    Button("Terminer la dictée", systemImage: "stop.circle.fill") { voice.stop() }
                        .foregroundStyle(.red).accessibilityIdentifier("stopDictation")
                        .font(.title).frame(minWidth: 44, minHeight: 44)
                } else if voice.starting {
                    ProgressView().frame(minWidth: 44, minHeight: 44)
                        .accessibilityLabel("Démarrage de la dictée")
                } else if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button("Dicter sur cet appareil", systemImage: "mic") { startVoiceInput() }
                        .accessibilityIdentifier("startDictation")
                        .font(.title3).frame(minWidth: 44, minHeight: 44)
                    Button("Démarrer une conversation vocale", systemImage: "waveform.circle.fill") { startVoiceConversation() }
                        .accessibilityIdentifier("startVoiceConversation")
                        .font(.title).frame(minWidth: 44, minHeight: 44)
                } else {
                    Button("Envoyer", systemImage: "arrow.up.circle.fill") { sendComposerMessage() }
                        .font(.title).frame(minWidth: 44, minHeight: 44)
                        .disabled(manager.selectedModel.isEmpty || (manager.isSynchronizing && manager.selectedModel != LocalModel.id))
                }
            }.labelStyle(.iconOnly).buttonStyle(.plain)
        }
        .padding(.horizontal, 18).padding(.vertical, 10)
        .frame(maxWidth: 760).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        .background(.ultraThinMaterial, ignoresSafeAreaEdges: .all)
    }

    private func openNewConversation() {
        manager.newConversation()
        preferredColumn = .detail
        composerPresented = true
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
        composerPresented = true
        Task {
            await voice.start()
            manager.wantsImmediateVoiceCapture = false
        }
    }
    private func startVoiceConversation() {
        preferredColumn = .detail
        voice.silence()
        if manager.session == nil { manager.authenticationPresented = true; return }
        manager.newConversation()
        // The compact composer is itself a sheet. Dismiss it before presenting
        // the full-screen voice UI so UIKit never restores it at a large detent.
        voiceConversationPreparing = true
        composerPresented = false
        composerFocused = false
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(180))
            guard voiceConversationPreparing else { return }
            voiceConversationPresented = true
            voiceConversationPreparing = false
        }
    }
}


private struct ModelPickerButton: View {
    @Environment(ConversationManager.self) private var manager
    let models: [ModelOption]
    @Binding var selectedModel: String
    let isLoading: Bool
    let isDisabled: Bool
    let reload: @MainActor () async -> Void
    @State private var presented = false
    @State private var detent: PresentationDetent = .medium
    @State private var favorites = ModelFavoriteStore.load()

    var body: some View {
        Button {
            favorites = ModelFavoriteStore.load()
            detent = .medium
            presented = true
        } label: {
            HStack(spacing: 6) {
                if let model = models.first(where: { $0.id == selectedModel }) {
                    ModelProviderLogo(provider: model.presentation.provider, size: 22)
                }
                Text(models.first(where: { $0.id == selectedModel })?.displayName ?? "Choisir un modèle")
                    .lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2)
            }.font(.subheadline).frame(minHeight: 44)
        }
        .disabled(isDisabled)
        .accessibilityLabel("Modèle")
        .accessibilityValue(models.first(where: { $0.id == selectedModel })?.displayName ?? "Aucun modèle choisi")
        .sheet(isPresented: $presented) {
            NavigationStack {
                ModelQuickPicker(models: models, selectedModel: selectedModel, favorites: $favorites,
                                 isLoading: isLoading, reload: reload, expand: { detent = .large }) { model in
                    presented = false
                    Task { await manager.chooseModel(model) }
                }
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
    let isLoading: Bool
    let reload: @MainActor () async -> Void
    let expand: () -> Void
    let select: (ModelOption) -> Void
    @Environment(\.dismiss) private var dismiss
    private var selected: ModelOption? { models.first { $0.id == selectedModel } }
    private var favoriteModels: [ModelOption] { models.filter { favorites.contains($0.id) && $0.id != selectedModel } }

    var body: some View {
        List {
            if let selected {
                Section("Modèle actuel") {
                    Button { select(selected) } label: {
                        ModelPickerRow(model: selected, favorite: favorites.contains(selected.id), trailing: "checkmark")
                    }
                }
            }
            if !favoriteModels.isEmpty {
                Section("Favoris") {
                    ForEach(favoriteModels) { model in
                        Button { select(model) } label: { ModelPickerRow(model: model, favorite: true) }
                    }
                }
            }
            Section {
                NavigationLink {
                    ModelMarketplaceView(models: models, favorites: $favorites, select: select).onAppear(perform: expand)
                } label: {
                    Label("Explorer tous les modèles", systemImage: "sparkles.rectangle.stack")
                        .font(.body.weight(.semibold)).foregroundStyle(MultiVibeTheme.accent)
                }
                Button { Task { await reload() } } label: {
                    Label("Actualiser les modèles", systemImage: "arrow.clockwise")
                }.disabled(isLoading)
            }
        }
        .navigationTitle("Changer de modèle")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fermer") { dismiss() } } }
        .overlay {
            if selected == nil && favoriteModels.isEmpty && models.isEmpty && !isLoading {
                ContentUnavailableView("Aucun modèle disponible", systemImage: "cpu",
                                       description: Text("Actualisez le catalogue ou connectez-vous à votre compte."))
                    .allowsHitTesting(false)
            }
        }
    }
}

private struct ModelPickerRow: View {
    let model: ModelOption
    let favorite: Bool
    var trailing: String? = nil
    var body: some View {
        HStack(spacing: 12) {
            ModelProviderLogo(provider: model.presentation.provider, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.displayName).font(.body.weight(.medium)).foregroundStyle(.primary)
                Text(model.id == LocalModel.id ? "Apple · sur cet appareil" : model.author ?? "Catalogue MultiVibe")
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
    enum Tab: Hashable { case discover, categories, favorites, providers }
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
            ModelProvidersView(models: filtered)
                .tabItem { Label("Fournisseurs", systemImage: "person.2.badge.gearshape") }.tag(Tab.providers)
        }
        .navigationTitle("Modèles")
        .navigationBarTitleDisplayMode(.large)
        .searchable(text: $search, prompt: "Modèles, fournisseurs et usages")
        .task(id: search) { try? await Task.sleep(for: .milliseconds(300)); guard !Task.isCancelled else { return }; await load(reset: true) }
        .safeAreaInset(edge: .bottom) {
            if tab != .providers {
                VStack {
                    if let catalogError { Text(catalogError).font(.caption); Button("Réessayer") { Task { await load(reset: true) } } }
                    if loading { ProgressView() }
                    else if cursor != nil { Button("Charger plus de modèles") { Task { await load(reset: false) } }.padding(8) }
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
                ModelProviderLogo(provider: model.presentation.provider, size: 58, prominent: true)
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
                            ModelProviderLogo(provider: model.presentation.provider, size: 42)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(model.displayName).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
                                Text(model.id == LocalModel.id ? "Sur cet appareil" : model.author ?? "Catalogue MultiVibe")
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
                    ModelProviderLogo(provider: model.presentation.provider, size: 76, prominent: true)
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
                LabeledContent("Accès", value: model.id == LocalModel.id ? "Sur cet appareil" : "Au choix selon disponibilité")
                if let context = (detail ?? model).metadata?.contextLength { LabeledContent("Contexte", value: "\(context) tokens") }
                if let output = (detail ?? model).metadata?.maxOutputTokens { LabeledContent("Sortie maximale", value: "\(output) tokens") }
                if let license = (detail ?? model).metadata?.license { LabeledContent("Licence", value: license) }
                if model.id == LocalModel.id { Label("Traitement sur cet appareil", systemImage: "lock.iphone") }
            }
            Section { Button("Utiliser \(model.displayName)") { select(model) }.buttonStyle(.borderedProminent).frame(maxWidth: .infinity) }
        }
        .navigationTitle("Détails").navigationBarTitleDisplayMode(.inline)
        .task {
            guard model.id != LocalModel.id else { return }
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

private struct ModelProviderLogo: View {
    let provider: ModelProvider
    let size: CGFloat
    var prominent = false
    var body: some View {
        Group {
            if let asset = provider.assetName { Image(asset).resizable().renderingMode(.template).scaledToFit().padding(size * 0.24) }
            else if provider == .multivibe { Image("MultiVibeMark").resizable().scaledToFit().padding(size * 0.16) }
            else { Image(systemName: "cpu").resizable().scaledToFit().padding(size * 0.25) }
        }
        .foregroundStyle(prominent ? .white : .primary)
        .frame(width: size, height: size)
        .background(prominent ? Color.black.opacity(0.22) : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: size * 0.28))
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
                    Text("Apple Foundation Local traite les messages sur cet appareil, sans compte et sans Internet. Les modèles distants transmettent le message et son contexte à MultiVibe et peuvent consommer des crédits. Aucun basculement vers un modèle distant n’est automatique.")
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
private struct NativeMessageContent: View {
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
                    ScrollView(.horizontal) {
                        Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 9) {
                            ForEach(Array(rows.enumerated()), id: \.offset) { row, cells in
                                GridRow {
                                    ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                                        Text(MessageBlock.inline(cell)).font(row == 0 ? .subheadline.bold() : .subheadline)
                                            .padding(.vertical, 3).textSelection(.enabled)
                                    }
                                }
                                if row == 0 { Divider().gridCellUnsizedAxes(.horizontal) }
                            }
                        }.padding(12)
                    }.background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 14))
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

private struct NativeContentView: View {
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

private struct WebSourceCard: View { let source: NativeContentBlock.WebSource; var body: some View { EditorialCard(icon: "safari", title: source.url.host ?? "Source web") { Text(source.excerpt).font(.subheadline).lineLimit(4); Link("Ouvrir la source", destination: source.url); Text("HTTP \(source.status) · \(source.contentType)").font(.caption2).foregroundStyle(.secondary) } } }
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

struct ChatWelcomeView: View {
    @Binding var text: String
    let suggestions: [HomeSuggestion]
    let execute: (HomeSuggestion) -> Void
    let edit: (HomeSuggestion) -> Void
    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                Spacer(minLength: 40)
                Image("MultiVibeMark").renderingMode(.original).resizable().scaledToFit()
                    .frame(width: 96, height: 96).accessibilityHidden(true)
                Text("Comment puis-je\nvous aider ?")
                    .font(.largeTitle.bold()).multilineTextAlignment(.center)
                Text("Une idée, une question, un premier brouillon.")
                    .foregroundStyle(.secondary).multilineTextAlignment(.center)
                VStack(spacing: 10) {
                    ForEach(suggestions) { suggestionButton($0) }
                }.padding(.top, 8)
                Text("Maintenez une suggestion pour personnaliser cette liste.")
                    .font(.caption).foregroundStyle(.tertiary)
            }.frame(maxWidth: 560).padding(24).frame(maxWidth: .infinity)
        }.scrollDismissesKeyboard(.interactively)
    }

    private func suggestionButton(_ suggestion: HomeSuggestion) -> some View {
        Button { execute(suggestion) } label: {
            HStack(spacing: 14) {
                Image(systemName: suggestion.systemImage).foregroundStyle(MultiVibeTheme.accent).frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(suggestion.title).foregroundStyle(.primary)
                    if suggestion.inputSource == .clipboard { Label("Utilise le presse-papiers", systemImage: "doc.on.clipboard").font(.caption2).foregroundStyle(.secondary) }
                }
                Spacer()
                Image(systemName: suggestion.behavior == .send ? "arrow.up.circle.fill" : "arrow.up.left").font(.caption).foregroundStyle(.secondary)
            }.padding(16).background(.background.opacity(0.7), in: RoundedRectangle(cornerRadius: 18))
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
                    if let failure { Text(failure).foregroundStyle(.red) }
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
            }
            .scrollContentBackground(.hidden).background(MultiVibeTheme.softAccent.ignoresSafeArea())
            .navigationTitle("Outils locaux")
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
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { timeline in
            let time = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
            GeometryReader { proxy in
                let shortSide = min(proxy.size.width, proxy.size.height)
                let radius = min(64.0, max(44.0, shortSide * 0.13))
                let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
                let pulse = 0.82 + sin(time * 1.55) * 0.18
                let drift = Angle.degrees(time * 18 + sin(time * 0.48) * 30)
                let counterDrift = Angle.degrees(-time * 12 + cos(time * 0.63) * 38)

                ZStack {
                    shape.inset(by: 3)
                        .strokeBorder(glowGradient(angle: drift), lineWidth: 4.5 + sin(time * 1.1) * 1.5)
                        .blur(radius: reduceTransparency ? 0 : 1.8)
                        .opacity(reduceTransparency ? 0.88 : 1)

                    shape.inset(by: 1)
                        .strokeBorder(glowGradient(angle: counterDrift), lineWidth: 12)
                        .blur(radius: reduceTransparency ? 0 : 10)
                        .opacity(reduceTransparency ? 0.3 : 0.62 * pulse)

                    if !reduceTransparency {
                        shape.inset(by: 8)
                            .strokeBorder(glowGradient(angle: drift + .degrees(110)), lineWidth: 20)
                            .blur(radius: 20)
                            .opacity(0.27 + cos(time * 1.25) * 0.07)
                    }
                }
                .blendMode(reduceTransparency ? .normal : .plusLighter)
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func glowGradient(angle: Angle) -> AngularGradient {
        AngularGradient(
            colors: [
                MultiVibeTheme.accent.opacity(0.25),
                MultiVibeTheme.accent,
                Color(red: 0.45, green: 0.97, blue: 0.73),
                MultiVibeTheme.warmAccent.opacity(0.92),
                MultiVibeTheme.accent.opacity(0.32),
                MultiVibeTheme.warmAccent.opacity(0.6),
                MultiVibeTheme.accent
            ],
            center: .center,
            angle: angle
        )
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

private struct ConversationShortcutLabel: View {
    let title: String
    let systemImage: String
    @ScaledMetric(relativeTo: .caption) private var itemWidth = 88.0
    @ScaledMetric(relativeTo: .body) private var iconSize = 60.0

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: systemImage)
                .font(.title2.weight(.medium))
                .foregroundStyle(MultiVibeTheme.accent)
                .frame(width: iconSize, height: iconSize)
                .background(.background, in: Circle())
                .overlay(Circle().stroke(MultiVibeTheme.accent.opacity(0.15), lineWidth: 1))
                .accessibilityHidden(true)
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(.primary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(width: max(itemWidth, iconSize), alignment: .top)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
    }
}

private struct CloudCreditBalanceSection: View {
    let accountId: String
    @Environment(ConversationManager.self) private var manager
    @Environment(\.scenePhase) private var scenePhase
    @State private var balance: CloudCreditBalance?
    @State private var loading = true
    @State private var failed = false
    @State private var billingPresented = false

    var body: some View {
        Section("MultiVibe Cloud") {
            LabeledContent("Solde disponible") {
                if loading {
                    ProgressView().accessibilityLabel("Chargement du solde")
                } else if let balance {
                    Text(balance.formatted).monospacedDigit()
                        .accessibilityIdentifier("cloudCreditBalance")
                } else {
                    Text("Indisponible").foregroundStyle(.secondary)
                }
            }
            if failed {
                Button("Réessayer") { Task { await reload() } }
            }
            Button("Recharger / S’abonner") { billingPresented = true }
                .accessibilityIdentifier("openCloudBilling")
        }
        .sheet(isPresented: $billingPresented, onDismiss: { Task { await reload() } }) {
            CloudBillingView(accountId: accountId)
        }
        .task(id: scenePhase) {
            if scenePhase == .active { await reload() }
        }
    }

    @MainActor private func reload() async {
        loading = true
        failed = false
        balance = nil
        do {
            let session = try await manager.validSession()
            guard session.accountId == accountId else { throw CancellationError() }
            let result = try await ChatAPI.shared.creditBalance(token: session.accessToken)
            try Task.checkCancellation()
            guard manager.session?.accountId == accountId else { return }
            balance = result
            loading = false
        } catch {
            guard !Task.isCancelled, manager.session?.accountId == accountId else { return }
            loading = false
            failed = true
        }
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


private struct NativeAccountSection: View {
    let accountId: String
    @Environment(ConversationManager.self) private var manager
    @Environment(\.scenePhase) private var scenePhase
    @State private var profile: NativeAccountProfile?
    @State private var loading = true
    @State private var failed = false

    var body: some View {
        Section {
            LabeledContent("Compte") {
                if loading {
                    ProgressView().accessibilityLabel("Chargement du compte")
                } else {
                    Text(profile?.email ?? "E-mail indisponible")
                        .multilineTextAlignment(.trailing)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("accountEmail")
                }
            }
            if let profile {
                ForEach(profile.teams) { team in
                    LabeledContent("Équipe", value: team.name)
                        .accessibilityIdentifier("accountTeam")
                }
            }
            if failed { Button("Réessayer") { Task { await reload() } } }
        }
        .task(id: scenePhase) { if scenePhase == .active { await reload() } }
    }

    @MainActor private func reload() async {
        loading = true
        failed = false
        profile = nil
        do {
            let session = try await manager.validSession()
            guard session.accountId == accountId else { throw CancellationError() }
            let result = try await ChatAPI.shared.accountProfile(token: session.accessToken)
            try Task.checkCancellation()
            guard manager.session?.accountId == accountId, result.accountId == accountId else { throw APIError.invalidResponse }
            profile = result
            loading = false
        } catch {
            guard !Task.isCancelled, manager.session?.accountId == accountId else { return }
            loading = false
            failed = true
        }
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
            Section("Ajouter un provider") {
                ForEach(capabilities) { provider in
                    ForEach(provider.authenticationMethods, id: \.self) { method in
                        Button { setup = .init(provider: provider.id, name: provider.name, method: method) } label: {
                            Label("\(provider.name) · \(method == "api_key" ? "Clé API" : "Abonnement")", systemImage: method == "api_key" ? "key" : "person.crop.circle")
                        }
                    }
                }
            }
            if let error { Section { Text(error).foregroundStyle(.red); Button("Réessayer") { Task { await load() } } } }
        }
        .task { await load() }.refreshable { await load() }
        .sheet(item: $setup) { value in NavigationStack { ProviderConnectView(setup: value) { _ in setup = nil; Task { await load() } } } }
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

private struct ProviderBrowser: UIViewControllerRepresentable {
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
                Text(setup.name).font(.title2.bold())
                Text("Connexion privée, enregistrée dans votre compte MultiVibe.").font(.callout).foregroundStyle(.secondary)
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
                Section { Button(setup.method == "api_key" ? "Valider la clé et connecter" : "Se connecter") { Task { await start() } }.disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (setup.method == "api_key" && key.isEmpty)) }
            }
            if busy { ProgressView() }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }
        .navigationTitle("Connecter un compte").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Annuler") { Task { await cancel(); dismiss() } } } }
        .interactiveDismissDisabled(busy || challenge != nil)
        .onAppear { name = setup.name; accountID = manager.session?.accountId }
        .onDisappear { key = ""; polling?.cancel(); if let challenge { Task { await cancelFlow(challenge) } } }
        .onChange(of: phase) { _, value in if value == .active, let challenge { beginPolling(challenge) } else if value == .background { polling?.cancel() } }
        .sheet(isPresented: $browser) { if let challenge { ProviderBrowser(url: challenge.verificationUrl) } }
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
