import CryptoKit
import Foundation

/// Versioned preservation capsule only. `deleted` describes the source record, not an outer
/// journal tombstone (which carries no value and erases ciphertext). No eligibility or consent implied.
struct HermesLegacyEnvelope: Encodable, Sendable {
    struct Provenance: Encodable, Sendable {
        let guestOrigin: String?
        let sourcePath: String
        let rawRange: [Int]
        let archiveSHA256: String
        private enum CodingKeys: String, CodingKey { case guestOrigin, sourcePath, rawRange, archiveSHA256 }
        func encode(to encoder: Encoder) throws {
            var value = encoder.container(keyedBy: CodingKeys.self)
            if let guestOrigin { try value.encode(guestOrigin, forKey: .guestOrigin) }
            else { try value.encodeNil(forKey: .guestOrigin) }
            try value.encode(sourcePath, forKey: .sourcePath)
            try value.encode(rawRange, forKey: .rawRange)
            try value.encode(archiveSHA256, forKey: .archiveSHA256)
        }
    }
    let schemaVersion: Int
    let type: String
    let source: String
    let originalID: String
    let revision: String
    let container: String
    let provenance: Provenance
    let deleted: Bool
    let payloadBase64: String
    let payloadSHA256: String
}

enum HermesLegacyEnvelopeCodec {
    enum Failure: Error { case invalid, tooLarge }
    struct Decoded: Sendable { let envelope: HermesLegacyEnvelope; let payload: Data }
    static let maximumPayloadBytes = 64 * 1024
    static let maximumEnvelopeBytes = 128 * 1024
    private static let sources = Set(["nativeConversation", "nativeMessage", "nativeMemory", "cloudConversation", "cloudRepositoryNode"])
    private static func digest(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    private static func validDigest(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    private static func bounded(_ value: String) throws {
        guard value.utf8.count <= maximumEnvelopeBytes else { throw Failure.tooLarge }
    }
    static func encode(_ record: HermesLegacyRecord) throws -> Data {
        guard record.payload.count <= maximumPayloadBytes else { throw Failure.tooLarge }
        guard let provenance = record.provenance else { throw Failure.invalid }
        try bounded(provenance.source)
        guard sources.contains(provenance.source), validDigest(provenance.archiveDigest) else { throw Failure.invalid }
        for text in [record.id, record.revision, record.container, provenance.sourcePath, provenance.guestOrigin ?? ""] { try bounded(text) }
        let value = HermesLegacyEnvelope(schemaVersion: 1, type: "hermes-legacy-preservation", source: provenance.source,
            originalID: record.id, revision: record.revision, container: record.container,
            provenance: .init(guestOrigin: provenance.guestOrigin, sourcePath: provenance.sourcePath,
                              rawRange: [provenance.rawRange.lowerBound, provenance.rawRange.upperBound], archiveSHA256: provenance.archiveDigest),
            deleted: record.deleted, payloadBase64: record.payload.base64EncodedString(), payloadSHA256: digest(record.payload))
        let encoded = try JSONEncoder().encode(value)
        _ = try decode(encoded)
        return encoded
    }
    static func decode(_ encoded: Data) throws -> Decoded {
        guard encoded.count <= maximumEnvelopeBytes else { throw Failure.tooLarge }
        let root: HermesLegacyJSONValue
        do { root = try HermesLegacyJSONScanner.scan(encoded) } catch { throw Failure.invalid }
        func object(_ value: HermesLegacyJSONValue, keys: Set<String>) throws -> [String: HermesLegacyJSONValue] {
            guard case .object(let members) = value.kind, Set(members.map(\.key)) == keys else { throw Failure.invalid }
            return Dictionary(uniqueKeysWithValues: members.map { ($0.key, $0.value) })
        }
        func text(_ value: HermesLegacyJSONValue?) throws -> String {
            guard let value, case .string(let string) = value.kind else { throw Failure.invalid }
            return string
        }
        func integer(_ value: HermesLegacyJSONValue?) throws -> Int {
            guard let value, case .number = value.kind,
                  let number = Double(String(decoding: encoded.subdata(in: value.range), as: UTF8.self)),
                  number.isFinite, number.rounded(.towardZero) == number,
                  number >= 0, number <= 9_007_199_254_740_991 else { throw Failure.invalid }
            return Int(number)
        }
        let fields = try object(root, keys: ["schemaVersion", "type", "source", "originalID", "revision", "container", "provenance", "deleted", "payloadBase64", "payloadSHA256"])
        guard try integer(fields["schemaVersion"]) == 1, try text(fields["type"]) == "hermes-legacy-preservation" else { throw Failure.invalid }
        let source = try text(fields["source"]), id = try text(fields["originalID"]), revision = try text(fields["revision"]), container = try text(fields["container"])
        guard sources.contains(source), !id.isEmpty, !revision.isEmpty,
              let deletedValue = fields["deleted"], case .bool(let deleted) = deletedValue.kind,
              let provenanceValue = fields["provenance"] else { throw Failure.invalid }
        let provenanceFields = try object(provenanceValue, keys: ["guestOrigin", "sourcePath", "rawRange", "archiveSHA256"])
        let guest: String?
        if let guestValue = provenanceFields["guestOrigin"], case .null = guestValue.kind { guest = nil }
        else { guest = try text(provenanceFields["guestOrigin"]); guard guest?.isEmpty == false else { throw Failure.invalid } }
        let path = try text(provenanceFields["sourcePath"]), archiveDigest = try text(provenanceFields["archiveSHA256"])
        guard !path.isEmpty, validDigest(archiveDigest), let rangeValue = provenanceFields["rawRange"],
              case .array(let range) = rangeValue.kind, range.count == 2 else { throw Failure.invalid }
        let lower = try integer(range[0]), upper = try integer(range[1])
        let base64 = try text(fields["payloadBase64"]), payloadDigest = try text(fields["payloadSHA256"])
        guard base64.utf8.count <= 4 * ((maximumPayloadBytes + 2) / 3) else { throw Failure.tooLarge }
        guard let payload = Data(base64Encoded: base64), payload.base64EncodedString() == base64,
              validDigest(payloadDigest), digest(payload) == payloadDigest,
              upper >= lower, upper - lower == payload.count else { throw Failure.invalid }
        guard payload.count <= maximumPayloadBytes else { throw Failure.tooLarge }
        // Syntax only: no authentication of originalID, provenance or the claimed whole-archive digest.
        do { _ = try HermesLegacyJSONScanner.scan(payload) } catch { throw Failure.invalid }
        let envelope = HermesLegacyEnvelope(schemaVersion: 1, type: "hermes-legacy-preservation", source: source,
            originalID: id, revision: revision, container: container,
            provenance: .init(guestOrigin: guest, sourcePath: path, rawRange: [lower, upper], archiveSHA256: archiveDigest),
            deleted: deleted, payloadBase64: base64, payloadSHA256: payloadDigest)
        return .init(envelope: envelope, payload: payload)
    }
}
