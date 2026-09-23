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
    @State private var closing = false

    var body: some View {
        ZStack {
            LinearGradient(colors: [MultiVibeTheme.accent.opacity(0.14), MultiVibeTheme.background], startPoint: .topLeading, endPoint: .bottomTrailing).ignoresSafeArea()
            if manager.session == nil { signedOutContent }
            else { conversationContent }
        }
        .interactiveDismissDisabled(manager.session != nil && controller.phase != .ended)
        .task { await begin() }
        .onDisappear { controller.end() }
        .sheet(isPresented: $settings) {
            NavigationStack {
                List {
                    Picker("Voix", selection: $selectedVoice) { ForEach(voices) { Text($0.name).tag($0.id) } }
                    Text("La nouvelle voix sera utilisée à la prochaine conversation.").font(.caption).foregroundStyle(.secondary)
                }
                .navigationTitle("Voix")
                .toolbar { Button("Terminé") { saveVoice(); settings = false } }
            }
        }
    }

    private var signedOutContent: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Button("Fermer", systemImage: "xmark") { dismiss() }
                    .labelStyle(.iconOnly).buttonStyle(.bordered).buttonBorderShape(.circle)
            }.padding(24)
            Spacer()
            Image("MultiVibeMark")
                .resizable().scaledToFit().frame(width: 82, height: 82)
                .accessibilityHidden(true)
            Text("Parlez avec MultiVibe")
                .font(.title2.weight(.semibold)).padding(.top, 24)
            Text("Connectez-vous pour démarrer une conversation vocale.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                .padding(.top, 8).padding(.horizontal, 44)
            Button("Se connecter", systemImage: "person.crop.circle") { presentAuthentication() }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .padding(.top, 28).accessibilityIdentifier("voiceOpenAuthentication")
            Spacer()
        }
    }

    private var conversationContent: some View {
        VStack(spacing: 24) {
            HStack {
                Button("Réglages vocaux", systemImage: "slider.horizontal.3") { settings = true }
                    .labelStyle(.iconOnly).buttonStyle(.plain)
                Spacer()
                if !controller.route.isEmpty {
                    Text(controller.route == "cascaded" ? "Mode compatible" : "Temps réel")
                        .font(.caption.weight(.medium)).foregroundStyle(.secondary)
                }
            }.padding(.horizontal, 24).padding(.top, 8)
            Spacer()
            VoiceOrb(phase: controller.phase, reduceMotion: reduceMotion)
                .frame(width: 190, height: 190).accessibilityLabel(status)
            VStack(spacing: 8) {
                Text(status).font(.headline)
                Text(controller.partialUser.isEmpty ? controller.partialAssistant : controller.partialUser)
                    .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).lineLimit(4)
                    .frame(minHeight: 64).padding(.horizontal, 32)
            }
            if let error = controller.error {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.callout).foregroundStyle(.primary).multilineTextAlignment(.leading)
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                    .padding(.horizontal, 24)
            }
            Spacer()
            HStack(spacing: 12) {
                TextField("Écrire à MultiVibe", text: $typed)
                    .textFieldStyle(.plain).padding(14).background(.regularMaterial, in: Capsule()).onSubmit(sendText)
                Button(controller.muted ? "Réactiver le micro" : "Couper le micro", systemImage: controller.muted ? "mic.slash.fill" : "mic.fill") { controller.setMuted(!controller.muted) }
                    .labelStyle(.iconOnly).buttonStyle(.bordered).buttonBorderShape(.circle).controlSize(.large)
                Button("Terminer", systemImage: "xmark") { close() }
                    .labelStyle(.iconOnly).buttonStyle(.borderedProminent).tint(.primary)
                    .buttonBorderShape(.circle).controlSize(.large).disabled(closing)
            }.padding(.horizontal, 20).padding(.bottom, 16)
        }
    }

    private var status: String {
        switch controller.phase { case .idle: "Prêt"; case .connecting: "Connexion…"; case .listening: "Je vous écoute"; case .thinking: "Je réfléchis"; case .speaking: "MultiVibe répond"; case .reconnecting: "Reconnexion…"; case .awaitingConfirmation: "Validation requise"; case .ended: "Conversation terminée" }
    }
    private func begin() async {
        guard let account = manager.session else { return }
        manager.newConversation()
        guard let conversation = manager.current else {
            controller.error = "Impossible de démarrer maintenant. Réessayez dans un instant."
            return
        }
        let key = "cloud.multivibe.voice.\(account.accountId)"
        selectedVoice = UserDefaults.standard.string(forKey: key) ?? "coral"
        do {
            guard await AVAudioApplication.requestRecordPermission() else { controller.error = "Autorisez le microphone dans les réglages de l’iPhone."; return }
            let capabilities = try await ChatAPI.shared.voiceCapabilities(token: account.accessToken)
            guard capabilities.enabled else { controller.error = "Le mode vocal n’est pas encore disponible pour ce compte."; return }
            voices = capabilities.voices
            if !voices.contains(where: { $0.id == selectedVoice }) { selectedVoice = voices.first?.id ?? "coral" }
            var model = manager.selectedModel
            if model.isEmpty || model == LocalModel.id {
                if !manager.models.contains(where: { $0.id != LocalModel.id }) { await manager.reloadModels() }
                model = manager.models.first(where: { $0.id != LocalModel.id })?.id ?? ""
            }
            guard !model.isEmpty else {
                controller.error = "La conversation vocale est temporairement indisponible. Réessayez dans un instant."
                return
            }
            manager.selectedModel = model
            let session = try await ChatAPI.shared.createVoiceSession(conversation: conversation, model: model, voice: selectedVoice, language: Locale.current.identifier, token: account.accessToken)
            await controller.start(session: session, history: conversation.messages, accountToken: account.accessToken, backgroundAudio: capabilities.backgroundAudio) { role, text, id in
                manager.appendVoiceTurn(conversationID: conversation.id, accountID: account.accountId, model: model, role: role, text: text, turnID: id)
            }
        } catch { controller.error = error.localizedDescription }
    }
    private func saveVoice() { guard let account=manager.session else{return};UserDefaults.standard.set(selectedVoice,forKey:"cloud.multivibe.voice.\(account.accountId)") }
    private func sendText() { let value=typed;typed="";Task { await controller.sendText(value) } }
    private func presentAuthentication() {
        dismiss()
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            manager.authenticationPresented = true
        }
    }
    private func close() {
        guard !closing else { return }
        closing = true
        Task { await controller.endWithCue(); dismiss() }
    }
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
