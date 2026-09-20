import AppIntents
import Foundation

enum NativeShortcutError: LocalizedError {
    case notReady, missing, busy, empty, noReply, invalidURL
    var errorDescription: String? {
        switch self {
        case .notReady: "Ouvrez MultiVibe et attendez le chargement de l’historique, puis relancez le raccourci."
        case .missing: "Cet élément n’est plus disponible dans le compte ouvert sur cet appareil."
        case .busy: "Attendez la fin de la réponse ou de la synchronisation avant de relancer cette action."
        case .empty: "Fournissez un texte non vide."
        case .noReply: "Cette conversation ne contient pas encore de réponse terminée."
        case .invalidURL: "Utilisez une adresse HTTPS sans identifiants."
        }
    }
}

enum MultiVibeDestination: String, AppEnum {
    case history, documents, memory, privacy, synchronization
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Écran MultiVibe"
    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .history: "Conversations", .documents: "Documents et outils locaux", .memory: "Mémoire",
        .privacy: "Confidentialité et données", .synchronization: "Synchronisation de l’historique"
    ]
}

struct MultiVibeConversationEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Conversation MultiVibe"
    static let defaultQuery = MultiVibeConversationQuery()
    var id: String
    var conversationID: UUID
    var accountID: String?
    var title: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)") }
    init(_ conversation: Conversation, accountID: String?) {
        self.conversationID = conversation.id
        self.accountID = accountID
        self.id = (accountID ?? "guest") + "/" + conversation.id.uuidString
        self.title = conversation.title
    }
}

struct MultiVibeConversationQuery: EntityStringQuery {
    @MainActor func entities(for identifiers: [String]) async throws -> [MultiVibeConversationEntity] {
        let manager = ConversationManager.shared
        await manager.restoreForNativeEntry()
        guard !manager.isRestoring else { return [] }
        return manager.conversations.map { MultiVibeConversationEntity($0, accountID: manager.session?.accountId) }
            .filter { identifiers.contains($0.id) }
    }
    @MainActor func entities(matching string: String) async throws -> [MultiVibeConversationEntity] {
        let manager = ConversationManager.shared
        await manager.restoreForNativeEntry()
        guard !manager.isRestoring else { throw NativeShortcutError.notReady }
        return Array(manager.conversations.filter { string.isEmpty || $0.title.localizedCaseInsensitiveContains(string) }
            .prefix(50)).map { MultiVibeConversationEntity($0, accountID: manager.session?.accountId) }
    }
    // Private titles are deliberately not donated as proactive system suggestions.
    func suggestedEntities() async throws -> [MultiVibeConversationEntity] { [] }
}

struct MultiVibeDocumentEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Document local MultiVibe"
    static let defaultQuery = MultiVibeDocumentQuery()
    var id: String
    var documentID: UUID
    var accountID: String?
    var name: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
    init(_ document: LocalDocument, accountID: String?) {
        self.documentID = document.id; self.accountID = accountID; self.name = document.name
        self.id = (accountID ?? "guest") + "/" + document.id.uuidString
    }
}
struct MultiVibeDocumentQuery: EntityStringQuery {
    @MainActor func entities(for identifiers: [String]) async throws -> [MultiVibeDocumentEntity] {
        let manager = ConversationManager.shared
        await manager.restoreForNativeEntry()
        guard !manager.isRestoring else { return [] }
        return manager.localDocuments.map { MultiVibeDocumentEntity($0, accountID: manager.session?.accountId) }
            .filter { identifiers.contains($0.id) }
    }
    @MainActor func entities(matching string: String) async throws -> [MultiVibeDocumentEntity] {
        let manager = ConversationManager.shared
        await manager.restoreForNativeEntry()
        guard !manager.isRestoring else { throw NativeShortcutError.notReady }
        return Array(manager.localDocuments.filter { string.isEmpty || $0.name.localizedCaseInsensitiveContains(string) }
            .prefix(50)).map { MultiVibeDocumentEntity($0, accountID: manager.session?.accountId) }
    }
    func suggestedEntities() async throws -> [MultiVibeDocumentEntity] { [] }
}

struct OpenMultiVibeScreenIntent: AppIntent {
    static let title: LocalizedStringResource = "Ouvrir un écran MultiVibe"
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Écran") var destination: MultiVibeDestination
    static var parameterSummary: some ParameterSummary { Summary("Ouvrir \(\.$destination)") }
    @MainActor func perform() async throws -> some IntentResult {
        let manager = ConversationManager.shared
        manager.queueNativeShortcut(.init(destination: .init(rawValue: destination.rawValue), accountID: manager.session?.accountId))
        return .result()
    }
}

struct OpenMultiVibeConversationIntent: AppIntent {
    static let title: LocalizedStringResource = "Ouvrir une conversation MultiVibe"
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Conversation") var conversation: MultiVibeConversationEntity
    static var parameterSummary: some ParameterSummary { Summary("Ouvrir \(\.$conversation)") }
    @MainActor func perform() async throws -> some IntentResult {
        ConversationManager.shared.queueNativeShortcut(.init(conversationID: conversation.conversationID, accountID: conversation.accountID))
        return .result()
    }
}

