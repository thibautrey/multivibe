import AVFoundation
import SwiftUI

struct ChatView: View {
    @Environment(ConversationManager.self) private var manager
    @Environment(\.scenePhase) private var scenePhase
    private var voice: VoiceController { manager.voice }
    @State private var text = ""
    @State private var search = ""
    @State private var conversationToDelete: Conversation?
    @State private var confirmHistorySync = false
    @State private var retryTarget: RetryTarget?
    private struct RetryTarget { let conversation: UUID; let message: UUID }
    @State private var voicePresented = false
    @State private var followsLatest = true
    @State private var userScrolling = false
    private let latestMessageAnchor = "latest-message"

    var body: some View {
        @Bindable var manager = manager
        NavigationSplitView {
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
            .navigationTitle("MultiVibe")
            .safeAreaInset(edge: .bottom) {
                if let status = manager.historyStatus { Text(status).font(.caption).padding().background(.regularMaterial) }
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) { Button("Nouvelle conversation", systemImage: "square.and.pencil") { manager.newConversation() } }
                ToolbarItem(placement: .secondaryAction) {
                    Button("Synchroniser l’historique", systemImage: "arrow.triangle.2.circlepath") { confirmHistorySync = true }
                        .disabled(manager.isSynchronizing || manager.isStreaming || manager.isRestoring)
                }
                ToolbarItem(placement: .bottomBar) { Button("Déconnexion") { Task { await manager.logout() } } }
            }
        } detail: {
            VStack(spacing: 0) {
                if manager.current == nil {
                    ContentUnavailableView("Une nouvelle idée ?", systemImage: "sparkles", description: Text("Choisissez un modèle et commencez une conversation."))
                } else {
                    ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 20) {
                            ForEach(manager.current?.messages ?? []) { message in
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(message.role == "user" ? "Vous" : "MultiVibe").font(.caption.bold()).foregroundStyle(.secondary)
                                    Text(message.content.isEmpty ? "…" : message.content).textSelection(.enabled)
                                    if let completion = message.completion {
                                        Text(completion == .streaming ? "Réponse en cours" : completion == .completed ? "Réponse terminée" : completion == .stopped ? "Réponse arrêtée" : "Réponse interrompue par une erreur")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    if message.canRetry && manager.current?.messages.last?.id == message.id {
                                        Button("Réessayer", systemImage: "arrow.clockwise") {
                                            if let conversation = manager.selection {
                                                retryTarget = RetryTarget(conversation: conversation, message: message.id)
                                            }
                                        }.disabled(manager.isStreaming)
                                    }
                                    if !message.content.isEmpty { Button("Lire à voix haute", systemImage: "speaker.wave.2") { voice.speak(message.content) }; ShareLink(item: message.content) { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("Partager le message") }
                                }.frame(maxWidth: .infinity, alignment: .leading)
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
                if voice.speaking {
                    Button("Arrêter la lecture", systemImage: "stop.circle") { voice.silence() }.padding(.horizontal)
                }
                if let error = voice.error { Text(error).font(.callout).foregroundStyle(.red).padding() }
                if let error = manager.error { Text(error).font(.callout).foregroundStyle(.red).padding() }
                HStack(alignment: .bottom) {
                    Button(voice.recording ? "Terminer la dictée" : "Dicter sur cet appareil", systemImage: voice.recording ? "mic.fill" : "mic") {
                        if voice.recording { voice.stop() } else { Task { await voice.start() } }
                    }
                    TextField("Message", text: $text, axis: .vertical).lineLimit(1...8).textFieldStyle(.roundedBorder)
                    if manager.isStreaming { Button("Arrêter", systemImage: "stop.circle.fill") { manager.stop() } }
                    else { Button("Envoyer", systemImage: "arrow.up.circle.fill") { if manager.send(text) { text = "" } }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || manager.selectedModel.isEmpty) }
                }.padding()
            }
            .background(MultiVibeTheme.background)
            .navigationTitle(manager.current?.title ?? "Chat")
            .toolbar {
                ToolbarItem(placement: .secondaryAction) { Button("Conversation vocale", systemImage: "waveform") { voice.silence(); voicePresented = true } }
                ToolbarItem(placement: .primaryAction) {
                    Picker("Modèle", selection: $manager.selectedModel) {
                        Text("Choisir un modèle").tag("")
                        ForEach(manager.models) { model in Text(model.displayName).tag(model.id) }
                    }.disabled(manager.isStreaming)
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
        .confirmationDialog("Synchroniser avec votre compte ?", isPresented: $confirmHistorySync, titleVisibility: .visible) {
            Button("Synchroniser") { Task { await manager.synchronizeHistory() } }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Les conversations de cet appareil seront envoyées à MultiVibe et celles de votre compte seront téléchargées. Elles ne sont pas chiffrées de bout en bout. Les modifications concurrentes ne seront pas écrasées automatiquement.")
        }
        .sheet(isPresented: $voicePresented) { VoiceConversationView() }
        .onChange(of: manager.selection) { _, _ in text = "" }
        .onChange(of: voice.transcript) { _, value in if !voicePresented { text = value } }
        .onChange(of: manager.wantsNewConversation) { _, _ in consumeIntent() }
        .onChange(of: manager.wantsVoiceConversation) { _, _ in consumeIntent() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { voice.silence() } else { consumeIntent() }
        }
        .onAppear { consumeIntent() }
        .onChange(of: manager.wantsVoice) { _, _ in consumeIntent() }
        .onChange(of: manager.pendingDraft) { _, _ in consumeIntent() }
        .onDisappear { voice.silence() }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in voice.silence() }
    }
    private func consumeIntent() {
        guard scenePhase == .active, manager.session != nil, !manager.isRestoring else { return }
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
        .onDisappear { awaitingReply = false; voice.silence() }
    }
    private var canStartAssistantCapture: Bool {
        manager.wantsImmediateVoiceCapture && scenePhase == .active &&
            manager.session != nil && !manager.isRestoring && !manager.isStreaming
    }
    private var status: String {
        if voice.recording { return "À votre écoute" }
        if manager.isStreaming { return "Réponse en cours" }
        if voice.speaking { return "MultiVibe vous répond" }
        return "Prêt à discuter"
    }
}
