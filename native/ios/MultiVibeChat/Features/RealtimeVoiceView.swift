import SwiftUI
import AVFoundation

struct RealtimeVoiceView: View {
    @Environment(ConversationManager.self) private var manager
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var controller = RealtimeVoiceController()
    @State private var voices: [VoiceOption] = []
    @State private var selectedVoice = "coral"
    @State private var typed = ""
    @State private var settings = false

    var body: some View {
        ZStack {
            LinearGradient(colors: [MultiVibeTheme.accent.opacity(0.18), MultiVibeTheme.background], startPoint: .topLeading, endPoint: .bottomTrailing).ignoresSafeArea()
            VStack(spacing: 24) {
                HStack {
                    Button("Réglages vocaux", systemImage: "slider.horizontal.3") { settings = true }.labelStyle(.iconOnly)
                    Spacer()
                    Text(controller.route == "cascaded" ? "Mode compatible" : "Temps réel").font(.caption).foregroundStyle(.secondary)
                }.padding(.horizontal, 24)
                Spacer()
                VoiceOrb(phase: controller.phase, reduceMotion: reduceMotion)
                    .frame(width: 190, height: 190)
                    .accessibilityLabel(status)
                VStack(spacing: 8) {
                    Text(status).font(.headline)
                    Text(controller.partialUser.isEmpty ? controller.partialAssistant : controller.partialUser)
                        .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).lineLimit(4)
                        .frame(minHeight: 64).padding(.horizontal, 32)
                }
                if let error = controller.error { Text(error).foregroundStyle(.red).font(.callout).padding(.horizontal) }
                Spacer()
                HStack(spacing: 12) {
                    TextField("Écrire à MultiVibe", text: $typed).textFieldStyle(.plain).padding(14).background(.regularMaterial, in: Capsule()).onSubmit(sendText)
                    Button(controller.muted ? "Réactiver le micro" : "Couper le micro", systemImage: controller.muted ? "mic.slash.fill" : "mic.fill") { controller.setMuted(!controller.muted) }.labelStyle(.iconOnly).buttonStyle(.bordered).buttonBorderShape(.circle).controlSize(.large)
                    Button("Terminer", systemImage: "xmark") { close() }.labelStyle(.iconOnly).buttonStyle(.borderedProminent).tint(.black).buttonBorderShape(.circle).controlSize(.large)
                }.padding(.horizontal, 20).padding(.bottom, 16)
            }
        }
        .interactiveDismissDisabled(controller.phase != .ended)
        .task { await begin() }
        .onDisappear { controller.end() }
        .sheet(isPresented: $settings) {
            NavigationStack { List { Picker("Voix", selection: $selectedVoice) { ForEach(voices) { Text($0.name).tag($0.id) } }; Text("Le choix de voix sera utilisé à la prochaine conversation.").font(.caption).foregroundStyle(.secondary) }.navigationTitle("Voix").toolbar { Button("Terminé") { saveVoice(); settings = false } } }
        }
    }

    private var status: String {
        switch controller.phase { case .idle: "Prêt"; case .connecting: "Connexion…"; case .listening: "Je vous écoute"; case .thinking: "Je réfléchis"; case .speaking: "MultiVibe répond"; case .reconnecting: "Reconnexion…"; case .awaitingConfirmation: "Validation requise"; case .ended: "Conversation terminée" }
    }
    private func begin() async {
        guard let account = manager.session, let conversation = manager.current else { controller.error = "Connectez-vous pour utiliser la conversation vocale."; return }
        let key = "cloud.multivibe.voice.\(account.accountId)"
        selectedVoice = UserDefaults.standard.string(forKey: key) ?? "coral"
        do {
            guard await AVAudioApplication.requestRecordPermission() else { controller.error = "Autorisez le microphone dans les réglages de l’iPhone."; return }
            let capabilities = try await ChatAPI.shared.voiceCapabilities(token: account.accessToken)
            guard capabilities.enabled else { controller.error = "Le mode vocal n’est pas encore disponible pour ce compte."; return }
            voices = capabilities.voices
            if !voices.contains(where: { $0.id == selectedVoice }) { selectedVoice = voices.first?.id ?? "coral" }
            let model = manager.selectedModel
            let session = try await ChatAPI.shared.createVoiceSession(conversation: conversation, model: model, voice: selectedVoice, language: Locale.current.identifier, token: account.accessToken)
            await controller.start(session: session, history: conversation.messages, accountToken: account.accessToken, backgroundAudio: capabilities.backgroundAudio) { role, text, id in
                manager.appendVoiceTurn(conversationID: conversation.id, accountID: account.accountId, model: model, role: role, text: text, turnID: id)
            }
        } catch { controller.error = error.localizedDescription }
    }
    private func saveVoice() { guard let account=manager.session else{return};UserDefaults.standard.set(selectedVoice,forKey:"cloud.multivibe.voice.\(account.accountId)") }
    private func sendText() { let value=typed;typed="";Task { await controller.sendText(value) } }
    private func close() { controller.end(); dismiss() }
}

private struct VoiceOrb: View {
    let phase: RealtimeVoiceController.Phase
    let reduceMotion: Bool
    @State private var animate = false
    var body: some View {
        Circle().fill(AngularGradient(colors: [.cyan.opacity(0.9), MultiVibeTheme.accent, MultiVibeTheme.warmAccent, .cyan.opacity(0.9)], center: .center))
            .overlay(Circle().fill(.ultraThinMaterial).padding(phase == .speaking ? 28 : 40))
            .shadow(color: MultiVibeTheme.accent.opacity(0.35), radius: phase == .listening ? 34 : 20)
            .scaleEffect(reduceMotion ? 1 : (animate ? scale : 0.94))
            .rotationEffect(reduceMotion ? .zero : .degrees(animate ? 360 : 0))
            .animation(reduceMotion ? nil : .easeInOut(duration: phase == .speaking ? 1.1 : 2.8).repeatForever(autoreverses: true), value: animate)
            .onAppear { animate = true }
    }
    private var scale: CGFloat { phase == .speaking ? 1.08 : phase == .listening ? 1.03 : 1 }
}
