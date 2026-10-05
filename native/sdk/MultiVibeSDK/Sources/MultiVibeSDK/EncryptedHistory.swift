import Foundation
import CryptoKit

// Account roots remain in the official client. Applications receive only scoped
// derived roots through ApplicationHistoryGrant; they cannot use v1 envelopes.
enum HistoryCryptoError: Error { case invalidFormat, authenticationFailed, locked, missingKey }

struct HistoryEnvelope: Codable, Sendable {
    let version: Int
    let algorithm: String
    let nonce: String
    let ciphertext: String
    let keyId: String?
}
struct HistoryKeyRecord: Codable, Sendable {
    let accountId: String
    let revision: Int
    let activeKeyId: String
    let keyIds: [String]
    let envelope: HistoryEnvelope
}
struct HistoryBinding: Codable, Sendable {
    let accountId: String
    let appId: String
    let conversationId: String
    let revision: Int
}

enum HistoryWire {
    static let documentLimit = 1_048_576
    static func uuid(_ value: String) -> Bool {
        value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil
    }
    static func revision(_ value: Int) -> Bool { value > 0 && value <= 9_007_199_254_740_991 }
    static func json(_ value: [Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes])
    }
    static func encode(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func decode(_ value: String, min: Int, max: Int) throws -> Data {
        guard value.utf8.count <= (max * 4 + 2) / 3,
              value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw HistoryCryptoError.invalidFormat }
        let base = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard let bytes = Data(base64Encoded: base + String(repeating: "=", count: (4 - base.count % 4) % 4)),
              (min...max).contains(bytes.count), encode(bytes) == value else { throw HistoryCryptoError.invalidFormat }
        return bytes
    }
    static func open(_ envelope: HistoryEnvelope, key: SymmetricKey, aad: Data, limit: Int) throws -> Data {
        guard [1, 2].contains(envelope.version), envelope.algorithm == "A256GCM" else { throw HistoryCryptoError.invalidFormat }
        let nonce = try decode(envelope.nonce, min: 12, max: 12)
        let bytes = try decode(envelope.ciphertext, min: 17, max: limit + 16)
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: bytes.dropLast(16), tag: bytes.suffix(16))
            return try AES.GCM.open(box, using: key, authenticating: aad)
        } catch { throw HistoryCryptoError.authenticationFailed }
    }
}

