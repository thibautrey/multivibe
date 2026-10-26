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
        let suite = "multivibe-model-preferences-test-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
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
        validateModelPreferences(folder: directory, defaults: defaults)
        defaults.removeObject(forKey: NativeChatStore.modelPreferencesKey)
        HostAssistantClient.shared.defaultModel = "fixture"
        NativeChatStore.defaultHarnessID = "native"
        try await validateRemoteChatSynchronization(folder: directory, defaults: defaults)
        try await validateAutomaticConversationDiscovery(folder: directory, defaults: defaults)
        let file = directory.appendingPathComponent("history.json")
        let store = NativeChatStore(file: file, defaults: defaults)
        store.newConversation()
        let first = store.selection!
        store.edit { $0.workspace = "/tmp/previous-project" }
        HostAssistantClient.shared.defaultModel = "latest-model"
        NativeChatStore.defaultHarnessID = "pi"
        store.error = "Failure in the previous conversation"
        store.newConversation()
        precondition(store.error == nil)
        precondition(store.selection == first && store.conversations.count == 1)
        precondition(store.current?.model == "latest-model" && store.current?.harnessID == "pi" && store.current?.workspace == nil)
        let initialReceipt = DesktopHarnessReceipt(id: "initial", sessionId: "session", command: .object(["displayText": .string("Premier message")]), state: "queued", createdAt: 1, ordinal: 1, result: nil, error: nil)
        let secondReceipt = DesktopHarnessReceipt(id: "second", sessionId: "session", command: .object(["displayText": .string("Deuxième message")]), state: "queued", createdAt: 2, ordinal: 2, result: nil, error: nil)
        let thirdReceipt = DesktopHarnessReceipt(id: "third", sessionId: "session", command: .object(["displayText": .string("Troisième message")]), state: "queued", createdAt: 3, ordinal: 3, result: nil, error: nil)
        let threeMessages = [initialReceipt, secondReceipt, thirdReceipt]
        let projectedQueue = NativeChatStore.followUpQueue(threeMessages, initialCommandID: initialReceipt.id)
        precondition(projectedQueue.map(\.id) == [secondReceipt.id, thirdReceipt.id])
        precondition(NativeChatStore.reorderedQueueIDs(threeMessages, initialCommandID: initialReceipt.id, receiptID: secondReceipt.id, by: 1) == [initialReceipt.id, thirdReceipt.id, secondReceipt.id])
        precondition(NativeChatStore.reorderedQueueIDs(threeMessages, initialCommandID: initialReceipt.id, receiptID: secondReceipt.id, by: -1) == nil)
        precondition(NativeChatStore.followUpQueue(threeMessages, initialCommandID: nil).map(\.id) == [initialReceipt.id, secondReceipt.id, thirdReceipt.id])
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
        let restored = NativeChatStore(file: file, defaults: defaults)
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
        let selectedWorkspace = "/tmp/multivibe-project"
        store.edit { $0.harnessID = "pi"; $0.workspace = selectedWorkspace }
        store.send()
        while store.generating != nil { try await Task.sleep(nanoseconds: 10_000_000) }
        precondition(NativeHarnessClient.shared.receivedHarnessID == "pi")
        precondition(DesktopHarnessClient.shared.lastCreatedWorkspace == selectedWorkspace)
        precondition(store.current?.runtimeSession?.workspace == selectedWorkspace)
        precondition(NativeChatStore(file: file, defaults: defaults).conversations.first { $0.id == second }?.workspace == selectedWorkspace)
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
        precondition(store.current?.messages.last?.runtimeTextSequences?["parent"] == sequence - 3)
        precondition(store.current?.messages.last?.runtimeTextSequences?["second"] == sequence - 1)
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
        store.selection = first
        precondition(store.error == nil)
        runtimeEvent("turn.failed", .object(["error": .string("Background failure")]))
        precondition(store.error == nil)
        store.selection = second
        store.error = nil
        let previousMessageCount = store.current!.messages.count
        store.edit { $0.draft = "Keep this draft" }
        store.importRuntimeSession(store.current!.runtimeSession!, target: "local")
        precondition(store.current?.messages.count == previousMessageCount && store.current?.draft == "Keep this draft")
        let reuseStore = NativeChatStore(file: directory.appendingPathComponent("reuse.json"), defaults: defaults)
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
        let withArtifact = NativeChatStore(file: file, defaults: defaults)
        let saved = withArtifact.conversations.first { $0.messages.last?.content == artifact }!
        precondition(NativeInteractiveDocument.segments(saved.messages.last!.content).contains { if case .document = $0 { return true }; return false })
        store.newConversation(text: "Brouillon à conserver")
        store.edit { $0.harnessID = "pi"; $0.authMode = "native"; $0.nativeModelID = "native-picked"; $0.nativeModelProvider = "native-provider" }
        let catalog = try await store.modelCatalog(store.selection!)
        precondition(catalog.models.first?.id == "native-picked" && catalog.models.first?.provider == "native-provider")
        let features = try await store.featureCatalog(store.selection!)
        precondition(features.harnessId == "pi" && features.items.first?.name == "Documents" && features.items.first?.value == "/skill:Documents ")
        let effort = try await store.effortCatalog(store.selection!)!
        try await store.selectEffort("high", catalog: effort, conversationID: store.selection!)
        try await store.resetEffort(catalog: effort, conversationID: store.selection!)
        precondition(store.current?.selectedEffort == nil)
        try await store.selectEffort("high", catalog: effort, conversationID: store.selection!)
        do { try await store.selectEffort("invented", catalog: effort, conversationID: store.selection!); preconditionFailure("Unadvertised effort was accepted") }
        catch { }
        let effortSelection = store.current!
        store.edit { $0.nativeModelID = "different-model" }
        precondition(store.current?.selectedEffort == nil)
        store.edit { $0.nativeModelID = effortSelection.nativeModelID }
        let selectedNative = NativeChatStore(file: file, defaults: defaults).current
        precondition(selectedNative?.selectedEffort == "high")
        print("PASS harness effort discovery, validation, model scoping and persistence")
        precondition(selectedNative?.nativeModelID == "native-picked" && selectedNative?.nativeModelProvider == "native-provider")
        store.send(interactiveAnswers: true)
        while store.current?.messages.last?.content != "Réponse du harness" { try await Task.sleep(nanoseconds: 10_000_000) }
        print("PASS harness catalog and native model selection persistence")
        HostAssistantClient.shared.defaultModel = "remembered-model"
        NativeChatStore.defaultHarnessID = "hermes-agent"
        store.newConversation(text: "Les préférences doivent suivre")
        precondition(store.current?.model == "remembered-model")
        precondition(store.current?.harnessID == "hermes-agent")
        try Data("invalid-history".utf8).write(to: file)
        let corrupt = NativeChatStore(file: file, defaults: defaults)
        precondition(corrupt.error != nil)
        corrupt.newConversation()
        let original = try String(contentsOf: file, encoding: .utf8)
        precondition(original == "invalid-history")
        print("PASS history persistence, permissions, harness routing/session, multi-turn context, cancellation, retry, selection isolation, deletion, corrupt-file preservation")
    }
}

