import AVFoundation
import SwiftUI

struct VoiceAudioConfiguration: Codable, Equatable, Sendable {
    var transcriptionModel: String
    var synthesisModel: String
    var voice: String
}

enum VoiceAudioConfigurationStore {
    private static func key(_ scope: String) -> String { scope + ".audio-configuration.v1" }
    static func load(scope: String, defaults: UserDefaults = .standard) -> VoiceAudioConfiguration? {
        guard let data = defaults.data(forKey: key(scope)) else { return nil }
        return try? JSONDecoder().decode(VoiceAudioConfiguration.self, from: data)
    }
    static func save(_ value: VoiceAudioConfiguration, scope: String, defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        defaults.set(data, forKey: key(scope))
    }
}

struct VoiceAudioCatalog: Equatable, Sendable {
    static let automaticModel = VoiceModelOption(id: "automatic", name: "Gestion automatique")
    let transcriptionModels: [VoiceModelOption]
    let synthesisModels: [VoiceModelOption]
    let voices: [VoiceOption]

    init(voices: [VoiceOption], transcriptionModels: [VoiceModelOption] = [],
         synthesisModels: [VoiceModelOption] = [], legacyTranscriptionModel: String? = nil) {
        self.voices = voices
        if transcriptionModels.isEmpty {
            self.transcriptionModels = legacyTranscriptionModel.map {
                [VoiceModelOption(id: $0, name: Self.modelName($0))]
            } ?? [Self.automaticModel]
        } else {
            self.transcriptionModels = transcriptionModels
        }
        if synthesisModels.isEmpty {
            let inferred = voices.map(Self.synthesisModel).reduce(into: [VoiceModelOption]()) { result, option in
                if !result.contains(where: { $0.id == option.id }) { result.append(option) }
            }
            self.synthesisModels = inferred.isEmpty ? [Self.automaticModel] : inferred
        } else {
            self.synthesisModels = synthesisModels
        }
    }

    func voices(for synthesisModel: String) -> [VoiceOption] {
        let matching = voices.filter { Self.synthesisModel($0).id == synthesisModel }
        return matching.isEmpty && synthesisModels.count == 1 ? voices : matching
    }

    func normalized(_ stored: VoiceAudioConfiguration?, preferredVoice: String? = nil) -> VoiceAudioConfiguration {
        let transcription = stored.flatMap { value in
            transcriptionModels.contains(where: { $0.id == value.transcriptionModel }) ? value.transcriptionModel : nil
        } ?? transcriptionModels[0].id
        let voiceCandidate = stored?.voice ?? preferredVoice
        let inferredSynthesis = voiceCandidate.flatMap { id in voices.first(where: { $0.id == id }) }.map(Self.synthesisModel)
        let synthesis = stored.flatMap { value in
            synthesisModels.contains(where: { $0.id == value.synthesisModel }) ? value.synthesisModel : nil
        } ?? inferredSynthesis.flatMap { inferred in
            synthesisModels.contains(where: { $0.id == inferred.id }) ? inferred.id : nil
        } ?? synthesisModels[0].id
        let compatible = voices(for: synthesis)
        let voice = voiceCandidate.flatMap { id in compatible.contains(where: { $0.id == id }) ? id : nil }
            ?? compatible.first?.id ?? voices.first?.id ?? ""
        return VoiceAudioConfiguration(transcriptionModel: transcription, synthesisModel: synthesis, voice: voice)
    }

    static func synthesisModel(_ voice: VoiceOption) -> VoiceModelOption {
        if let model = voice.model, !model.isEmpty { return .init(id: model, name: modelName(model)) }
        if voice.id.hasPrefix("kokoro:") { return .init(id: "Kokoro-82M-bf16", name: "Kokoro 82M") }
        if voice.id.hasPrefix("qwen:") { return .init(id: "Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16", name: "Qwen3 TTS 0.6B") }
        return automaticModel
    }

    static func modelName(_ id: String) -> String {
        switch id {
        case "whisper-large-v3-turbo-asr-4bit": "Whisper large v3 turbo"
        case "Kokoro-82M-bf16": "Kokoro 82M"
        case "Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16": "Qwen3 TTS 0.6B"
        default: id
        }
    }
}

