import CryptoKit
import Foundation

/// Preservation metadata only; neither chronological ordering nor inference/export eligibility.
struct HermesLegacyExtractedRecord: Sendable {
    enum Source: String, Sendable {
        case nativeConversation, nativeMessage, nativeMemory, cloudConversation, cloudRepositoryNode
    }
    enum Revision: Sendable { case original(String), contentIdentity(String) }
    let source: Source
    let id: String
    let revision: Revision
    let container: String
    let path: String
    let guestOrigin: String?
    let payload: Data
    let range: Range<Int>
    let tombstone: Bool?
    let scope: String?
}

struct HermesLegacyExtraction: Sendable {
    struct Diagnostic: Sendable { let path: String; let range: Range<Int>; let reason: String }
    /// Includes every unknown top-level field and unsupported record; callers archive this first.
    let original: Data
    let records: [HermesLegacyExtractedRecord]
    let diagnostics: [Diagnostic]
}

enum HermesLegacyExtractor {
    static func extract(_ original: Data) throws -> HermesLegacyExtraction {
        let root = try HermesLegacyJSONScanner.scan(original)
        var builder = Builder(original: original)
        switch root.kind {
        case .array: builder.conversations(root, path: "$", guest: nil, cloud: false)
        case .object:
            for key in ["conversations", "baseline"] {
                if let value = builder.field(root, key) { builder.conversations(value, path: "$." + key, guest: nil, cloud: false) }
            }
            for key in ["memory", "memoryBaseline"] {
                if let value = builder.field(root, key) { builder.memories(value, path: "$." + key) }
            }
            if let snapshot = builder.field(root, "snapshot") { builder.snapshot(snapshot, path: "$.snapshot") }
            if let pending = builder.field(root, "pending"), !builder.isNull(pending) {
                if case .object = pending.kind {
                    if let local = builder.field(pending, "local") { builder.conversations(local, path: "$.pending.local", guest: nil, cloud: false) }
                    if let memory = builder.field(pending, "memory") { builder.memories(memory, path: "$.pending.memory") }
                    if let snapshot = builder.field(pending, "snapshot") { builder.snapshot(snapshot, path: "$.pending.snapshot") }
                } else { builder.issue(pending, "$.pending", "expected_object") }
            }
            if let guests = builder.field(root, "importedGuestSnapshots") { builder.guests(guests) }
        default: builder.issue(root, "$", "unsupported_root")
        }
        return .init(original: original, records: builder.records, diagnostics: builder.diagnostics)
    }