@MainActor private final class RemoteChatRuntimeFixture: DesktopHarnessServing {
    var identity = "account-one"
    var title = "Web conversation"
    var text = "Answer from web"
    var revision = "one"
    var present = true
    var denied = false
    var deleted = false
    var attached = false
    func call(_ route: String, method: String, target: String, body: HarnessJSON?) async throws -> HarnessJSON {
        if denied { throw DesktopHarnessError.rejected("Connection unavailable") }
        if route == "/librechat" { return .object(["configured": .bool(true)]) }
        if route == "/openwebui" { return .object(["configured": .bool(false)]) }
        let summary: HarnessJSON = .object(["id": .string("native-chat"), "title": .string(title), "updatedAt": .number(1792900000000), "archived": .bool(false), "pinned": .bool(false), "model": .string("agent-web")])
        if route == "/remote-chats?harnessId=librechat" {
            return .object(["connectionId": .string(identity), "endpoint": .string("https://fixture.example/api/agents/v1"), "complete": .bool(true), "conversations": .array(present ? [summary] : [])])
        }
        if route.hasPrefix("/remote-chats/") {
            if method == "DELETE" { deleted = true; present = false; return .object(["deleted": .bool(true)]) }
            if method == "PATCH" { title = body?["title"].string ?? title; revision += "changed" }
            var snapshot = summary.object
            snapshot["title"] = .string(title); snapshot["revision"] = .string(revision)
            snapshot["messages"] = .array([.object(["id": .string("user-one"), "role": .string("user"), "content": .string("Hello"), "done": .bool(true)]), .object(["id": .string("assistant-one"), "role": .string("assistant"), "content": .string(text), "done": .bool(true)])])
            return .object(["connectionId": .string(identity), "conversation": .object(snapshot)])
        }
        throw DesktopHarnessError.invalidResponse
    }
    func events(sessionID: String, target: String, after: Int, update: @MainActor @escaping (DesktopHarnessEvent) -> Void) async throws { }
}

