import AVFoundation
import SwiftUI

struct ChatView: View {
    @Environment(ConversationManager.self) private var manager
    @Environment(\.scenePhase) private var scenePhase
    private var voice: VoiceController { manager.voice }
    @State private var text = ""
    @State private var search = ""
    var body: some View {
        @Bindable var manager = manager
        NavigationSplitView {
            List(selection: $manager.selection) {
                ForEach(manager.conversations.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) }) { conversation in
                    Label(conversation.title, systemImage: "bubble.left").tag(conversation.id)
                        .swipeActions { Button("Supprimer", role: .destructive) { manager.delete(conversation.id) } }
                }
            }
            .searchable(text: $search, prompt: "Conversations sur cet appareil")
            .navigationTitle("MultiVibe")
            .toolbar {
                ToolbarItem(placement: .primaryAction) { Button("Nouvelle conversation", systemImage: "square.and.pencil") { manager.newConversation() } }
                ToolbarItem(placement: .bottomBar) { Button("Déconnexion") { Task { await manager.logout() } } }
            }
        } detail: {
            VStack(spacing: 0) {
                if manager.current == nil {
                    ContentUnavailableView("Une nouvelle idée ?", systemImage: "sparkles", description: Text("Choisissez un modèle et commencez une conversation."))
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 20) {
                            ForEach(manager.current?.messages ?? []) { message in
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(message.role == "user" ? "Vous" : "MultiVibe").font(.caption.bold()).foregroundStyle(.secondary)
                                    Text(message.content.isEmpty ? "…" : message.content).textSelection(.enabled)
                                    if !message.content.isEmpty { Button("Lire à voix haute", systemImage: "speaker.wave.2") { voice.speak(message.content) }; ShareLink(item: message.content) { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("Partager le message") }
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }.padding()
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
                    else { Button("Envoyer", systemImage: "arrow.up.circle.fill") { manager.send(text); text = "" }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || manager.selectedModel.isEmpty) }
                }.padding()
            }
            .navigationTitle(manager.current?.title ?? "Chat")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Picker("Modèle", selection: $manager.selectedModel) {
                        ForEach(manager.models) { model in Text(model.displayName).tag(model.id) }
                    }.disabled(manager.isStreaming)
                }
            }
        }
        .onChange(of: voice.transcript) { _, value in text = value }
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
        guard scenePhase == .active, manager.session != nil else { return }
        if let draft = manager.pendingDraft { text = draft; manager.pendingDraft = nil }
        if manager.wantsVoice {
            manager.wantsVoice = false
            Task { await voice.start() }
        }
    }
}
