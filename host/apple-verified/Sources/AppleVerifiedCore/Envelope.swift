// SPDX-License-Identifier: Apache-2.0
import CryptoKit
import Foundation

public enum VerifiedHostError: Error {
    case invalidEnvelope, expired, bindingMismatch, replay, unavailable, invalidChallenge
    case runtimeNotQualified, unsafeModel, unsafeProcess
}

public enum Wire {
    public static let version = "mvah-inference-v1"
    public static let maxEnvelopeBytes = 2 * 1024 * 1024

    public static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }

    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        guard data.count <= maxEnvelopeBytes else { throw VerifiedHostError.invalidEnvelope }
        return try JSONDecoder().decode(type, from: data)
    }

    public static func base64(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    public static func bytes(_ value: String, count: Int? = nil) throws -> Data {
        guard value.utf8.count <= maxEnvelopeBytes * 2,
              value.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 })
        else { throw VerifiedHostError.invalidEnvelope }
        let standard = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard let data = Data(base64Encoded: standard + String(repeating: "=", count: (4 - standard.count % 4) % 4)),
              base64(data) == value, count == nil || data.count == count
        else { throw VerifiedHostError.invalidEnvelope }
        return data
    }

    public static func validIdentifier(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 256 && value.utf8.allSatisfy { (33...126).contains($0) }
    }

    public static func validDigest(_ value: String) -> Bool {
        value.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}

public struct RequestEnvelope: Codable, Sendable {
    public let version: String
    public let requestId: String
    public let hostId: String
    public let sessionId: String
    public let model: String
    public let releaseDigest: String
    public let modelDigest: String
    public let expiresAt: Int64
    public let ephemeralPublicKey: String
    public let nonce: String
    public let ciphertext: String
    public let tag: String

    public init(version: String = Wire.version, requestId: String, hostId: String, sessionId: String,
                model: String, releaseDigest: String, modelDigest: String, expiresAt: Int64, ephemeralPublicKey: String,
                nonce: String, ciphertext: String, tag: String) {
        self.version = version; self.requestId = requestId; self.hostId = hostId; self.sessionId = sessionId
        self.model = model; self.releaseDigest = releaseDigest; self.modelDigest = modelDigest; self.expiresAt = expiresAt
        self.ephemeralPublicKey = ephemeralPublicKey; self.nonce = nonce; self.ciphertext = ciphertext; self.tag = tag
    }

    public static func parse(_ data: Data) throws -> RequestEnvelope {
        guard data.count <= Wire.maxEnvelopeBytes,
              let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(root.keys) == ["version", "requestId", "hostId", "sessionId", "model", "modelDigest", "releaseDigest", "expiresAt", "ephemeralPublicKey", "nonce", "ciphertext", "tag"]
        else { throw VerifiedHostError.invalidEnvelope }
        return try Wire.decode(RequestEnvelope.self, from: data)
    }

    public func authenticatedData() throws -> Data {
        struct AAD: Encodable {
            let version: String; let requestId: String; let hostId: String; let sessionId: String
            let model: String; let releaseDigest: String; let modelDigest: String; let expiresAt: Int64
            let ephemeralPublicKey: String; let nonce: String
        }
        return try Wire.encode(AAD(version: version, requestId: requestId, hostId: hostId,
            sessionId: sessionId, model: model, releaseDigest: releaseDigest, modelDigest: modelDigest, expiresAt: expiresAt,
            ephemeralPublicKey: ephemeralPublicKey, nonce: nonce))
    }
}

public struct ResponseEnvelope: Codable, Sendable {
    public let version: String
    public let responseTo: String
    public let hostId: String
    public let sessionId: String
    public let nonce: String
    public let ciphertext: String
    public let tag: String

    public func authenticatedData() throws -> Data {
        struct AAD: Encodable {
            let version: String; let responseTo: String; let hostId: String; let sessionId: String; let nonce: String
        }
        return try Wire.encode(AAD(version: version, responseTo: responseTo, hostId: hostId, sessionId: sessionId, nonce: nonce))
    }
}

/// Per-request response key. Never serialize or persist this value.
public struct OpenedRequest {
    public let plaintext: Data
    fileprivate let envelope: RequestEnvelope
    fileprivate let responseKey: SymmetricKey

