// SPDX-License-Identifier: Apache-2.0
import CryptoKit
import Foundation
import XCTest
@testable import AppleVerifiedCore

final class EnvelopeTests: XCTestCase {
    func testRoundTripAndReplay() async throws {
        let host = Curve25519.KeyAgreement.PrivateKey()
        let client = Curve25519.KeyAgreement.PrivateKey()
        let digest = String(repeating: "a", count: 64)
        let session = try InferenceSession(privateKey: host, hostId: "host", sessionId: "session",
            model: "model", releaseDigest: digest, modelDigest: digest, expiresAt: 100_000)
        let nonce = AES.GCM.Nonce()
        let base = RequestEnvelope(requestId: UUID().uuidString.lowercased(), hostId: "host", sessionId: "session",
            model: "model", releaseDigest: digest, modelDigest: digest, expiresAt: 90_000,
            ephemeralPublicKey: Wire.base64(client.publicKey.rawRepresentation), nonce: Wire.base64(Data(nonce)), ciphertext: "", tag: "")
        let secret = try client.sharedSecretFromKeyAgreement(with: host.publicKey)
        let aad = try base.authenticatedData()
        let salt = Data(SHA256.hash(data: aad))
        let key = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt,
            sharedInfo: Data("multivibe/apple-host/request/v1".utf8), outputByteCount: 32)
        let sealed = try AES.GCM.seal(Data("private prompt".utf8), using: key, nonce: nonce, authenticating: aad)
        let request = RequestEnvelope(requestId: base.requestId, hostId: base.hostId, sessionId: base.sessionId,
            model: base.model, releaseDigest: digest, modelDigest: digest, expiresAt: base.expiresAt,
            ephemeralPublicKey: base.ephemeralPublicKey, nonce: base.nonce,
            ciphertext: Wire.base64(sealed.ciphertext), tag: Wire.base64(sealed.tag))
        let opened = try await session.open(RequestEnvelope.parse(Wire.encode(request)), now: 1)
        XCTAssertEqual(opened.plaintext, Data("private prompt".utf8))
        let response = try opened.seal(response: Data("private answer".utf8))
        let responseKey = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt,
            sharedInfo: Data("multivibe/apple-host/response/v1".utf8), outputByteCount: 32)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: Wire.bytes(response.nonce)),
            ciphertext: Wire.bytes(response.ciphertext), tag: Wire.bytes(response.tag))
        XCTAssertEqual(try AES.GCM.open(box, using: responseKey, authenticating: response.authenticatedData()), Data("private answer".utf8))
        XCTAssertThrowsError(try AES.GCM.open(box, using: key, authenticating: response.authenticatedData()))
        do { _ = try await session.open(request, now: 2); XCTFail("Replay accepted") }
        catch VerifiedHostError.replay {} catch { XCTFail("Wrong error: \(error)") }
        await session.close()
        do { _ = try await session.open(request, now: 2); XCTFail("Closed session accepted") }
        catch VerifiedHostError.unavailable {} catch { XCTFail("Wrong error: \(error)") }
    }

    func testStrictBase64AndUnknownFields() throws {
        XCTAssertThrowsError(try Wire.bytes("YQ=="))
        XCTAssertThrowsError(try Wire.bytes("YQ", count: 32))
        XCTAssertEqual(try Wire.bytes("YQ"), Data("a".utf8))
        XCTAssertThrowsError(try RequestEnvelope.parse(Data("{\"unexpected\":true}".utf8)))
    }
}
