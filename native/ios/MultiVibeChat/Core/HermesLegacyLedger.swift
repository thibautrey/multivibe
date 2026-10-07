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

    /// Latest means last locally accepted entry, never lexical/chronological revision ordering.
    /// Any accepted tombstone excludes the entire identity, including its preserved older payloads.
    var inferenceCandidates: [HermesLegacyRecord] {
        var latest: [LegacyIdentity: HermesLegacyRecord] = [:]
        var deleted = Set<LegacyIdentity>()
        for conversion in conversions {
            let record = conversion.record
            let identity = LegacyIdentity(record)
            latest[identity] = record
            if record.deleted { deleted.insert(identity) }
        }
        return conversions.compactMap { conversion in
            let record = conversion.record
            let identity = LegacyIdentity(record)
            guard !deleted.contains(identity), record.inferenceUsable,
                  latest[identity]?.revision == record.revision else { return nil }
            return record
        }
    }
}

private struct LegacyIdentity: Hashable {
    let kind: String
    let id: String
    init(_ record: HermesLegacyRecord) { kind = record.kind.rawValue; id = record.id }
}

/// Locks only this app process; this is not an app-group or cross-process coordination protocol.
private final class LegacyLedgerLocks: @unchecked Sendable {
    static let shared = LegacyLedgerLocks()
    private let registryLock = NSLock()
    private var roots: [String: NSLock] = [:]
    func lock(for root: URL) -> NSLock {
        registryLock.lock(); defer { registryLock.unlock() }
        let key = root.standardizedFileURL.resolvingSymlinksInPath().path
        if let existing = roots[key] { return existing }
        let created = NSLock(); roots[key] = created; return created
    }
}

enum HermesLegacyLedgerError: Error { case invalid, unsupportedVersion, tooLarge }

/// One account (including a distinct guest namespace) per atomic, protected ledger file.
/// No in-memory accepted state is advanced before a successful durable write.
actor HermesLegacyLedger {
    static let maximumBytes = 32 * 1_048_576
    private let root: URL
    private let transactionLock: NSLock
    private let writeFile: @Sendable (Data, URL) throws -> Void
    init(root: URL, writeFile: @escaping @Sendable (Data, URL) throws -> Void = { data, url in
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: url, options: .atomic)
        #endif
    }) {
        self.root = root.standardizedFileURL.resolvingSymlinksInPath()
        self.transactionLock = LegacyLedgerLocks.shared.lock(for: self.root)
        self.writeFile = writeFile
    }

    private func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    private func scope(_ accountID: String?) throws -> String {
        if let accountID, accountID.isEmpty { throw HermesLegacyLedgerError.invalid }
        return digest(Data((accountID.map { "account:\($0)" } ?? "guest-device-only").utf8))
    }
    private func location(_ scope: String) -> URL { root.appendingPathComponent(scope + ".json") }

    private func archiveLocation(_ hash: String, namespace: String) throws -> URL {
        guard hash.utf8.count == 64, hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw HermesLegacyLedgerError.invalid
        }
        return root.appendingPathComponent(namespace, isDirectory: true)
            .appendingPathComponent("raw-archives", isDirectory: true).appendingPathComponent(hash + ".raw")
    }

    /// Exact original cache bytes, independent of conversion, inference and publication.
    /// The digest identifies immutable content within the supplied account/guest namespace.
    @discardableResult
    func archive(_ original: Data, accountID: String?) throws -> String {
        transactionLock.lock(); defer { transactionLock.unlock() }
        guard original.count <= Self.maximumBytes else { throw HermesLegacyLedgerError.tooLarge }
        let namespace = try scope(accountID)
        let hash = digest(original)
        let url = try archiveLocation(hash, namespace: namespace)
        if let existing = try readArchive(hash, namespace: namespace) {
            guard existing == original else { throw HermesLegacyLedgerError.invalid }
            return hash
        }
        let directory = url.deletingLastPathComponent()
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
        #if os(iOS)
        attributes[.protectionKey] = FileProtectionType.complete
        #endif
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: attributes)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var excluded = root; try excluded.setResourceValues(values)
        // Only a previously absent digest path is written. Source history is never opened or modified.
        try writeFile(original, url)
        return hash
    }

    func archivedBytes(digest hash: String, accountID: String?) throws -> Data? {
        transactionLock.lock(); defer { transactionLock.unlock() }
        return try readArchive(hash, namespace: scope(accountID))
    }

    private func readArchive(_ hash: String, namespace: String) throws -> Data? {
        let url = try archiveLocation(hash, namespace: namespace)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= Self.maximumBytes else { throw HermesLegacyLedgerError.tooLarge }
        let bytes = try Data(contentsOf: url)
        guard bytes.count <= Self.maximumBytes else { throw HermesLegacyLedgerError.tooLarge }
        guard digest(bytes) == hash else { throw HermesLegacyLedgerError.invalid }
        return bytes
    }

    func snapshot(accountID: String?) throws -> HermesLegacyLedgerSnapshot? {
        transactionLock.lock(); defer { transactionLock.unlock() }
        return try readSnapshot(accountID: accountID)
    }

    private func readSnapshot(accountID: String?) throws -> HermesLegacyLedgerSnapshot? {
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
        try validate(result)
        return result
    }

    private func validate(_ snapshot: HermesLegacyLedgerSnapshot) throws {
        let zero = UUID(uuidString: "00000000-0000-0000-0000-000000000000")!
        var identifiers = Set<UUID>()
        func claim(_ id: UUID) throws {
            guard id != zero, identifiers.insert(id).inserted else { throw HermesLegacyLedgerError.invalid }
        }
        try claim(snapshot.deviceID)
        for binding in snapshot.bindings.values {
            try claim(binding.bindingID); try claim(binding.sessionID); try claim(binding.branchID)
        }
        var revisions: [LegacyIdentity: Set<String>] = [:]
        var containers: [LegacyIdentity: String] = [:]
        var tombstones = Set<LegacyIdentity>()
        var usedBindings = Set<String>()
        for conversion in snapshot.conversions {
            let record = conversion.record
            let identity = LegacyIdentity(record)
            guard !record.id.isEmpty, !record.revision.isEmpty,
                  conversion.digest == digest(record.payload),
                  !(revisions[identity]?.contains(record.revision) ?? false),
                  containers[identity].map({ $0 == record.container }) ?? true,
                  record.deleted || !tombstones.contains(identity),
                  conversion.publication == .converted else { throw HermesLegacyLedgerError.invalid }
            revisions[identity, default: []].insert(record.revision)
            containers[identity] = record.container
            if record.deleted { tombstones.insert(identity) }
            usedBindings.insert((record.kind == .memory ? "memory:" : "conversation:") + record.container)
            try claim(conversion.operationID); try claim(conversion.versionID)
        }
        guard usedBindings == Set(snapshot.bindings.keys) else { throw HermesLegacyLedgerError.invalid }
    }

    /// Atomic batch; exact repeats do not write. Raw payloads and every accepted revision remain intact.
    @discardableResult
    func convert(_ records: [HermesLegacyRecord], accountID: String?) throws -> HermesLegacyLedgerSnapshot {
        transactionLock.lock(); defer { transactionLock.unlock() }
        let namespace = try scope(accountID)
        let prior = try readSnapshot(accountID: accountID)
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
        try validate(next)
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
