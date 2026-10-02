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
        do { _ = try await reopened.completedMessages(context,engine:"pinned"); throw NSError(domain:"Unknown effect exported",code:1) }
        catch HermesCheckpointError.indeterminate {}
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
        let exported = try await relaunch.completedMessages(context,engine:"pinned")
        try expect(exported == result,"Completed checkpoint export must retain tool history")
        let otherExport = try await relaunch.completedMessages(otherContext,engine:"pinned")
        try expect(otherExport == nil,"Checkpoint export crossed account")
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
        let compactContext = HermesRunContext(accountID: "compact-account", conversationID: UUID(), turnID: UUID(), modelID: "local-model")
        let compactLease = try await store.begin(compactContext, engine: "pinned")
        let prefix = [["role":"user","content":"old fact"],["role":"assistant","content":"old answer"]]
        let canonical = prefix + [["role":"user","content":"new question"]]
        let prefixJSON = String(decoding:try JSONSerialization.data(withJSONObject:prefix),as:UTF8.self)
        let fullJSON = String(decoding:try JSONSerialization.data(withJSONObject:canonical),as:UTF8.self)
        let compact: [String:Any] = ["version":1,"coveredCount":2,"prefixJSON":prefixJSON,"summary":"An old fact and answer."]
        func encoded(_ value:[String:Any]) throws -> String {
            String(decoding:try JSONSerialization.data(withJSONObject:["compaction":value]),as:UTF8.self)
        }
        try await store.save(compactLease,engine:"pinned",messages:fullJSON,state:encoded(compact))
        for (key,value) in [("version",true as Any),("coveredCount",3 as Any),("coveredCount",1.5 as Any),("prefixJSON","[]" as Any),("summary","" as Any)] {
            var malformed=compact;malformed[key]=value
            do { try await store.save(compactLease,engine:"pinned",messages:fullJSON,state:encoded(malformed));throw NSError(domain:"Invalid compaction accepted",code:1) }
            catch HermesCheckpointError.invalid {}
        }
        let completeTools = (try JSONSerialization.jsonObject(with:Data(result.utf8)) as! [[String:Any]]) + [["role":"user","content":"next"]]
        let splitPrefix = Array(completeTools.prefix(2))
        var split=compact
        split["prefixJSON"]=String(decoding:try JSONSerialization.data(withJSONObject:splitPrefix),as:UTF8.self)
        do {
            try await store.save(compactLease,engine:"pinned",messages:String(decoding:try JSONSerialization.data(withJSONObject:completeTools),as:UTF8.self),state:encoded(split))
            throw NSError(domain:"Compaction split a tool result",code:1)
        } catch HermesCheckpointError.invalid {}
        let compactResume = try await HermesCheckpointStore(root:root).begin(compactContext,engine:"pinned")
        try expect(compactResume.resumeJSON?.contains("old fact") == true && compactResume.resumeJSON?.contains("An old fact and answer.") == true,"Compaction must preserve canonical transcript and durable summary")
        print("HermesCheckpointStore: reopen, unknown effect, isolation, fencing, failure, resolution and deletion checks passed")
    }
}