@MainActor private func validateRemoteChatSynchronization(folder: URL, defaults: UserDefaults) async throws {
    let remote = RemoteChatRuntimeFixture()
    let store = NativeChatStore(file: folder.appendingPathComponent("remote-conversations.json"), runtime: remote, defaults: defaults)
    await store.synchronizeRemoteChats(force: true)
    precondition(store.conversations.count == 1)
    let id = store.conversations[0].id
    store.selection = id
    await store.synchronizeRemoteChats(force: true)
    precondition(store.current?.messages.map(\.content) == ["Hello", "Answer from web"])
    let messageID = store.current!.messages[1].id
    store.edit { $0.messages.append(NativeChatMessage(role: "assistant", content: "Late replay of a local event")) }
    await store.synchronizeRemoteChats(force: true)
    precondition(store.current?.messages.count == 2 && store.current?.messages[1].id == messageID)
    store.edit { $0.draft = "Preserve this draft" }
    remote.text = "Edited in the web client"; remote.title = "Renamed on server"; remote.revision = "two"
    await store.synchronizeRemoteChats(force: true)
    precondition(store.conversations.count == 1 && store.current?.id == id)
    precondition(store.current?.messages[1].id == messageID && store.current?.messages[1].content == remote.text)
    precondition(store.current?.draft == "Preserve this draft" && store.current?.title == remote.title)
    remote.denied = true
    await store.synchronizeRemoteChats(force: true)
    precondition(store.conversations.count == 1 && !store.remoteSyncErrors.isEmpty)
    remote.denied = false; remote.identity = "account-two"
    await store.synchronizeRemoteChats(force: true)
    precondition(store.conversations.count == 2 && store.current?.messages[1].content == "Edited in the web client")
    remote.identity = "account-one"; remote.present = false
    await store.synchronizeRemoteChats(force: true)
    precondition(store.current?.remoteUnavailable == true && store.current?.draft == "Preserve this draft")
    remote.present = true; store.edit { $0.draft = "" }
    await store.synchronizeRemoteChats(force: true)
    store.updateMetadata(id, title: "Renamed in Desktop")
    for _ in 0..<100 where store.current?.title != "Renamed in Desktop" { try await Task.sleep(nanoseconds: 10_000_000) }
    precondition(remote.title == "Renamed in Desktop" && store.current?.title == remote.title)
    store.delete(id)
    for _ in 0..<100 where !remote.deleted { try await Task.sleep(nanoseconds: 10_000_000) }
    precondition(remote.deleted && !store.conversations.contains { $0.id == id })
    print("PASS remote chat list, live messages, stable identity, account isolation, drafts, offline preservation and server mutations")
}

