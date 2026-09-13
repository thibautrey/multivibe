import AppIntents

struct NewConversationIntent: AppIntent {
    static let title: LocalizedStringResource = "Nouvelle conversation MultiVibe"
    static let description = IntentDescription("Ouvre MultiVibe pour commencer une conversation. Une connexion est nécessaire.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @MainActor func perform() async throws -> some IntentResult {
        ConversationManager.shared.newConversation()
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
        ConversationManager.shared.wantsVoice = true
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
        ConversationManager.shared.pendingDraft = String(message.prefix(32_000))
        return .result()
    }
}

struct MultiVibeShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: NewConversationIntent(), phrases: ["Nouvelle conversation dans \(.applicationName)"], shortTitle: "Nouvelle conversation", systemImageName: "bubble.left.and.bubble.right")
        AppShortcut(intent: DictateInMultiVibeIntent(), phrases: ["Dicter dans \(.applicationName)"], shortTitle: "Dicter un message", systemImageName: "mic")
        AppShortcut(intent: PrepareMultiVibeMessageIntent(), phrases: ["Préparer un message dans \(.applicationName)"], shortTitle: "Préparer un message", systemImageName: "square.and.pencil")
    }
}
