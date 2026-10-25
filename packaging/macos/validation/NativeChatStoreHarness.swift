import Foundation

enum AppleFoundationModel { static let id = "apple-local" }
enum HostAssistantError: Error { case emptyReply }

@MainActor final class HostAssistantClient {
    static let shared = HostAssistantClient()
    var defaultModel = "fixture"
    var received: [[String: String]] = []
    func computerTurn(_ messages: [[String: Any]], model: String) async throws -> ComputerUseModelReply {
        received = messages.compactMap { value in
            guard let role = value["role"] as? String, let content = value["content"] as? String else { return nil }
            return ["role": role, "content": content]
        }
        try await Task.sleep(nanoseconds: 80_000_000)
        try Task.checkCancellation()
        return .init(message: ["role": "assistant", "content": response], text: response, calls: [])
    }
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
        try NativeChatPresentationHarness.validate()
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
        let initialReceipt = DesktopHarnessReceipt(id: "initial", sessionId: "session", command: .object(["displayText": .string("Premier message")]), state: "queued", createdAt: 1, ordinal: 1, result: nil, error: nil)
        let followUpReceipt = DesktopHarnessReceipt(id: "follow-up", sessionId: "session", command: .object(["displayText": .string("Message suivant")]), state: "queued", createdAt: 2, ordinal: 2, result: nil, error: nil)
        let projectedQueue = NativeChatStore.followUpQueue([initialReceipt, followUpReceipt], initialCommandID: initialReceipt.id)
        precondition(projectedQueue.map(\.id) == [followUpReceipt.id])
        precondition(NativeChatStore.followUpQueue([initialReceipt, followUpReceipt], initialCommandID: nil).map(\.id) == [initialReceipt.id, followUpReceipt.id])
        let pendingID = UUID()
        store.edit {
            $0.initialRuntimeCommandID = pendingID.uuidString.lowercased()
            $0.pendingSubmissions = [.init(id: pendingID, text: "Premier message", attachments: [], displayText: "Premier message")]
        }
        store.restorePending(first)
        precondition(store.current?.initialRuntimeCommandID == nil && store.current?.draft == "Premier message")
        store.edit { $0.draft = "" }
        store.edit { $0.queuePaused = true }
        store.newConversation()
        precondition(store.selection == first && store.current?.queuePaused == false)
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
        let runtimeSessionID = store.current!.runtimeSessionID!
        var sequence = (store.current?.runtimeCursor ?? 0) + 1
        func runtimeEvent(_ type: String, _ payload: HarnessJSON, item: String = "parent") {
            store.applyRuntime(.init(seq: sequence, sessionId: runtimeSessionID, type: type, turnId: "projection-turn", itemId: item, payload: payload, createdAt: 1), conversationID: second)
            sequence += 1
        }
        runtimeEvent("message.delta", .object(["text": .string("Par")]))
        runtimeEvent("message.part", .object(["text": .string("Parent complet")]))
        runtimeEvent("message.part", .object(["text": .string("Deuxième bloc")]), item: "second")
        precondition(store.current?.messages.last?.content == "Parent complet\n\nDeuxième bloc")
        store.applyRuntime(.init(seq: sequence + 100, sessionId: "other-session", type: "message.delta", turnId: "projection-turn", itemId: "parent", payload: .object(["text": .string("MUST NOT LEAK")]), createdAt: 1), conversationID: second)
        precondition(store.current?.runtimeCursor == sequence - 1)
        runtimeEvent("turn.completed", .object([:]))
        precondition(store.current?.messages.last?.interrupted == false)
        runtimeEvent("turn.cancelled", .object([:]))
        precondition(store.current?.messages.last?.interrupted == true)
        store.error = nil
        runtimeEvent("diagnostic", .object(["message": .string("Streaming failed before delivery: Connection error.\nTraceback: internal detail")]))
        precondition(store.error == nil)
        precondition(store.current?.runtimeEvents?.last?.type == "diagnostic")
        runtimeEvent("turn.failed", .object(["error": .string("Model request failed")]))
        precondition(store.error == "Model request failed")
        store.error = nil
        let previousMessageCount = store.current!.messages.count
        store.edit { $0.draft = "Keep this draft" }
        store.importRuntimeSession(store.current!.runtimeSession!, target: "local")
        precondition(store.current?.messages.count == previousMessageCount && store.current?.draft == "Keep this draft")
        let reuseStore = NativeChatStore(file: directory.appendingPathComponent("reuse.json"))
        reuseStore.newConversation(); let supervised = reuseStore.selection!
        reuseStore.edit { $0.runtimeSessionID = "supervised-without-messages" }
        reuseStore.newConversation()
        precondition(reuseStore.selection != supervised && reuseStore.conversations.count == 2)
        let formSchema: HarnessJSON = .object(["required": .array([.string("choice"), .string("count")]), "properties": .object([
            "choice": .object(["type": .string("string"), "enum": .array([.string("read"), .string("write")])]),
            "count": .object(["type": .string("integer"), "minimum": .number(1), "maximum": .number(5)]),
            "enabled": .object(["type": .string("boolean")]),
            "items": .object(["type": .string("array")])
        ])])
        let form = try DesktopHarnessForm.content(schema: formSchema, values: ["choice": "read", "count": "2", "items": "[1,2]"])
        precondition(form["enabled"] == .bool(false) && form["count"] == .number(2) && form["items"] == .array([.number(1), .number(2)]))
        for invalid in [["choice": "read"], ["choice": "other", "count": "2"], ["choice": "read", "count": "2.5"], ["choice": "read", "count": "6"], ["choice": "read", "count": "2", "items": "{}"]] {
            do { _ = try DesktopHarnessForm.content(schema: formSchema, values: invalid); preconditionFailure("Invalid form was accepted") } catch {}
        }
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
