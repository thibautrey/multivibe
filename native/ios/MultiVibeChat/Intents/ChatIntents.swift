import AppIntents

struct NewConversationIntent: AppIntent {
    static let title: LocalizedStringResource = "Nouvelle conversation MultiVibe"
    static let description = IntentDescription("Ouvre MultiVibe pour commencer une conversation. Une connexion est nécessaire.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @MainActor func perform() async throws -> some IntentResult {
        ConversationManager.shared.prepareShortcut(.newConversation)
        return .result()
    }
}

/// A foreground handoff, not an invisible microphone or background network request.
struct DictateInMultiVibeIntent: AppIntent {
    static let title: LocalizedStringResource = "Dicter dans MultiVibe"
    static let description = IntentDescription("Ouvre la dictée locale. Relisez votre message avant de l’envoyer au modèle choisi.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @MainActor func perform() async throws -> some IntentResult {
        ConversationManager.shared.prepareShortcut(.dictation)
        return .result()
    }
}

struct PrepareMultiVibeMessageIntent: AppIntent {
    static let title: LocalizedStringResource = "Préparer un message MultiVibe"
    static let description = IntentDescription("Prépare un brouillon dans l’app sans transmettre de message au serveur.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Message") var message: String
    @MainActor func perform() async throws -> some IntentResult {
        ConversationManager.shared.prepareShortcut(.draft(message))
        return .result()
    }
}

/// All entry points use the app's shared conversation and audio controllers.
/// A shortcut opens the native voice interface; it never sends dictated content.
struct VoiceConversationIntent: AppIntent {
    static let title: LocalizedStringResource = "Conversation vocale MultiVibe"
    static let description = IntentDescription("Ouvre le mode vocal. Dictez localement, puis confirmez l’envoi pour entendre la réponse.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @MainActor func perform() async throws -> some IntentResult {
        ConversationManager.shared.prepareShortcut(.voiceConversation)
        return .result()
    }
}

struct MultiVibeShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: VoiceConversationIntent(), phrases: ["Parler avec \(.applicationName)"], shortTitle: "Conversation vocale", systemImageName: "waveform")
        AppShortcut(intent: NewConversationIntent(), phrases: ["Nouvelle conversation dans \(.applicationName)"], shortTitle: "Nouvelle conversation", systemImageName: "bubble.left.and.bubble.right")
        AppShortcut(intent: DictateInMultiVibeIntent(), phrases: ["Dicter dans \(.applicationName)"], shortTitle: "Dicter un message", systemImageName: "mic")
        AppShortcut(intent: PrepareMultiVibeMessageIntent(), phrases: ["Préparer un message dans \(.applicationName)"], shortTitle: "Préparer un message", systemImageName: "square.and.pencil")
    }
}
