import Foundation

@MainActor private final class AgentFixture {
    var account: String? = "account-a"
    var responseAccount = "account-a"
    var requests: [URLRequest] = []
    var redirected = false
    var oversized = false
    var pause = false
    var pending: CheckedContinuation<Void, Never>?
    let id = "11111111-1111-4111-8111-111111111111"
    lazy var client = NativeAgentClient(token: { "cloud-bearer" }, account: { self.account }, transport: { try await self.respond($0) })
    func respond(_ request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        if pause { await withCheckedContinuation { pending = $0 } }
        let payload: [String: Any]
        if request.url!.path.contains("/runs") {
            payload = ["accountId": responseAccount, "run": ["runId": id, "sessionId": id, "branchId": id, "state": request.url!.path.hasSuffix("cancel") ? "cancelled" : "queued", "generation": 1]]
        } else if request.url!.path.hasSuffix("mutations") {
            payload = ["accountId": responseAccount, "receipts": [["operationId": id, "versionId": id, "cursor": 1, "heads": [id], "deleted": false]]]
        } else { payload = ["accountId": responseAccount, "cloudEnabled": false, "exportSources": [], "revision": 0] }
        let url = redirected ? URL(string: "https://other.example/")! : request.url!
        return (oversized ? Data(repeating: 32, count: NativeAgentClient.responseLimit + 1) : try JSONSerialization.data(withJSONObject: payload), HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!)
    }
    func release() { pending?.resume(); pending = nil }
}

@main struct NativeAgentClientChecks {
    @MainActor static func main() async throws {
        let fixture = AgentFixture()
        _ = try await fixture.client.consent(accountID: "account-a")
        precondition(fixture.requests[0].value(forHTTPHeaderField: "Authorization") == "Bearer cloud-bearer")
        precondition(fixture.requests[0].value(forHTTPHeaderField: "Cookie") == nil)
        do { _ = try await fixture.client.consent(accountID: "account-b"); fatalError("Wrong account sent") } catch NativeAgentClientError.accountMismatch {}
        precondition(fixture.requests.count == 1)
        fixture.responseAccount = "account-b"
        do { _ = try await fixture.client.consent(accountID: "account-a"); fatalError("Wrong account accepted") } catch NativeAgentClientError.accountMismatch {}
        fixture.responseAccount = "account-a"; fixture.redirected = true
        do { _ = try await fixture.client.consent(accountID: "account-a"); fatalError("Redirect accepted") } catch NativeAgentClientError.invalidResponse {}
        fixture.redirected = false
        fixture.oversized = true
        do { _ = try await fixture.client.consent(accountID: "account-a"); fatalError("Oversized response accepted") } catch NativeAgentClientError.tooLarge {}
        fixture.oversized = false
        let countBeforeOversized = fixture.requests.count
        let oversizedOp = NativeAgentMutation(operationId: fixture.id, objectId: fixture.id, versionId: fixture.id, deviceId: fixture.id, kind: .memory, parents: [], deleted: false, value: .string(String(repeating: "x", count: 131_073)))
        do { _ = try await fixture.client.mutate(accountID: "account-a", operations: [oversizedOp]); fatalError("Oversized mutation sent") } catch NativeAgentClientError.tooLarge {}
        precondition(fixture.requests.count == countBeforeOversized)
        let op = NativeAgentMutation(operationId: fixture.id, objectId: fixture.id, versionId: fixture.id, deviceId: fixture.id, kind: .session, parents: [], deleted: false, value: .object(["name": .string("test")]))
        _ = try await fixture.client.mutate(accountID: "account-a", operations: [op])
        let first = fixture.requests.last!.httpBody
        _ = try await fixture.client.mutate(accountID: "account-a", operations: [op])
        precondition(first == fixture.requests.last!.httpBody)
        let run = NativeAgentRunInput(operationId: fixture.id, runId: fixture.id, sessionId: fixture.id, branchId: fixture.id, projectId: nil, model: .init(id: "model", accessId: nil, source: .cloud, deviceId: nil), message: "hello", history: nil)
        _ = try await fixture.client.createRun(accountID: "account-a", run: run)
        let firstRun = fixture.requests.last!.httpBody
        _ = try await fixture.client.createRun(accountID: "account-a", run: run)
        precondition(firstRun == fixture.requests.last!.httpBody)
        _ = try await fixture.client.readRun(accountID: "account-a", runID: fixture.id)
        let cancelled = try await fixture.client.cancelRun(accountID: "account-a", runID: fixture.id)
        precondition(cancelled.state == .cancelled)
        fixture.pause = true
        let late = Task { try await fixture.client.consent(accountID: "account-a") }
        for _ in 0..<1000 where fixture.pending == nil { await Task.yield() }
        precondition(fixture.pending != nil)
        fixture.account = "account-b"; fixture.release()
        do { _ = try await late.value; fatalError("Late account response accepted") } catch NativeAgentClientError.accountMismatch {}
        fixture.account = "account-a"
        let cancel = Task { try await fixture.client.consent(accountID: "account-a") }
        for _ in 0..<1000 where fixture.pending == nil { await Task.yield() }
        precondition(fixture.pending != nil)
        cancel.cancel(); fixture.release()
        do { _ = try await cancel.value; fatalError("Cancelled response accepted") } catch is CancellationError {}
        precondition(fixture.requests.allSatisfy { $0.url!.host == "app.multivibe.cloud" && $0.url!.path.hasPrefix("/native/v2/agent/") && !$0.httpShouldHandleCookies })
        print("NativeAgentClient: account fences, redirected responses, cancellation, fixed auth and durable retry payloads passed")
    }
}
