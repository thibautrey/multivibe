// SPDX-License-Identifier: Apache-2.0
import CryptoKit
import Foundation
import Security

public struct AppleHostBinding: Codable, Sendable {
    public let hostId: String
    public let sessionId: String
    public let processPublicKey: String
    public let secureEnclavePublicKey: String
    public let releaseDigest: String
    public let modelDigest: String

    public func transcript() throws -> Data {
        try Wire.encode([AppleChallenge.protocolName, hostId, sessionId, processPublicKey,
                         secureEnclavePublicKey, releaseDigest, modelDigest])
    }
    public func digest() throws -> Data { Data(SHA256.hash(data: try transcript())) }
}

public struct AppleChallenge: Codable {
    public static let protocolName = "multivibe-apple-host-verification-v1"
    public let `protocol`: String
    public let challengeId: String
    public let ephemeralPublicKey: String
    public let iv: String
    public let ciphertext: String
    public let tag: String
    public let bindingDigest: String
    public let expiresAt: Int64
}

public struct ChallengeResponse: Codable, Sendable {
    public let hostId: String
    public let sessionId: String
    public let challengeId: String
    public let signature: String
    /// SHA256 of the signed transcript, supplied to an independently trusted MDA adapter.
    public let challengeDigest: String
}

/// This object lives in the SAME process as inference; never export the agreement key.
/// APNs proves possession of the process key and app token, not a hardware TEE.
public actor AppleProcessIdentity {
    private var processKey: Curve25519.KeyAgreement.PrivateKey?
    private let signingKey: SecureEnclave.P256.Signing.PrivateKey
    public let binding: AppleHostBinding
    private var usedChallenges = Set<String>()

    public init(hostId: String, sessionId: String, releaseDigest: String, modelDigest: String,
                signingKey: SecureEnclave.P256.Signing.PrivateKey) throws {
        guard [hostId, sessionId].allSatisfy(Wire.validIdentifier),
              Wire.validDigest(releaseDigest), Wire.validDigest(modelDigest)
        else { throw VerifiedHostError.bindingMismatch }
        let key = Curve25519.KeyAgreement.PrivateKey()
        self.processKey = key; self.signingKey = signingKey
        self.binding = AppleHostBinding(hostId: hostId, sessionId: sessionId,
            processPublicKey: (Self.x25519Prefix + key.publicKey.rawRepresentation).base64EncodedString(),
            secureEnclavePublicKey: signingKey.publicKey.derRepresentation.base64EncodedString(),
            releaseDigest: releaseDigest, modelDigest: modelDigest)
    }

    private static let x25519Prefix = Data([0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x6e,0x03,0x21,0x00])

    public func close() { processKey = nil; usedChallenges.removeAll() }

    public func respond(to challenge: AppleChallenge, now: Int64) throws -> ChallengeResponse {
        guard let processKey else { throw VerifiedHostError.unavailable }
        guard challenge.protocol == AppleChallenge.protocolName, challenge.expiresAt > now,
              challenge.expiresAt - now <= 60_000, !usedChallenges.contains(challenge.challengeId),
              usedChallenges.count < 32
        else { throw VerifiedHostError.invalidChallenge }
        let digest = try binding.digest()
        guard challenge.bindingDigest == digest.hex else { throw VerifiedHostError.bindingMismatch }
        func bytes(_ value: String, count: Int? = nil) throws -> Data {
            guard value.count <= 4096, let data = Data(base64Encoded: value),
                  data.base64EncodedString() == value, count == nil || data.count == count
            else { throw VerifiedHostError.invalidChallenge }
            return data
        }
        let spki = try bytes(challenge.ephemeralPublicKey, count: 44)
        guard spki.prefix(12) == Self.x25519Prefix else { throw VerifiedHostError.invalidChallenge }
        let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: spki.dropFirst(12))
        let secret = try processKey.sharedSecretFromKeyAgreement(with: peer)
        let key = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: digest,
            sharedInfo: Data(AppleChallenge.protocolName.utf8), outputByteCount: 32)
        let sealed = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: bytes(challenge.iv, count: 12)),
            ciphertext: bytes(challenge.ciphertext), tag: bytes(challenge.tag, count: 16))
        let transcript = try AES.GCM.open(sealed, using: key, authenticating: digest)
        guard let values = try JSONSerialization.jsonObject(with: transcript) as? [Any], values.count == 5,
              values[0] as? String == AppleChallenge.protocolName,
              values[1] as? String == challenge.challengeId,
              values[2] as? String == challenge.bindingDigest,
              let nonce = values[3] as? String,
              let expiry = values[4] as? NSNumber, expiry.int64Value == challenge.expiresAt
        else { throw VerifiedHostError.invalidChallenge }
        _ = try bytes(nonce, count: 32)
        // Sign only canonical, fully checked transcripts; never become an arbitrary signing oracle.
        let canonical = try JSONSerialization.data(withJSONObject: values, options: [.fragmentsAllowed, .withoutEscapingSlashes])
        guard canonical == transcript else { throw VerifiedHostError.invalidChallenge }
        usedChallenges.insert(challenge.challengeId)
        let signature = try signingKey.signature(for: transcript)
        return ChallengeResponse(hostId: binding.hostId, sessionId: binding.sessionId,
            challengeId: challenge.challengeId, signature: signature.derRepresentation.base64EncodedString(),
            challengeDigest: Data(SHA256.hash(data: transcript)).hex)
    }

    /// Only call after a matching lease arrives over the original authenticated connection.
    public func admit(model: String, lease: AppleVerificationLease, now: Int64) throws -> InferenceSession {
        guard let processKey, lease.tier == "apple_host_verified", lease.binding == binding,
              lease.verifiedAt <= now, lease.expiresAt > now, lease.expiresAt - now <= 300_000
        else { throw VerifiedHostError.runtimeNotQualified }
        return try InferenceSession(privateKey: processKey, hostId: binding.hostId,
            sessionId: binding.sessionId, model: model, releaseDigest: binding.releaseDigest,
            modelDigest: binding.modelDigest, expiresAt: lease.expiresAt)
    }
}

extension AppleHostBinding: Equatable {}
public struct AppleVerificationLease: Codable, Sendable {
    public let tier: String
    public let binding: AppleHostBinding
    public let deviceId: String
    public let verifiedAt: Int64
    public let expiresAt: Int64
}

extension Data {
    public var hex: String { map { String(format: "%02x", $0) }.joined() }
}

/// The persistent blob is encrypted by the Secure Enclave and stored in the login Keychain.
/// Enrollment must independently bind this exact public key through MDA; key creation alone is not proof.
public enum EnclaveKeyStore {
    public static func loadOrCreate(account: String) throws -> SecureEnclave.P256.Signing.PrivateKey {
        guard SecureEnclave.isAvailable, Wire.validIdentifier(account) else { throw VerifiedHostError.unavailable }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.multivibe.apple-verified.enclave-key", kSecAttrAccount as String: account]
        var item: CFTypeRef?
        var read = query; read[kSecReturnData as String] = true
        let status = SecItemCopyMatching(read as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data {
            return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data)
        }
        guard status == errSecItemNotFound else { throw VerifiedHostError.unavailable }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage], &error) else { throw VerifiedHostError.unavailable }
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        var add = query
        add[kSecValueData as String] = key.dataRepresentation
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw VerifiedHostError.unavailable }
        return key
    }
}
