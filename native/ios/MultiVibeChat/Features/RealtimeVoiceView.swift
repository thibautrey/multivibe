import AVFoundation
import SwiftUI

struct RealtimeVoiceView: View {
    var remoteChatID: UUID? = nil
    @Environment(ConversationManager.self) private var manager
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var controller = RealtimeVoiceController()
    @State private var voices: [VoiceOption] = []
    @State private var selectedVoice = "coral"
    @State private var typed = ""
    @State private var settings = false
    @State private var closing = false
    @State private var instanceModel = ""
    private var instances: RemoteInstances { .shared }
    private var messages: [ChatMessage] {
        if let remoteChatID { return instances.chats.first(where: { $0.id == remoteChatID })?.messages ?? [] }
        return manager.current?.messages ?? []
    }
    private var preferenceKey: String {
        let machine = remoteChatID.flatMap { id in instances.chats.first(where: { $0.id == id })?.machine }
        let key = "cloud.multivibe.voice.\(manager.session?.accountId ?? "")"
        return machine.map { key + "." + $0 } ?? key
    }

    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground).ignoresSafeArea()
            if manager.session == nil {
                signedOutContent
            } else {
                RealtimeVoiceCanvas(
                    messages: messages,
                    assistantDraft: controller.partialAssistant,
                    userDraft: controller.partialUser,
                    phase: controller.phase,
                    error: controller.error,
                    muted: controller.muted,
                    closing: closing,
                    typed: $typed,
                    reduceMotion: reduceMotion,
                    openSettings: { settings = true },
                    focusComposer: {},
                    toggleMute: { controller.setMuted(!controller.muted) },
                    submit: sendText,
                    close: close
                )
            }
        }
        .interactiveDismissDisabled(manager.session != nil && controller.phase != .ended)
        .task { await begin() }
        .onDisappear { controller.end() }
        .sheet(isPresented: $settings) {
            NavigationStack {
                List {
                    Section("Conversation") {
                        Picker(remoteChatID == nil ? "Voix" : "Modèle et voix", selection: $selectedVoice) {
                            ForEach(voices) { Text($0.name).tag($0.id) }
                        }
                        if !instanceModel.isEmpty { LabeledContent("Modèle de réponse", value: instanceModel) }
                        if !controller.route.isEmpty {
                            LabeledContent("Connexion", value: controller.route == "instance" ? "Instance distante · Relay WAN" : controller.route == "cascaded" ? "Mode compatible" : "Temps réel")
                        }
                    }
                    Text("La nouvelle voix sera utilisée à la prochaine conversation.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
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
                    .labelStyle(.iconOnly)
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.circle)
            }
            .padding(24)
            Spacer()
            Image("MultiVibeMark")
                .resizable()
                .scaledToFit()
                .frame(width: 82, height: 82)
                .accessibilityHidden(true)
            Text("Parlez avec MultiVibe")
                .font(.title2.weight(.semibold))
                .padding(.top, 24)
            Text("Connectez-vous pour démarrer une conversation vocale.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, 8)
                .padding(.horizontal, 44)
            Button("Se connecter", systemImage: "person.crop.circle") { presentAuthentication() }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding(.top, 28)
                .accessibilityIdentifier("voiceOpenAuthentication")
            Spacer()
        }
    }

    private func begin() async {
        guard let account = manager.session else { return }
        if let remoteChatID { await beginRemote(remoteChatID, account: account); return }
        manager.newConversation()
        guard let conversation = manager.current else {
            controller.error = "Impossible de démarrer maintenant. Réessayez dans un instant."
            return
        }
        selectedVoice = UserDefaults.standard.string(forKey: preferenceKey) ?? "coral"
        do {
            guard await AVAudioApplication.requestRecordPermission() else {
                controller.error = "Autorisez le microphone dans les réglages de l’iPhone."
                return
            }
            let capabilities = try await ChatAPI.shared.voiceCapabilities(token: account.accessToken)
            guard capabilities.enabled else {
                controller.error = "Le mode vocal n’est pas encore disponible pour ce compte."
                return
            }
            voices = capabilities.voices
            if !voices.contains(where: { $0.id == selectedVoice }) {
                selectedVoice = voices.first?.id ?? "coral"
            }
            var model = manager.selectedModel
            if model.isEmpty || model == LocalModel.id {
                if !manager.models.contains(where: { $0.id != LocalModel.id }) {
                    await manager.reloadModels()
                }
                model = manager.models.first(where: { $0.id != LocalModel.id })?.id ?? ""
            }
            guard !model.isEmpty else {
                controller.error = "La conversation vocale est temporairement indisponible. Réessayez dans un instant."
                return
            }
            manager.selectedModel = model
            let session = try await ChatAPI.shared.createVoiceSession(
                conversation: conversation,
                model: model,
                voice: selectedVoice,
                language: Locale.current.identifier,
                token: account.accessToken
            )
            await controller.start(
                session: session,
                history: conversation.messages,
                accountToken: account.accessToken,
                backgroundAudio: capabilities.backgroundAudio
            ) { role, text, id in
                manager.appendVoiceTurn(
                    conversationID: conversation.id,
                    accountID: account.accountId,
                    model: model,
                    role: role,
                    text: text,
                    turnID: id
                )
            }
        } catch {
            controller.error = error.localizedDescription
        }
    }

    private func beginRemote(_ id: UUID, account: NativeSession) async {
        guard let chat = instances.chats.first(where: { $0.id == id }), chat.command == nil, chat.pendingConfiguration == nil else {
            controller.error = "Terminez le tour ou vérifiez sa configuration avant de parler à cette instance."; return
        }
        do {
            guard await AVAudioApplication.requestRecordPermission() else {
                controller.error = "Autorisez le microphone dans les réglages de l’iPhone."; return
            }
            let capabilities = try await instances.voiceCapabilities(chat.machine)
            guard capabilities.enabled, !capabilities.voices.isEmpty else { throw APIError.noModel }
            voices = capabilities.voices; instanceModel = capabilities.llmModel
            selectedVoice = UserDefaults.standard.string(forKey: preferenceKey) ?? "kokoro:ff_siwis"
            if !voices.contains(where: { $0.id == selectedVoice }) { selectedVoice = voices[0].id }
            let connection = try await instances.voiceConnection(chat.machine, voice: selectedVoice)
            await controller.start(session: connection.session, history: chat.messages, accountToken: "", backgroundAudio: false,
                                   headers: connection.headers) { role, text, turnID in
                instances.appendVoiceTurn(chatID: id, accountID: account.accountId, model: capabilities.llmModel, role: role, text: text, turnID: turnID)
            }
        } catch { controller.error = "Le vocal est indisponible sur cette instance. Vérifiez que sa passerelle et ses modèles vocaux sont démarrés." }
    }

    private func saveVoice() {
        guard manager.session != nil else { return }
        UserDefaults.standard.set(selectedVoice, forKey: preferenceKey)
    }

    private func sendText() {
        let value = typed
        typed = ""
        Task { await controller.sendText(value) }
    }

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

enum VoiceCanvasPresentation {
    static func shouldActivate(messages: [ChatMessage], assistantDraft: String) -> Bool {
        if !assistantDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        return messages.contains {
            $0.role == "assistant" &&
                (!$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || $0.nativeContent != nil)
        }
    }

    static func visibleDraft(_ draft: String, messages: [ChatMessage]) -> String? {
        let clean = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return nil }
        let final = messages.last(where: { $0.role == "assistant" })?.content
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard final != clean else { return nil }
        return clean
    }

    static func status(for phase: RealtimeVoiceController.Phase) -> String {
        switch phase {
        case .idle: "Prêt"
        case .connecting: "Connexion…"
        case .listening: "Je vous écoute"
        case .thinking: "Réflexion…"
        case .speaking: "MultiVibe répond"
        case .reconnecting: "Reconnexion…"
        case .awaitingConfirmation: "Validation requise"
        case .ended: "Conversation terminée"
        }
    }

    static func compactStatus(for phase: RealtimeVoiceController.Phase) -> String? {
        switch phase {
        case .connecting, .thinking, .reconnecting, .awaitingConfirmation:
            status(for: phase)
        case .idle, .listening, .speaking, .ended:
            nil
        }
    }
}

