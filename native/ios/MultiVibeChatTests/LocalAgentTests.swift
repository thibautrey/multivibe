import XCTest
@testable import MultiVibeChat

@MainActor final class LocalAgentTests: XCTestCase {
    func testGuestLocalRunUsesToolsWithoutAuthenticationOrNetwork() async throws {
        var saved: [Data] = []
        let services = SessionServices(writeHistory: { data, _ in saved.append(data) }, load: { nil },
            refresh: { _ in XCTFail("Local run must not refresh credentials"); throw APIError.invalidResponse },
            stream: { _, _, _, _ in XCTFail("Local model must never reach remote inference") },
            readLocalHistory: { _ in throw CocoaError(.fileReadNoSuchFile) },
            localAvailability: { nil }, localRespond: { _, workspace, output in
                let sum = try await workspace.execute(action: "add", query: "", documentID: "", text: "", lhs: 12, rhs: 8)
                let result = try await workspace.execute(action: "multiply", query: "", documentID: "", text: "", lhs: Double(sum)!, rhs: 3)
                await output(result)
            }, models: { _ in XCTFail("Guest must not request remote models"); return [] })
        let manager = ConversationManager(services: services)
        await manager.restore()
        XCTAssertEqual(manager.selectedModel, LocalModel.id)
        XCTAssertTrue(manager.send("Calcule (12+8)*3"))
        for _ in 0..<1000 { if !manager.isStreaming { break }; await Task.yield() }
        XCTAssertEqual(manager.current?.messages.last?.content, "60.0")
        XCTAssertEqual(manager.current?.messages.last?.completion, .completed)
        XCTAssertEqual(manager.current?.messages.last?.localEvents?.count, 2)
        XCTAssertFalse(saved.isEmpty)
        XCTAssertNil(manager.session)
    }

    func testGuestHistoryRestoresWithoutNetwork() async throws {
        var storage: [String: Data] = [:]
        let services = SessionServices(writeHistory: { storage[$1.lastPathComponent] = $0 }, load: { nil },
            readLocalHistory: { url in
                guard let data = storage[url.lastPathComponent] else { throw CocoaError(.fileReadNoSuchFile) }; return data
            },
            localAvailability: { nil }, localRespond: { _, _, output in await output("Réponse locale") })
        let first = ConversationManager(services: services)
        await first.restore()
        XCTAssertTrue(first.send("Bonjour"))
        for _ in 0..<1000 { if !first.isStreaming { break }; await Task.yield() }
        let second = ConversationManager(services: services)
        await second.restore()
        XCTAssertEqual(second.conversations, first.conversations)
        XCTAssertEqual(storage.keys.sorted(), ["history-guest.json"])
    }

    func testUnavailableLocalModelDoesNotCreateOrSendMessage() async {
        let manager = ConversationManager(services: SessionServices(writeHistory: { _, _ in }, load: { nil },
            readLocalHistory: { _ in throw CocoaError(.fileReadNoSuchFile) }, localAvailability: { "Modèle absent" },
            localRespond: { _, _, _ in XCTFail("Unavailable model must not run") }))
        await manager.restore()
        XCTAssertFalse(manager.send("Bonjour"))
        XCTAssertEqual(manager.error, "Modèle absent")
        XCTAssertTrue(manager.conversations.isEmpty)
    }

    func testWriteFailurePreventsInference() async {
        let manager = ConversationManager(services: SessionServices(writeHistory: { _, _ in throw CocoaError(.fileWriteOutOfSpace) },
            load: { nil }, readLocalHistory: { _ in throw CocoaError(.fileReadNoSuchFile) }, localAvailability: { nil },
            localRespond: { _, _, _ in XCTFail("Unsaved request must not execute") }))
        await manager.restore()
        XCTAssertFalse(manager.send("Bonjour"))
        XCTAssertFalse(manager.isStreaming)
    }

    func testToolBudgetAndDocumentIsolation() async throws {
        let document = LocalDocument(name: "Facture", text: "Total: 42")
        let workspace = LocalAgentWorkspace(conversations: [], documents: [document], event: { _ in }, saveDocument: { _ in })
        let read = try await workspace.execute(action: "read_document", query: "", documentID: document.id.uuidString, text: "", lhs: 0, rhs: 0)
        XCTAssertTrue(read.hasSuffix("Total: 42"))
        do {
            _ = try await workspace.execute(action: "read_document", query: "", documentID: "/etc/passwd", text: "", lhs: 0, rhs: 0)
            XCTFail("Arbitrary paths must not be readable")
        } catch LocalAgentError.documentMissing {}
        for _ in 0..<10 {
            _ = try await workspace.execute(action: "add", query: "", documentID: "", text: "", lhs: 1, rhs: 1)
        }
        do {
            _ = try await workspace.execute(action: "add", query: "", documentID: "", text: "", lhs: 1, rhs: 1)
            XCTFail("Budget must stop further calls")
        } catch LocalAgentError.budget {}
    }
}