/// Contains multiple account key generations in memory only. No Keychain write,
/// automatic key creation, network operation or recovery-code persistence.
@MainActor final class HistoryKeys {
    let record: HistoryKeyRecord
    private var roots: [String: SymmetricKey]?
    let applicationId: String?
    init(record: HistoryKeyRecord, roots: [String: SymmetricKey], applicationId: String? = nil) {
        self.applicationId = applicationId
        self.record = record
        self.roots = roots
    }
    static func unlock(_ record: HistoryKeyRecord, recoveryCode: String, expectedAccountId: String) throws -> HistoryKeys {
        guard record.accountId == expectedAccountId, HistoryWire.uuid(record.accountId), HistoryWire.revision(record.revision),
              HistoryWire.uuid(record.activeKeyId), (1...64).contains(record.keyIds.count),
              record.keyIds.allSatisfy(HistoryWire.uuid), Set(record.keyIds).count == record.keyIds.count,
              record.keyIds.contains(record.activeKeyId), record.envelope.version == 1, record.envelope.keyId == nil else { throw HistoryCryptoError.invalidFormat }
        var code = try HistoryWire.decode(recoveryCode.trimmingCharacters(in: .whitespacesAndNewlines), min: 32, max: 32)
        defer { code.resetBytes(in: 0..<code.count) }
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: code), salt: Data("multivibe.history-recovery.v1".utf8), info: Data(record.accountId.utf8), outputByteCount: 32)
        let aad = try HistoryWire.json(["multivibe.history-keyring", 1, record.accountId, record.revision, record.activeKeyId, record.keyIds.sorted()])
        var plaintext = try HistoryWire.open(record.envelope, key: key, aad: aad, limit: 16368)
        defer { plaintext.resetBytes(in: 0..<plaintext.count) }
        struct Contents: Decodable {
            struct Entry: Decodable { let id: String; let secret: String }
            let version: Int
            let keys: [Entry]
        }
        let contents = try JSONDecoder().decode(Contents.self, from: plaintext)
        guard contents.version == 1, contents.keys.count == record.keyIds.count else { throw HistoryCryptoError.invalidFormat }
        var roots: [String: SymmetricKey] = [:]
        for entry in contents.keys {
            guard record.keyIds.contains(entry.id), roots[entry.id] == nil else { throw HistoryCryptoError.invalidFormat }
            var bytes = try HistoryWire.decode(entry.secret, min: 32, max: 32)
            defer { bytes.resetBytes(in: 0..<bytes.count) }
            roots[entry.id] = SymmetricKey(data: bytes)
        }
        return HistoryKeys(record: record, roots: roots)
    }
    func lock() { roots = nil }
    private func derivedKey(_ binding: HistoryBinding, keyId: String, version: Int) throws -> SymmetricKey {
        guard let roots else { throw HistoryCryptoError.locked }
        guard binding.accountId == record.accountId,
              [binding.accountId, binding.appId, binding.conversationId, keyId].allSatisfy(HistoryWire.uuid),
              HistoryWire.revision(binding.revision) else { throw HistoryCryptoError.invalidFormat }
        guard [1, 2].contains(version), applicationId == nil || (version == 2 && applicationId == binding.appId) else { throw HistoryCryptoError.invalidFormat }
        guard var root = roots[keyId] else { throw HistoryCryptoError.missingKey }
        if version == 2, applicationId == nil {
            root = HKDF<SHA256>.deriveKey(inputKeyMaterial: root, salt: Data("multivibe.history-application.v2".utf8), info: try HistoryWire.json([binding.accountId, binding.appId, keyId]), outputByteCount: 32)
        }
        return HKDF<SHA256>.deriveKey(inputKeyMaterial: root, salt: Data("multivibe.history.v\(version)".utf8),
            info: try HistoryWire.json(version == 1 ? [binding.accountId, binding.appId, binding.conversationId, keyId] : [binding.conversationId, keyId]), outputByteCount: 32)
    }
    private func aad(_ binding: HistoryBinding, keyId: String, version: Int) throws -> Data {
        try HistoryWire.json(["multivibe.history", version, "A256GCM", keyId, binding.accountId, binding.appId, binding.conversationId, binding.revision])
    }
    func encrypt<T: Encodable>(_ document: T, binding: HistoryBinding) throws -> HistoryEnvelope {
        let keyId = record.activeKeyId
        let key = try derivedKey(binding, keyId: keyId, version: 2)
        var plaintext = try JSONEncoder().encode(document)
        defer { plaintext.resetBytes(in: 0..<plaintext.count) }
        guard !plaintext.isEmpty, plaintext.count <= HistoryWire.documentLimit else { throw HistoryCryptoError.invalidFormat }
        let sealed = try AES.GCM.seal(plaintext, using: key, authenticating: aad(binding, keyId: keyId, version: 2))
        return HistoryEnvelope(version: 2, algorithm: "A256GCM", nonce: HistoryWire.encode(Data(sealed.nonce)),
            ciphertext: HistoryWire.encode(sealed.ciphertext + sealed.tag), keyId: keyId)
    }
    func decrypt<T: Decodable>(_ envelope: HistoryEnvelope, binding: HistoryBinding, as type: T.Type) throws -> T {
        guard let keyId = envelope.keyId else { throw HistoryCryptoError.invalidFormat }
        let key = try derivedKey(binding, keyId: keyId, version: envelope.version)
        var plaintext = try HistoryWire.open(envelope, key: key, aad: aad(binding, keyId: keyId, version: envelope.version), limit: HistoryWire.documentLimit)
        defer { plaintext.resetBytes(in: 0..<plaintext.count) }
        return try JSONDecoder().decode(type, from: plaintext)
    }
}
