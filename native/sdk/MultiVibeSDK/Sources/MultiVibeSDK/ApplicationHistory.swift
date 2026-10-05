import Foundation
import CryptoKit
import Security

struct ApplicationHistoryPublicKey: Codable, Sendable, Equatable {
    let version: Int
    let algorithm: String
    let x: String
    let y: String
    init(_ key: P256.KeyAgreement.PublicKey) {
        let raw = key.x963Representation
        version = 1; algorithm = "P-256"
        x = HistoryWire.encode(raw.subdata(in: 1..<33)); y = HistoryWire.encode(raw.subdata(in: 33..<65))
    }
    func cryptoKey() throws -> P256.KeyAgreement.PublicKey {
        guard version == 1, algorithm == "P-256" else { throw HistoryCryptoError.invalidFormat }
        return try P256.KeyAgreement.PublicKey(x963Representation: Data([4]) + HistoryWire.decode(x, min: 32, max: 32) + HistoryWire.decode(y, min: 32, max: 32))
    }
}
struct ApplicationHistoryGrant: Codable, Sendable {
    let version: Int
    let algorithm: String
    let accountId: String
    let appId: String
    let keyringRevision: Int
    let activeKeyId: String
    let keyIds: [String]
    let recipient: ApplicationHistoryPublicKey
    let ephemeral: ApplicationHistoryPublicKey
    let nonce: String
    let ciphertext: String

    @MainActor func unwrap(privateKey: P256.KeyAgreement.PrivateKey, account: String, application: String) throws -> HistoryKeys {
        guard version == 1, algorithm == "P256-HKDF-SHA256-A256GCM", accountId == account, appId == application,
              [accountId, appId, activeKeyId].allSatisfy(HistoryWire.uuid), HistoryWire.revision(keyringRevision),
              (1...64).contains(keyIds.count), keyIds.allSatisfy(HistoryWire.uuid), Set(keyIds).count == keyIds.count,
              keyIds.contains(activeKeyId), recipient == ApplicationHistoryPublicKey(privateKey.publicKey) else { throw HistoryCryptoError.invalidFormat }
        _ = try recipient.cryptoKey()
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: ephemeral.cryptoKey())
        let aad = try HistoryWire.json(["multivibe.history-delegation", 1, accountId, appId, keyringRevision, activeKeyId, keyIds.sorted(), recipient.x, recipient.y, ephemeral.x, ephemeral.y])
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data("multivibe.history-delegation.v1".utf8), sharedInfo: aad, outputByteCount: 32)
        let envelope = HistoryEnvelope(version: 1, algorithm: "A256GCM", nonce: nonce, ciphertext: ciphertext, keyId: nil)
        var plaintext = try HistoryWire.open(envelope, key: key, aad: aad, limit: 8176)
        defer { plaintext.resetBytes(in: 0..<plaintext.count) }
        struct Contents: Decodable {
            struct Entry: Decodable { let id: String; let secret: String }
            let version: Int; let keys: [Entry]
        }
        let contents = try JSONDecoder().decode(Contents.self, from: plaintext)
        guard contents.version == 1, contents.keys.count == keyIds.count else { throw HistoryCryptoError.invalidFormat }
        var roots: [String: SymmetricKey] = [:]
        for entry in contents.keys {
            guard keyIds.contains(entry.id), roots[entry.id] == nil else { throw HistoryCryptoError.invalidFormat }
            var bytes = try HistoryWire.decode(entry.secret, min: 32, max: 32)
            defer { bytes.resetBytes(in: 0..<bytes.count) }
            roots[entry.id] = SymmetricKey(data: bytes)
        }
        return HistoryKeys(record: HistoryKeyRecord(accountId: accountId, revision: keyringRevision, activeKeyId: activeKeyId, keyIds: keyIds, envelope: envelope), roots: roots, applicationId: appId)
    }
}

/// Independent from session storage so reconnecting can read an unresolved
/// encrypted write. No global key or recovery code is ever stored here.
struct ApplicationHistoryKeychain {
    let service: String
    func loadOrCreate() throws -> P256.KeyAgreement.PrivateKey {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "application-history-p256"]
        var read = query; read[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data { return try P256.KeyAgreement.PrivateKey(rawRepresentation: data) }
        guard status == errSecItemNotFound else { throw MultiVibeError.authenticationRequired }
        let key = P256.KeyAgreement.PrivateKey()
        var create = query; create[kSecValueData as String] = key.rawRepresentation
        create[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let added = SecItemAdd(create as CFDictionary, nil)
        if added == errSecDuplicateItem { return try loadOrCreate() }
        guard added == errSecSuccess else { throw MultiVibeError.authenticationRequired }
        return key
    }
}
