import AppIntents
import AppKit

struct HostModelEntity: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Modèle MultiVibe")
    static let defaultQuery = HostModelQuery()
    let id: String
    let name: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)", subtitle: "\(id)") }
}

struct HostModelQuery: EntityStringQuery {
    @MainActor func entities(for identifiers: [String]) async throws -> [HostModelEntity] {
        try await suggestedEntities().filter { identifiers.contains($0.id) }
    }
    @MainActor func entities(matching string: String) async throws -> [HostModelEntity] {
        try await suggestedEntities().filter {
            $0.id.localizedCaseInsensitiveContains(string) || $0.name.localizedCaseInsensitiveContains(string)
        }
    }
    @MainActor func suggestedEntities() async throws -> [HostModelEntity] {
        try await HostAssistantClient.shared.models().map { HostModelEntity(id: $0.id, name: $0.displayName) }
    }
    @MainActor func defaultResult() async -> HostModelEntity? {
        let id = HostAssistantClient.shared.defaultModel
        guard !id.isEmpty else { return nil }
        return (try? await suggestedEntities().first { $0.id == id })
    }
}

struct AskMultiVibeHostIntent: AppIntent {
    static let title: LocalizedStringResource = "Demander à MultiVibe"
    static let description = IntentDescription("Interroge le modèle choisi. Apple Foundation s’exécute sur ce Mac ; les autres modèles passent par MultiVibe Host et leur fournisseur reçoit le texte.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Question") var question: String
    @Parameter(title: "Modèle") var model: HostModelEntity
    static var parameterSummary: some ParameterSummary { Summary("Demander \(\.$question) à \(\.$model)") }
    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let reply = try await HostAssistantClient.shared.ask(question, model: model.id)
        return .result(value: reply, dialog: IntentDialog(stringLiteral: reply))
    }
}

struct SetHostDefaultModelIntent: AppIntent {
    static let title: LocalizedStringResource = "Choisir le modèle MultiVibe par défaut"
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Modèle") var model: HostModelEntity
    @MainActor func perform() async throws -> some IntentResult {
        guard try await HostAssistantClient.shared.models().contains(where: { $0.id == model.id }) else { throw HostAssistantError.missingModel }
        HostAssistantClient.shared.defaultModel = model.id
        return .result()
    }
}

struct ListHostModelsIntent: AppIntent {
    static let title: LocalizedStringResource = "Lister les modèles MultiVibe"
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<[HostModelEntity]> {
        .result(value: try await HostModelQuery().suggestedEntities())
    }
}

struct OpenHostAssistantIntent: AppIntent {
    static let title: LocalizedStringResource = "Ouvrir une demande MultiVibe"
    static let openAppWhenRun = true
    @Parameter(title: "Texte", default: "") var text: String
    @MainActor func perform() async throws -> some IntentResult {
        (NSApplication.shared.delegate as? MultiVibeMenuBarApp)?.showAssistant(text: text)
        return .result()
    }
}

struct HostAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AskMultiVibeHostIntent(), phrases: ["Demander à \(.applicationName)", "Ask \(.applicationName)"], shortTitle: "Demander à MultiVibe", systemImageName: "bubble.left.and.text.bubble.right")
        AppShortcut(intent: OpenHostAssistantIntent(), phrases: ["Ouvrir une demande dans \(.applicationName)"], shortTitle: "Nouvelle demande", systemImageName: "square.and.pencil")
        AppShortcut(intent: ListHostModelsIntent(), phrases: ["Lister les modèles de \(.applicationName)"], shortTitle: "Modèles", systemImageName: "list.bullet")
        AppShortcut(intent: SetHostDefaultModelIntent(), phrases: ["Choisir le modèle de \(.applicationName)"], shortTitle: "Modèle par défaut", systemImageName: "checkmark.circle")
    }
}

struct AskHostTextFileIntent: AppIntent {
    static let title: LocalizedStringResource = "Interroger un fichier texte avec MultiVibe"
    static let description = IntentDescription("Interroge un fichier texte UTF-8 avec le modèle choisi. Apple Foundation traite le texte sur ce Mac ; les autres modèles le transmettent via le Host. Maximum 32 000 caractères au total.")
    static let openAppWhenRun = true
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "Fichier texte") var file: IntentFile
    @Parameter(title: "Question") var question: String
    @Parameter(title: "Modèle") var model: HostModelEntity
    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<String> {
        guard file.data.count <= 128_000, let text = String(data: file.data, encoding: .utf8) else { throw HostAssistantError.invalidInput }
        let reply = try await HostAssistantClient.shared.ask(question + "\n\n" + text, model: model.id)
        return .result(value: reply)
    }
}
