import Foundation

struct NativeChatSuggestion: Codable, Identifiable, Equatable, Sendable {
    var id: UUID
    var title: String
    var subtitle: String
    var systemImage: String
    var text: String

    static let defaults: [NativeChatSuggestion] = [
        .init(
            id: UUID(uuidString: "DDF4744F-F9C2-4B8F-A099-000000000001")!,
            title: "Explorer une idée",
            subtitle: "Trouver de nouvelles pistes",
            systemImage: "lightbulb",
            text: "Aide-moi à trouver des idées pour "
        ),
        .init(
            id: UUID(uuidString: "DDF4744F-F9C2-4B8F-A099-000000000002")!,
            title: "M’aider à écrire",
            subtitle: "Donner forme à mes mots",
            systemImage: "pencil.line",
            text: "Aide-moi à rédiger "
        ),
        .init(
            id: UUID(uuidString: "DDF4744F-F9C2-4B8F-A099-000000000003")!,
            title: "Créer un outil",
            subtitle: "Passer de l’idée à l’action",
            systemImage: "slider.horizontal.3",
            text: "Crée un calculateur interactif pour partager une addition, avec pourboire et nombre de personnes modifiables."
        )
    ]

    var normalized: NativeChatSuggestion {
        var value = self
        value.title = value.title.trimmingCharacters(in: .whitespacesAndNewlines)
        value.subtitle = value.subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
        value.systemImage = value.systemImage.trimmingCharacters(in: .whitespacesAndNewlines)
        return value
    }
}

enum NativeChatSuggestionStore {
    static let key = "assistantWelcomeSuggestionsV1"

    static func load(from defaults: UserDefaults = .standard) -> [NativeChatSuggestion] {
        guard let data = defaults.data(forKey: key),
              let values = try? JSONDecoder().decode([NativeChatSuggestion].self, from: data),
              values.count == NativeChatSuggestion.defaults.count else {
            return NativeChatSuggestion.defaults
        }
        return values
    }

    static func save(_ values: [NativeChatSuggestion], to defaults: UserDefaults = .standard) {
        guard values.count == NativeChatSuggestion.defaults.count,
              let data = try? JSONEncoder().encode(values) else { return }
        defaults.set(data, forKey: key)
    }
}
