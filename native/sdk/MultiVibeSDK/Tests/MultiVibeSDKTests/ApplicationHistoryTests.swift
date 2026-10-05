import XCTest
import CryptoKit
@testable import MultiVibeSDK

final class ApplicationHistoryTests: XCTestCase {
    struct Fixture: Decodable {
        let privateKey: String
        let recoveryCode: String
        let record: HistoryKeyRecord
        let grant: ApplicationHistoryGrant
        let binding: HistoryBinding
        let document: JSONValue
        let envelope: HistoryEnvelope
        func key() throws -> P256.KeyAgreement.PrivateKey {
            try P256.KeyAgreement.PrivateKey(rawRepresentation: HistoryWire.decode(privateKey, min: 32, max: 32))
        }
    }
    func fixture() throws -> Fixture {
        try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: Bundle.module.url(forResource: "history-delegation-v2", withExtension: "json", subdirectory: "Fixtures")!))
    }
    @MainActor func testWebCryptoDelegationAndV2DocumentMatchOwner() throws {
        let f = try fixture()
        let app = try f.grant.unwrap(privateKey: f.key(), account: f.binding.accountId, application: f.binding.appId)
        let owner = try HistoryKeys.unlock(f.record, recoveryCode: f.recoveryCode, expectedAccountId: f.binding.accountId)
        XCTAssertEqual(try app.decrypt(f.envelope, binding: f.binding, as: JSONValue.self), f.document)
        XCTAssertEqual(try owner.decrypt(f.envelope, binding: f.binding, as: JSONValue.self), f.document)
        let saved = try app.encrypt(f.document, binding: f.binding)
        XCTAssertEqual(saved.version, 2)
        XCTAssertEqual(try owner.decrypt(saved, binding: f.binding, as: JSONValue.self), f.document)
        XCTAssertNotEqual(saved.nonce, try app.encrypt(f.document, binding: f.binding).nonce)
        app.lock()
        XCTAssertThrowsError(try app.decrypt(saved, binding: f.binding, as: JSONValue.self))
    }
    @MainActor func testDelegationRejectsRecipientAccountApplicationAndMetadataSubstitution() throws {
        let f = try fixture()
        XCTAssertThrowsError(try f.grant.unwrap(privateKey: P256.KeyAgreement.PrivateKey(), account: f.binding.accountId, application: f.binding.appId))
        XCTAssertThrowsError(try f.grant.unwrap(privateKey: f.key(), account: f.binding.appId, application: f.binding.appId))
        XCTAssertThrowsError(try f.grant.unwrap(privateKey: f.key(), account: f.binding.accountId, application: f.binding.accountId))
        var fields = try JSONSerialization.jsonObject(with: JSONEncoder().encode(f.grant)) as! [String: Any]
        fields["keyringRevision"] = f.grant.keyringRevision + 1
        let changed = try JSONDecoder().decode(ApplicationHistoryGrant.self, from: JSONSerialization.data(withJSONObject: fields))
        XCTAssertThrowsError(try changed.unwrap(privateKey: f.key(), account: f.binding.accountId, application: f.binding.appId))
        let app = try f.grant.unwrap(privateKey: f.key(), account: f.binding.accountId, application: f.binding.appId)
        let other = HistoryBinding(accountId: f.binding.accountId, appId: f.binding.accountId, conversationId: f.binding.conversationId, revision: 1)
        XCTAssertThrowsError(try app.encrypt(f.document, binding: other))
        let v1 = HistoryEnvelope(version: 1, algorithm: f.envelope.algorithm, nonce: f.envelope.nonce, ciphertext: f.envelope.ciphertext, keyId: f.envelope.keyId)
        XCTAssertThrowsError(try app.decrypt(v1, binding: f.binding, as: JSONValue.self))
    }
    @MainActor func testNewEncryptedConversationPendingRetryAndReload() async throws {
        let f = try fixture(), directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = OwnerEncryptedHistory(namespace: "app-test", directory: directory, applicationId: f.binding.appId)
        var bodies: [Data] = [], lost = true
        let transport: OwnerEncryptedHistory.Transport = { path, method, body in
            if path == "/sdk/v2/history-keys" { return try JSONSerialization.data(withJSONObject: ["grant": JSONSerialization.jsonObject(with: JSONEncoder().encode(f.grant))]) }
            guard path.hasPrefix("/sdk/v2/conversations/"), method == "POST", let body else { throw MultiVibeError.invalidResponse }
            bodies.append(body)
            if lost { lost = false; throw URLError(.networkConnectionLost) }
            let value = try JSONSerialization.jsonObject(with: body) as! [String: Any]
            return try JSONSerialization.data(withJSONObject: ["id": String(path.split(separator: "/").last!), "revision": (value["revision"] as! Int) + 1, "deleted": false])
        }
        try await store.unlockApplication(accountId: f.binding.accountId, privateKey: f.key(), transport: transport)
        var draft = MultiVibeConversation(appId: f.binding.appId, model: "cloud/test")
        draft.title = "Never plaintext on the wire"; draft.messages = [MultiVibeMessage(role: "user", content: "private message")]
        do { _ = try await store.save(draft, operationId: UUID().uuidString, transport: transport); XCTFail() } catch is URLError {}
        XCTAssertTrue(store.hasPending)
        XCTAssertFalse(String(decoding: bodies[0], as: UTF8.self).contains(draft.title))
        store.lock()
        let restored = OwnerEncryptedHistory(namespace: "app-test", directory: directory, applicationId: f.binding.appId)
        try await restored.unlockApplication(accountId: f.binding.accountId, privateKey: f.key(), transport: transport)
        XCTAssertTrue(restored.hasPending)
        let saved = try await restored.retry(transport: transport)
        XCTAssertEqual(saved?.title, draft.title); XCTAssertEqual(saved?.revision, 1)
        XCTAssertEqual(bodies.count, 2); XCTAssertEqual(bodies[0], bodies[1]); XCTAssertFalse(restored.hasPending)
    }
}
