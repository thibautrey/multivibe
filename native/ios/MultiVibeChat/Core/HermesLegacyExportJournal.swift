import Foundation
import CryptoKit

/// Preservation publication only. This journal never grants inference or creates execution history.
actor HermesLegacyExportJournal {
    enum Failure: Error { case invalid, consentRequired, identityConflict, tooLarge }
    enum Phase: String, Codable, Sendable { case prepared, queued, receiptConfirmed, blocked }
    struct Confirmation: Codable, Equatable, Sendable {
        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.accountID == rhs.accountID && lhs.change == rhs.change && lhs.receipt?.operationId == rhs.receipt?.operationId &&
            lhs.receipt?.versionId == rhs.receipt?.versionId && lhs.receipt?.cursor == rhs.receipt?.cursor &&
            lhs.receipt?.heads == rhs.receipt?.heads && lhs.receipt?.deleted == rhs.receipt?.deleted
        }
        let accountID: String
        let receipt: CloudAgentReceipt?
        let change: CloudAgentChange?
    }
    struct Intent: Codable, Equatable, Sendable {
        let accountID: String
        let identity: String
        let conversionDigest: String
        let mutation: CloudAgentMutation
        let requiredSources: [String]
        let consentRevision: Int
        var phase: Phase
        var reason: String?
        var confirmation: Confirmation? = nil
    }
    struct Snapshot: Codable, Equatable, Sendable {
        let schemaVersion: Int
        let accountID: String
        var mappings: [String: String] = [:]
        var intents: [String: Intent] = [:]
    }
    private let root: URL
    private let transactionLock: NSRecursiveLock
    private let writeFile: @Sendable (Data, URL) throws -> Void
    private static let maximumBytes = 32 * 1_048_576
    init(root: URL, writeFile: @escaping @Sendable (Data, URL) throws -> Void = { bytes, url in
        #if os(iOS)
        try bytes.write(to: url, options: [.atomic, .completeFileProtection])
        #else
        try bytes.write(to: url, options: .atomic)
        #endif
    }) { self.root = root; self.writeFile = writeFile; self.transactionLock = HermesLegacyExportLocks.shared.lock(root) }
    private static func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    private static func identity(_ record: HermesLegacyRecord) throws -> String {
        guard let provenance = record.provenance else { throw Failure.invalid }
        func field(_ text: String) -> String { "\(text.utf8.count):\(text)" }
        return field(record.kind.rawValue) + field(provenance.source) + (provenance.guestOrigin.map { "value:" + field($0) } ?? "nil:") + field(record.id)
    }
    static func mappedObjectID(record: HermesLegacyRecord, snapshot: Snapshot) throws -> String? {
        snapshot.mappings[try identity(record)]
    }
    private static func sources(_ source: String, guest: String?) throws -> [String] {
        let required: String
        switch source {
        case "nativeConversation", "nativeMessage": required = "legacy-native-history"
        case "nativeMemory": required = "legacy-native-memory"
        case "cloudConversation", "cloudRepositoryNode": required = "legacy-cloud-history"
        default: throw Failure.invalid
        }
        return ([required] + (guest == nil ? [] : ["legacy-guest"])).sorted()
    }
    private func location(_ account: String) throws -> URL {
        guard CloudAgentState.uuid(account) else { throw Failure.invalid }
        return root.appendingPathComponent(Self.digest(Data(account.utf8)) + ".json")
    }
    func snapshot(accountID: String) throws -> Snapshot {
        transactionLock.lock(); defer { transactionLock.unlock() }
        let url = try location(accountID)
        guard FileManager.default.fileExists(atPath: url.path) else { return .init(schemaVersion: 1, accountID: accountID) }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard ((attributes[.size] as? NSNumber)?.intValue ?? Int.max) <= Self.maximumBytes else { throw Failure.tooLarge }
        let bytes = try Data(contentsOf: url)
        guard bytes.count <= Self.maximumBytes else { throw Failure.tooLarge }
        let state = try JSONDecoder().decode(Snapshot.self, from: bytes)
        guard state.schemaVersion == 1, state.accountID == accountID else { throw Failure.invalid }
        for (key, intent) in state.intents {
            guard key == intent.mutation.operationId, intent.accountID == accountID,
                  state.mappings[intent.identity] == intent.mutation.objectId, intent.consentRevision >= 0,
                  !intent.mutation.deleted, let value = intent.mutation.value else { throw Failure.invalid }
            try CloudAgentState.validate(intent.mutation)
            let decoded = try HermesLegacyEnvelopeCodec.decode(JSONEncoder().encode(value))
            guard Self.digest(decoded.payload) == intent.conversionDigest,
                  intent.requiredSources == (try Self.sources(decoded.envelope.source, guest: decoded.envelope.provenance.guestOrigin)),
                  intent.identity == (try Self.identity(HermesLegacyRecord(
                    kind: intent.mutation.kind == "session" ? .conversation : intent.mutation.kind == "message" ? .message : .memory,
                    id: decoded.envelope.originalID, revision: decoded.envelope.revision, container: decoded.envelope.container,
                    payload: decoded.payload, deleted: decoded.envelope.deleted, inferenceUsable: false,
                    provenance: .init(source: decoded.envelope.source, guestOrigin: decoded.envelope.provenance.guestOrigin,
                        sourcePath: decoded.envelope.provenance.sourcePath,
                        rawRange: decoded.envelope.provenance.rawRange[0]..<decoded.envelope.provenance.rawRange[1],
                        archiveDigest: decoded.envelope.provenance.archiveSHA256)))),
                  ["session", "message", "memory"].contains(intent.mutation.kind) else { throw Failure.invalid }
        }
        for intent in state.intents.values {
            let source = intent.mutation.value?.object?["source"]?.string
            let expectedKind = source == "nativeMemory" ? "memory" : ["nativeMessage", "cloudRepositoryNode"].contains(source ?? "") ? "message" : "session"
            guard intent.mutation.kind == expectedKind else { throw Failure.invalid }
            if intent.phase == .receiptConfirmed {
                guard let proof = intent.confirmation else { throw Failure.invalid }
                guard proof.accountID == accountID else { throw Failure.invalid }
                try Self.validate(proof, operation: intent.mutation)
            } else if intent.confirmation != nil { throw Failure.invalid }
        }
        guard state.mappings.values.allSatisfy(CloudAgentState.uuid), Set(state.mappings.values).count == state.mappings.count else { throw Failure.invalid }
        return state
    }
    private static func validate(_ proof: Confirmation, operation: CloudAgentMutation) throws {
        guard (proof.receipt == nil) != (proof.change == nil) else { throw Failure.invalid }
        if let change = proof.change {
            guard !change.erased, !change.deleted, change.mutation == operation,
                  change.cursor > 0, change.cursor < 9_007_199_254_740_991 else { throw Failure.invalid }
        }
        if let receipt = proof.receipt {
            guard receipt.operationId == operation.operationId, receipt.versionId == operation.versionId,
                  !receipt.deleted, receipt.cursor > 0, receipt.cursor < 9_007_199_254_740_991,
                  !receipt.heads.isEmpty, receipt.heads.allSatisfy(CloudAgentState.uuid),
                  Set(receipt.heads).count == receipt.heads.count else { throw Failure.invalid }
        }
    }
    private func save(_ state: Snapshot) throws {
        let bytes = try JSONEncoder().encode(state)
        guard bytes.count <= Self.maximumBytes else { throw Failure.tooLarge }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = try location(state.accountID)
        try writeFile(bytes, url)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    /// Call after pulling Cloud changes. Captured parents become immutable with the first durable preparation.
    func prepare(_ conversion: HermesLegacyConversion, accountID: String, deviceID: String,
                 parents: [String], consent: CloudHermesConsent) throws -> Intent {
        transactionLock.lock(); defer { transactionLock.unlock() }
        guard consent.accountId == accountID, consent.cloudEnabled, consent.revision >= 0,
              let provenance = conversion.record.provenance else { throw Failure.consentRequired }
        let required = try Self.sources(provenance.source, guest: provenance.guestOrigin)
        guard Set(required).isSubset(of: Set(consent.exportSources ?? [])) else { throw Failure.consentRequired }
        let encoded = try HermesLegacyEnvelopeCodec.encode(conversion.record)
        guard conversion.digest == Self.digest(conversion.record.payload) else { throw Failure.invalid }
        let value = try JSONDecoder().decode(HistoryJSON.self, from: encoded)
        let identity = try Self.identity(conversion.record)
        var state = try snapshot(accountID: accountID)
        let key = conversion.operationID.uuidString.lowercased()
        if let saved = state.intents[key] {
            guard saved.identity == identity, saved.conversionDigest == conversion.digest,
                  saved.mutation.versionId == conversion.versionID.uuidString.lowercased(), saved.mutation.deviceId == deviceID,
                  saved.mutation.value == value else { throw Failure.identityConflict }
            return saved // Never regenerate IDs or recapture parents during retry.
        }
        guard state.intents.count < 1000 else { throw Failure.tooLarge }
        let objectID = state.mappings[identity] ?? UUID().uuidString.lowercased()
        let kind = conversion.record.kind == .conversation ? "session" : conversion.record.kind.rawValue
        let operation = CloudAgentMutation(operationId: key, objectId: objectID,
            versionId: conversion.versionID.uuidString.lowercased(), deviceId: deviceID,
            kind: kind, parents: parents.sorted(), deleted: false, value: value)
        try CloudAgentState.validate(operation)
        guard !state.intents.values.contains(where: { $0.mutation.versionId == operation.versionId }) else { throw Failure.identityConflict }
        let intent = Intent(accountID: accountID, identity: identity, conversionDigest: conversion.digest,
            mutation: operation, requiredSources: required, consentRevision: consent.revision, phase: .prepared)
        state.mappings[identity] = objectID; state.intents[key] = intent
        try save(state); return intent
    }
    func queue(accountID: String, operationID: String, consent: CloudHermesConsent) throws -> Intent {
        transactionLock.lock(); defer { transactionLock.unlock() }
        var state = try snapshot(accountID: accountID)
        guard var intent = state.intents[operationID] else { throw Failure.invalid }
        guard consent.accountId == accountID, consent.cloudEnabled,
              Set(intent.requiredSources).isSubset(of: Set(consent.exportSources ?? [])) else { throw Failure.consentRequired }
        guard intent.phase == .prepared || intent.phase == .queued else { throw Failure.invalid }
        intent.phase = .queued; state.intents[operationID] = intent; try save(state); return intent
    }
    /// Recovery is exact-operation comparison, not a guess from a matching version UUID.
    func reconcile(accountID: String, changes: [CloudAgentChange]) throws -> Snapshot {
        transactionLock.lock(); defer { transactionLock.unlock() }
        var state = try snapshot(accountID: accountID)
        // Terminal object erasure wins over stale publication evidence in either page order.
        let erasedObjects = Set(changes.filter { $0.deleted || $0.erased }.map(\.objectId))
        for key in Array(state.intents.keys) {
            guard var intent = state.intents[key], intent.phase != .blocked else { continue }
            if erasedObjects.contains(intent.mutation.objectId) {
                intent.phase = .blocked; intent.reason = "legacy_export_object_erased"; intent.confirmation = nil
            } else {
                let related = changes.filter { $0.operationId == key || $0.versionId == intent.mutation.versionId }
                if related.contains(where: { $0.erased || $0.mutation != intent.mutation }) {
                    intent.phase = .blocked; intent.reason = "legacy_export_operation_mismatch_or_erased"; intent.confirmation = nil
                } else if let exact = related.last {
                    let proof = Confirmation(accountID: accountID, receipt: nil, change: exact)
                    try Self.validate(proof, operation: intent.mutation)
                    intent.phase = .receiptConfirmed; intent.reason = nil; intent.confirmation = proof
                }
            }
            state.intents[key] = intent
        }
        try save(state); return state
    }
    func acknowledge(accountID: String, submitted: [CloudAgentMutation], reply: CloudAgentReceipts) throws -> Snapshot {
        transactionLock.lock(); defer { transactionLock.unlock() }
        var state = try snapshot(accountID: accountID)
        guard reply.accountId == accountID, !reply.receipts.isEmpty else { throw Failure.invalid }
        var seen = Set<String>()
        for receipt in reply.receipts {
            guard var intent = state.intents[receipt.operationId], submitted.contains(intent.mutation),
                  intent.phase == .queued, receipt.versionId == intent.mutation.versionId, !receipt.deleted,
                  receipt.cursor > 0, receipt.cursor < 9_007_199_254_740_991,
                  !receipt.heads.isEmpty, receipt.heads.allSatisfy(CloudAgentState.uuid), Set(receipt.heads).count == receipt.heads.count,
                  seen.insert(receipt.operationId).inserted else { throw Failure.invalid }
            intent.phase = .receiptConfirmed; intent.confirmation = Confirmation(accountID: accountID, receipt: receipt, change: nil)
            try Self.validate(intent.confirmation!, operation: intent.mutation)
            state.intents[receipt.operationId] = intent
        }
        try save(state); return state
    }
}

/// Serializes atomic read-modify-write across journal instances in this process.
private final class HermesLegacyExportLocks: @unchecked Sendable {
    static let shared = HermesLegacyExportLocks()
    private let registry = NSLock()
    private var locks: [String: NSRecursiveLock] = [:]
    func lock(_ root: URL) -> NSRecursiveLock {
        registry.lock(); defer { registry.unlock() }
        let key = root.standardizedFileURL.resolvingSymlinksInPath().path
        if let existing = locks[key] { return existing }
        let created = NSRecursiveLock(); locks[key] = created; return created
    }
}