@MainActor private func validateModelPreferences(folder: URL, defaults: UserDefaults) {
    let file = folder.appendingPathComponent("preferences.json")
    let store = NativeChatStore(file: file, defaults: defaults)
    store.newConversation()
    store.edit { $0.model = "host-a" }
    store.rememberCurrentModel()
    store.selectHarness("pi")
    store.edit { $0.nativeModelID = "shared-id"; $0.nativeModelProvider = "provider-a" }
    store.rememberCurrentModel()
    store.selectHarness("openai-codex")
    precondition(store.current?.nativeModelID == nil && store.current?.nativeModelProvider == nil)
    store.edit { $0.authMode = "multivibe"; $0.model = "host-b" }
    store.rememberCurrentModel()
    store.selectHarness("pi")
    precondition(store.current?.nativeModelID == "shared-id" && store.current?.nativeModelProvider == "provider-a" && store.current?.authMode == "native")
    store.selectHarness("native")
    precondition(store.current?.model == "host-a" && store.current?.nativeModelID == nil)
    store.selectHarness("openai-codex")
    precondition(store.current?.authMode == "multivibe" && store.current?.model == "host-b")
    // Reopening existing history must preserve that conversation's model.
    store.edit { $0.model = "conversation-specific" }
    let reopened = NativeChatStore(file: file, defaults: defaults)
    precondition(reopened.current?.model == "conversation-specific")
    reopened.newConversation()
    precondition(reopened.current?.model == "host-b" && reopened.current?.authMode == "multivibe")
    // A fresh store after restart restores the same persisted preference.
    let restarted = NativeChatStore(file: folder.appendingPathComponent("fresh.json"), defaults: defaults)
    restarted.newConversation(text: "New draft")
    precondition(restarted.current?.model == "host-b")
    restarted.selectHarness("pi")
    precondition(restarted.current?.nativeModelID == "shared-id")
    restarted.edit { $0.executionTargetID = "remote" }
    restarted.selectHarness("pi")
    precondition(restarted.current?.nativeModelID == nil)
    restarted.edit { $0.nativeModelID = "remote-model"; $0.nativeModelProvider = "provider-b" }
    restarted.rememberCurrentModel()
    restarted.edit { $0.executionTargetID = nil }
    restarted.selectHarness("pi")
    precondition(restarted.current?.nativeModelID == "shared-id" && restarted.current?.nativeModelProvider == "provider-a")
    // Reusing an empty draft also restores preferences and clears other harness fields.
    restarted.newConversation()
    precondition(restarted.current?.nativeModelID == "shared-id")
    restarted.edit { $0.messages = [NativeChatMessage(role: "user", content: "Started")] }
    restarted.selectHarness("native")
    precondition(restarted.current?.harnessID == "pi" && restarted.current?.nativeModelID == "shared-id")
    restarted.newConversation(text: "Fresh conversation")
    precondition(restarted.current?.nativeModelID == "shared-id")
    let project = DesktopHarnessProject(id: "one", harnessId: "pi", name: "Été Multivibe", path: "/Users/demo/Work/astronomy-store", updatedAt: 0)
    precondition(project.matches(search: "  "))
    precondition(project.matches(search: "ETE"))
    precondition(project.matches(search: "STORE"))
    precondition(project.matches(search: "multivibe astronomy"))
    precondition(!project.matches(search: "multivibe absent"))
    print("PASS per-harness model preferences, provider/source and target isolation, restart, fresh/reused drafts, existing conversations and project search")
}