    public func seal(response: Data) throws -> ResponseEnvelope {
        guard response.count <= Wire.maxEnvelopeBytes else { throw VerifiedHostError.invalidEnvelope }
        let nonce = AES.GCM.Nonce()
        let base = ResponseEnvelope(version: Wire.version, responseTo: envelope.requestId,
            hostId: envelope.hostId, sessionId: envelope.sessionId,
            nonce: Wire.base64(Data(nonce)), ciphertext: "", tag: "")
        let sealed = try AES.GCM.seal(response, using: responseKey, nonce: nonce,
            authenticating: base.authenticatedData())
        return ResponseEnvelope(version: base.version, responseTo: base.responseTo, hostId: base.hostId,
            sessionId: base.sessionId, nonce: base.nonce, ciphertext: Wire.base64(sealed.ciphertext), tag: Wire.base64(sealed.tag))
    }
}

/// Bound to one live, independently admitted connection. Closing it destroys its process key.
/// The initializer belongs to the native admission path, never to request-controlled input.
public actor InferenceSession {
    private var privateKey: Curve25519.KeyAgreement.PrivateKey?
    private let hostId: String
    private let sessionId: String
    private let model: String
    private let releaseDigest: String
    private let modelDigest: String
    private let expiresAt: Int64
    private var seen = Set<String>()

    public init(privateKey: Curve25519.KeyAgreement.PrivateKey, hostId: String, sessionId: String,
                model: String, releaseDigest: String, modelDigest: String, expiresAt: Int64) throws {
        guard [hostId, sessionId, model].allSatisfy(Wire.validIdentifier), Wire.validDigest(releaseDigest), Wire.validDigest(modelDigest)
        else { throw VerifiedHostError.bindingMismatch }
        self.privateKey = privateKey; self.hostId = hostId; self.sessionId = sessionId
        self.model = model; self.releaseDigest = releaseDigest; self.modelDigest = modelDigest; self.expiresAt = expiresAt
    }

    public func close() { privateKey = nil; seen.removeAll() }

    public func open(_ envelope: RequestEnvelope, now: Int64) throws -> OpenedRequest {
        guard let privateKey else { throw VerifiedHostError.unavailable }
        guard now < expiresAt, envelope.expiresAt > now,
              envelope.expiresAt <= expiresAt, envelope.expiresAt - now <= 60_000
        else { throw VerifiedHostError.expired }
        guard envelope.version == Wire.version, UUID(uuidString: envelope.requestId) != nil,
              envelope.hostId == hostId, envelope.sessionId == sessionId,
              envelope.model == model, envelope.releaseDigest == releaseDigest, envelope.modelDigest == modelDigest
        else { throw VerifiedHostError.bindingMismatch }
        // Bound replay memory; require a fresh admitted session after 4096 requests.
        guard !seen.contains(envelope.requestId) else { throw VerifiedHostError.replay }
        guard seen.count < 4096 else { throw VerifiedHostError.unavailable }
        let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: Wire.bytes(envelope.ephemeralPublicKey, count: 32))
        let secret = try privateKey.sharedSecretFromKeyAgreement(with: peer)
        let aad = try envelope.authenticatedData()
        let salt = Data(SHA256.hash(data: aad))
        let requestKey = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt,
            sharedInfo: Data("multivibe/apple-host/request/v1".utf8), outputByteCount: 32)
        let responseKey = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt,
            sharedInfo: Data("multivibe/apple-host/response/v1".utf8), outputByteCount: 32)
        let ciphertext = try Wire.bytes(envelope.ciphertext)
        guard ciphertext.count <= Wire.maxEnvelopeBytes else { throw VerifiedHostError.invalidEnvelope }
        let sealed = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: Wire.bytes(envelope.nonce, count: 12)),
            ciphertext: ciphertext, tag: Wire.bytes(envelope.tag, count: 16))
        let plaintext = try AES.GCM.open(sealed, using: requestKey, authenticating: aad)
        // Consume before execution: execution failures cannot cause a duplicate inference.
        seen.insert(envelope.requestId)
        return OpenedRequest(plaintext: plaintext, envelope: envelope, responseKey: responseKey)
    }
}
