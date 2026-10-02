import Foundation
import CryptoKit

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
struct CloudWorkspaceArtifact: Codable, Equatable, Sendable {
    let id: String
    let projectId: String
    let path: String
    let artifactId: String
    let byteLength: Int
    let sha256: String

    func validated() throws -> Self {
        try CloudAgentState.validateWorkspacePath(path)
        guard CloudAgentState.uuid(projectId), CloudAgentState.uuid(artifactId),
            id == CloudAgentState.workspaceFileID(projectId:projectId,path:path),
            (0...64*1024*1024).contains(byteLength), sha256.utf8.count == 64,
            sha256.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
        else { throw APIError.server(400,"invalid_workspace_artifact") }
        return self
    }
}
/// Account-owned graph/outbox only. It contains no execution requests or SDK encrypted conversations.
struct CloudAgentState: Codable, Equatable, Sendable {
    let accountId: String; let deviceId: String
    var cursor: Int64 = 0
    var objects: [String:CloudAgentObject] = [:]
    var outbox: [CloudAgentMutation] = []
    // Local-only authorization provenance. Never included in mutations sent to the server.
    var memoryWriteScopes: [String: String]? = nil
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
        next.memoryWriteScopes = next.memoryWriteScopes?.filter { id, _ in next.outbox.contains(where: { $0.operationId == id }) }
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
    func anchoredHistory(_ anchor: HistoryJSON, sessionId: String, account: String, runs: [String:CloudHermesRun]) throws -> [HistoryJSON] {
        guard account == accountId, Self.uuid(sessionId), let a=anchor.object,
            a["type"]?.string == "hermes_history_anchor", let source=a["source"]?.string,
            let branch=a["sourceBranchId"]?.string, Self.uuid(branch) else { throw APIError.invalidResponse }
        let history:[HistoryJSON]
        if source == "run" {
            guard Set(a.keys) == ["type","source","sourceBranchId","runId"],
                let runId=a["runId"]?.string,Self.uuid(runId),let run=runs[runId],
                run.runId == runId,run.sessionId == sessionId,run.branchId == branch,run.state == "completed",let result=run.result
            else { throw APIError.server(409,"hermes_history_anchor_unavailable") }
            history=result.history
        } else if source == "message" {
            guard Set(a.keys) == ["type","source","sourceBranchId","objectId","versionId"],
                let id=a["objectId"]?.string,Self.uuid(id),let version=a["versionId"]?.string,Self.uuid(version),
                let object=objects[id],object.kind == "message",!object.deleted,
                let change=object.versions[version],!change.deleted,!change.erased,
                let value=change.value?.object,value["type"]?.string == "hermes_local_turn",
                value["sessionId"]?.string == sessionId,value["branchId"]?.string == branch,value["turnId"]?.string == id,
                let saved=value["history"]?.array else { throw APIError.server(409,"hermes_history_anchor_unavailable") }
            history=saved
        } else { throw APIError.invalidResponse }
        try RemoteHermesSession.validateHistory(history)
        return history
    }
    func anchoredResolution(objectId:String, reviewedHeads:[String], selectedHead:String, account:String, anchor:HistoryJSON, runs:[String:CloudHermesRun]) throws -> CloudAgentMutation {
        guard account == accountId,let object=objects[objectId],object.kind == "session",!object.deleted,
            object.heads.count>1,Set(reviewedHeads)==Set(object.heads),reviewedHeads.count==object.heads.count,
            reviewedHeads.contains(selectedHead),var value=object.versions[selectedHead]?.value?.object,
            value["branchId"]?.string == anchor.object?["sourceBranchId"]?.string,
            !outbox.contains(where:{$0.objectId == objectId || $0.value?.object?["sessionId"]?.string == objectId}),
            object.heads.allSatisfy({object.versions[$0]?.value != nil && object.versions[$0]?.erased == false})
        else { throw APIError.server(409,"agent_resolution_review_stale_or_unavailable") }
        _ = try anchoredHistory(anchor,sessionId:objectId,account:account,runs:runs)
        value["branchId"] = .string(UUID().uuidString.lowercased())
        value["localTurnId"]=nil;value["messages"]=nil;value["historyAnchor"]=anchor
        return .init(operationId:UUID().uuidString.lowercased(),objectId:objectId,versionId:UUID().uuidString.lowercased(),deviceId:deviceId,
            kind:"session",parents:reviewedHeads.sorted(),deleted:false,value:.object(value))
    }
    static func workspaceFileID(projectId:String,path:String) -> String {
        var bytes=Array(SHA256.hash(data:Data(("multivibe-workspace-v1\0"+projectId+":"+path).utf8)).prefix(16))
        bytes[6]=(bytes[6]&15)|0x50;bytes[8]=(bytes[8]&63)|0x80
        let hex=bytes.map{String(format:"%02x",$0)}.joined()
        let chars=Array(hex)
        return [String(chars[0..<8]),String(chars[8..<12]),String(chars[12..<16]),String(chars[16..<20]),String(chars[20..<32])].joined(separator:"-")
    }
    static func validateWorkspacePath(_ path:String) throws {
        let segments=path.split(separator:"/",omittingEmptySubsequences:false)
        guard path.utf16.count<=512,segments.count<=10,!segments.contains(where:{$0.isEmpty || $0=="." || $0==".."}),
            !path.unicodeScalars.contains(where:{$0.value<32 || $0.value==127 || $0.value==92})
        else { throw APIError.server(400,"invalid_workspace_file") }
    }
    static func validateWorkspaceText(path:String,content:String) throws {
        try validateWorkspacePath(path)
        guard !content.utf8.contains(0),content.utf8.count<=65536 else { throw APIError.server(400,"invalid_workspace_file") }
    }
    func workspaceProject(_ id:String) throws -> CloudAgentObject {
        guard Self.uuid(id),let object=objects[id],["project","session"].contains(object.kind),!object.deleted,object.heads.count==1,
            let head=object.versions[object.heads[0]],head.value != nil,!head.deleted,!head.erased,
            !outbox.contains(where:{$0.objectId==id}) else { throw APIError.server(409,"workspace_project_unavailable") }
        return object
    }
    func workspaceMutation(projectId:String,objectId:String,path:String,content:String,parents:[String],projectParents:[String],delete:Bool) throws -> CloudAgentMutation {
        try Self.validateWorkspaceText(path:path,content:content)
        return try workspaceFileMutation(projectId:projectId,objectId:objectId,path:path,
            replacement:["type":.string("hermes_workspace_file"),"content":.string(content)],parents:parents,projectParents:projectParents,delete:delete)
    }
    func workspaceArtifactMutation(projectId:String,objectId:String,path:String,artifact:CloudWorkspaceArtifact,parents:[String],projectParents:[String]) throws -> CloudAgentMutation {
        _ = try artifact.validated()
        guard artifact.projectId==projectId,artifact.path==path else { throw APIError.server(409,"workspace_path_changed") }
        return try workspaceFileMutation(projectId:projectId,objectId:objectId,path:path,
            replacement:["type":.string("hermes_artifact_file"),"artifactId":.string(artifact.artifactId),"byteLength":.number(Double(artifact.byteLength)),"sha256":.string(artifact.sha256)],
            parents:parents,projectParents:projectParents,delete:false)
    }
    private static func workspaceFileSize(id:String,projectId:String,value:[String:HistoryJSON]) throws -> (text:Int,binary:Int) {
        guard value["projectId"]?.string==projectId,let path=value["path"]?.string,
            Self.workspaceFileID(projectId:projectId,path:path)==id else { throw APIError.invalidResponse }
        if value["type"]?.string=="hermes_workspace_file" {
            guard let content=value["content"]?.string else { throw APIError.invalidResponse }
            try validateWorkspaceText(path:path,content:content)
            return (content.utf8.count,0)
        }
        guard value["type"]?.string=="hermes_artifact_file",let artifactId=value["artifactId"]?.string,
            let size=value["byteLength"]?.number,size.isFinite,size>=0,size<=Double(64*1024*1024),size.rounded(.towardZero)==size,
            let hash=value["sha256"]?.string else { throw APIError.invalidResponse }
        let artifact=CloudWorkspaceArtifact(id:id,projectId:projectId,path:path,artifactId:artifactId,byteLength:Int(size),sha256:hash)
        _ = try artifact.validated()
        return (0,artifact.byteLength)
    }
    private func workspaceFileMutation(projectId:String,objectId:String,path:String,replacement:[String:HistoryJSON],parents:[String],projectParents:[String],delete:Bool) throws -> CloudAgentMutation {
        try Self.validateWorkspacePath(path)
        let project=try workspaceProject(projectId)
        guard project.heads==projectParents else { throw APIError.server(409,"workspace_project_changed") }
        let id=Self.workspaceFileID(projectId:projectId,path:path)
        guard objectId.isEmpty || objectId==id else { throw APIError.server(409,"workspace_path_changed") }
        var value:[String:HistoryJSON]=[:]
        if let object=objects[id] {
            guard !object.deleted,object.kind=="file",object.heads.count==1,object.heads==parents,
                let head=object.versions[object.heads[0]],!head.deleted,!head.erased,
                let existing=head.value?.object,["hermes_workspace_file","hermes_artifact_file"].contains(existing["type"]?.string ?? ""),
                existing["projectId"]?.string==projectId,existing["path"]?.string==path else { throw APIError.server(409,"workspace_file_changed_or_deleted") }
            value=existing
        } else {
            guard parents.isEmpty,!delete else { throw APIError.server(409,"workspace_file_missing") }
        }
        // Retain custom metadata while removing fields that belong to the previous representation.
        for key in ["content","artifactId","byteLength","sha256","mediaType"] { value[key]=nil }
        for (key,item) in replacement { value[key]=item }
        value["projectId"] = .string(projectId);value["path"] = .string(path)
        let payload:HistoryJSON? = delete ? nil : .object(value)
        let pending=outbox.first(where:{$0.objectId==id})
        if let pending {
            guard pending.kind=="file",pending.parents==parents,pending.deleted==delete,pending.value==payload else { throw APIError.server(409,"workspace_file_pending") }
        }
        var files:[String:[String:HistoryJSON]]=[:]
        for (key,object) in objects where object.kind=="file" && !object.deleted {
            let related=object.versions.values.contains { version in
                guard let raw=version.value?.object else { return false }
                return ["hermes_workspace_file","hermes_artifact_file"].contains(raw["type"]?.string ?? "") && raw["projectId"]?.string==projectId
            }
            if !related { continue }
            guard object.heads.count==1,let head=object.versions[object.heads[0]],!head.deleted,!head.erased,
                let raw=head.value?.object,raw["projectId"]?.string==projectId else { throw APIError.server(409,"workspace_file_conflicted") }
            _ = try Self.workspaceFileSize(id:key,projectId:projectId,value:raw)
            files[key]=raw
        }
        for operation in outbox where operation.kind=="file" {
            try Self.validate(operation)
            if operation.deleted { files[operation.objectId]=nil;continue }
            guard let raw=operation.value?.object,raw["projectId"]?.string==projectId else { continue }
            _ = try Self.workspaceFileSize(id:operation.objectId,projectId:projectId,value:raw)
            files[operation.objectId]=raw
        }
        if delete { files[id]=nil } else { files[id]=value }
        guard files.count<=200 else { throw APIError.server(413,"workspace_file_limit") }
        var textBytes=0,binaryBytes=0
        for (fileId,raw) in files {
            let size=try Self.workspaceFileSize(id:fileId,projectId:projectId,value:raw)
            textBytes += size.text;binaryBytes += size.binary
        }
        guard textBytes<=512*1024 else { throw APIError.server(413,"workspace_size_limit") }
        guard binaryBytes<=256*1024*1024 else { throw APIError.server(413,"workspace_artifact_size_limit") }
        if let pending { return pending }
        let operation=CloudAgentMutation(operationId:UUID().uuidString.lowercased(),objectId:id,versionId:UUID().uuidString.lowercased(),deviceId:deviceId,kind:"file",parents:parents,deleted:delete,value:payload)
        try Self.validate(operation)
        return operation
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
        next.memoryWriteScopes = next.memoryWriteScopes?.filter { id, _ in next.outbox.contains(where: { $0.operationId == id }) }
        return next // Cursor advances only after the corresponding change page is durably applied.
    }
}