@MainActor private final class NativeSourcesRuntimeFixture: DesktopHarnessServing {
    var offline = false
    var revision = "one"
    var text = "External answer"
    var mutations = 0
    var importedSource: String?
    func source() -> DesktopNativeSessionSource {
        .init(sourceId: "external-source", harnessId: "pi", nativeSessionId: "/native/session.jsonl", title: "Created in the CLI", workspace: "/project", updatedAt: 1793000000000, canContinue: true, strategy: "isolated_fork", reason: nil)
    }
    func call(_ route: String, method: String, target: String, body: HarnessJSON?) async throws -> HarnessJSON {
        if method != "GET" { mutations += 1 }
        if route == "/targets" { return .object(["targets": .array([.object(["id": .string("local"), "name": .string("Mac"), "kind": .string("local")]), .object(["id": .string("ssh-host"), "name": .string("Remote Host"), "kind": .string("ssh")])])]) }
        if route.hasPrefix("/conversation-sources") {
            if offline { throw DesktopHarnessError.rejected("Offline") }
            if route.contains("page=1") { return .object(["sessions": .array([]), "nativeSessions": .array([try .encode(source())]), "nextPage": .null]) }
            return .object(["sessions": .array([]), "nativeSessions": .array([]), "nextPage": .number(1)])
        }
        if route == "/librechat" || route == "/openwebui" { return .object(["configured": .bool(false)]) }
        if route.hasPrefix("/native-sessions/") {
            if offline { throw DesktopHarnessError.rejected("Offline") }
            return .object(["source": try .encode(source()), "revision": .string(revision), "messages": .array([.object(["id": .string("native-user"), "role": .string("user"), "content": .string("External question"), "done": .bool(true)]), .object(["id": .string("native-answer"), "role": .string("assistant"), "content": .string(text), "done": .bool(true)])])])
        }
        if route == "/sessions/import" {
            precondition(body?["history"] == .null || body?.object["history"] == nil)
            importedSource = body?["sourceId"].string
            throw DesktopHarnessError.rejected("Fixture stopped before execution")
        }
        throw DesktopHarnessError.invalidResponse
    }
    func events(sessionID: String, target: String, after: Int, update: @MainActor @escaping (DesktopHarnessEvent) -> Void) async throws { }
}

@MainActor private func validateAutomaticConversationDiscovery(folder: URL, defaults: UserDefaults) async throws {
    let runtime = NativeSourcesRuntimeFixture()
    let store = NativeChatStore(file: folder.appendingPathComponent("native-sources.json"), runtime: runtime, defaults: defaults)
    store.newConversation(); let draftID = store.selection!
    await store.synchronizeConversations()
    precondition(store.selection == draftID && store.conversations.count == 3)
    precondition(Set(store.conversations.filter { $0.nativeSource != nil }.compactMap(\.executionTargetID)) == ["local", "ssh-host"])
    await store.synchronizeConversations()
    precondition(store.conversations.count == 3 && runtime.mutations == 0)
    let id = store.conversations.first { $0.executionTargetID == "ssh-host" }!.id
    store.selection = id
    try await store.refreshNativeConversation(id)
    let messageID = store.current!.messages[1].id
    store.edit { $0.draft = "Keep draft" }
    runtime.revision = "two"; runtime.text = "Updated in native CLI"
    try await store.refreshNativeConversation(id)
    precondition(store.current?.messages[1].id == messageID && store.current?.messages[1].content == runtime.text && store.current?.draft == "Keep draft")
    runtime.offline = true
    await store.synchronizeConversations()
    precondition(store.conversations.count == 3 && store.current?.messages.count == 2 && !store.remoteSyncErrors.isEmpty)
    runtime.offline = false
    await store.synchronizeConversations()
    store.newConversation()
    precondition(store.selection == draftID && store.conversations.count == 3)
    store.selection = id
    do { _ = try await store.command(id, type: "inspect"); preconditionFailure("Fixture should stop attachment") } catch { }
    precondition(runtime.importedSource == "external-source" && runtime.mutations == 1)
    store.delete(id)
    await store.synchronizeConversations()
    precondition(!store.conversations.contains { $0.id == id } && store.conversations.count == 2)
    // Identical native IDs on distinct environments never collapse into one conversation.
    precondition(store.conversations.filter { $0.nativeSource != nil }.count == 1)
    print("PASS automatic native discovery across all environments, stable messages, live updates, read-only loading, drafts, offline cache, isolated continuation and dismissal")
}