@MainActor final class OfflineHistoryTests: XCTestCase {
    private func credentials(_ account: String, expired: Bool = false) -> NativeSession {
        NativeSession(accessToken: "fixture", refreshToken: "fixture", expiresAt: expired ? .distantPast : .distantFuture, accountId: account)
    }
    func testExpiredAccountCanRunLocalWithoutRefresh() async {
        let account = credentials(UUID().uuidString, expired: true)
        let manager = ConversationManager(services: SessionServices(writeHistory: { _, _ in }, load: { account },
            refresh: { _ in XCTFail("Offline inference must not refresh"); throw APIError.invalidResponse },
            stream: { _, _, _, _ in XCTFail("No remote inference") },
            readLocalHistory: { _ in throw CocoaError(.fileReadNoSuchFile) }, localAvailability: { nil },
            localRespond: { _, _, output in await output("Hors ligne") }, monitorConnectivity: false))
        await manager.restore(loadRemoteModels: false)
        XCTAssertTrue(manager.send("Bonjour"))
        for _ in 0..<1000 { if !manager.isStreaming { break }; await Task.yield() }
        XCTAssertEqual(manager.current?.messages.last?.content, "Hors ligne")
        XCTAssertEqual(manager.session?.accountId, account.accountId)
    }
    func testCorruptLocalStorageCannotBeOverwrittenByNewRun() async {
        var writes = 0
        let manager = ConversationManager(services: SessionServices(writeHistory: { _, _ in writes += 1 }, load: { nil },
            readLocalHistory: { _ in Data("not JSON".utf8) }, localAvailability: { nil },
            localRespond: { _, _, _ in XCTFail("Unreadable history must be preserved") }, monitorConnectivity: false))
        await manager.restore()
        XCTAssertNotNil(manager.error)
        XCTAssertFalse(manager.send("Bonjour"))
        XCTAssertEqual(writes, 0)
    }
    func testGuestImportIsExplicitAccountScopedAndIdempotent() async throws {
        var files: [String: Data] = [:]
        let services = SessionServices(writeHistory: { files[$1.lastPathComponent] = $0 }, load: { nil }, save: { _ in }, clear: {}, revoke: { _ in },
            readLocalHistory: { url in
                guard let data = files[url.lastPathComponent] else { throw CocoaError(.fileReadNoSuchFile) }; return data
            }, localAvailability: { nil }, localRespond: { _, _, output in await output("Privé") }, monitorConnectivity: false, models: { _ in [] })
        let manager = ConversationManager(services: services)
        await manager.restore()
        XCTAssertTrue(manager.send("Message invité"))
        for _ in 0..<1000 { if !manager.isStreaming { break }; await Task.yield() }
        let guest = manager.conversations
        try await manager.accept(credentials("account-A"))
        XCTAssertTrue(manager.conversations.isEmpty, "Login must not silently upload guest data")
        manager.importGuestHistory()
        XCTAssertEqual(manager.conversations.count, 1)
        XCTAssertNotEqual(manager.conversations.first?.id, guest.first?.id)
        manager.importGuestHistory()
        XCTAssertEqual(manager.conversations.count, 1)
        try await manager.accept(credentials("account-B"))
        XCTAssertTrue(manager.conversations.isEmpty, "Account A history cannot leak into B")
        await manager.logout()
        XCTAssertEqual(manager.conversations, guest)
        XCTAssertEqual(manager.selectedModel, LocalModel.id)
    }
    func testReconnectUploadsLocalConversationWithoutRemoteInference() async throws {
        let account = credentials(UUID().uuidString)
        var remote = AccountHistorySnapshot(accountId: account.accountId, revision: 0, conversations: [])
        var writes = 0
        let services = SessionServices(writeHistory: { _, _ in }, load: { account },
            readHistory: { _ in remote }, saveHistory: { snapshot, _ in writes += 1; remote = snapshot; remote.revision += 1; return remote },
            stream: { _, _, _, _ in XCTFail("Sync cannot trigger remote inference") },
            readLocalHistory: { _ in throw CocoaError(.fileReadNoSuchFile) }, localAvailability: { nil },
            localRespond: { _, _, output in await output("Réponse sans réseau") }, monitorConnectivity: false,
            syncDelay: { _ in await Task.yield() })
        let manager = ConversationManager(services: services)
        await manager.restore(loadRemoteModels: false)
        manager.connectivityChanged(false)
        manager.enableAutomaticSync()
        XCTAssertTrue(manager.send("Bonjour"))
        for _ in 0..<1000 { if !manager.isStreaming { break }; await Task.yield() }
        XCTAssertEqual(writes, 0)
        manager.connectivityChanged(true)
        for _ in 0..<1000 { if writes > 0 && !manager.isSynchronizing { break }; await Task.yield() }
        XCTAssertEqual(writes, 1)
        XCTAssertEqual(remote.conversations.first?.object?["model"]?.string, LocalModel.id)
        XCTAssertEqual(manager.current?.messages.last?.content, "Réponse sans réseau")
        manager.disableAutomaticSync()
    }
    func testLocalToolTraceSurvivesServerHistoryProjection() throws {
        let event = LocalAgentEvent(tool: "add", detail: "Étape 1 : add")
        let original = Conversation(model: LocalModel.id, messages: [ChatMessage(role: "assistant", content: "3", localEvents: [event], completion: .completed)])
        var snapshot = AccountHistorySnapshot(accountId: "fixture", revision: 0, conversations: [])
        var ids: [String: UUID] = [:]
        try snapshot.store(original, serverID: original.id.uuidString, messageIDs: &ids)
        let restored = try snapshot.projectedConversation(at: 0, id: original.id, messageIDs: &ids)
        XCTAssertEqual(restored.messages.first?.localEvents, [event])
    }
    func testStopPreventsLateToolSideEffect() async throws {
        actor Gate {
            var continuation: CheckedContinuation<Void, Never>?
            var started = false
            func wait() async { started = true; await withCheckedContinuation { continuation = $0 } }
            func release() { continuation?.resume() }
        }
        let gate = Gate()
        let manager = ConversationManager(services: SessionServices(writeHistory: { _, _ in }, load: { nil },
            readLocalHistory: { _ in throw CocoaError(.fileReadNoSuchFile) }, localAvailability: { nil },
            localRespond: { _, workspace, output in
                await gate.wait()
                _ = try await workspace.execute(action: "create_document", query: "Must not exist", documentID: "", text: "data", lhs: 0, rhs: 0)
                await output("Must not appear")
            }, monitorConnectivity: false))
        await manager.restore()
        XCTAssertTrue(manager.send("Crée un document"))
        for _ in 0..<1000 { if await gate.started { break }; await Task.yield() }
        manager.stop()
        await gate.release()
        for _ in 0..<50 { await Task.yield() }
        XCTAssertTrue(manager.localDocuments.isEmpty)
        XCTAssertEqual(manager.current?.messages.last?.completion, .stopped)
        XCTAssertEqual(manager.current?.messages.last?.content, "")
    }
}

