import Foundation

@MainActor final class HostAssistantClient {
    static let shared = HostAssistantClient()
    var defaultModel = "fixture"
    var received: [[String: String]] = []
    var response = "Réponse complète"
    func stream(_ messages: [[String: String]], model: String, update: @MainActor (String) -> Void) async throws {
        received = messages
        update("Partiel")
        try await Task.sleep(nanoseconds: 80_000_000)
        update(response)
    }
}

@MainActor final class NativeHarnessClient {
    static let shared = NativeHarnessClient()
    var receivedHarnessID: String?
    func stream(harnessID: String, conversationID: UUID, prompt: String, model: String, sessionID: String?,
                update: @MainActor (String) -> Void) async throws -> String? {
        receivedHarnessID = harnessID
        precondition(prompt == NativeInteractiveDocument.prompt("Brouillon à conserver"))
        update("Réponse du harness")
        return "session-fixture"
    }
}

@main struct NativeChatStoreHarness {
    @MainActor static func main() async throws {
        let previousModel = HostAssistantClient.shared.defaultModel
        let previousHarness = NativeChatStore.defaultHarnessID
        defer {
            HostAssistantClient.shared.defaultModel = previousModel
            NativeChatStore.defaultHarnessID = previousHarness
        }
        HostAssistantClient.shared.defaultModel = "fixture"
        NativeChatStore.defaultHarnessID = "native"
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("history.json")
        let store = NativeChatStore(file: file)
        store.newConversation()
        let first = store.selection!
        HostAssistantClient.shared.defaultModel = "latest-model"
        NativeChatStore.defaultHarnessID = "pi"
        store.newConversation()
        precondition(store.selection == first && store.conversations.count == 1)
        precondition(store.current?.model == "latest-model" && store.current?.harnessID == "pi")
        HostAssistantClient.shared.defaultModel = "fixture"
        NativeChatStore.defaultHarnessID = "native"
        store.edit { $0.model = "fixture"; $0.harnessID = nil }
        store.edit { $0.draft = "Bonjour" }
        store.send()
        while store.generating != nil { try await Task.sleep(nanoseconds: 10_000_000) }
        precondition(store.current?.messages.count == 2)
        precondition(store.current?.messages.first?.content == "Bonjour")
        precondition(HostAssistantClient.shared.received.first?["content"] == NativeInteractiveDocument.prompt("Bonjour"))
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
        store.edit { $0.harnessID = "pi" }
        store.send()
        while store.generating != nil { try await Task.sleep(nanoseconds: 10_000_000) }
        precondition(NativeHarnessClient.shared.receivedHarnessID == "pi")
        precondition(store.current?.harnessSessionID == "session-fixture")
        precondition(store.current?.messages.last?.content == "Réponse du harness")
        store.delete(first)
        precondition(store.conversations.count == 1)
        let artifact = "```intelligent-ui\n{\"title\":\"Saved calculator\",\"html\":\"<output>42</output>\"}\n```"
        HostAssistantClient.shared.response = artifact
        store.newConversation(text: "Un outil")
        store.edit { $0.harnessID = nil }
        store.send(interactiveAnswers: false)
        while store.generating != nil { try await Task.sleep(nanoseconds: 10_000_000) }
        precondition(HostAssistantClient.shared.received.last?["content"] == "Un outil")
        let withArtifact = NativeChatStore(file: file)
        let saved = withArtifact.conversations.first { $0.messages.last?.content == artifact }!
        precondition(NativeInteractiveDocument.segments(saved.messages.last!.content).contains { if case .document = $0 { return true }; return false })
        HostAssistantClient.shared.defaultModel = "remembered-model"
        NativeChatStore.defaultHarnessID = "hermes-agent"
        store.newConversation(text: "Les préférences doivent suivre")
        precondition(store.current?.model == "remembered-model")
        precondition(store.current?.harnessID == "hermes-agent")
        try Data("invalid-history".utf8).write(to: file)
        let corrupt = NativeChatStore(file: file)
        precondition(corrupt.error != nil)
        corrupt.newConversation()
        let original = try String(contentsOf: file, encoding: .utf8)
        precondition(original == "invalid-history")
        print("PASS history persistence, permissions, harness routing/session, multi-turn context, cancellation, retry, selection isolation, deletion, corrupt-file preservation")
    }
}
