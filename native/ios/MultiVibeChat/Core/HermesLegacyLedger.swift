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

/// Structural inspection only. Every range addresses the original UTF-8 bytes; numbers remain opaque.
struct HermesLegacyJSONValue: Sendable {
    struct Member: Sendable { let key: String; let value: HermesLegacyJSONValue }
    indirect enum Kind: Sendable {
        case object([Member]), array([HermesLegacyJSONValue]), string(String), number, bool(Bool), null
    }
    let range: Range<Int>
    let kind: Kind
}

enum HermesLegacyJSONScanner {
    enum Failure: Error { case invalid, tooLarge, depthLimit, nodeLimit }

    static func scan(_ data: Data, maximumDepth: Int = 64, maximumNodes: Int = 100_000) throws -> HermesLegacyJSONValue {
        guard data.count <= HermesLegacyLedger.maximumBytes else { throw Failure.tooLarge }
        guard maximumDepth >= 0, maximumDepth <= 64, maximumNodes > 0,
              String(data: data, encoding: .utf8) != nil else { throw Failure.invalid }
        var parser = Parser(bytes: Array(data), maximumDepth: maximumDepth, maximumNodes: maximumNodes)
        let value = try parser.value(depth: 0)
        parser.whitespace()
        guard parser.index == parser.bytes.count else { throw Failure.invalid }
        return value
    }

    private struct Parser {
        let bytes: [UInt8]
        let maximumDepth: Int
        let maximumNodes: Int
        var index = 0
        var nodes = 0
        var current: UInt8? { index < bytes.count ? bytes[index] : nil }
        mutating func whitespace() {
            while let byte = current, byte == 32 || byte == 9 || byte == 10 || byte == 13 { index += 1 }
        }
        mutating func consume(_ byte: UInt8) throws {
            guard current == byte else { throw Failure.invalid }; index += 1
        }
        mutating func literal(_ text: String) throws {
            for byte in text.utf8 { try consume(byte) }
        }
        mutating func hex() throws -> UInt16 {
            var value: UInt16 = 0
            for _ in 0..<4 {
                guard let byte = current else { throw Failure.invalid }
                let digit: UInt16
                switch byte {
                case 48...57: digit = UInt16(byte - 48)
                case 65...70: digit = UInt16(byte - 65 + 10)
                case 97...102: digit = UInt16(byte - 97 + 10)
                default: throw Failure.invalid
                }
                value = value * 16 + digit; index += 1
            }
            return value
        }
        mutating func string() throws -> String {
            let start = index
            try consume(34)
            while let byte = current {
                if byte == 34 {
                    index += 1
                    return try JSONDecoder().decode(String.self, from: Data(bytes[start..<index]))
                }
                guard byte >= 32 else { throw Failure.invalid }
                index += 1
                if byte == 92 {
                    guard let escape = current else { throw Failure.invalid }; index += 1
                    switch escape {
                    case 34, 92, 47, 98, 102, 110, 114, 116: break
                    case 117:
                        let code = try hex()
                        if (0xD800...0xDBFF).contains(code) {
                            try consume(92); try consume(117)
                            guard (0xDC00...0xDFFF).contains(try hex()) else { throw Failure.invalid }
                        } else if (0xDC00...0xDFFF).contains(code) { throw Failure.invalid }
                    default: throw Failure.invalid
                    }
                }
            }
            throw Failure.invalid
        }
        mutating func digits() throws {
            guard let byte = current, (48...57).contains(byte) else { throw Failure.invalid }
            while let byte = current, (48...57).contains(byte) { index += 1 }
        }
        mutating func number() throws {
            if current == 45 { index += 1 }
            if current == 48 { index += 1 }
            else {
                guard let byte = current, (49...57).contains(byte) else { throw Failure.invalid }
                try digits()
            }
            if current == 46 { index += 1; try digits() }
            if current == 101 || current == 69 {
                index += 1
                if current == 43 || current == 45 { index += 1 }
                try digits()
            }
        }
        mutating func value(depth: Int) throws -> HermesLegacyJSONValue {
            // Limits are checked before descending into another recursive frame.
            guard depth <= maximumDepth else { throw Failure.depthLimit }
            guard nodes < maximumNodes else { throw Failure.nodeLimit }; nodes += 1
            whitespace(); let start = index
            let kind: HermesLegacyJSONValue.Kind
            guard let token = current else { throw Failure.invalid }
            switch token {
            case 123:
                index += 1; whitespace()
                var members: [HermesLegacyJSONValue.Member] = []
                var keys = Set<String>()
                if current != 125 {
                    while true {
                        let key = try string()
                        guard keys.insert(key).inserted else { throw Failure.invalid }
                        whitespace(); try consume(58)
                        guard depth < maximumDepth else { throw Failure.depthLimit }
                        members.append(.init(key: key, value: try value(depth: depth + 1)))
                        whitespace()
                        if current != 44 { break }
                        index += 1; whitespace()
                    }
                }
                try consume(125); kind = .object(members)
            case 91:
                index += 1; whitespace()
                var children: [HermesLegacyJSONValue] = []
                if current != 93 {
                    while true {
                        guard depth < maximumDepth else { throw Failure.depthLimit }
                        children.append(try value(depth: depth + 1)); whitespace()
                        if current != 44 { break }; index += 1
                    }
                }
                try consume(93); kind = .array(children)
            case 34: kind = .string(try string())
            case 116: try literal("true"); kind = .bool(true)
            case 102: try literal("false"); kind = .bool(false)
            case 110: try literal("null"); kind = .null
            case 45, 48...57: try number(); kind = .number
            default: throw Failure.invalid
            }
            return .init(range: start..<index, kind: kind)
        }
    }
}