@MainActor final class AppleFoundationDeviceTests: XCTestCase {
    /// Runs real Apple inference on supported hardware. Simulator/disabled models are
    /// explicitly skipped; a skip is not evidence of a successful local model run.
    func testRealAppleModelCompletesTwoDependentToolCalls() async throws {
        if let reason = LocalModel.unavailableReason { throw XCTSkip(reason) }
        actor Evidence {
            var events: [LocalAgentEvent] = []
            var answer = ""
            func record(_ event: LocalAgentEvent) { events.append(event) }
            func output(_ text: String) { answer = text }
        }
        let evidence = Evidence()
        let workspace = LocalAgentWorkspace(conversations: [], documents: [], event: { await evidence.record($0) }, saveDocument: { _ in
            XCTFail("This request does not authorize creating a document")
        })
        try await LocalAgent.respond(messages: [ChatMessage(role: "user", content: "Utilise obligatoirement l’outil local_workspace avec action add, lhs 137 et rhs 286. Puis utilise le résultat obtenu dans un second appel avec action multiply et rhs 7. Donne le résultat final en français.")], workspace: workspace, onText: { await evidence.output($0) })
        let events = await evidence.events
        let answer = await evidence.answer
        XCTAssertTrue(events.contains { $0.tool == "add" })
        XCTAssertTrue(events.contains { $0.tool == "multiply" })
        XCTAssertTrue(answer.replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "\u{202f}", with: "").contains("2961"), answer)
    }
}