struct FindMultiVibeConversationsIntent: AppIntent {
    static let title: LocalizedStringResource = "Rechercher des conversations MultiVibe"
    static let description = IntentDescription("Recherche les titres chargés sur cet appareil et transmet les résultats aux actions suivantes du raccourci.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Recherche", default: "") var query: String
    static var parameterSummary: some ParameterSummary { Summary("Rechercher les conversations contenant \(\.$query)") }
    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<[MultiVibeConversationEntity]> {
        .result(value: try await MultiVibeConversationQuery().entities(matching: query))
    }
}

struct GetMultiVibeReplyIntent: AppIntent {
    static let title: LocalizedStringResource = "Obtenir la dernière réponse MultiVibe"
    static let description = IntentDescription("Transmet la dernière réponse terminée au raccourci. Les actions suivantes peuvent partager ce texte.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Conversation") var conversation: MultiVibeConversationEntity
    static var parameterSummary: some ParameterSummary { Summary("Obtenir la dernière réponse de \(\.$conversation)") }
    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<String> {
        await ConversationManager.shared.restoreForNativeEntry()
        let current = try ConversationManager.shared.shortcutConversation(conversation.conversationID, accountID: conversation.accountID)
        guard let reply = current.messages.last(where: { $0.role == "assistant" && $0.completion == .completed && !$0.content.isEmpty }) else {
            throw NativeShortcutError.noReply
        }
        return .result(value: reply.content)
    }
}

struct ExportMultiVibeConversationIntent: AppIntent {
    static let title: LocalizedStringResource = "Exporter une conversation MultiVibe"
    static let description = IntentDescription("Retourne un fichier texte au raccourci, qui peut le sauvegarder ou le partager.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Conversation") var conversation: MultiVibeConversationEntity
    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<IntentFile> {
        await ConversationManager.shared.restoreForNativeEntry()
        let current = try ConversationManager.shared.shortcutConversation(conversation.conversationID, accountID: conversation.accountID)
        let text = current.title + "\n\n" + current.messages.map { "\($0.role):\n\($0.content)" }.joined(separator: "\n\n")
        return .result(value: IntentFile(data: Data(text.utf8), filename: "MultiVibe-conversation.txt", type: .plainText))
    }
}

struct PrepareLocalMultiVibeIntent: AppIntent {
    static let title: LocalizedStringResource = "Préparer une demande à Apple Foundation Local"
    static let description = IntentDescription("Crée une conversation avec le modèle Apple local et prépare le texte à relire avant l’envoi. Aucun repli vers un modèle distant.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Demande", default: "") var prompt: String
    static var parameterSummary: some ParameterSummary { Summary("Préparer localement \(\.$prompt)") }
    @MainActor func perform() async throws -> some IntentResult {
        let manager = ConversationManager.shared
        manager.queueNativeShortcut(.init(accountID: manager.session?.accountId, localDraft: prompt))
        return .result()
    }
}

struct PrepareMultiVibeWebsiteIntent: AppIntent {
    static let title: LocalizedStringResource = "Préparer l’analyse d’une page web"
    static let description = IntentDescription("Prépare l’URL pour le modèle local. L’accès Internet reste soumis à l’autorisation de la conversation après l’envoi.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Adresse HTTPS") var url: URL
    @MainActor func perform() async throws -> some IntentResult {
        guard url.scheme?.lowercased() == "https", url.host != nil, url.user == nil, url.password == nil else { throw NativeShortcutError.invalidURL }
        let manager = ConversationManager.shared
        manager.queueNativeShortcut(.init(accountID: manager.session?.accountId, localDraft: "Lis cette page et résume les informations utiles : " + url.absoluteString))
        return .result()
    }
}

struct ImportMultiVibeTextIntent: AppIntent {
    static let title: LocalizedStringResource = "Ajouter un document texte à MultiVibe"
    static let description = IntentDescription("Enregistre le texte dans les documents locaux de l’app, sans l’envoyer à un modèle.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Nom") var name: String
    @Parameter(title: "Texte") var text: String
    static var parameterSummary: some ParameterSummary { Summary("Ajouter \(\.$name) avec \(\.$text)") }
    @MainActor func perform() async throws -> some IntentResult {
        let manager = ConversationManager.shared
        manager.queueNativeShortcut(.init(destination: .documents, accountID: manager.session?.accountId, documentName: name, documentText: text))
        return .result()
    }
}

struct FindMultiVibeDocumentsIntent: AppIntent {
    static let title: LocalizedStringResource = "Rechercher des documents MultiVibe"
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Recherche", default: "") var query: String
    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<[MultiVibeDocumentEntity]> {
        .result(value: try await MultiVibeDocumentQuery().entities(matching: query))
    }
}

