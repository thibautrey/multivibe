import XCTest
import CryptoKit
import Security
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
    @MainActor func testClientConnectsReadsAppHistoryAndLocksOnRotation() async throws {
        let f = try fixture(), host = "sdk-test-" + UUID().uuidString.lowercased() + ".example"
        let service = "cloud.multivibe.sdk.\(host).\(f.binding.appId)"
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "application-history-p256"]
        var create = query; create[kSecValueData as String] = try f.key().rawRepresentation
        create[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        XCTAssertEqual(SecItemAdd(create as CFDictionary, nil), errSecSuccess)
        let storage = SDKKeychain(service: service)
        defer { storage.clear(); SecItemDelete(query as CFDictionary) }
        try storage.save(StoredSession(accessToken: "synthetic", refreshToken: "synthetic-refresh", expiresAt: Date().addingTimeInterval(3600)))
        let client = MultiVibeClient(configuration: .init(clientID: f.binding.appId, redirectURI: URL(string: "https://example.com/callback")!, baseURL: URL(string: "https://" + host)!))
        var paths: [String] = []
        client.dataTransportOverride = { request in
            let path = request.url!.path; paths.append(path)
            let value: [String: Any]
            switch path {
            case "/sdk/v2/session": value = ["accountId": f.binding.accountId, "appId": f.binding.appId]
            case "/sdk/v2/history-keys": value = ["grant": try JSONSerialization.jsonObject(with: JSONEncoder().encode(f.grant))]
            case "/sdk/v2/conversations": value = ["data": [["id": f.binding.conversationId, "appId": f.binding.appId, "revision": 1, "updatedAt": "2026-10-01T00:00:00Z"]], "nextCursor": NSNull()]
            case "/sdk/v2/conversations/" + f.binding.conversationId: value = ["id": f.binding.conversationId, "accountId": f.binding.accountId, "appId": f.binding.appId, "revision": 1, "updatedAt": "2026-10-01T00:00:00Z", "envelope": try JSONSerialization.jsonObject(with: JSONEncoder().encode(f.envelope))]
            case "/sdk/v2/models": value = ["data": [["id": "cloud/test"]]]
            default: throw MultiVibeError.invalidResponse
            }
            return (try JSONSerialization.data(withJSONObject: value), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        try await client.connect()
        XCTAssertTrue(client.isHistoryUnlocked); XCTAssertEqual(client.conversations.first?.title, "Private app history")
        XCTAssertFalse(paths.contains(where: { $0.contains("/v1/") }))
        let response = HTTPURLResponse(url: URL(string: "https://" + host)!, statusCode: 409, httpVersion: nil, headerFields: nil)!
        XCTAssertThrowsError(try client.validate(response, data: Data("{\"error\":\"history_keys_changed\"}".utf8)))
        XCTAssertTrue(client.historyAuthorizationRequired); XCTAssertFalse(client.isHistoryUnlocked); XCTAssertTrue(client.conversations.isEmpty)
        let authorization = try client.beginAuthorization()
        let params = URLComponents(url: authorization.url(broker: false), resolvingAgainstBaseURL: false)!.queryItems!
        let encoded = params.first(where: { $0.name == "history_key" })!.value!
        let publicKey = try JSONDecoder().decode(ApplicationHistoryPublicKey.self, from: HistoryWire.decode(encoded, min: 1, max: 1024))
        XCTAssertEqual(publicKey, f.grant.recipient)
        XCTAssertFalse(authorization.url(broker: false).absoluteString.contains(f.recoveryCode))
    }

}