    private struct Builder {
        let original: Data
        var records: [HermesLegacyExtractedRecord] = []
        var diagnostics: [HermesLegacyExtraction.Diagnostic] = []
        func field(_ value: HermesLegacyJSONValue, _ key: String) -> HermesLegacyJSONValue? {
            guard case .object(let members) = value.kind else { return nil }
            return members.first { $0.key == key }?.value
        }
        func string(_ value: HermesLegacyJSONValue?) -> String? {
            guard let value, case .string(let text) = value.kind else { return nil }; return text
        }
        func isNull(_ value: HermesLegacyJSONValue) -> Bool { if case .null = value.kind { return true }; return false }
        mutating func issue(_ value: HermesLegacyJSONValue, _ path: String, _ reason: String) {
            diagnostics.append(.init(path: path, range: value.range, reason: reason))
        }
        mutating func append(_ value: HermesLegacyJSONValue, source: HermesLegacyExtractedRecord.Source,
                             id: String, container: String, path: String, guest: String? = nil,
                             revision: String? = nil, tombstone: Bool? = nil, scope: String? = nil) {
            let bytes = original.subdata(in: value.range)
            let version: HermesLegacyExtractedRecord.Revision
            if let revision { version = .original(revision) }
            else {
                let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
                version = .contentIdentity("sha256:" + digest)
            }
            records.append(.init(source: source, id: id, revision: version, container: container, path: path,
                                 guestOrigin: guest, payload: bytes, range: value.range, tombstone: tombstone, scope: scope))
        }
        mutating func memories(_ value: HermesLegacyJSONValue, path: String) {
            if isNull(value) { return }
            guard case .array(let values) = value.kind else { issue(value, path, "expected_array"); return }
            for (index, memory) in values.enumerated() {
                let location = path + "[\(index)]"
                guard let id = string(field(memory, "id")), !id.isEmpty,
                      let version = string(field(memory, "version")), !version.isEmpty else {
                    issue(memory, location, "missing_memory_identity_or_revision"); continue
                }
                let state = string(field(memory, "state"))
                let known = state.map { ["proposed", "confirmed", "deleted"].contains($0) } ?? false
                if !known { issue(memory, location, "unknown_memory_state") }
                append(memory, source: .nativeMemory, id: id, container: "native-memory", path: location,
                       revision: version, tombstone: known ? state == "deleted" : nil, scope: string(field(memory, "scope")))
            }
        }
        mutating func snapshot(_ value: HermesLegacyJSONValue, path: String) {
            if isNull(value) { return }
            guard case .object = value.kind else { issue(value, path, "expected_object"); return }
            if let memory = field(value, "memory") { memories(memory, path: path + ".memory") }
            if let conversations = field(value, "conversations") { self.conversations(conversations, path: path + ".conversations", guest: nil, cloud: true) }
        }
        mutating func conversations(_ value: HermesLegacyJSONValue, path: String, guest: String?, cloud: Bool) {
            if isNull(value) { return }
            guard case .array(let values) = value.kind else { issue(value, path, "expected_array"); return }
            for (index, conversation) in values.enumerated() {
                self.conversation(conversation, path: path + "[\(index)]", guest: guest, cloud: cloud)
            }
        }
        mutating func conversation(_ value: HermesLegacyJSONValue, path: String, guest: String?, cloud: Bool) {
            guard let id = string(field(value, "id")), !id.isEmpty else { issue(value, path, "missing_conversation_identity"); return }
            append(value, source: cloud ? .cloudConversation : .nativeConversation, id: id, container: id, path: path, guest: guest)
            if cloud {
                if let repository = field(value, "repository") {
                    guard case .object = repository.kind else { issue(repository, path + ".repository", "expected_object"); return }
                    if let nodes = field(repository, "messages") { messages(nodes, path: path + ".repository.messages", parent: id, guest: guest, cloud: true) }
                }
            } else if let messages = field(value, "messages") { self.messages(messages, path: path + ".messages", parent: id, guest: guest, cloud: false) }
        }
        mutating func messages(_ value: HermesLegacyJSONValue, path: String, parent: String, guest: String?, cloud: Bool) {
            guard case .array(let values) = value.kind else { issue(value, path, "expected_array"); return }
            for (index, node) in values.enumerated() {
                let location = path + "[\(index)]"
                let message = cloud ? field(node, "message") : node
                guard let message, let id = string(field(message, "id")), !id.isEmpty else { issue(node, location, "missing_message_identity"); continue }
                // Cloud payload is the complete repository node, retaining parent/branch and future metadata.
                append(node, source: cloud ? .cloudRepositoryNode : .nativeMessage, id: id, container: parent, path: location, guest: guest)
            }
        }
        mutating func guests(_ value: HermesLegacyJSONValue) {
            let path = "$.importedGuestSnapshots"
            if isNull(value) { return }
            switch value.kind {
            case .object(let members):
                for member in members {
                    conversation(member.value, path: path + "[" + String(reflecting: member.key) + "]", guest: member.key, cloud: false)
                }
            case .array(let values):
                guard values.count.isMultiple(of: 2) else { issue(value, path, "invalid_dictionary_array"); return }
                for index in stride(from: 0, to: values.count, by: 2) {
                    guard let key = string(values[index]), !key.isEmpty else { issue(values[index], path + "[\(index)]", "invalid_dictionary_key"); continue }
                    conversation(values[index + 1], path: path + "[\(index + 1)]", guest: key, cloud: false)
                }
            default: issue(value, path, "expected_dictionary")
            }
        }
    }
}
