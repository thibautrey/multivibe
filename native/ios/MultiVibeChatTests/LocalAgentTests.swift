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
            readLocalHistory: { url in try XCTUnwrap(storage[url.lastPathComponent]) },
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
        XCTAssertEqual(read, "Total: 42")
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
