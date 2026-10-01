import Foundation
struct NativeChatMessage: Codable { let id: UUID; let role: String; let content: String; let interrupted: Bool }
struct NativeChatConversation: Codable { let id: UUID; let title: String; let model: String; let messages: [NativeChatMessage] }
@MainActor private final class CoordinatorFixture {
    var saved: NativeCloudCredential? = .init(accessToken: "access", refreshToken: "refresh", expiresAt: .distantFuture, accountID: "account-a")
    var requests: [URLRequest] = []
    var failWrite = false
    var pauseWrite = false
    var pending: CheckedContinuation<Void, Never>?
    func transport(_ req: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(req)
        var payload: [String: Any] = ["accountId": "account-a"]
        if req.url!.path.hasSuffix("consent") { payload.merge(["cloudEnabled": true, "exportSources": [], "revision": 1]) { _, new in new } }
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
        print("NativeChatAgentCoordinator: explicit import, restart/retry IDs, logout epoch isolation passed")
    }
}
