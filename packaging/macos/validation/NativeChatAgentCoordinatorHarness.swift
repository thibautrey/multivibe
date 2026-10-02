import Foundation
struct NativeChatMessage: Codable { let id: UUID; let role: String; let content: String; let interrupted: Bool }
struct NativeChatConversation: Codable { let id: UUID; let title: String; let model: String; let messages: [NativeChatMessage] }
@MainActor private final class CoordinatorFixture {
    var saved: NativeCloudCredential? = .init(accessToken: "access", refreshToken: "refresh", expiresAt: .distantFuture, accountID: "account-a")
    var requests: [URLRequest] = []
    var failWrite = false
    var runBodies: [String: [String: Any]] = [:]
    var runState = "awaiting_resolution"
    var changes: [[String: Any]] = []
    var pauseWrite = false
    var pending: CheckedContinuation<Void, Never>?
    func transport(_ req: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(req)
        var payload: [String: Any] = ["accountId": "account-a"]
        if req.url!.path == "/native/v1/models" { payload = ["object": "list", "data": [["id": "cloud-model", "owned_by": "multivibe"], ["id": "personal/hidden", "owned_by": "you", "source": "personal"]]] }
        if req.url!.path == "/relay/v1/models" { payload = ["data": [["id": "relay/11111111-1111-4111-8111-111111111111/local", "owned_by": "you", "source": "relay", "available": true, "machineName": "Mac"]]] }
        if req.url!.path.hasSuffix("consent") { payload.merge(["cloudEnabled": true, "exportSources": [], "revision": 1]) { _, new in new } }
        if req.url!.path.hasSuffix("changes") { payload.merge(["changes": changes, "cursor": changes.last?["cursor"] ?? 0, "hasMore": false]) { _, v in v } }
        if req.url!.path.contains("/runs") {
            var id = req.url!.lastPathComponent
            if req.url!.path.hasSuffix("/runs") {
                let body = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: Any]
                let run = body["run"] as! [String: Any]; id = run["runId"] as! String; runBodies[id] = run
            }
            if id == "cancel" { id = req.url!.deletingLastPathComponent().lastPathComponent }
            guard let run = runBodies[id] else {
                return (Data(), HTTPURLResponse(url: req.url!, statusCode: 404, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!)
            }
            payload["run"] = ["runId": id, "sessionId": run["sessionId"]!, "branchId": run["branchId"]!, "state": req.url!.path.hasSuffix("cancel") ? "cancelled" : runState, "generation": 1]
        }
        if req.url!.path.hasSuffix("mutations") {
            if failWrite { throw URLError(.notConnectedToInternet) }
            if pauseWrite { await withCheckedContinuation { pending = $0 } }
            let body = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: Any]
            let ops = body["operations"] as! [[String: Any]]
            payload["receipts"] = ops.map { ["operationId": $0["operationId"]!, "versionId": $0["versionId"]!, "cursor": 1, "heads": [$0["versionId"]!], "deleted": false] }
        }
        return (try JSONSerialization.data(withJSONObject: payload), HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!)
    }
}
@main struct CoordinatorChecks {
    @MainActor static func main() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let f = CoordinatorFixture()
        let session = try NativeCloudSession(storage: .init(load: { f.saved }, save: { f.saved = $0 }, clear: { f.saved = nil }), transport: f.transport)
        let client = NativeAgentClient(token: { try await session.token() }, account: { session.accountID }, transport: f.transport)
        let c = NativeChatAgentCoordinator(session: session, client: client, root: folder)
        await c.restore()
        precondition(c.accountID == "account-a" && c.consent != nil)
        try await c.loadModels()
        precondition(c.models.count == 2 && c.models[0].id == "cloud-model" && c.models[1].source == "relay")
        precondition(!f.requests.contains { $0.url!.path.hasSuffix("mutations") })
        let conversation = NativeChatConversation(id: UUID(), title: "Selected", model: "local-model", messages: [.init(id: UUID(), role: "user", content: "Selected history", interrupted: false)])
        f.failWrite = true
        await c.enableCloud(import: [conversation])
        precondition(c.importedConversationIDs.isEmpty && c.error != nil)
        let first = f.requests.last { $0.url!.path.hasSuffix("mutations") }!.httpBody
        let restored = NativeChatAgentCoordinator(session: session, client: client, root: folder)
        await restored.restore()
        f.failWrite = false
        await restored.retryImports()
        precondition(restored.importedConversationIDs.contains(conversation.id))
        precondition(first == f.requests.last { $0.url!.path.hasSuffix("mutations") }!.httpBody)
        let objectID = conversation.id.uuidString.lowercased()
        let base: [String: Any] = ["operationId": UUID().uuidString.lowercased(), "objectId": objectID, "versionId": UUID().uuidString.lowercased(), "deviceId": UUID().uuidString.lowercased(), "kind": "session", "parents": [], "deleted": false, "erased": false, "cursor": 1, "value": ["title": "Synced"]]
        f.changes = [base]
        try await restored.synchronize()
        precondition(restored.cloudObjects[objectID]?.count == 1)
        let remoteID = UUID()
        var remote = base; remote["objectId"] = remoteID.uuidString.lowercased(); remote["versionId"] = UUID().uuidString.lowercased(); remote["cursor"] = 2
        f.changes = [remote]
        try await restored.synchronize()
        precondition(restored.cloudConversations.contains { $0.id == remoteID })
        let freshID = try await restored.newCloudConversation()
        precondition(restored.cloudConversations.contains { $0.id == freshID })
        let run = try await restored.execute(modelID: "cloud-model", source: .cloud, conversationID: conversation.id, message: "New turn")
        precondition(run.state == .awaiting_resolution)
        let createCount = f.requests.filter { $0.url!.path.hasSuffix("/runs") && $0.httpMethod == "POST" }.count
        let runRestored = NativeChatAgentCoordinator(session: session, client: client, root: folder)
        await runRestored.restore()
        let recovered = try await runRestored.poll(runID: run.runId, intervalNanoseconds: 1)
        precondition(recovered.state == .awaiting_resolution)
        precondition(f.requests.filter { $0.url!.path.hasSuffix("/runs") && $0.httpMethod == "POST" }.count == createCount)
        try await runRestored.cancel(runID: run.runId)
        precondition(runRestored.runs[run.runId]?.state == .cancelled)
        let second = try await runRestored.execute(modelID: "cloud-model", source: .cloud, conversationID: freshID, message: "Fresh Cloud turn")
        precondition(runRestored.orderedRuns.map(\.runId) == [run.runId, second.runId])
        let orderedReload = NativeChatAgentCoordinator(session: session, client: client, root: folder)
        await orderedReload.restore()
        precondition(orderedReload.orderedRuns.map(\.runId) == [run.runId, second.runId])
        precondition(orderedReload.cloudConversations.contains { $0.id == remoteID })
        f.pauseWrite = true
        let another = NativeChatConversation(id: UUID(), title: "Another", model: "local-model", messages: [])
        let epoch = restored.loginEpoch
        let late = Task { await restored.enableCloud(import: [another]) }
        for _ in 0..<1000 where f.pending == nil { await Task.yield() }
        precondition(f.pending != nil)
        await restored.disconnect()
        f.pending?.resume(); f.pending = nil
        await late.value
        precondition(restored.loginEpoch != epoch && restored.accountID == nil && restored.importedConversationIDs.isEmpty)
        print("NativeChatAgentCoordinator: explicit import, durable retries, downward sync, Cloud run/restart/poll/cancel, no resolution replay, logout epoch passed")
    }
}
