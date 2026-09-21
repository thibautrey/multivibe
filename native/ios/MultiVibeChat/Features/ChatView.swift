import AVFoundation
import ContactsUI
import EventKit
import EventKitUI
import MapKit
import SwiftUI
import UniformTypeIdentifiers

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
    @State private var voicePresented = false
    @State private var documentsPresented = false
    @State private var privacyPresented = false
    @State private var suggestions = HomeSuggestionStore.load()
    @State private var suggestionsPresented = false
    @State private var highlightedSuggestion: UUID?
    @State private var selectionContent: SelectableMessage?
    @State private var followsLatest = true
    @State private var userScrolling = false
    @State private var composerPresented = true
    private static let compactComposerHeight: CGFloat = 126
    private static let compactComposerDetent = PresentationDetent.height(compactComposerHeight)
    private let latestMessageAnchor = "latest-message"

    var body: some View {
        @Bindable var manager = manager
        NavigationSplitView(preferredCompactColumn: $preferredColumn) {
            List(selection: $manager.selection) {
                Section {
                    Button("Mémoire", systemImage: "brain") { manager.memoryPresented = true }.accessibilityIdentifier("openMemory")
                }

                ForEach(manager.conversations.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) }) { conversation in
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
                VStack {
                    if let status = manager.historyStatus { Text(status).font(.caption) }
                    if manager.hasHistoryConflict {
                        Button("Conserver les deux versions") { confirmHistoryConflict = true }
                            .disabled(manager.isSynchronizing || manager.isStreaming || manager.isRestoring)
                    }
                }.padding().background(.regularMaterial)
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) { Button("Nouvelle conversation", systemImage: "square.and.pencil") { manager.newConversation() } }
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
                ToolbarItem(placement: .bottomBar) {
                    if manager.session != nil { Button("Déconnexion") { Task { await manager.logout() } } }
                    else { Button("Se connecter") { manager.authenticationPresented = true }.accessibilityIdentifier("openAuthentication") }
                }
                ToolbarItem(placement: .secondaryAction) {
                    Button("Documents et outils locaux", systemImage: "doc") { documentsPresented = true }
                }
            }
        } detail: {
            VStack(spacing: 0) {
                if manager.current?.messages.isEmpty != false {
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
                                        if message.content.isEmpty && message.completion == .streaming { ProgressView("MultiVibe réfléchit…") }
                                        else {
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
                                        if let completion = message.completion, completion != .completed {
                                            Text(completion == .streaming ? "Réponse en cours" : completion == .stopped ? "Réponse arrêtée" : "Réponse interrompue")
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
                if let error = voice.error { Text(error).font(.callout).foregroundStyle(.red).padding() }
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
                if !composerPresented {
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
                    Button("Nouvelle conversation", systemImage: "square.and.pencil") { manager.newConversation() }
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
        .sheet(isPresented: $manager.memoryPresented) { MemoryView() }
        .sheet(item: Binding(get: { manager.memoryPresented ? nil : manager.memoryDraft }, set: { manager.memoryDraft = $0 })) { draft in MemoryEditor(draft: draft) }
        .sheet(isPresented: $documentsPresented) { LocalDocumentsView() }
        .sheet(isPresented: $privacyPresented) { NativePrivacyView() }
        .sheet(isPresented: $voicePresented) { VoiceConversationView() }
        .sheet(isPresented: $suggestionsPresented) {
            SuggestionsEditor(suggestions: $suggestions, highlighted: highlightedSuggestion) {
                HomeSuggestionStore.save(suggestions)
            }
        }
        .sheet(item: $selectionContent) { SelectableMessageSheet(message: $0) }
        .sheet(isPresented: Binding(get: { composerPresented && preferredColumn == .detail && !modalIsActive }, set: { presented in
            if !presented && preferredColumn == .detail && !modalIsActive { composerPresented = false }
        })) {
            composer
            .presentationDetents([Self.compactComposerDetent])
            .presentationDragIndicator(.visible)
            .presentationContentInteraction(.scrolls)
            .presentationBackgroundInteraction(.enabled(upThrough: Self.compactComposerDetent))
            .presentationCornerRadius(30)
            .presentationBackground(.clear)
        }
        .onChange(of: modalIsActive) { _, active in
            if !active { Task { @MainActor in await Task.yield(); composerPresented = true } }
        }
        .onChange(of: manager.selection) { _, selection in
            if shortcutDraftConversation != selection { text = "" }
        }
        .onChange(of: voice.transcript) { _, value in if !voicePresented { text = value } }
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

    private var modalIsActive: Bool {
        manager.authenticationPresented || manager.internetApproval != nil || manager.memoryPresented || manager.memoryDraft != nil ||
            documentsPresented || privacyPresented || voicePresented || suggestionsPresented || selectionContent != nil
    }

    private func executeSuggestion(_ suggestion: HomeSuggestion) {
        var prompt = suggestion.instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        if suggestion.inputSource == .clipboard {
            guard let clipboard = UIPasteboard.general.string, !clipboard.isEmpty else {
                text = prompt; return
            }
            prompt += prompt.isEmpty ? clipboard : ": " + clipboard
        } else if suggestion.behavior == .prepare { prompt += prompt.isEmpty ? "" : " " }
        if suggestion.behavior == .send, manager.send(prompt) { text = "" }
        else { text = prompt }
    }


    private var composer: some View {
        @Bindable var manager = manager
        return VStack(alignment: .leading, spacing: 12) {
            TextField("Que souhaitez-vous savoir ?", text: $text, axis: .vertical)
                .accessibilityLabel("Message").lineLimit(1...4).padding(.horizontal, 6).padding(.top, 2)
            HStack(spacing: 8) {
                Menu {
                    Picker("Modèle", selection: $manager.selectedModel) {
                        Text("Choisir un modèle").tag("")
                        ForEach(manager.models) { model in Text(model.displayName).tag(model.id) }
                    }
                    Button("Actualiser les modèles", systemImage: "arrow.clockwise") { Task { await manager.reloadModels() } }
                        .disabled(manager.isLoadingModels)
                } label: {
                    HStack(spacing: 5) {
                        Text(manager.models.first(where: { $0.id == manager.selectedModel })?.displayName ?? "Choisir un modèle").lineLimit(1)
                        Image(systemName: "chevron.down").font(.caption2)
                    }.font(.subheadline).frame(minHeight: 44)
                }.disabled(manager.isStreaming).accessibilityLabel("Modèle")
                Spacer(minLength: 0)
                Button(voice.recording ? "Terminer la dictée" : "Dicter sur cet appareil", systemImage: voice.recording ? "mic.fill" : "mic") {
                    if voice.recording { voice.stop() } else { Task { await voice.start() } }
                }.frame(minWidth: 44, minHeight: 44)
                if manager.isStreaming {
                    Button("Arrêter", systemImage: "stop.circle.fill") { manager.stop() }.font(.title).frame(minWidth: 44, minHeight: 44)
                } else if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button("Conversation vocale", systemImage: "waveform.circle.fill") { voice.silence(); voicePresented = true }
                        .font(.title).frame(minWidth: 44, minHeight: 44)
                } else {
                    Button("Envoyer", systemImage: "arrow.up.circle.fill") { if manager.send(text) { text = "" } }
                        .font(.title).frame(minWidth: 44, minHeight: 44)
                        .disabled(manager.selectedModel.isEmpty || (manager.isSynchronizing && manager.selectedModel != LocalModel.id))
                }
            }.labelStyle(.iconOnly).buttonStyle(.plain)
        }
        .padding(.horizontal, 18).padding(.top, 2).padding(.bottom, 6)
        .frame(maxWidth: 760).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(.ultraThinMaterial, ignoresSafeAreaEdges: .all)
    }

    private func consumeIntent() {
        guard scenePhase == .active, !manager.isRestoring else { return }
        do {
            if let request = try manager.applyNativeShortcut() {
                voice.silence()
                voicePresented = false; documentsPresented = false; privacyPresented = false
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
            manager.newConversation()
        }
        if manager.wantsVoiceConversation {
            manager.wantsVoiceConversation = false; voice.silence(); voicePresented = true
        }
        if let draft = manager.pendingDraft {
            shortcutDraftConversation = manager.selection
            text = draft; manager.pendingDraft = nil
        }
        if manager.wantsVoice {
            manager.wantsVoice = false
            Task { await voice.start() }
        }
    }
}

/// Push-to-talk conversation mode deliberately keeps sending separate from
/// recognition. Siri, Shortcuts and the toolbar all open this same interface.
struct VoiceConversationView: View {
    @Environment(ConversationManager.self) private var manager
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var draft = ""
    @State private var awaitingReply = false
    @State private var replyConversation: UUID?
    @State private var replyMessage: UUID?
    @State private var response = ""
    private var voice: VoiceController { manager.voice }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label(status, systemImage: voice.recording ? "mic.fill" : voice.speaking ? "speaker.wave.2.fill" : "waveform")
                        .font(.title2).foregroundStyle(MultiVibeTheme.accent)
                        .accessibilityAddTraits(.updatesFrequently)
                    Text("La dictée reste sur cet appareil. Seul le bouton Envoyer transmet votre message au modèle sélectionné.")
                        .font(.callout).foregroundStyle(.secondary)
                    Text(manager.selectedModel.isEmpty ? "Aucun modèle disponible" : manager.selectedModel).font(.caption)
                }
                Section("Votre message") {
                    TextField("Dictez ou saisissez votre message", text: $draft, axis: .vertical).lineLimit(3...10)
                    Button(voice.recording ? "Terminer la dictée" : "Dicter", systemImage: voice.recording ? "stop.circle" : "mic") {
                        if voice.recording { voice.stop() } else { Task { await voice.start() } }
                    }.disabled(manager.isStreaming || scenePhase != .active)
                    Button("Envoyer et écouter la réponse", systemImage: "arrow.up.circle.fill") {
                        voice.silence()
                        if manager.send(draft) {
                            replyConversation = manager.selection
                            replyMessage = manager.current?.messages.last?.id
                            awaitingReply = true; draft = ""; response = ""
                        }
                    }.disabled(manager.isStreaming || manager.selectedModel.isEmpty || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if manager.isStreaming { Button("Arrêter la réponse", systemImage: "stop.circle") { awaitingReply = false; manager.stop() } }
                if !response.isEmpty { Section("Réponse") { Text(response).textSelection(.enabled) } }
                if voice.speaking { Button("Arrêter la lecture", systemImage: "speaker.slash") { voice.silence() } }
                if let error = voice.error ?? manager.error { Section { Text(error).foregroundStyle(.red) } }
            }
            .scrollContentBackground(.hidden).background(MultiVibeTheme.background)
            .navigationTitle("Conversation vocale")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fermer") { voice.silence(); dismiss() } } }
        }
        .task(id: canStartAssistantCapture) {
            guard canStartAssistantCapture else { return }
            await voice.start()
            // Keep a deferred request while inactive or restoring. Consume only
            // after permission handling, so changing this task's identity cannot
            // cancel its own microphone activation before it has completed.
            guard !Task.isCancelled else { return }
            manager.wantsImmediateVoiceCapture = false
        }
        .onChange(of: voice.transcript) { _, value in draft = value }
        .onChange(of: manager.isStreaming) { _, streaming in
            guard !streaming, awaitingReply else { return }
            awaitingReply = false
            guard scenePhase == .active, manager.error == nil,
                  let replyMessage, manager.completedReply == replyMessage,
                  let conversation = manager.conversations.first(where: { $0.id == replyConversation }),
                  let reply = conversation.messages.first(where: { $0.id == replyMessage }),
                  !reply.content.isEmpty else { return }
            response = reply.content; voice.speak(reply.content)
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { awaitingReply = false; voice.silence() } }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in awaitingReply = false; voice.silence() }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.mediaServicesWereLostNotification)) { _ in awaitingReply = false }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.mediaServicesWereResetNotification)) { _ in awaitingReply = false }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification)) { notification in
            if VoiceSystemEvent.decode(notification) == .routeLost { awaitingReply = false }
        }
        .onDisappear { awaitingReply = false; voice.silence() }
    }
    private var canStartAssistantCapture: Bool {
        manager.wantsImmediateVoiceCapture && scenePhase == .active &&
            !manager.isRestoring && !manager.isStreaming
    }
    private var status: String {
        if voice.recording { return "À votre écoute" }
        if manager.isStreaming { return "Réponse en cours" }
        if voice.speaking { return "MultiVibe vous répond" }
        return "Prêt à discuter"
    }
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
                let radius = min(52.0, min(proxy.size.width, proxy.size.height) * 0.08)
                let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
                let pulse = 0.88 + sin(time * 1.35) * 0.12
                let drift = Angle.degrees(time * 14 + sin(time * 0.43) * 24)
                let counterDrift = Angle.degrees(-time * 9 + cos(time * 0.57) * 31)

                ZStack {
                    shape.inset(by: 3)
                        .strokeBorder(glowGradient(angle: drift), lineWidth: 3.5 + sin(time * 0.9) * 1.2)
                        .blur(radius: reduceTransparency ? 0 : 1.6)
                        .opacity(reduceTransparency ? 0.82 : 0.95)

                    shape.inset(by: 1)
                        .strokeBorder(glowGradient(angle: counterDrift), lineWidth: 9)
                        .blur(radius: reduceTransparency ? 0 : 8)
                        .opacity(reduceTransparency ? 0.25 : 0.48 * pulse)

                    if !reduceTransparency {
                        shape.inset(by: 7)
                            .strokeBorder(glowGradient(angle: drift + .degrees(110)), lineWidth: 16)
                            .blur(radius: 17)
                            .opacity(0.2 + cos(time * 1.1) * 0.045)
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
