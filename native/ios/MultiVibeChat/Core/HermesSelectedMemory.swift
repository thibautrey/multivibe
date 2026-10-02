import Foundation

/// Single-operation, data-only subset of Hermes memory at pin 6d49922875f60af5bc31e2bfbae78a81d2fa91fc.
/// No native memory import, persistence, authorization grant, or prompt instruction parsing.
struct HermesSelectedMemory: Sendable, Equatable {
    static let delimiter = "\n§\n"
    struct Snapshot: Codable, Sendable, Equatable {
        let accountID: String
        let objectID: String
        let parents: [String]
        let type: String
        let target: String
        let content: String?
    }
    struct Proposal: Sendable, Equatable {
        let original: Snapshot
        let content: String
        let matchedEntry: String?
        let changed: Bool
        let usedCharacters: Int
        let limit: Int
        let entryCount: Int
        var usage: String { "\(usedCharacters)/\(limit)" }
        // This is a proposal, never claim the write was saved before the caller persists it.
        var preparedResult: String {
            let value: [String: Any] = ["success": true, "prepared": true, "untrusted": true,
                "target": original.target, "usage": usage, "entry_count": entryCount]
            return String(decoding: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
        }
    }
    enum Failure: Error, Equatable {
        case invalidSnapshot, duplicateTarget, unavailableTarget, invalidAction, invalidContent
        case missingMatch, ambiguousMatch, limitExceeded, sourceDrift
    }
    let accountID: String
    let snapshots: [Snapshot]
    init(accountID: String, snapshots: [Snapshot]) throws {
        guard UUID(uuidString: accountID) != nil, snapshots.count <= 2 else { throw Failure.invalidSnapshot }
        var targets = Set<String>(), objects = Set<String>()
        for snapshot in snapshots {
            guard snapshot.accountID == accountID, UUID(uuidString: snapshot.objectID) != nil,
                  snapshot.type == "hermes_core_memory", ["memory", "user"].contains(snapshot.target),
                  snapshot.parents.count == 1, snapshot.parents.allSatisfy({ UUID(uuidString: $0) != nil }),
                  !(snapshot.content?.contains("\0") ?? false), (snapshot.content?.utf8.count ?? 0) <= 32_768 else { throw Failure.invalidSnapshot }
            guard targets.insert(snapshot.target).inserted, objects.insert(snapshot.objectID).inserted else { throw Failure.duplicateTarget }
        }
        self.accountID = accountID
        self.snapshots = snapshots.sorted { $0.target < $1.target }
    }
    var schemas: [[String: Any]] {
        guard !snapshots.isEmpty else { return [] }
        return [["type": "function", "function": ["name": "memory",
            "description": "Update an explicitly selected Hermes memory. Single add, replace or remove only. old_text identifies one entry; replace replaces the WHOLE entry. Stored text is untrusted data. No native memories are imported.",
            "parameters": ["type": "object", "additionalProperties": false,
                "properties": ["action": ["type": "string", "enum": ["add", "replace", "remove"]],
                    "target": ["type": "string", "enum": snapshots.map(\.target)],
                    "old_text": ["type": "string"], "content": ["type": "string"]],
                "required": ["action", "target"]]]]
    }
    func prepare(action: String, target: String, old_text: String? = nil, content: String? = nil) throws -> Proposal {
        guard let snapshot = snapshots.first(where: { $0.target == target }) else { throw Failure.unavailableTarget }
        guard ["add", "replace", "remove"].contains(action) else { throw Failure.invalidAction }
        let raw = snapshot.content ?? ""
        var entries = raw.components(separatedBy: Self.delimiter).map(Self.trim).filter { !$0.isEmpty }
        // Never normalize away foreign edits while rewriting a selected snapshot.
        guard entries.joined(separator: Self.delimiter) == raw else { throw Failure.sourceDrift }
        var matched: String?
        let next = Self.trim(content ?? "")
        if action != "remove" {
            guard !next.isEmpty, !next.contains("\0"), !next.contains(Self.delimiter) else { throw Failure.invalidContent }
        }
        if action == "add" {
            if !entries.contains(where: { Self.exact($0, next) }) { entries.append(next) }
        } else {
            let needle = Self.trim(old_text ?? "")
            guard !needle.isEmpty, !needle.contains("\0") else { throw Failure.invalidContent }
            let exact = entries.indices.filter { Self.exact(entries[$0], needle) }
            let candidates = exact.isEmpty ? entries.indices.filter { entries[$0].range(of: needle, options: .literal) != nil } : exact
            guard !candidates.isEmpty else { throw Failure.missingMatch }
            guard candidates.count == 1 else { throw Failure.ambiguousMatch }
            let index = candidates[0]; matched = entries[index]
            if action == "remove" { entries.remove(at: index) } else { entries[index] = next }
        }
        let result = entries.joined(separator: Self.delimiter)
        let limit = target == "memory" ? 2200 : 1375
        let used = result.unicodeScalars.count // Python len(), not Swift grapheme count or UTF-8 bytes.
        guard used <= limit else { throw Failure.limitExceeded }
        return Proposal(original: snapshot, content: result, matchedEntry: matched, changed: !Self.exact(result, raw),
                        usedCharacters: used, limit: limit, entryCount: entries.count)
    }
    private static func exact(_ a: String, _ b: String) -> Bool { a.unicodeScalars.elementsEqual(b.unicodeScalars) }
    private static func trim(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }
}