struct GetMultiVibeDocumentIntent: AppIntent {
    static let title: LocalizedStringResource = "Lire un document MultiVibe"
    static let description = IntentDescription("Retourne le texte local aux actions suivantes du raccourci.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Document") var document: MultiVibeDocumentEntity
    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let manager = ConversationManager.shared
        await manager.restoreForNativeEntry()
        guard !manager.isRestoring else { throw NativeShortcutError.notReady }
        guard document.accountID == manager.session?.accountId,
              let current = manager.localDocuments.first(where: { $0.id == document.documentID }) else { throw NativeShortcutError.missing }
        return .result(value: current.text)
    }
}

struct ProposeMultiVibeMemoryIntent: AppIntent {
    static let title: LocalizedStringResource = "Proposer un souvenir à MultiVibe"
    static let description = IntentDescription("Ouvre la fiche de validation du souvenir. Le texte ne devient une mémoire utilisable qu’après votre confirmation.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Souvenir") var text: String
    @MainActor func perform() async throws -> some IntentResult {
        let manager = ConversationManager.shared
        manager.queueNativeShortcut(.init(accountID: manager.session?.accountId, memoryText: text))
        return .result()
    }
}

struct StopMultiVibeResponseIntent: AppIntent {
    static let title: LocalizedStringResource = "Arrêter la réponse MultiVibe"
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @MainActor func perform() async throws -> some IntentResult {
        ConversationManager.shared.stop()
        return .result()
    }
}

struct StopMultiVibeAudioIntent: AppIntent {
    static let title: LocalizedStringResource = "Arrêter l’audio MultiVibe"
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @MainActor func perform() async throws -> some IntentResult {
        ConversationManager.shared.voice.stop()
        ConversationManager.shared.voice.silence()
        return .result()
    }
}

struct AskLocalMultiVibeIntent: AppIntent {
    static let title: LocalizedStringResource = "Demander à Apple Foundation Local"
    static let description = IntentDescription("Envoie une demande au modèle local et retourne la réponse au raccourci. Gardez MultiVibe ouvert. Les outils demandent leurs autorisations habituelles ; aucun modèle distant n’est utilisé.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Demande") var prompt: String
    static var parameterSummary: some ParameterSummary { Summary("Demander localement \(\.$prompt)") }
    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let manager = ConversationManager.shared
        await manager.restoreForNativeEntry()
        return .result(value: try await manager.askLocalFromShortcut(prompt))
    }
}

struct ReadMultiVibeReplyAloudIntent: AppIntent {
    static let title: LocalizedStringResource = "Lire une réponse MultiVibe à voix haute"
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Conversation") var conversation: MultiVibeConversationEntity
    @MainActor func perform() async throws -> some IntentResult {
        let manager = ConversationManager.shared
        await manager.restoreForNativeEntry()
        let current = try manager.shortcutConversation(conversation.conversationID, accountID: conversation.accountID)
        guard let reply = current.messages.last(where: { $0.role == "assistant" && $0.completion == .completed && !$0.content.isEmpty }) else {
            throw NativeShortcutError.noReply
        }
        manager.voice.speak(reply.content)
        return .result()
    }
}

struct ImportMultiVibeFileIntent: AppIntent {
    static let title: LocalizedStringResource = "Importer un fichier texte dans MultiVibe"
    static let description = IntentDescription("Importe un fichier UTF-8 de 100 Ko maximum dans les documents locaux. Les PDF et fichiers binaires ne sont pas pris en charge par cette action.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Fichier texte", supportedContentTypes: [.plainText]) var file: IntentFile
    @MainActor func perform() async throws -> some IntentResult {
        let data = file.data
        guard data.count <= 100_000, let text = String(data: data, encoding: .utf8),
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw LocalAgentError.invalidInput }
        let manager = ConversationManager.shared
        manager.queueNativeShortcut(.init(destination: .documents, accountID: manager.session?.accountId, documentName: file.filename, documentText: text))
        return .result()
    }
}

enum MultiVibeDeviceRequest: String, AppEnum {
    case calendar, reminders, contacts, location
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Données de cet appareil"
    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .calendar: "Calendrier", .reminders: "Rappels", .contacts: "Contacts", .location: "Position actuelle"
    ]
    var prompt: String {
        switch self {
        case .calendar: "Consulte mon calendrier et présente mes prochains rendez-vous."
        case .reminders: "Consulte mes rappels et présente ce qu’il me reste à faire."
        case .contacts: "Recherche dans mes contacts : "
        case .location: "Obtiens ma position actuelle."
        }
    }
}
struct PrepareMultiVibeDeviceRequestIntent: AppIntent {
    static let title: LocalizedStringResource = "Préparer une demande sur les données iOS"
    static let description = IntentDescription("Prépare une demande locale. Après l’envoi, iOS demandera l’autorisation d’accès aux données si nécessaire.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Données") var source: MultiVibeDeviceRequest
    @MainActor func perform() async throws -> some IntentResult {
        let manager = ConversationManager.shared
        manager.queueNativeShortcut(.init(accountID: manager.session?.accountId, localDraft: source.prompt))
        return .result()
    }
}
