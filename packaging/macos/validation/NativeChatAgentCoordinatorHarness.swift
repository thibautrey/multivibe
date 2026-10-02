import Foundation
struct NativeChatMessage: Codable { let id: UUID; let role: String; let content: String; let interrupted: Bool }
struct NativeChatConversation: Codable { let id: UUID; let title: String; let model: String; let messages: [NativeChatMessage] }
@MainActor private final class CoordinatorFixture {
    var saved: NativeCloudCredential? = .init(accessToken: "access", refreshToken: "refresh", expiresAt: .distantFuture, accountID: "account-a")
    var requests: [URLRequest] = []
    var failWrite = false
    var runBodies: [String: [String: Any]] = [:]
    var runState = "awaiting_resolution"
    var runResults: [String: [String: Any]] = [:]
    var changes: [[String: Any]] = []
    var pauseWrite = false
    var mutationCursor = 1
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
            var remoteRun: [String: Any] = ["runId": id, "sessionId": run["sessionId"]!, "branchId": run["branchId"]!, "state": req.url!.path.hasSuffix("cancel") ? "cancelled" : runState, "generation": 1]
            if let result = runResults[id] { remoteRun["result"] = result }
            payload["run"] = remoteRun
        }
        if req.url!.path.hasSuffix("mutations") {
            if failWrite { throw URLError(.notConnectedToInternet) }
            if pauseWrite { await withCheckedContinuation { pending = $0 } }
            let body = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: Any]
            let ops = body["operations"] as! [[String: Any]]
            payload["receipts"] = ops.map { ["operationId": $0["operationId"]!, "versionId": $0["versionId"]!, "cursor": mutationCursor, "heads": [$0["versionId"]!], "deleted": false] }
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
        let objectID = conversation.id.uuidString.lowercased(), billingProject = UUID().uuidString.lowercased()
        let base: [String: Any] = ["operationId": UUID().uuidString.lowercased(), "objectId": objectID, "versionId": UUID().uuidString.lowercased(), "deviceId": UUID().uuidString.lowercased(), "kind": "session", "parents": [], "deleted": false, "erased": false, "cursor": 1, "value": ["title": "Synced", "projectId": billingProject]]
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
        precondition(f.runBodies[run.runId]?["projectId"] as? String == billingProject)
        precondition(f.runBodies[run.runId]?["workspaceProjectId"] == nil)
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
        // A remote task carries full hidden tool history; discovery performs only GET.
        let remoteKey = remoteID.uuidString.lowercased(), branch = UUID().uuidString.lowercased(), remoteRunID = UUID().uuidString.lowercased()
        let history: [[String: Any]] = [["role": "user", "content": "Remote question"], ["role": "assistant", "content": "", "tool_calls": [["id": "call-1", "type": "function", "function": ["name": "terminal", "arguments": "{}"]]]], ["role": "tool", "tool_call_id": "call-1", "content": "hidden output"], ["role": "assistant", "content": "Remote answer"]]
        var updatedSession = remote; updatedSession["parents"] = [remote["versionId"]!]; updatedSession["versionId"] = UUID().uuidString.lowercased(); updatedSession["cursor"] = 3
        updatedSession["value"] = ["title": "Remote", "branchId": branch, "messages": []]
        var task = base; task["kind"] = "task"; task["objectId"] = remoteRunID; task["versionId"] = UUID().uuidString.lowercased(); task["cursor"] = 4
        task["value"] = ["type": "hermes_run", "runId": remoteRunID, "sessionId": remoteKey, "branchId": branch]
        f.runBodies[remoteRunID] = ["sessionId": remoteKey, "branchId": branch]; f.runResults[remoteRunID] = ["history": history, "response": "Remote answer"]; f.runState = "completed"
        f.changes = [updatedSession, task]
        let beforeSync = f.requests.count
        try await orderedReload.synchronize()
        precondition(f.requests.dropFirst(beforeSync).allSatisfy { $0.httpMethod == "GET" })
        precondition(orderedReload.synchronizedMessages(remoteID).map(\.content) == ["Remote question", "", "Remote answer"])
        let continued = try await orderedReload.execute(modelID: "cloud-model", source: .cloud, conversationID: remoteID, message: "Continue")
        precondition(f.runBodies[continued.runId]?["branchId"] as? String == branch)
        precondition((f.runBodies[continued.runId]?["history"] as? [[String: Any]])?.count == 4)
        let localID = UUID().uuidString.lowercased()
        var local = base; local["objectId"] = localID; local["kind"] = "message"; local["cursor"] = 5; local["versionId"] = UUID().uuidString.lowercased()
        local["value"] = ["type": "hermes_local_turn", "sessionId": remoteKey, "branchId": branch, "history": [["role": "user", "content": "Offline"], ["role": "assistant", "content": "Local answer"]]]
        f.changes = [local]; try await orderedReload.synchronize()
        precondition(orderedReload.synchronizedMessages(remoteID).last?.content == "Local answer")
        let syncReload = NativeChatAgentCoordinator(session: session, client: client, root: folder); await syncReload.restore()
        precondition(syncReload.synchronizedMessages(remoteID).last?.content == "Local answer")
        var conflict = updatedSession; conflict["parents"] = []; conflict["versionId"] = UUID().uuidString.lowercased(); conflict["cursor"] = 6
        f.changes = [conflict]; try await syncReload.synchronize()
        precondition(syncReload.synchronizedMessages(remoteID).isEmpty)
        do { _ = try await syncReload.execute(modelID: "cloud-model", source: .cloud, conversationID: remoteID, message: "Must refuse"); preconditionFailure("conflict executed") } catch {}
        let projectID = UUID().uuidString.lowercased()
        var project = base; project["objectId"] = projectID; project["kind"] = "project"; project["versionId"] = UUID().uuidString.lowercased(); project["cursor"] = 7; project["value"] = ["name": "Selected workspace"]
        f.changes = [project]; try await syncReload.synchronize()
        precondition(syncReload.cloudProjects.map(\.id) == [projectID])
        try syncReload.selectWorkspaceProject(projectID, conversation: conversation.id)
        let projectReload = NativeChatAgentCoordinator(session: session, client: client, root: folder); await projectReload.restore()
        precondition(projectReload.selectedWorkspaceProject(conversation.id) == projectID)
        f.mutationCursor = 8
        let projectRun = try await projectReload.execute(modelID: "cloud-model", source: .cloud, conversationID: conversation.id, message: "Use selected files")
        precondition(f.runBodies[projectRun.runId]?["workspaceProjectId"] as? String == projectID)
        precondition(f.runBodies[projectRun.runId]?["projectId"] as? String == billingProject) // Preserve billing independently of selected workspace.
        precondition(projectID != billingProject)
        let mutationBody = try JSONSerialization.jsonObject(with: f.requests.last { $0.url!.path.hasSuffix("mutations") }!.httpBody!) as! [String: Any]
        var propagated = (mutationBody["operations"] as! [[String: Any]])[0]
        let propagatedValue = propagated["value"] as! [String: Any]
        precondition(propagatedValue["workspaceProjectId"] as? String == projectID && propagatedValue["title"] as? String == "Synced")
        precondition(propagated["parents"] as? [String] == [base["versionId"] as! String])
        propagated["cursor"] = 8; propagated["erased"] = false
        f.changes = [base, project, propagated]
        let otherClient = NativeChatAgentCoordinator(session: session, client: client, root: folder.appendingPathComponent("other-client"))
        await otherClient.restore(); try await otherClient.synchronize()
        precondition(otherClient.selectedWorkspaceProject(conversation.id) == projectID)
        var projectConflict = project; projectConflict["versionId"] = UUID().uuidString.lowercased(); projectConflict["cursor"] = 9
        f.changes = [projectConflict]; try await projectReload.synchronize()
        precondition(projectReload.cloudProjects.isEmpty)
        do { _ = try await projectReload.execute(modelID: "cloud-model", source: .cloud, conversationID: conversation.id, message: "Reject ambiguous workspace"); preconditionFailure("conflicted project executed") } catch {}
        try projectReload.selectWorkspaceProject("", conversation: conversation.id)
        precondition(projectReload.selectedWorkspaceProject(conversation.id).isEmpty)
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
