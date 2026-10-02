import XCTest
@testable import MultiVibeSDK

final class EncryptedHistoryTests: XCTestCase {
    struct Fixture: Decodable {
        let recoveryCode: String
        let record: HistoryKeyRecord
        let binding: HistoryBinding
        let document: JSONValue
        let envelopes: [HistoryEnvelope]
    }
    func fixture() throws -> Fixture {
        let url = Bundle.module.url(forResource: "history-v1", withExtension: "json", subdirectory: "Fixtures")!
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }
    @MainActor func testTypeScriptKeyringAndBothGenerationsDecrypt() throws {
        let f = try fixture()
        let keys = try HistoryKeys.unlock(f.record, recoveryCode: f.recoveryCode, expectedAccountId: f.binding.accountId)
        for envelope in f.envelopes {
            XCTAssertEqual(try keys.decrypt(envelope, binding: f.binding, as: JSONValue.self), f.document)
        }
        let saved = try keys.encrypt(f.document, binding: f.binding)
        XCTAssertEqual(saved.keyId, f.record.activeKeyId)
        XCTAssertEqual(try keys.decrypt(saved, binding: f.binding, as: JSONValue.self), f.document)
        let second = try keys.encrypt(f.document, binding: f.binding)
        XCTAssertNotEqual(saved.nonce, second.nonce)
    }
    @MainActor func testWrongRecoveryAndAccountAreRejected() throws {
        let f = try fixture()
        XCTAssertThrowsError(try HistoryKeys.unlock(f.record, recoveryCode: String(repeating: "A", count: 43), expectedAccountId: f.binding.accountId))
        XCTAssertThrowsError(try HistoryKeys.unlock(f.record, recoveryCode: f.recoveryCode, expectedAccountId: f.binding.appId))
        XCTAssertThrowsError(try HistoryKeys.unlock(f.record, recoveryCode: f.recoveryCode + "=", expectedAccountId: f.binding.accountId))
        let changed = HistoryKeyRecord(accountId: f.record.accountId, revision: f.record.revision + 1, activeKeyId: f.record.activeKeyId, keyIds: f.record.keyIds, envelope: f.record.envelope)
        XCTAssertThrowsError(try HistoryKeys.unlock(changed, recoveryCode: f.recoveryCode, expectedAccountId: f.binding.accountId))
    }
    @MainActor func testBindingTamperingAndLockFailClosed() throws {
        let f = try fixture()
        let keys = try HistoryKeys.unlock(f.record, recoveryCode: f.recoveryCode, expectedAccountId: f.binding.accountId)
        for b in [
            HistoryBinding(accountId: f.binding.appId, appId: f.binding.appId, conversationId: f.binding.conversationId, revision: 3),
            HistoryBinding(accountId: f.binding.accountId, appId: f.binding.accountId, conversationId: f.binding.conversationId, revision: 3),
            HistoryBinding(accountId: f.binding.accountId, appId: f.binding.appId, conversationId: f.binding.appId, revision: 3),
            HistoryBinding(accountId: f.binding.accountId, appId: f.binding.appId, conversationId: f.binding.conversationId, revision: 4)
        ] { XCTAssertThrowsError(try keys.decrypt(f.envelopes[0], binding: b, as: JSONValue.self)) }
        let old = f.envelopes[0]
        let changed = HistoryEnvelope(version: 1, algorithm: "A256GCM", nonce: old.nonce, ciphertext: old.ciphertext, keyId: f.record.activeKeyId)
        XCTAssertThrowsError(try keys.decrypt(changed, binding: f.binding, as: JSONValue.self))
        keys.lock()
        XCTAssertThrowsError(try keys.decrypt(old, binding: f.binding, as: JSONValue.self))
        XCTAssertThrowsError(try keys.encrypt(f.document, binding: f.binding))
    }
    @MainActor func testMalformedEnvelopeAndOversizedDocumentRejected() throws {
        let f = try fixture()
        let keys = try HistoryKeys.unlock(f.record, recoveryCode: f.recoveryCode, expectedAccountId: f.binding.accountId)
        let old = f.envelopes[0]
        for envelope in [
            HistoryEnvelope(version: 2, algorithm: "A256GCM", nonce: old.nonce, ciphertext: old.ciphertext, keyId: old.keyId),
            HistoryEnvelope(version: 1, algorithm: "AES", nonce: old.nonce, ciphertext: old.ciphertext, keyId: old.keyId),
            HistoryEnvelope(version: 1, algorithm: "A256GCM", nonce: old.nonce + "=", ciphertext: old.ciphertext, keyId: old.keyId),
            HistoryEnvelope(version: 1, algorithm: "A256GCM", nonce: old.nonce, ciphertext: "AA", keyId: old.keyId)
        ] { XCTAssertThrowsError(try keys.decrypt(envelope, binding: f.binding, as: JSONValue.self)) }
        XCTAssertThrowsError(try keys.encrypt(String(repeating: "x", count: 1_048_576), binding: f.binding))
    }
}
