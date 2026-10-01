// Dependency-free native journal checks. Compile with HermesCheckpointStore.swift.
import Foundation

@main struct CheckpointStoreChecks {
    static func expect(_ value: Bool, _ message: String) throws {
        if !value { throw NSError(domain: "HermesCheckpointChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("hermes-store-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let context = HermesRunContext(accountID: "account-a/../../unsafe", conversationID: UUID(), turnID: UUID(), modelID: "local-model")
        let store = HermesCheckpointStore(root: root)
        let lease = try await store.begin(context, engine: "pinned")
        let user = #"[{"role":"user","content":"Do work"}]"#
        let intent = #"[{"role":"user","content":"Do work"},{"role":"assistant","tool_calls":[{"id":"call-1","function":{"name":"create_document","arguments":"{}"}}]}]"#
        let result = #"[{"role":"user","content":"Do work"},{"role":"assistant","tool_calls":[{"id":"call-1","function":{"name":"create_document","arguments":"{}"}}]},{"role":"tool","tool_call_id":"call-1","content":"Saved"}]"#
        try await store.save(lease, engine: "pinned", messages: user, state: #"{"rounds":1}"#)
        let reopened = HermesCheckpointStore(root: root)
        let resumed = try await reopened.begin(context, engine: "pinned")
        try expect(resumed.generation == 2 && resumed.resumeJSON?.contains("Do work") == true, "Safe model checkpoint must survive reopening")
        do {
            try await store.save(lease, engine: "pinned", messages: user, state: "{}")
            throw NSError(domain: "Stale writer accepted", code: 1)
        } catch HermesCheckpointError.staleGeneration {}
        try await reopened.save(resumed, engine: "pinned", messages: intent, state: "{}")
        let relaunch = HermesCheckpointStore(root: root)
        do {
            _ = try await relaunch.begin(context, engine: "pinned")
            throw NSError(domain: "Unknown effect was resumed", code: 1)
        } catch HermesCheckpointError.indeterminate(let calls) { try expect(calls.count == 1 && calls[0].name == "create_document", "Missing intent") }
        let otherContext = HermesRunContext(accountID: "account-b", conversationID: context.conversationID, turnID: context.turnID, modelID: context.modelID)
        let other = try await relaunch.begin(otherContext, engine: "pinned")
        try expect(other.resumeJSON == nil, "Account switch leaked checkpoint")
        let anonymous = HermesRunContext(accountID: nil, conversationID: context.conversationID, turnID: context.turnID, modelID: context.modelID)
        let guest = try await relaunch.begin(anonymous, engine: "pinned")
        try expect(guest.resumeJSON == nil && anonymous.scope != context.scope, "Anonymous scope leaked checkpoint")
        try await relaunch.skipIndeterminate(context, engine: "pinned")
        let skipped = try await relaunch.begin(context, engine: "pinned")
        try expect(skipped.resumeJSON?.contains("Execution outcome unknown") == true, "Skip fabricated success")
        try await relaunch.save(skipped, engine: "pinned", messages: result, state: #"{"completed":true,"outputText":"Final answer"}"#)
        let completed = try await HermesCheckpointStore(root: root).begin(context, engine: "pinned")
        try expect(completed.completed && completed.recoveredText == "Final answer", "Completed response not recoverable")
        do {
            _ = try await relaunch.begin(context, engine: "different-engine")
            throw NSError(domain: "Incompatible engine accepted", code: 1)
        } catch HermesCheckpointError.incompatible {}
        let failed = HermesCheckpointStore(root: root.appendingPathComponent("failure"), writeFile: { _, _ in throw CocoaError(.fileWriteOutOfSpace) })
        let failureLease = try await failed.begin(context, engine: "pinned")
        do {
            try await failed.save(failureLease, engine: "pinned", messages: intent, state: "{}")
            throw NSError(domain: "Persistence failure hidden", code: 1)
        } catch let error as CocoaError { try expect(error.code == .fileWriteOutOfSpace, "Wrong failure") }
        await relaunch.invalidateAccount(context.accountID)
        do {
            try await relaunch.save(skipped, engine: "pinned", messages: result, state: "{}")
            throw NSError(domain: "Invalidated account writer accepted", code: 1)
        } catch HermesCheckpointError.staleGeneration {}
        try await relaunch.deleteConversation(accountID: context.accountID, conversationID: context.conversationID)
        let deleted = try await relaunch.begin(context, engine: "pinned")
        try expect(deleted.resumeJSON == nil, "Deleted conversation retained journal")
        print("HermesCheckpointStore: reopen, unknown effect, isolation, fencing, failure, resolution and deletion checks passed")
    }
}
