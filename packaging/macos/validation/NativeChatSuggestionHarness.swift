import Foundation

@main struct NativeChatSuggestionHarness {
    static func main() {
        let suite = "NativeChatSuggestionHarness-\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suite) else { fatalError("Unable to create defaults suite") }
        defer { defaults.removePersistentDomain(forName: suite) }

        precondition(NativeChatSuggestionStore.load(from: defaults) == NativeChatSuggestion.defaults)

        var edited = NativeChatSuggestion.defaults
        edited[1].title = "Réécrire"
        edited[1].subtitle = "Clarifier ce brouillon"
        edited[1].systemImage = "text.quote"
        edited[1].text = "Réécris ce texte avec clarté : "
        NativeChatSuggestionStore.save(edited, to: defaults)
        precondition(NativeChatSuggestionStore.load(from: defaults) == edited)

        defaults.set(Data("not-json".utf8), forKey: NativeChatSuggestionStore.key)
        precondition(NativeChatSuggestionStore.load(from: defaults) == NativeChatSuggestion.defaults)

        NativeChatSuggestionStore.save(Array(edited.prefix(2)), to: defaults)
        precondition(NativeChatSuggestionStore.load(from: defaults) == NativeChatSuggestion.defaults)

        var padded = edited[0]
        padded.title = "  Explorer  "
        padded.subtitle = "  Trouver  \n"
        padded.systemImage = " lightbulb "
        padded.text = "Conserver les espaces utiles : "
        precondition(padded.normalized.title == "Explorer")
        precondition(padded.normalized.subtitle == "Trouver")
        precondition(padded.normalized.systemImage == "lightbulb")
        precondition(padded.normalized.text == padded.text)

        print("PASS editable welcome suggestion defaults, persistence and corrupt-data fallback")
    }
}
