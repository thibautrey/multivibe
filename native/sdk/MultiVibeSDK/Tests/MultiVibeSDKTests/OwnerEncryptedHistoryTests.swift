import XCTest
@testable import MultiVibeSDK

@MainActor private final class OwnerWire {
    let fixture: EncryptedHistoryTests.Fixture
    let keys: HistoryKeys
    var records: [String: Data] = [:]
    var requests: [(String, String, Data?)] = []
    var loseReceipt = false
    var corruptAccount = false
    var beforeRead: (() -> Void)?
    let document: JSONValue
    init() throws {
        fixture = try EncryptedHistoryTests().fixture()
        keys = try HistoryKeys.unlock(fixture.record, recoveryCode: fixture.recoveryCode, expectedAccountId: fixture.binding.accountId)
        document = .object(["title": .string("Web secret"), "model": .string("cloud/test"), "future": .string("preserve me"), "messages": .array([
            .object(["id": .string("message-1"), "role": .string("user"), "content": .string("private message"), "receipt": .string("future receipt")])])])
        let envelope = try keys.encrypt(document, binding: fixture.binding)
        records[fixture.binding.conversationId] = try record(envelope, revision: fixture.binding.revision)
    }
    func record(_ envelope: HistoryEnvelope, revision: Int) throws -> Data {
        struct WireRecord: Encodable { let id: String; let accountId: String; let appId: String; let revision: Int; let updatedAt: String; let envelope: HistoryEnvelope }
        return try JSONEncoder().encode(WireRecord(id: fixture.binding.conversationId, accountId: corruptAccount ? fixture.binding.appId : fixture.binding.accountId, appId: fixture.binding.appId, revision: revision, updatedAt: "2026-10-01T00:00:00Z", envelope: envelope))
    }
    func request(_ path: String, _ method: String, _ body: Data?) async throws -> Data {
        requests.append((path, method, body))
        if path == "/native/v2/history-keys" {
            struct Reply: Encodable { let accountId: String; let keyring: HistoryKeyRecord }
            return try JSONEncoder().encode(Reply(accountId: fixture.binding.accountId, keyring: fixture.record))
        }
        if path == "/native/v2/sdk/conversations" {
            return try JSONSerialization.data(withJSONObject: ["data": [["id": fixture.binding.conversationId, "appId": fixture.binding.appId, "revision": 3, "updatedAt": "2026-10-01T00:00:00Z"]], "nextCursor": NSNull()])
        }
        if path == "/native/v2/sdk/conversations/" + fixture.binding.conversationId {
            if method == "GET" { beforeRead?(); return records[fixture.binding.conversationId]! }
            let fields = try JSONSerialization.jsonObject(with: body!) as! [String: Any]
            let revision = (fields["revision"] as! Int) + 1
            if method == "POST" {
                let envelope = try JSONDecoder().decode(HistoryEnvelope.self, from: JSONSerialization.data(withJSONObject: fields["envelope"]!))
                records[fixture.binding.conversationId] = try record(envelope, revision: revision)
            }
            if loseReceipt { loseReceipt = false; throw URLError(.networkConnectionLost) }
            return try JSONSerialization.data(withJSONObject: ["id": fixture.binding.conversationId, "revision": revision, "deleted": method == "DELETE"])
        }
        throw MultiVibeError.invalidResponse
    }
}

private actor InterruptedLocalModel: MultiVibeLocalModelProvider {
    nonisolated let modelID = "local/test"
    private(set) var calls = 0
    func isAvailable() async -> Bool { true }
    func respond(messages: [MultiVibeMessage], context: String) async throws -> String {
        calls += 1
        throw URLError(.networkConnectionLost)
    }
}

