import CryptoKit
import Foundation

/// Lossless device-only preservation. Conversion grants neither export consent nor inference access.
/// Callers must supply original serialized bytes, before decoding into native Codable models.
struct HermesLegacyRecord: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable { case conversation, message, memory }
    let kind: Kind
    let id: String
    let revision: String
    /// Original containing conversation, or original memory scope. Never a generated project ID.
    let container: String
    let payload: Data
    let deleted: Bool
    /// Explicit retrieval policy, separate from preservation of invalid/proposed/expired memories.
    let inferenceUsable: Bool
    var usableForInference: Bool { inferenceUsable && !deleted }
}

struct HermesLegacyConversion: Codable, Equatable, Sendable {
    enum Publication: String, Codable, Sendable { case converted, queued, receiptConfirmed }
    let record: HermesLegacyRecord
    let digest: String
    let operationID: UUID
    let versionID: UUID
    var publication: Publication = .converted
}

struct HermesLegacyLedgerSnapshot: Codable, Equatable, Sendable {
    struct Binding: Codable, Equatable, Sendable {
        let bindingID: UUID
        let sessionID: UUID
        let branchID: UUID
    }
    struct Quarantine: Codable, Equatable, Sendable {
        let record: HermesLegacyRecord
        let reason: String
    }
    let formatVersion: Int
    let scope: String
    let deviceID: UUID
    var bindings: [String: Binding] = [:]
    var conversions: [HermesLegacyConversion] = []
    var quarantine: [Quarantine] = []
}

enum HermesLegacyLedgerError: Error { case invalid, unsupportedVersion, tooLarge }

/// One account (including a distinct guest namespace) per atomic, protected ledger file.
/// No in-memory accepted state is advanced before a successful durable write.
actor HermesLegacyLedger {
    static let maximumBytes = 32 * 1_048_576
    private let root: URL
    private let writeFile: @Sendable (Data, URL) throws -> Void
    init(root: URL, writeFile: @escaping @Sendable (Data, URL) throws -> Void = { data, url in
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: url, options: .atomic)
        #endif
    }) { self.root = root; self.writeFile = writeFile }

    private func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    private func scope(_ accountID: String?) throws -> String {
        if let accountID, accountID.isEmpty { throw HermesLegacyLedgerError.invalid }
        return digest(Data((accountID.map { "account:\($0)" } ?? "guest-device-only").utf8))
    }
    private func location(_ scope: String) -> URL { root.appendingPathComponent(scope + ".json") }

    func snapshot(accountID: String?) throws -> HermesLegacyLedgerSnapshot? {
        let namespace = try scope(accountID)
        let url = location(namespace)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= Self.maximumBytes else { throw HermesLegacyLedgerError.tooLarge }
        let data = try Data(contentsOf: url)
        guard data.count <= Self.maximumBytes else { throw HermesLegacyLedgerError.tooLarge }
        let result = try JSONDecoder().decode(HermesLegacyLedgerSnapshot.self, from: data)
        guard result.formatVersion == 1 else { throw HermesLegacyLedgerError.unsupportedVersion }
        guard result.scope == namespace else { throw HermesLegacyLedgerError.invalid }
        return result
    }

    /// Atomic batch; exact repeats do not write. Raw payloads and every accepted revision remain intact.
    @discardableResult
    func convert(_ records: [HermesLegacyRecord], accountID: String?) throws -> HermesLegacyLedgerSnapshot {
        let namespace = try scope(accountID)
        let prior = try snapshot(accountID: accountID)
        var next = prior ?? .init(formatVersion: 1, scope: namespace, deviceID: UUID())
        for record in records {
            guard !record.id.isEmpty, !record.revision.isEmpty,
                  record.payload.count <= Self.maximumBytes else { throw HermesLegacyLedgerError.invalid }
            let hash = digest(record.payload)
            let history = next.conversions.filter { $0.record.kind == record.kind && $0.record.id == record.id }
            let sameRevision = next.conversions.first { $0.record.kind == record.kind && $0.record.id == record.id && $0.record.revision == record.revision }
            var reason: String?
            if let existing = sameRevision {
                if existing.record == record && existing.digest == hash { continue }
                reason = "revision_or_payload_collision"
            } else if history.contains(where: { $0.record.container != record.container }) {
                reason = "identity_container_collision"
            } else if !record.deleted && history.contains(where: { $0.record.deleted }) {
                reason = "tombstone_resurrection"
            }
            if let reason {
                let item = HermesLegacyLedgerSnapshot.Quarantine(record: record, reason: reason)
                if !next.quarantine.contains(item) { next.quarantine.append(item) }
                continue
            }
            // Memory scopes remain independent; conversation/message containers share a binding.
            let bindingKey = (record.kind == .memory ? "memory:" : "conversation:") + record.container
            if next.bindings[bindingKey] == nil {
                next.bindings[bindingKey] = .init(bindingID: UUID(), sessionID: UUID(), branchID: UUID())
            }
            next.conversions.append(.init(record: record, digest: hash, operationID: UUID(), versionID: UUID()))
        }
        if prior == next { return next }
        let data = try JSONEncoder().encode(next)
        guard data.count <= Self.maximumBytes else { throw HermesLegacyLedgerError.tooLarge }
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
        #if os(iOS)
        attributes[.protectionKey] = FileProtectionType.complete
        #endif
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: attributes)
        // Set metadata before committing content; a metadata failure must not replace prior bytes.
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var directory = root; try directory.setResourceValues(values)
        try writeFile(data, location(namespace))
        return next
    }
}
