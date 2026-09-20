import AVFoundation
import SwiftUI
import UniformTypeIdentifiers

struct ChatView: View {
    @Environment(ConversationManager.self) private var manager
    @Environment(\.scenePhase) private var scenePhase
    private var voice: VoiceController { manager.voice }
    @State private var text = ""
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
    @State private var followsLatest = true
    @State private var userScrolling = false
    private let latestMessageAnchor = "latest-message"

    var body: some View {
        @Bindable var manager = manager
        NavigationSplitView(preferredCompactColumn: $preferredColumn) {
            List(selection: $manager.selection) {
                ForEach(manager.conversations.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) }) { conversation in
                    Label(conversation.title, systemImage: "bubble.left").tag(conversation.id)
                        .swipeActions(allowsFullSwipe: false) {
                            Button("Supprimer", role: .destructive) { conversationToDelete = conversation }
                        }
                }
            }
            .scrollContentBackground(.hidden)
            .background(MultiVibeTheme.background)
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
                    Button("Documents locaux", systemImage: "doc") { documentsPresented = true }
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
                                        else { NativeMessageContent(content: message.content) }
                                        if let completion = message.completion, completion != .completed {
                                            Text(completion == .streaming ? "Réponse en cours" : completion == .stopped ? "Réponse arrêtée" : "Réponse interrompue")
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                        if let events = message.localEvents, !events.isEmpty {
                                            DisclosureGroup("Étapes locales (\(events.count))") {
                                                ForEach(events) { event in Text(event.detail).font(.caption) }
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

                            }
                            Color.clear.frame(height: 1).id(latestMessageAnchor)
                        }.padding()
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
                if manager.selectedModel == LocalModel.id {
                    VStack(alignment: .leading, spacing: 5) {
                        Label("Calcul sur cet iPhone · sans Internet", systemImage: "iphone")
                        if let reason = manager.localUnavailableReason { Text(reason).foregroundStyle(.secondary) }
                        if manager.isStreaming {
                            ForEach(manager.localEvents.suffix(3)) { event in Text(event.detail).font(.caption) }
                        }
                    }.font(.caption).padding(.horizontal).accessibilityIdentifier("localModelStatus")
                }
                if voice.speaking {
                    Button("Arrêter la lecture", systemImage: "stop.circle") { voice.silence() }.padding(.horizontal)
                }
                if let error = voice.error { Text(error).font(.callout).foregroundStyle(.red).padding() }
                if let error = manager.error { Text(error).font(.callout).foregroundStyle(.red).padding() }
                if let error = manager.modelsError {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(error).font(.callout)
                        Button("Réessayer le chargement des modèles", systemImage: "arrow.clockwise") {
                            Task { await manager.reloadModels() }
                        }.disabled(manager.isLoadingModels || manager.isStreaming)
                    }.padding(.horizontal)
                }
                if manager.isLoadingModels { ProgressView("Chargement des modèles…").padding(.horizontal) }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { composer }
            .background(MultiVibeTheme.background)
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
            Text("La réponse partielle sera remplacée. Votre message ne sera pas ajouté une seconde fois. Cette nouvelle demande peut consommer des crédits.")
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
        .sheet(isPresented: $documentsPresented) { LocalDocumentsView() }
        .sheet(isPresented: $privacyPresented) { NativePrivacyView() }
        .sheet(isPresented: $voicePresented) { VoiceConversationView() }
        .onChange(of: manager.selection) { _, _ in text = "" }
        .onChange(of: voice.transcript) { _, value in if !voicePresented { text = value } }
        .onChange(of: manager.wantsNewConversation) { _, _ in consumeIntent() }
        .onChange(of: manager.wantsVoiceConversation) { _, _ in consumeIntent() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { voice.silence(); if manager.selectedModel == LocalModel.id { manager.stop() } } else { manager.foreground(); consumeIntent() }
        }
        .onAppear { consumeIntent() }
        .onChange(of: manager.wantsVoice) { _, _ in consumeIntent() }
        .onChange(of: manager.pendingDraft) { _, _ in consumeIntent() }
        .onDisappear { voice.silence() }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in voice.silence() }
    }
    private var welcome: some View { ChatWelcomeView(text: $text) }

    private var composer: some View {
        @Bindable var manager = manager
        return VStack(alignment: .leading, spacing: 12) {
            TextField("Que souhaitez-vous savoir ?", text: $text, axis: .vertical)
                .accessibilityLabel("Message").lineLimit(1...8).padding(.horizontal, 6).padding(.top, 6)
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
                        .disabled(manager.selectedModel.isEmpty || manager.isSynchronizing)
                }
            }.labelStyle(.iconOnly).buttonStyle(.plain)
        }
        .padding(12).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 28))
        .overlay(RoundedRectangle(cornerRadius: 28).stroke(.primary.opacity(0.08), lineWidth: 1))
        .frame(maxWidth: 760).padding(.horizontal, 16).padding(.vertical, 10)
        .frame(maxWidth: .infinity).background(MultiVibeTheme.background)
    }

    private func consumeIntent() {
        guard scenePhase == .active, !manager.isRestoring else { return }
        if manager.wantsNewConversation {
            manager.wantsNewConversation = false
            manager.newConversation()
        }
        if manager.wantsVoiceConversation {
            manager.wantsVoiceConversation = false; voice.silence(); voicePresented = true
        }
        if let draft = manager.pendingDraft { text = draft; manager.pendingDraft = nil }
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
                Section("Historique") {
                    Text("L’app conserve une copie des conversations sur cet appareil. La synchronisation automatique, activée avec votre confirmation, envoie les conversations du compte au retour du réseau et télécharge celles du compte. Les conversations invitées nécessitent un import explicite. Les documents importés restent sur cet appareil ; les passages cités dans une réponse font partie de la conversation synchronisée. Ce stockage n’est pas chiffré de bout en bout.")
                    Text("Supprimer une conversation dans l’app retire sa copie locale. Cela ne constitue pas une suppression de compte ni une demande d’effacement de toutes les données détenues par le service.")
                }
                Section("Dictée, lecture et raccourcis") {
                    Text("La dictée exige la reconnaissance sur l’appareil : l’app ne transmet pas l’enregistrement audio à MultiVibe. Vérifiez le texte avant d’appuyer sur Envoyer. La lecture vocale utilise la synthèse vocale du système.")
                    Text("Les raccourcis préparent une action dans l’app au premier plan. Ils n’envoient pas automatiquement votre brouillon. Partager un message utilise la feuille de partage iOS ; vous choisissez sa destination.")
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

/// Shared welcome for signed-out and authenticated empty chats. Suggestions only edit a draft.
struct ChatWelcomeView: View {
    @Binding var text: String
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
                    suggestion("Trouver l’inspiration", icon: "lightbulb", draft: "Aide-moi à trouver des idées pour ")
                    suggestion("M’aider à écrire", icon: "pencil.line", draft: "Aide-moi à rédiger ")
                    suggestion("Comprendre un sujet", icon: "text.book.closed", draft: "Explique-moi simplement ")
                }.padding(.top, 8)
            }.frame(maxWidth: 560).padding(24).frame(maxWidth: .infinity)
        }.scrollDismissesKeyboard(.interactively)
    }

    private func suggestion(_ title: String, icon: String, draft: String) -> some View {
        Button { text = draft } label: {
            HStack(spacing: 14) {
                Image(systemName: icon).foregroundStyle(MultiVibeTheme.accent).frame(width: 24)
                Text(title).foregroundStyle(.primary)
                Spacer()
                Image(systemName: "arrow.up.left").font(.caption).foregroundStyle(.secondary)
            }.padding(16).background(.background.opacity(0.7), in: RoundedRectangle(cornerRadius: 18))
        }.buttonStyle(.plain)
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
                ForEach(manager.localDocuments) { document in
                    NavigationLink(document.name) {
                        ScrollView { Text(document.text).textSelection(.enabled).padding() }
                            .navigationTitle(document.name)
                            .toolbar { ShareLink(item: document.text) { Label("Partager", systemImage: "square.and.arrow.up") } }
                    }
                }
            }
            .navigationTitle("Documents locaux")
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