private struct RealtimeVoiceCanvas: View {
    let messages: [ChatMessage]
    let assistantDraft: String
    let userDraft: String
    let phase: RealtimeVoiceController.Phase
    let error: String?
    let muted: Bool
    let closing: Bool
    @Binding var typed: String
    let reduceMotion: Bool
    let openSettings: () -> Void
    let focusComposer: () -> Void
    let toggleMute: () -> Void
    let submit: () -> Void
    let close: () -> Void

    @State private var canvasActivated = false
    @State private var assistantSnapshot = ""
    @State private var finalizedAssistantCount = 0
    @FocusState private var composerFocused: Bool
    @Namespace private var orbTransition
    private let latestAnchor = "voice-latest-message"

    var body: some View {
        VStack(spacing: 0) {
            header
            ZStack(alignment: .bottom) {
                if canvasActivated {
                    transcript
                        .transition(.opacity)
                    dockedOrb
                        .transition(.opacity.combined(with: .scale(scale: 0.8, anchor: .bottom)))
                } else {
                    hero
                        .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            composer
        }
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        .onAppear { updatePresentation() }
        .onChange(of: assistantDraft) { _, value in
            if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                assistantSnapshot = value
            }
            updatePresentation()
        }
        .onChange(of: messages) { _, _ in updatePresentation() }
        .onChange(of: assistantMessageCount) { oldValue, newValue in
            if newValue > oldValue { assistantSnapshot = "" }
            finalizedAssistantCount = newValue
            updatePresentation()
        }
        .animation(reduceMotion ? nil : .spring(duration: 0.5, bounce: 0.08), value: canvasActivated)
    }

    private var header: some View {
        HStack {
            Button("Revenir au chat", systemImage: "line.3.horizontal") { close() }
                .labelStyle(.iconOnly)
                .font(.body.weight(.medium))
                .frame(width: 44, height: 44)
                .contentShape(Circle())
                .accessibilityIdentifier("voiceReturnToChat")
            Spacer()
            Button("Réglages vocaux", systemImage: "slider.horizontal.3") { openSettings() }
                .labelStyle(.iconOnly)
                .font(.body.weight(.medium))
                .frame(width: 44, height: 44)
                .contentShape(Circle())
                .accessibilityIdentifier("voiceSettings")
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
        .frame(height: 52)
    }

    private var hero: some View {
        VStack(spacing: 22) {
            Spacer(minLength: 24)
            VoiceOrb(phase: phase, reduceMotion: reduceMotion)
                .matchedGeometryEffect(id: "voice-orb", in: orbTransition)
                .frame(width: 132, height: 132)
                .accessibilityLabel(accessibleOrbLabel)
            VStack(spacing: 8) {
                Text(VoiceCanvasPresentation.status(for: phase))
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.secondary)
                if !userDraft.isEmpty {
                    Text(userDraft)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(3)
                        .padding(.horizontal, 40)
                        .transition(.opacity)
                }
            }
            .frame(minHeight: 58, alignment: .top)
            if let error { errorView(error) }
            Spacer(minLength: 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    ForEach(messages) { message in
                        VoiceCanvasMessage(message: message)
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
                    if let draft = displayedAssistantDraft {
                        VoiceStreamingMessage(content: draft)
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
                    if let error { errorView(error) }
                    Color.clear.frame(height: 94).id(latestAnchor)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onAppear { proxy.scrollTo(latestAnchor, anchor: .bottom) }
            .onChange(of: messages.count) { _, _ in scrollToLatest(proxy) }
            .onChange(of: assistantDraft) { _, _ in scrollToLatest(proxy) }
            .accessibilityIdentifier("voiceTranscript")
        }
    }

    private var dockedOrb: some View {
        VStack(spacing: 7) {
            VoiceOrb(phase: phase, reduceMotion: reduceMotion)
                .matchedGeometryEffect(id: "voice-orb", in: orbTransition)
                .frame(width: 68, height: 68)
                .accessibilityLabel(accessibleOrbLabel)
            if let compactStatus = VoiceCanvasPresentation.compactStatus(for: phase) {
                Text(compactStatus)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .transition(.opacity)
            }
        }
        .padding(.bottom, 5)
        .allowsHitTesting(false)
    }

    private var composer: some View {
        HStack(spacing: 8) {
            Menu("Ajouter", systemImage: "plus") {
                Button("Écrire un message", systemImage: "keyboard") {
                    composerFocused = true
                    focusComposer()
                }
                Button("Réglages vocaux", systemImage: "slider.horizontal.3") { openSettings() }
            }
            .labelStyle(.iconOnly)
            .font(.title3.weight(.medium))
            .frame(width: 42, height: 42)

            HStack(spacing: 6) {
                TextField("Écrire à MultiVibe", text: $typed, axis: .vertical)
                    .focused($composerFocused)
                    .lineLimit(1...3)
                    .submitLabel(.send)
                    .onSubmit(submit)
                    .accessibilityLabel("Message vocal écrit")
                Button("Afficher le clavier", systemImage: "keyboard") {
                    composerFocused = true
                    focusComposer()
                }
                .labelStyle(.iconOnly)
                .foregroundStyle(.secondary)
                .frame(width: 32, height: 32)
            }
            .padding(.leading, 14)
            .padding(.trailing, 7)
            .frame(minHeight: 44)
            .background(Color(uiColor: .secondarySystemBackground), in: Capsule())
            .overlay(Capsule().stroke(.primary.opacity(0.07), lineWidth: 0.7))

            Button(muted ? "Réactiver le micro" : "Couper le micro",
                   systemImage: muted ? "mic.slash.fill" : "mic.fill") {
                toggleMute()
            }
            .labelStyle(.iconOnly)
            .font(.body.weight(.semibold))
            .frame(width: 44, height: 44)
            .background(Color(uiColor: .secondarySystemBackground), in: Circle())
            .accessibilityIdentifier("voiceMute")

            Button("Terminer", systemImage: "xmark") { close() }
                .labelStyle(.iconOnly)
                .font(.body.weight(.bold))
                .foregroundStyle(Color(uiColor: .systemBackground))
                .frame(width: 48, height: 48)
                .background(.primary, in: Circle())
                .disabled(closing)
                .accessibilityIdentifier("voiceEnd")
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(.ultraThinMaterial)
        .accessibilityIdentifier("voiceComposer")
    }

    private var assistantMessageCount: Int {
        messages.lazy.filter { $0.role == "assistant" && (!$0.content.isEmpty || $0.nativeContent != nil) }.count
    }

    private var displayedAssistantDraft: String? {
        VoiceCanvasPresentation.visibleDraft(
            assistantSnapshot.isEmpty ? assistantDraft : assistantSnapshot,
            messages: messages
        )
    }

    private var accessibleOrbLabel: String {
        let status = VoiceCanvasPresentation.status(for: phase)
        let caption = userDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        return caption.isEmpty ? status : status + ". " + caption
    }

    @ViewBuilder private func errorView(_ error: String) -> some View {
        Label(error, systemImage: "exclamationmark.circle")
            .font(.callout)
            .multilineTextAlignment(.leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
            .padding(.horizontal, 8)
    }

    private func updatePresentation() {
        let shouldActivate = VoiceCanvasPresentation.shouldActivate(
            messages: messages,
            assistantDraft: assistantSnapshot.isEmpty ? assistantDraft : assistantSnapshot
        )
        if shouldActivate && !canvasActivated {
            if reduceMotion { canvasActivated = true }
            else { withAnimation(.spring(duration: 0.5, bounce: 0.08)) { canvasActivated = true } }
        }
        if finalizedAssistantCount == 0 { finalizedAssistantCount = assistantMessageCount }
    }

    private func scrollToLatest(_ proxy: ScrollViewProxy) {
        Task { @MainActor in
            await Task.yield()
            if reduceMotion { proxy.scrollTo(latestAnchor, anchor: .bottom) }
            else { withAnimation(.easeOut(duration: 0.22)) { proxy.scrollTo(latestAnchor, anchor: .bottom) } }
        }
    }
}

private struct VoiceCanvasMessage: View {
    let message: ChatMessage

    var body: some View {
        VStack(alignment: message.role == "user" ? .trailing : .leading, spacing: 10) {
            if message.role == "user" {
                Text(message.content)
                    .textSelection(.enabled)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 11)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .padding(.leading, 40)
            } else {
                if let payload = message.nativeContent, payload.version == NativeContentPayload.currentVersion {
                    NativeContentView(payload: payload)
                }
                if !message.content.isEmpty {
                    NativeMessageContent(content: message.content)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: message.role == "user" ? .trailing : .leading)
    }
}

private struct VoiceStreamingMessage: View {
    let content: String

    var body: some View {
        NativeMessageContent(content: content)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel("Réponse en cours")
    }
}

private struct VoiceOrb: View {
    let phase: RealtimeVoiceController.Phase
    let reduceMotion: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { timeline in
            GeometryReader { geometry in
                let side = min(geometry.size.width, geometry.size.height)
                let time = reduceMotion ? 0.4 : timeline.date.timeIntervalSinceReferenceDate
                let speed = phase == .speaking ? 2.0 : phase == .listening ? 1.15 : 0.72
                let wave = CGFloat(sin(time * speed))
                let crossWave = CGFloat(cos(time * speed * 0.73))

                ZStack {
                    Circle()
                        .fill(LinearGradient(
                            colors: [.black, Color(white: 0.12), Color(white: 0.72)],
                            startPoint: .top,
                            endPoint: .bottom
                        ))
                    Ellipse()
                        .fill(Color.black.opacity(0.92))
                        .frame(width: side * 1.28, height: side * 0.66)
                        .blur(radius: side * 0.10)
                        .rotationEffect(.degrees(Double(wave) * 9 - 8))
                        .offset(x: crossWave * side * 0.08, y: -side * 0.18 + wave * side * 0.05)
                    Ellipse()
                        .fill(Color.white.opacity(phase == .speaking ? 0.88 : 0.72))
                        .frame(width: side * 1.35, height: side * 0.48)
                        .blur(radius: side * 0.12)
                        .rotationEffect(.degrees(Double(crossWave) * 8 + 5))
                        .offset(x: wave * side * 0.10, y: side * 0.12 + crossWave * side * 0.04)
                    Circle()
                        .fill(RadialGradient(
                            colors: [Color.white.opacity(0.55), .clear],
                            center: UnitPoint(x: 0.62 + Double(wave) * 0.08, y: 0.72),
                            startRadius: 0,
                            endRadius: side * 0.52
                        ))
                        .blur(radius: side * 0.06)
                    Ellipse()
                        .fill(Color(white: 0.4).opacity(0.44))
                        .frame(width: side * 0.82, height: side * 0.24)
                        .blur(radius: side * 0.08)
                        .offset(x: -crossWave * side * 0.15, y: wave * side * 0.16)
                }
                .clipShape(Circle())
                .overlay(Circle().stroke(.white.opacity(0.16), lineWidth: 0.7))
                .scaleEffect(reduceMotion ? 1 : 1 + wave * (phase == .speaking ? 0.025 : 0.012))
                .shadow(color: .black.opacity(0.18), radius: side * 0.12, y: side * 0.05)
                .drawingGroup(opaque: false, colorMode: .linear)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityIdentifier("voiceOrb")
    }
}

#if DEBUG
struct RealtimeVoiceFixtureView: View {
    @State private var typed = ""
    private let hero = ProcessInfo.processInfo.arguments.contains("-realtime-voice-ui-fixture-hero")

    var body: some View {
        RealtimeVoiceCanvas(
            messages: hero ? [] : Self.sampleMessages,
            assistantDraft: "",
            userDraft: "",
            phase: hero ? .listening : .thinking,
            error: nil,
            muted: false,
            closing: false,
            typed: $typed,
            reduceMotion: false,
            openSettings: {},
            focusComposer: {},
            toggleMute: {},
            submit: { typed = "" },
            close: {}
        )
    }

    private static let sampleMessages: [ChatMessage] = {
        let weather = ChatMessage(
            role: "assistant",
            content: """
            ## ☀️ Météo à Castanet-Tolosan — Lundi 26 octobre 2026

            ```openui
            root = Stack([weather])
            weather = Card("Castanet-Tolosan, Haute-Garonne, France", [temperature, outlook])
            temperature = Metric("Température", "17 °C", "Nuages épais")
            outlook = Table(["Jour", "Lun.", "Mar.", "Mer.", "Jeu."], [["Maximum", "20°", "22°", "19°", "20°"], ["Minimum", "12°", "12°", "4°", "6°"]])
            ```

            Actuellement, **17 °C** avec un ciel plutôt nuageux. Cet après-midi, les températures atteindront **20 °C**, avec quelques éclaircies et très peu de risque de pluie.
            """,
            completion: .completed
        )
        let restaurants = ChatMessage(
            role: "assistant",
            content: """
            ## 🍽 Restaurants ouverts demain à Castanet-Tolosan

            Pour **mardi 27 octobre 2026**, voici les restaurants dont les horaires habituels indiquent une ouverture.

            | Restaurant | Cuisine | Horaires du mardi |
            | --- | --- | --- |
            | Stéphie & Roméo | Italienne | 12h–14h / 19h–20h45 |
            | Le Jardin de Lana | Française, tapas | 10h–15h / 18h–23h |
            | Le 46 | Pizzas, burgers | 9h–14h30 / 18h–22h30 |
            """,
            nativeContent: NativeContentPayload(blocks: [
                .location(.init(latitude: 43.5154, longitude: 1.4970, accuracy: 80, measuredAt: Date()))
            ]),
            completion: .completed
        )
        return [weather, restaurants]
    }()
}
#endif
