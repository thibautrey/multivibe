import XCTest
@testable import MultiVibeChat

final class HermesLegacyEnvelopeTests: XCTestCase {
    private let fixture = #"{"schemaVersion":1,"type":"hermes-legacy-preservation","source":"nativeMemory","originalID":"original","revision":"v1","container":"native-memory","provenance":{"guestOrigin":null,"sourcePath":"$.memory[0]","rawRange":[5,52],"archiveSHA256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"deleted":false,"payloadBase64":"IHsibiI6OTAwNzE5OTI1NDc0MDk5MzEyMzQ1Njc4OSwiZnV0dXJlIjp0cnVlfQo=","payloadSHA256":"4739ab52ac7150ea8a1c895cfdb5c521e0d39a8779c773332bdfca068048ddf6"}"#
    private func record(_ payload: Data, deleted: Bool = false, guest: String? = nil) -> HermesLegacyRecord {
        .init(kind: .memory, id: "original", revision: "v1", container: "native-memory", payload: payload,
              deleted: deleted, inferenceUsable: false,
              provenance: .init(source: "nativeMemory", guestOrigin: guest, sourcePath: "$.memory[0]",
                                rawRange: 5..<(5 + payload.count), archiveDigest: String(repeating: "a", count: 64)))
    }
    func testCloudLiteralFixturePreservesExactNumberAndUnknownBytes() throws {
        let decoded = try HermesLegacyEnvelopeCodec.decode(Data(fixture.utf8))
        let original = Data(" {\"n\":9007199254740993123456789,\"future\":true}\n".utf8)
        XCTAssertEqual(decoded.payload, original)
        XCTAssertEqual(decoded.envelope.provenance.rawRange, [5, 52])
        XCTAssertNil(decoded.envelope.provenance.guestOrigin)
        let encoded = try HermesLegacyEnvelopeCodec.encode(record(original))
        let expected = try JSONSerialization.jsonObject(with: Data(fixture.utf8)) as? NSDictionary
        let actual = try JSONSerialization.jsonObject(with: encoded) as? NSDictionary
        XCTAssertEqual(expected, actual)
    }
    func testTombstoneGuestAndDetachedBytesGrantNoEligibility() throws {
        let payload = Data(#"{"state":"deleted","scope":"","future":{"unknown":true}}"#.utf8)
        let encoded = try HermesLegacyEnvelopeCodec.encode(record(payload, deleted: true, guest: "guest-original"))
        let decoded = try HermesLegacyEnvelopeCodec.decode(encoded)
        XCTAssertTrue(decoded.envelope.deleted); XCTAssertEqual(decoded.envelope.provenance.guestOrigin, "guest-original")
        XCTAssertEqual(decoded.payload, payload)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertNil(object["inferenceUsable"]); XCTAssertNil(object["exportConsent"])
        var copy = decoded.payload; copy.append(0)
        XCTAssertEqual(decoded.payload, payload)
    }
    func testRejectsUnknownFieldsBase64DigestRangeAndUnsupportedClaims() throws {
        let base = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(fixture.utf8)) as? [String: Any])
        var candidates: [[String: Any]] = []
        for (key, value) in [("future", true as Any), ("schemaVersion", 2), ("source", "invented"),
                             ("payloadBase64", "e30"), ("payloadSHA256", String(repeating: "0", count: 64)), ("originalID", "")] {
            var object = base; object[key] = value; candidates.append(object)
        }
        for (key, value) in [("future", true as Any), ("rawRange", [5, 99]), ("rawRange", [-1, 46]),
                             ("rawRange", [5, 52, 0]), ("archiveSHA256", "invalid")] {
            var object = base
            var provenance = try XCTUnwrap(base["provenance"] as? [String: Any]); provenance[key] = value
            object["provenance"] = provenance; candidates.append(object)
        }
        for object in candidates { XCTAssertThrowsError(try HermesLegacyEnvelopeCodec.decode(JSONSerialization.data(withJSONObject: object))) }
        let duplicate = fixture.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":1,\"schemaVersion\":1")
        XCTAssertThrowsError(try HermesLegacyEnvelopeCodec.decode(Data(duplicate.utf8)))
    }
    func testPayloadAndEnvelopeByteBoundsAndMissingProvenance() throws {
        var payload = Data([34]); payload.append(Data(repeating: 65, count: HermesLegacyEnvelopeCodec.maximumPayloadBytes - 2)); payload.append(34)
        XCTAssertEqual(try HermesLegacyEnvelopeCodec.decode(HermesLegacyEnvelopeCodec.encode(record(payload))).payload, payload)
        payload.append(32)
        XCTAssertThrowsError(try HermesLegacyEnvelopeCodec.encode(record(payload)))
        XCTAssertThrowsError(try HermesLegacyEnvelopeCodec.decode(Data(repeating: 32, count: HermesLegacyEnvelopeCodec.maximumEnvelopeBytes + 1)))
        var noProvenance = record(Data("{}".utf8)); noProvenance.provenance = nil
        XCTAssertThrowsError(try HermesLegacyEnvelopeCodec.encode(noProvenance))
        let oversized = HermesLegacyRecord(kind: .memory, id: String(repeating: "é", count: 70_000), revision: "v", container: "native-memory",
            payload: Data("{}".utf8), deleted: false, inferenceUsable: false, provenance: record(Data("{}".utf8)).provenance)
        XCTAssertThrowsError(try HermesLegacyEnvelopeCodec.encode(oversized))
    }
    func testIdentityAndArchiveClaimsAreNotAuthenticatedBySyntaxValidation() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(fixture.utf8)) as? [String: Any])
        object["originalID"] = "different-unverified-claim"
        var provenance = try XCTUnwrap(object["provenance"] as? [String: Any])
        provenance["archiveSHA256"] = String(repeating: "b", count: 64); object["provenance"] = provenance
        let decoded = try HermesLegacyEnvelopeCodec.decode(JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(decoded.envelope.originalID, "different-unverified-claim")
        XCTAssertEqual(decoded.envelope.provenance.archiveSHA256, String(repeating: "b", count: 64))
        XCTAssertEqual(decoded.payload, Data(" {\"n\":9007199254740993123456789,\"future\":true}\n".utf8))
    }
    func testEncodeRejectsOversizedUnsupportedSourceAndArchiveBeforeSerialization() throws {
        let original = record(Data("{}".utf8))
        let provenance = try XCTUnwrap(original.provenance)
        for (source, archive) in [(String(repeating: "a", count: HermesLegacyEnvelopeCodec.maximumEnvelopeBytes + 1), provenance.archiveDigest),
                                  ("unknown-source", provenance.archiveDigest),
                                  (provenance.source, String(repeating: "a", count: HermesLegacyEnvelopeCodec.maximumEnvelopeBytes + 1))] {
            var candidate = original
            candidate.provenance = .init(source: source, guestOrigin: provenance.guestOrigin, sourcePath: provenance.sourcePath,
                                         rawRange: provenance.rawRange, archiveDigest: archive)
            XCTAssertThrowsError(try HermesLegacyEnvelopeCodec.encode(candidate))
        }
    }

}
