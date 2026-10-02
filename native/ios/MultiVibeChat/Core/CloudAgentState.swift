import Foundation

struct CloudAgentMutation: Codable, Equatable, Sendable {
    let operationId: String; let objectId: String; let versionId: String; let deviceId: String
    let kind: String; let parents: [String]; let deleted: Bool; let value: HistoryJSON?
}
struct CloudAgentChange: Codable, Equatable, Sendable {
    let operationId: String; let objectId: String; let versionId: String; let deviceId: String
    let kind: String; let parents: [String]; let deleted: Bool; var value: HistoryJSON?
    let cursor: Int64; var erased: Bool
    var mutation: CloudAgentMutation { .init(operationId:operationId,objectId:objectId,versionId:versionId,deviceId:deviceId,kind:kind,parents:parents,deleted:deleted,value:value) }
}
struct CloudAgentPage: Codable, Sendable { let accountId: String; let changes: [CloudAgentChange]; let cursor: Int64; let hasMore: Bool }
struct CloudAgentReceipt: Codable, Sendable { let operationId: String; let versionId: String; let cursor: Int64; let heads: [String]; let deleted: Bool }
struct CloudAgentReceipts: Codable, Sendable { let accountId: String; let receipts: [CloudAgentReceipt] }
struct CloudAgentObject: Codable, Equatable, Sendable {
    let kind: String; var versions: [String:CloudAgentChange] = [:]; var heads: [String] = []; var deleted = false
}
/// Account-owned graph/outbox only. It contains no execution requests or SDK encrypted conversations.
struct CloudAgentState: Codable, Equatable, Sendable {
    let accountId: String; let deviceId: String
    var cursor: Int64 = 0
    var objects: [String:CloudAgentObject] = [:]
    var outbox: [CloudAgentMutation] = []
    var conflicts: [String:String] = [:]
    static let kinds: Set<String> = ["session","message","memory","skill","project","file","environment","task"]
    static func uuid(_ value:String) -> Bool { value.count == 36 && UUID(uuidString:value) != nil && value == value.lowercased() }
    static func validate(_ operation:CloudAgentMutation) throws {
        guard [operation.operationId,operation.objectId,operation.versionId,operation.deviceId].allSatisfy(uuid), kinds.contains(operation.kind),
            operation.parents.count <= 100, operation.parents.allSatisfy(uuid), Set(operation.parents).count == operation.parents.count,
            !operation.parents.contains(operation.versionId), operation.deleted ? operation.value == nil : operation.value != nil else { throw APIError.invalidResponse }
        if let value = operation.value, try JSONEncoder().encode(value).count > 128 * 1024 { throw APIError.server(413,"agent_value_too_large") }
    }
    func applying(_ page:CloudAgentPage) throws -> Self {
        guard page.accountId == accountId, page.cursor >= cursor, page.cursor < 9_007_199_254_740_991,
            page.changes.count <= 100, !page.hasMore || page.cursor > cursor else { throw APIError.invalidResponse }
        var next = self, last = cursor
        for raw in page.changes {
            guard raw.cursor > last, raw.cursor <= page.cursor else { throw APIError.invalidResponse }
            // Erased revisions legitimately lack their former value.
            if raw.erased && !raw.deleted {
                let placeholder = CloudAgentMutation(operationId:raw.operationId,objectId:raw.objectId,versionId:raw.versionId,deviceId:raw.deviceId,kind:raw.kind,parents:raw.parents,deleted:false,value:.null)
                try Self.validate(placeholder)
            } else { try Self.validate(raw.mutation) }
            var object = next.objects[raw.objectId] ?? CloudAgentObject(kind:raw.kind)
            guard object.kind == raw.kind else { throw APIError.invalidResponse }
            var change = raw
            if object.deleted || raw.deleted || raw.erased {
                object.deleted = true
                for key in object.versions.keys { object.versions[key]?.value = nil; let erased = object.versions[key]?.deleted == false; object.versions[key]?.erased = erased }
                change.value = nil; change.erased = !change.deleted
                if next.outbox.contains(where:{$0.objectId == raw.objectId}) { next.conflicts[raw.objectId] = "agent_object_deleted" }
                next.outbox.removeAll(where:{$0.objectId == raw.objectId})
            }
            object.versions[change.versionId] = change
            let parents = Set(object.versions.values.flatMap(\.parents))
            object.heads = object.versions.keys.filter{!parents.contains($0)}.sorted()
            next.objects[raw.objectId] = object
            if object.heads.count > 1 { next.conflicts[raw.objectId] = "agent_conflict_requires_resolution" }
            else if !object.deleted { next.conflicts[raw.objectId] = nil }
            last = raw.cursor
        }
        guard last == page.cursor else { throw APIError.invalidResponse }
        next.cursor = page.cursor; return next
    }
    mutating func enqueue(_ operation:CloudAgentMutation) throws {
        try Self.validate(operation)
        guard outbox.count < 1000 else { throw APIError.invalidResponse }
        if let object = objects[operation.objectId] {
            guard !object.deleted else { throw APIError.server(410,"agent_object_deleted") }
            guard object.kind == operation.kind else { throw APIError.invalidResponse }
            if object.heads.count > 1 && Set(operation.parents) != Set(object.heads) { throw APIError.server(409,"agent_conflict_requires_resolution") }
        }
        if let previous = outbox.first(where:{$0.operationId == operation.operationId}) {
            guard previous == operation else { throw APIError.server(409,"agent_operation_reused") }; return
        }
        outbox.append(operation)
    }
    static let resolvableKinds: Set<String> = ["memory","project","file","skill","session"]
    func resolution(objectId: String, reviewedHeads: [String], selectedHead: String, account: String) throws -> CloudAgentMutation {
        guard account == accountId, let object = objects[objectId], !object.deleted,
            Self.resolvableKinds.contains(object.kind), object.heads.count > 1,
            Set(reviewedHeads).count == reviewedHeads.count, Set(reviewedHeads) == Set(object.heads),
            reviewedHeads.contains(selectedHead), !outbox.contains(where: { $0.objectId == objectId }),
            let selected = object.versions[selectedHead], !selected.deleted, !selected.erased, let value = selected.value,
            object.heads.allSatisfy({ object.versions[$0]?.value != nil && object.versions[$0]?.erased == false && object.versions[$0]?.deleted == false })
        else { throw APIError.server(409,"agent_resolution_review_stale_or_unavailable") }
        // Existing execution history needs an explicit history anchor, not an arbitrary task scan.
        if object.kind == "session" {
            guard !objects.values.contains(where: { object in object.kind == "task" && object.versions.values.contains(where: { $0.value?.object?["sessionId"]?.string == objectId }) }),
                !outbox.contains(where: { $0.value?.object?["sessionId"]?.string == objectId })
            else { throw APIError.server(409,"agent_session_history_requires_resolution") }
        }
        return .init(operationId:UUID().uuidString.lowercased(),objectId:objectId,versionId:UUID().uuidString.lowercased(),deviceId:deviceId,kind:object.kind,parents:reviewedHeads.sorted(),deleted:false,value:value)
    }
    func acknowledging(_ reply:CloudAgentReceipts, submitted:[CloudAgentMutation]) throws -> Self {
        guard reply.accountId == accountId, !reply.receipts.isEmpty else { throw APIError.invalidResponse }
        var next = self; var acknowledged = Set<String>()
        for receipt in reply.receipts {
            guard let operation = submitted.first(where:{$0.operationId == receipt.operationId}), operation.versionId == receipt.versionId,
                receipt.cursor > 0, receipt.cursor < 9_007_199_254_740_991, receipt.heads.allSatisfy(Self.uuid),
                Set(receipt.heads).count == receipt.heads.count, acknowledged.insert(receipt.operationId).inserted else { throw APIError.invalidResponse }
            if receipt.deleted {
                var object = next.objects[operation.objectId] ?? CloudAgentObject(kind:operation.kind)
                object.deleted = true; object.heads = receipt.heads
                for key in object.versions.keys { object.versions[key]?.value = nil; let erased = object.versions[key]?.deleted == false; object.versions[key]?.erased = erased }
                next.objects[operation.objectId] = object
                next.outbox.removeAll(where:{$0.objectId == operation.objectId})
            }
        }
        next.outbox.removeAll(where:{acknowledged.contains($0.operationId)})
        return next // Cursor advances only after the corresponding change page is durably applied.
    }
}