struct RealtimeVoiceView: View {
    var remoteChatID: UUID? = nil
    @Environment(ConversationManager.self) private var manager
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var controller = RealtimeVoiceController()
    @State private var voices: [VoiceOption] = []
    @State private var transcriptionModels: [VoiceModelOption] = []
    @State private var synthesisModels: [VoiceModelOption] = []
    @State private var selectedTranscriptionModel = ""
    @State private var selectedSynthesisModel = ""
    @State private var selectedVoice = "coral"
    @State private var typed = ""
    @State private var settings = false
    @State private var closing = false
    @State private var instanceModel = ""
    @State private var preparedModel = ""
    @State private var preparedBackgroundAudio = false
    @State private var configurationRequired = false
    @State private var configurationReady = false
    @State private var sessionStarted = false
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
    private var audioCatalog: VoiceAudioCatalog {
        VoiceAudioCatalog(voices: voices, transcriptionModels: transcriptionModels, synthesisModels: synthesisModels)
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
                    audioLevel: controller.orbAudioLevel,
                    typed: $typed,
                    reduceMotion: reduceMotion,
                    openSettings: openSettings,
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
            VoiceAudioConfigurationView(
                catalog: audioCatalog,
                selectedTranscriptionModel: $selectedTranscriptionModel,
                selectedSynthesisModel: $selectedSynthesisModel,
                selectedVoice: $selectedVoice,
                responseModel: instanceModel.isEmpty ? preparedModel : instanceModel,
                route: controller.route,
                required: configurationRequired,
                cancel: cancelConfiguration,
                confirm: confirmConfiguration
            )
            .interactiveDismissDisabled(configurationRequired)
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
        do {
            if let remoteChatID { try await prepareRemote(remoteChatID); return }
            let capabilities = try await ChatAPI.shared.voiceCapabilities(token: account.accessToken)
            guard capabilities.enabled else {
                controller.error = "Le mode vocal n’est pas encore disponible pour ce compte."
                return
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
            preparedModel = model
            preparedBackgroundAudio = capabilities.backgroundAudio
            await configure(
                VoiceAudioCatalog(
                    voices: capabilities.voices,
                    transcriptionModels: capabilities.transcriptionModels ?? [],
                    synthesisModels: capabilities.synthesisModels ?? []
                ),
                preferredVoice: "coral"
            )
        } catch {
            controller.error = error.localizedDescription
        }
    }

    private func prepareRemote(_ id: UUID) async throws {
        guard let chat = instances.chats.first(where: { $0.id == id }), chat.command == nil, chat.pendingConfiguration == nil else {
            controller.error = "Terminez le tour ou vérifiez sa configuration avant de parler à cette instance."
            return
        }
        let capabilities = try await instances.voiceCapabilities(chat.machine)
        guard capabilities.enabled, !capabilities.voices.isEmpty else { throw APIError.noModel }
        instanceModel = capabilities.llmModel
        preparedModel = capabilities.llmModel
        preparedBackgroundAudio = capabilities.backgroundAudio
        await configure(
            VoiceAudioCatalog(
                voices: capabilities.voices,
                transcriptionModels: capabilities.transcriptionModels ?? [],
                synthesisModels: capabilities.synthesisModels ?? [],
                legacyTranscriptionModel: capabilities.transcriptionModel
            ),
            preferredVoice: "kokoro:ff_siwis"
        )
    }

    private func configure(_ catalog: VoiceAudioCatalog, preferredVoice: String) async {
        voices = catalog.voices
        transcriptionModels = catalog.transcriptionModels
        synthesisModels = catalog.synthesisModels
        let stored = VoiceAudioConfigurationStore.load(scope: preferenceKey)
        let legacyVoice = UserDefaults.standard.string(forKey: preferenceKey) ?? preferredVoice
        let value = catalog.normalized(stored, preferredVoice: legacyVoice)
        selectedTranscriptionModel = value.transcriptionModel
        selectedSynthesisModel = value.synthesisModel
        selectedVoice = value.voice
        configurationReady = true
        configurationRequired = stored == nil
        if configurationRequired { settings = true }
        else { await startPrepared() }
    }

    private func startPrepared() async {
        guard configurationReady, !sessionStarted, let account = manager.session, !selectedVoice.isEmpty else { return }
        sessionStarted = true
        guard await AVAudioApplication.requestRecordPermission() else {
            sessionStarted = false
            controller.error = "Autorisez le microphone dans les réglages de l’iPhone."
            return
        }
        do {
            if let id = remoteChatID {
                guard let chat = instances.chats.first(where: { $0.id == id }) else { throw APIError.invalidResponse }
                let connection = try await instances.voiceConnection(chat.machine, voice: selectedVoice)
                await controller.start(session: connection.session, history: chat.messages, accountToken: "", backgroundAudio: preparedBackgroundAudio,
                                       headers: connection.headers) { role, text, turnID in
                    instances.appendVoiceTurn(chatID: id, accountID: account.accountId, model: preparedModel, role: role, text: text, turnID: turnID)
                }
                return
            }
            manager.selectedModel = preparedModel
            manager.newConversation()
            guard let conversation = manager.current else { throw APIError.invalidResponse }
            let session = try await ChatAPI.shared.createVoiceSession(
                conversation: conversation,
                model: preparedModel,
                voice: selectedVoice,
                language: Locale.current.identifier,
                token: account.accessToken
            )
            await controller.start(
                session: session,
                history: conversation.messages,
                accountToken: account.accessToken,
                backgroundAudio: preparedBackgroundAudio
            ) { role, text, id in
                manager.appendVoiceTurn(
                    conversationID: conversation.id,
                    accountID: account.accountId,
                    model: preparedModel,
                    role: role,
                    text: text,
                    turnID: id
                )
            }
        } catch {
            sessionStarted = false
            controller.error = remoteChatID == nil ? error.localizedDescription :
                "Le vocal est indisponible sur cette instance. Vérifiez que sa passerelle et ses modèles vocaux sont démarrés."
        }
    }

    private func saveConfiguration() {
        guard configurationReady, manager.session != nil, !selectedVoice.isEmpty else { return }
        let value = VoiceAudioConfiguration(
            transcriptionModel: selectedTranscriptionModel,
            synthesisModel: selectedSynthesisModel,
            voice: selectedVoice
        )
        VoiceAudioConfigurationStore.save(value, scope: preferenceKey)
        UserDefaults.standard.set(selectedVoice, forKey: preferenceKey)
    }

    private func confirmConfiguration() {
        saveConfiguration()
        let shouldStart = configurationRequired && !sessionStarted
        configurationRequired = false
        settings = false
        if shouldStart {
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(250))
                await startPrepared()
            }
        }
    }

    private func cancelConfiguration() {
        let shouldClose = configurationRequired && !sessionStarted
        if !configurationRequired, let stored = VoiceAudioConfigurationStore.load(scope: preferenceKey) {
            let restored = audioCatalog.normalized(stored)
            selectedTranscriptionModel = restored.transcriptionModel
            selectedSynthesisModel = restored.synthesisModel
            selectedVoice = restored.voice
        }
        settings = false
        if shouldClose {
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(200))
                dismiss()
            }
        }
    }

    private func openSettings() {
        if let stored = VoiceAudioConfigurationStore.load(scope: preferenceKey) {
            let restored = audioCatalog.normalized(stored)
            selectedTranscriptionModel = restored.transcriptionModel
            selectedSynthesisModel = restored.synthesisModel
            selectedVoice = restored.voice
        }
        settings = true
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

struct VoiceAudioConfigurationView: View {
    let catalog: VoiceAudioCatalog
    @Binding var selectedTranscriptionModel: String
    @Binding var selectedSynthesisModel: String
    @Binding var selectedVoice: String
    let responseModel: String
    let route: String
    let required: Bool
    let cancel: () -> Void
    let confirm: () -> Void

    private var compatibleVoices: [VoiceOption] { catalog.voices(for: selectedSynthesisModel) }
    private var valid: Bool {
        catalog.transcriptionModels.contains { $0.id == selectedTranscriptionModel } &&
            catalog.synthesisModels.contains { $0.id == selectedSynthesisModel } &&
            compatibleVoices.contains { $0.id == selectedVoice }
    }

    var body: some View {
        NavigationStack {
            List {
                if required {
                    Section {
                        Label("Choisissez comment votre voix est comprise et comment l’agent vous répond.", systemImage: "waveform.circle")
                    }
                }
                Section {
                    Picker("Modèle de transcription", selection: $selectedTranscriptionModel) {
                        ForEach(catalog.transcriptionModels) { Text($0.name).tag($0.id) }
                    }
                    .accessibilityIdentifier("voiceTranscriptionModel")
                } header: {
                    Text("Votre voix")
                } footer: {
                    Text("Ce modèle transforme votre parole en texte.")
                }
                Section {
                    Picker("Modèle vocal", selection: $selectedSynthesisModel) {
                        ForEach(catalog.synthesisModels) { Text($0.name).tag($0.id) }
                    }
                    .accessibilityIdentifier("voiceSynthesisModel")
                    Picker("Voix", selection: $selectedVoice) {
                        ForEach(compatibleVoices) { Text($0.name).tag($0.id) }
                    }
                    .accessibilityIdentifier("voiceOutputVoice")
                } header: {
                    Text("Voix de l’agent")
                } footer: {
                    Text("Le modèle vocal synthétise la réponse. La voix choisie est utilisée à partir de la prochaine conversation.")
                }
                if !responseModel.isEmpty || !route.isEmpty {
                    Section("Conversation") {
                        if !responseModel.isEmpty { LabeledContent("Modèle de réponse", value: responseModel) }
                        if !route.isEmpty { LabeledContent("Connexion", value: routeLabel) }
                    }
                }
            }
            .accessibilityIdentifier("voiceAudioConfiguration")
            .navigationTitle(required ? "Configurer le vocal" : "Réglages vocaux")
            .onChange(of: selectedSynthesisModel) { _, value in
                let choices = catalog.voices(for: value)
                if !choices.contains(where: { $0.id == selectedVoice }) { selectedVoice = choices.first?.id ?? "" }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(required ? "Annuler" : "Fermer", action: cancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(required ? "Démarrer" : "Terminé", action: confirm)
                        .disabled(!valid)
                        .accessibilityIdentifier("voiceConfigurationConfirm")
                }
            }
        }
    }

    private var routeLabel: String {
        route == "instance" ? "Instance distante · Relay WAN" : route == "cascaded" ? "Mode compatible" : "Temps réel"
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
    let audioLevel: Double
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
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
            accessibleOrb(size: 132)
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
        .ignoresSafeArea(.container, edges: .horizontal)
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
            accessibleOrb(size: 68)
            if let compactStatus = VoiceCanvasPresentation.compactStatus(for: phase) {
                Text(compactStatus)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .ignoresSafeArea(.container, edges: .horizontal)
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

    private var orbAccessibilityValue: String {
        "\(Int((min(1, max(0, audioLevel)) * 100).rounded())) %"
    }

    private func accessibleOrb(size: CGFloat) -> some View {
        ZStack {
            VoiceOrb(phase: phase, audioLevel: audioLevel, reduceMotion: reduceMotion)
                .accessibilityHidden(true)
            Color.clear
                .accessibilityElement(children: .ignore)
                .accessibilityIdentifier("voiceOrb")
                .accessibilityLabel(accessibleOrbLabel)
                .accessibilityValue(orbAccessibilityValue)
        }
        .frame(width: size, height: size)
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
    let audioLevel: Double
    let reduceMotion: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { timeline in
            GeometryReader { geometry in
                let side = min(geometry.size.width, geometry.size.height)
                let orbSide = side * 0.88
                let time = reduceMotion ? 0.4 : timeline.date.timeIntervalSinceReferenceDate
                let level = CGFloat(min(1, max(0, audioLevel)))
                let reactiveLevel = reduceMotion ? level * 0.28 : level
                let speed = (phase == .speaking ? 1.7 : phase == .listening ? 1.05 : 0.68) + Double(reactiveLevel) * 3.2
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
                        .frame(width: orbSide * (1.28 + reactiveLevel * 0.16), height: orbSide * (0.66 - reactiveLevel * 0.08))
                        .blur(radius: orbSide * 0.10)
                        .rotationEffect(.degrees(Double(wave) * (9 + Double(reactiveLevel) * 10) - 8))
                        .offset(x: crossWave * orbSide * (0.08 + reactiveLevel * 0.05),
                                y: -orbSide * 0.18 + wave * orbSide * (0.05 + reactiveLevel * 0.05))
                    Ellipse()
                        .fill(Color.white.opacity(0.68 + Double(reactiveLevel) * 0.26))
                        .frame(width: orbSide * (1.35 + reactiveLevel * 0.16), height: orbSide * (0.48 + reactiveLevel * 0.06))
                        .blur(radius: orbSide * 0.12)
                        .rotationEffect(.degrees(Double(crossWave) * (8 + Double(reactiveLevel) * 9) + 5))
                        .offset(x: wave * orbSide * (0.10 + reactiveLevel * 0.06),
                                y: orbSide * 0.12 + crossWave * orbSide * (0.04 + reactiveLevel * 0.04))
                    Circle()
                        .fill(RadialGradient(
                            colors: [Color.white.opacity(0.55), .clear],
                            center: UnitPoint(x: 0.62 + Double(wave) * (0.08 + Double(reactiveLevel) * 0.05),
                                              y: 0.72 - Double(reactiveLevel) * 0.06),
                            startRadius: 0,
                            endRadius: orbSide * 0.52
                        ))
                        .blur(radius: orbSide * 0.06)
                    Ellipse()
                        .fill(Color(white: 0.4).opacity(0.44))
                        .frame(width: orbSide * (0.82 + reactiveLevel * 0.10), height: orbSide * (0.24 + reactiveLevel * 0.08))
                        .blur(radius: orbSide * 0.08)
                        .offset(x: -crossWave * orbSide * 0.15, y: wave * orbSide * 0.16)
                }
                .frame(width: orbSide, height: orbSide)
                .clipShape(Circle())
                .overlay(Circle().stroke(.white.opacity(0.16), lineWidth: 0.7))
                .scaleEffect(1 + reactiveLevel * 0.09 + (reduceMotion ? 0 : wave * (phase == .speaking ? 0.022 : 0.010)))
                .shadow(color: .black.opacity(0.18), radius: orbSide * 0.12, y: orbSide * 0.05)
                .frame(width: side, height: side)
                .drawingGroup(opaque: false, colorMode: .linear)
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

#if DEBUG
struct VoiceAudioConfigurationFixtureView: View {
    @State private var transcription = "whisper-large-v3-turbo-asr-4bit"
    @State private var synthesis = "Kokoro-82M-bf16"
    @State private var voice = "kokoro:ff_siwis"
    @State private var started = false
    private let catalog = VoiceAudioCatalog(
        voices: [
            VoiceOption(id: "kokoro:ff_siwis", name: "Kokoro · Siwis", model: "Kokoro-82M-bf16", voice: "ff_siwis"),
            VoiceOption(id: "qwen:serena", name: "Qwen3 TTS · Serena", model: "Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16", voice: "serena")
        ],
        transcriptionModels: [.init(id: "whisper-large-v3-turbo-asr-4bit", name: "Whisper large v3 turbo")],
        synthesisModels: [
            .init(id: "Kokoro-82M-bf16", name: "Kokoro 82M"),
            .init(id: "Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16", name: "Qwen3 TTS 0.6B")
        ]
    )

    var body: some View {
        if started {
            ContentUnavailableView("Configuration enregistrée", systemImage: "checkmark.circle.fill")
                .accessibilityIdentifier("voiceConfigurationSaved")
        } else {
            VoiceAudioConfigurationView(
                catalog: catalog,
                selectedTranscriptionModel: $transcription,
                selectedSynthesisModel: $synthesis,
                selectedVoice: $voice,
                responseModel: "gpt-6.1-sol",
                route: "instance",
                required: true,
                cancel: {},
                confirm: { started = true }
            )
        }
    }
}

struct RealtimeVoiceFixtureView: View {
    @State private var typed = ""
    private let hero = ProcessInfo.processInfo.arguments.contains("-realtime-voice-ui-fixture-hero")
    private let speaking = ProcessInfo.processInfo.arguments.contains("-realtime-voice-ui-fixture-speaking")

    var body: some View {
        RealtimeVoiceCanvas(
            messages: hero ? [] : Self.sampleMessages,
            assistantDraft: "",
            userDraft: "",
            phase: hero ? .listening : speaking ? .speaking : .thinking,
            error: nil,
            muted: false,
            closing: false,
            audioLevel: hero ? 0.78 : speaking ? 0.86 : 0.64,
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
