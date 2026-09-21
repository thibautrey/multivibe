import Foundation

@MainActor final class HostAssistantClient {
    static let shared = HostAssistantClient()
    var defaultModel = "fixture"
    var received: [[String: String]] = []
    func stream(_ messages: [[String: String]], model: String, update: @MainActor (String) -> Void) async throws {
        received = messages
        update("Partiel")
        try await Task.sleep(nanoseconds: 80_000_000)
        update("Réponse complète")
    }
}

@main struct NativeChatStoreHarness {
    @MainActor static func main() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("history.json")
        let store = NativeChatStore(file: file)
        store.newConversation()
        let first = store.selection!
        store.newConversation()
        precondition(store.selection == first && store.conversations.count == 1)
        store.edit { $0.draft = "Bonjour" }
        store.send()
        while store.generating != nil { try await Task.sleep(nanoseconds: 10_000_000) }
        precondition(store.current?.messages.count == 2)
        precondition(store.current?.messages.last?.content == "Réponse complète")
        precondition(store.current?.messages.last?.interrupted == false)
        store.edit { $0.draft = "Suite" }
        store.send()
        try await Task.sleep(nanoseconds: 20_000_000)
        store.stop()
        while store.generating != nil { try await Task.sleep(nanoseconds: 10_000_000) }
        precondition(store.current?.messages.last?.interrupted == true)
        precondition(HostAssistantClient.shared.received.count == 3)
        store.send(retry: true)
        while store.generating != nil { try await Task.sleep(nanoseconds: 10_000_000) }
        precondition(store.current?.messages.count == 4)
        precondition(store.current?.messages.last?.interrupted == false)
        let restored = NativeChatStore(file: file)
        precondition(restored.current?.messages.count == 4)
        let mode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as! NSNumber
        precondition(mode.intValue == 0o600)
        store.newConversation(text: "Brouillon à conserver")
        let second = store.selection!
        store.selection = first
        store.edit { $0.draft = "Une autre question" }
        store.send()
        store.selection = second
        while store.generating != nil { try await Task.sleep(nanoseconds: 10_000_000) }
        precondition(store.current?.draft == "Brouillon à conserver")
        precondition(store.current?.messages.isEmpty == true)
        store.delete(first)
        precondition(store.conversations.count == 1)
        try Data("invalid-history".utf8).write(to: file)
        let corrupt = NativeChatStore(file: file)
        precondition(corrupt.error != nil)
        corrupt.newConversation()
        let original = try String(contentsOf: file, encoding: .utf8)
        precondition(original == "invalid-history")
        print("PASS history persistence, permissions, empty reuse, multi-turn context, cancellation, retry, selection isolation, deletion, corrupt-file preservation")
    }
}