final class OwnerEncryptedHistoryTests: XCTestCase {
    @MainActor func testOpaqueWriteRetrySurvivesRecreationAndPreservesWebFields() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let wire = try OwnerWire()
        let history = OwnerEncryptedHistory(namespace: "test", directory: directory)
        try await history.unlock(accountId: wire.fixture.binding.accountId, code: wire.fixture.recoveryCode, transport: wire.request)
        try await history.reload(transport: wire.request)
        XCTAssertEqual(history.conversations.first?.title, "Web secret")
        var changed = try XCTUnwrap(history.conversations.first); changed.title = "Updated secret"
        wire.loseReceipt = true
        do { _ = try await history.save(changed, operationId: UUID().uuidString, transport: wire.request); XCTFail() } catch is URLError {}
        XCTAssertTrue(history.hasPending)
        do { try await history.reload(transport: wire.request); XCTFail() } catch MultiVibeError.historyWritePending {}
        let firstBody = try XCTUnwrap(wire.requests.last(where: { $0.1 == "POST" })?.2)
        XCTAssertFalse(String(decoding: firstBody, as: UTF8.self).contains("Updated secret"))
        history.lock()
        let resumed = OwnerEncryptedHistory(namespace: "test", directory: directory)
        try await resumed.unlock(accountId: wire.fixture.binding.accountId, code: wire.fixture.recoveryCode, transport: wire.request)
        XCTAssertTrue(resumed.hasPending)
        let saved = try await resumed.retry(transport: wire.request)
        XCTAssertEqual(saved?.revision, 4)
        XCTAssertEqual(saved?.title, "Updated secret")
        XCTAssertEqual(firstBody, wire.requests.last(where: { $0.1 == "POST" })?.2)
        XCTAssertFalse(resumed.hasPending)
        let stored = try XCTUnwrap(wire.records[wire.fixture.binding.conversationId])
        let envelope = try JSONDecoder().decode(JSONValue.self, from: stored)
        guard case .object(let fields) = envelope, let e = fields["envelope"] else { return XCTFail() }
        let ciphertext = try JSONDecoder().decode(HistoryEnvelope.self, from: JSONEncoder().encode(e))
        let b = wire.fixture.binding
        let clear = try wire.keys.decrypt(ciphertext, binding: HistoryBinding(accountId: b.accountId, appId: b.appId, conversationId: b.conversationId, revision: 4), as: JSONValue.self)
        guard case .object(let document) = clear, case .array(let messages) = document["messages"], case .object(let message) = messages[0] else { return XCTFail() }
        XCTAssertEqual(document["future"], .string("preserve me")); XCTAssertEqual(message["receipt"], .string("future receipt"))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
    }
    @MainActor func testForeignAccountAndLockDuringReadNeverExposePlaintext() async throws {
        let wire = try OwnerWire()
        let history = OwnerEncryptedHistory(namespace: UUID().uuidString)
        try await history.unlock(accountId: wire.fixture.binding.accountId, code: wire.fixture.recoveryCode, transport: wire.request)
        wire.corruptAccount = true
        wire.records[wire.fixture.binding.conversationId] = try wire.record(wire.keys.encrypt(wire.document, binding: wire.fixture.binding), revision: 3)
        do { try await history.reload(transport: wire.request); XCTFail() } catch MultiVibeError.invalidResponse {}
        XCTAssertTrue(history.conversations.isEmpty)
        wire.beforeRead = { history.lock() }
        do { try await history.reload(transport: wire.request); XCTFail() } catch MultiVibeError.historyLocked {}
        XCTAssertFalse(history.unlocked); XCTAssertTrue(history.conversations.isEmpty)
    }
    @MainActor func testLostDeleteReceiptRetriesSameOperation() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let wire = try OwnerWire(), history = OwnerEncryptedHistory(namespace: "delete", directory: directory)
        try await history.unlock(accountId: wire.fixture.binding.accountId, code: wire.fixture.recoveryCode, transport: wire.request)
        try await history.reload(transport: wire.request)
        wire.loseReceipt = true
        do { try await history.delete(history.conversations[0], transport: wire.request); XCTFail() } catch is URLError {}
        let first = wire.requests.last!.2
        try await history.retry(transport: wire.request)
        XCTAssertEqual(first, wire.requests.last!.2); XCTAssertTrue(history.conversations.isEmpty)
    }
    @MainActor func testApplicationCannotRequestAccountKeyring() async throws {
        let client = MultiVibeClient(configuration: .init(clientID: UUID().uuidString, redirectURI: URL(string: "https://example.com/callback")!))
        var requests = 0
        client.dataTransportOverride = { _ in requests += 1; throw MultiVibeError.invalidResponse }
        do { try await client.unlockHistory(recoveryCode: "never send"); XCTFail() } catch MultiVibeError.authenticationRequired {}
        XCTAssertEqual(requests, 0)
    }
    @MainActor func testOfficialClientUsesV2HistoryAndNeverUploadsRecoveryCode() async throws {
        let wire = try OwnerWire()
        let client = MultiVibeClient(configuration: .init(clientID: "multivibe-ios", redirectURI: URL(string: "https://example.com/callback")!), mode: .accountOwner, tokenProvider: { "synthetic-token" })
        var paths: [String] = []
        client.dataTransportOverride = { request in
            paths.append(request.url!.path)
            XCTAssertFalse(String(decoding: request.httpBody ?? Data(), as: UTF8.self).contains(wire.fixture.recoveryCode))
            let bytes: Data
            switch request.url!.path {
            case "/native/v1/auth/session": bytes = try JSONSerialization.data(withJSONObject: ["accountId": wire.fixture.binding.accountId])
            case "/native/v1/models": bytes = Data("{\"data\":[]}".utf8)
            default: bytes = try await wire.request(request.url!.path, request.httpMethod!, request.httpBody)
            }
            return (bytes, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        try await client.connect()
        XCTAssertFalse(client.isHistoryUnlocked)
        XCTAssertTrue(client.conversations.isEmpty)
        try await client.unlockHistory(recoveryCode: wire.fixture.recoveryCode)
        XCTAssertTrue(client.isHistoryUnlocked)
        XCTAssertEqual(client.conversations.first?.title, "Web secret")
        XCTAssertFalse(paths.contains("/native/v1/sdk/conversations"))
        client.lockHistory()
        XCTAssertFalse(client.isHistoryUnlocked); XCTAssertTrue(client.conversations.isEmpty)
    }
    @MainActor func testRepeatedPaginationCursorFailsRatherThanLooping() async throws {
        let wire = try OwnerWire(), history = OwnerEncryptedHistory(namespace: UUID().uuidString)
        try await history.unlock(accountId: wire.fixture.binding.accountId, code: wire.fixture.recoveryCode, transport: wire.request)
        var count = 0
        do {
            try await history.reload { _, _, _ in
                count += 1
                return try JSONSerialization.data(withJSONObject: ["data": [], "nextCursor": wire.fixture.binding.conversationId])
            }
            XCTFail()
        } catch MultiVibeError.invalidResponse {}
        XCTAssertEqual(count, 2); XCTAssertTrue(history.conversations.isEmpty)
    }

    @MainActor func testModelFailureLeavesEncryptedExecutionMarkerWithoutReplay() async throws {
        let wire = try OwnerWire(), model = InterruptedLocalModel()
        let client = MultiVibeClient(configuration: .init(clientID: "multivibe-ios", redirectURI: URL(string: "https://example.com/callback")!), mode: .accountOwner, localProvider: model, tokenProvider: { "synthetic-token" })
        client.dataTransportOverride = { request in
            let bytes: Data
            switch request.url!.path {
            case "/native/v1/auth/session": bytes = try JSONSerialization.data(withJSONObject: ["accountId": wire.fixture.binding.accountId])
            case "/native/v1/models": bytes = Data("{\"data\":[]}".utf8)
            default: bytes = try await wire.request(request.url!.path, request.httpMethod!, request.httpBody)
            }
            return (bytes, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        try await client.connect(); try await client.unlockHistory(recoveryCode: wire.fixture.recoveryCode)
        var conversation = client.conversations[0]; conversation.model = model.modelID
        do { _ = try await client.respond(to: conversation, confirm: { _ in false }, update: { _ in }); XCTFail() } catch is URLError {}
        try await client.reload()
        XCTAssertEqual(client.conversations[0].messages.last?.status, "interrupted")
        XCTAssertEqual(client.conversations[0].messages.last?.role, "assistant")
        let calls = await model.calls; XCTAssertEqual(calls, 1)
        XCTAssertEqual(wire.requests.filter { $0.1 == "POST" }.count, 2)
        client.lockHistory()
    }

    @MainActor func testStaleClientCannotRemoveAnotherPendingWrite() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let wire = try OwnerWire(), history = OwnerEncryptedHistory(namespace: "shared", directory: directory)
        try await history.unlock(accountId: wire.fixture.binding.accountId, code: wire.fixture.recoveryCode, transport: wire.request)
        try await history.reload(transport: wire.request)
        wire.loseReceipt = true
        do { _ = try await history.save(history.conversations[0], operationId: UUID().uuidString, transport: wire.request); XCTFail() } catch is URLError {}
        let location = directory.appendingPathComponent(wire.fixture.binding.accountId + ".json")
        var newer = try JSONSerialization.jsonObject(with: Data(contentsOf: location)) as! [String: Any]
        newer["operationId"] = UUID().uuidString.lowercased()
        let bytes = try JSONSerialization.data(withJSONObject: newer)
        try bytes.write(to: location)
        do { try await history.retry(transport: wire.request); XCTFail() } catch MultiVibeError.historyWritePending {}
        XCTAssertEqual(try Data(contentsOf: location), bytes)
        XCTAssertTrue(history.hasPending)
    }

}
