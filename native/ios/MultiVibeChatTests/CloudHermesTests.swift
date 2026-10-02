import XCTest
@testable import MultiVibeChat

final class CloudHermesTests: XCTestCase {
    func testCloudAndRelaySelectionsNeverSilentlyFallBack() throws {
        let cloud = try CloudHermesModel.selected("vendor/model", access:.init(id:"cloud",modelId:"vendor/model",label:"Cloud",method:"cloud"))
        XCTAssertEqual(cloud.id,"multivibe/cloud/vendor/model")
        XCTAssertEqual(cloud.source,"cloud"); XCTAssertNil(cloud.accessId)
        let connection = UUID().uuidString.lowercased()
        let relay = try CloudHermesModel.selected("vendor/model", access:.init(id:connection,modelId:"vendor/model",label:"Mine",method:"api_key"))
        XCTAssertEqual(relay.id,"vendor/model"); XCTAssertEqual(relay.source,"relay"); XCTAssertEqual(relay.accessId,connection)
        let machine = "relay/\(UUID().uuidString.lowercased())/vendor/model"
        XCTAssertEqual(try CloudHermesModel.selected(machine,access:nil).id,machine)
        XCTAssertThrowsError(try CloudHermesModel.selected("vendor/model",access:nil))
        XCTAssertThrowsError(try CloudHermesModel.selected("other",access:.init(id:"cloud",modelId:"vendor/model",label:"Cloud",method:"cloud")))
    }
    func testRunReplyCannotCrossAccountOrRunBoundary() throws {
        let account = UUID().uuidString.lowercased(), runID = UUID().uuidString.lowercased()
        let run = CloudHermesRun(runId:runID,sessionId:UUID().uuidString.lowercased(),branchId:UUID().uuidString.lowercased(),state:"awaiting_resolution",generation:2,result:nil)
        let reply = CloudHermesRunReply(accountId:account,run:run)
        XCTAssertEqual(try reply.checked(accountId:account,runId:runID).state,"awaiting_resolution")
        XCTAssertThrowsError(try reply.checked(accountId:UUID().uuidString.lowercased(),runId:runID))
        XCTAssertThrowsError(try reply.checked(accountId:account,runId:UUID().uuidString.lowercased()))
    }
    func testPersistentPendingRunPreservesOperationAndHiddenToolHistory() throws {
        let id = { UUID().uuidString.lowercased() }
        var binding = CloudHermesBinding(accountId:id(),conversationId:id(),sessionId:id(),branchId:id(),operationId:id(),versionId:id(),deviceId:id(),importApproved:false)
        let hidden: HistoryJSON = .object(["role":.string("tool"),"tool_call_id":.string("call"),"content":.string("real output")])
        binding.history = [hidden]
        binding.pending = CloudHermesRunInput(operationId:id(),runId:id(),sessionId:binding.sessionId,branchId:binding.branchId,model:.init(id:"model",source:"cloud",accessId:nil),message:"next",history:binding.history)
        binding.turnId = UUID()
        let restored = try JSONDecoder().decode(CloudHermesBinding.self,from:JSONEncoder().encode(binding))
        XCTAssertEqual(restored.pending,binding.pending)
        XCTAssertEqual(restored.history,[hidden]); XCTAssertEqual(restored.turnId,binding.turnId)
        XCTAssertFalse(restored.importApproved)
    }
    func testLocalPublicationRequiresSourceConsentAndKeepsCloudToolHistoryAndParents() throws {
        let id = { UUID().uuidString.lowercased() }
        var binding = CloudHermesBinding(accountId:id(),conversationId:id(),sessionId:id(),branchId:id(),operationId:id(),versionId:id(),deviceId:id(),importApproved:true)
        let parent = id(), turn = UUID()
        let oldTool: HistoryJSON = .object(["role":.string("tool"),"content":.string("Cloud private result")])
        binding.history = [oldTool]
        binding.recordLocalIntent(turnId:turn,modelId:"downloaded",source:"downloaded-local",parents:[parent])
        let captured = binding.localTurns![0]
        let checkpoint: [HistoryJSON] = [.object(["role":.string("system"),"content":.string("local context")]),.object(["role":.string("user"),"content":.string("local request")]),.object(["role":.string("tool"),"content":.string("local private result")]),.object(["role":.string("assistant"),"content":.string("answer")])]
        XCTAssertThrowsError(try binding.localPublication(index:0,checkpoint:checkpoint))
        binding.localExportSources = ["downloaded-local"]
        let operations = try binding.localPublication(index:0,checkpoint:checkpoint)
        XCTAssertEqual(operations[1].parents,[parent]);XCTAssertEqual(operations[0].operationId,captured.operationId)
        XCTAssertEqual(operations[0].value?.object?["messages"],.array(checkpoint))
        XCTAssertEqual(binding.history,[oldTool]+Array(checkpoint[1...]))
        XCTAssertThrowsError(try binding.localPublication(index:0,checkpoint:checkpoint))
        let restored = try JSONDecoder().decode(CloudHermesBinding.self,from:JSONEncoder().encode(binding))
        XCTAssertEqual(restored.localTurns?[0].operationId,captured.operationId)
        XCTAssertEqual(restored.localTurns?[0].parents,[parent]);XCTAssertEqual(restored.localTurns?[0].published,true)
    }
    func testLocalIntentIsIdempotentAndConcurrentParentsCannotBeAutoMerged() throws {
        let id = { UUID().uuidString.lowercased() }
        var binding = CloudHermesBinding(accountId:id(),conversationId:id(),sessionId:id(),branchId:id(),operationId:id(),versionId:id(),deviceId:id(),importApproved:false)
        binding.localExportSources = ["apple-foundation-local"]
        let turn = UUID()
        binding.recordLocalIntent(turnId:turn,modelId:"local",source:"apple-foundation-local",parents:[id(),id()])
        let operation = binding.localTurns![0].operationId
        binding.recordLocalIntent(turnId:turn,modelId:"local",source:"apple-foundation-local",parents:[])
        XCTAssertEqual(binding.localTurns?.count,1);XCTAssertEqual(binding.localTurns?[0].operationId,operation)
        XCTAssertThrowsError(try binding.localPublication(index:0,checkpoint:[.object(["role":.string("user"),"content":.string("x")])]))
        XCTAssertTrue(binding.history.isEmpty)
    }

}

@MainActor final class CloudHermesRecoveryTests: XCTestCase {
    private func fixture(state: String, beforeRead: @escaping @MainActor (Bool) async -> Void = { _ in }) throws -> (ConversationManager, UUID, () -> [String]) {
        let account = UUID().uuidString.lowercased(), conversationID = UUID(), turnID = UUID(), runID = UUID().uuidString.lowercased()
        let sessionID = UUID().uuidString.lowercased(), branchID = UUID().uuidString.lowercased()
        var conversation = Conversation(id:conversationID,model:"vendor/model",messages:[ChatMessage(id:turnID,role:"user",content:"question"),ChatMessage(role:"assistant",content:"",completion:.stopped)])
        conversation.title = "Preserved title"
        let input = CloudHermesRunInput(operationId:UUID().uuidString.lowercased(),runId:runID,sessionId:sessionID,branchId:branchID,model:.init(id:"vendor/model",source:"cloud",accessId:nil),message:"question",history:[])
        var binding = CloudHermesBinding(accountId:account,conversationId:conversationID.uuidString.lowercased(),sessionId:sessionID,branchId:branchID,operationId:UUID().uuidString.lowercased(),versionId:UUID().uuidString.lowercased(),deviceId:UUID().uuidString.lowercased(),importApproved:false)
        binding.pending = input; binding.turnId = turnID
        let encodedBindings = try JSONSerialization.jsonObject(with:JSONEncoder().encode([conversationID:binding]))
        let encodedConversations = try JSONSerialization.jsonObject(with:JSONEncoder().encode([conversation]))
        let data = try JSONSerialization.data(withJSONObject:["cloudHermesBindings":encodedBindings,"conversations":encodedConversations,"baseline":[],"conversationIDs":[:],"messageIDs":[:]])
        let auth = NativeSession(accessToken:"fixture",refreshToken:"fixture",expiresAt:.distantFuture,accountId:account)
        var calls:[String] = []
        var services = isolatedServices(load:{auth},readLocalHistory:{_ in data})
        services.hermesCreate = {_,_,_ in calls.append("POST");throw APIError.invalidResponse}
        services.hermesEnable = {_,_,_ in calls.append("CONSENT");throw APIError.invalidResponse}
        services.hermesRead = {receivedAccount,receivedRun,_,cancel in
            XCTAssertEqual(receivedAccount,account);XCTAssertEqual(receivedRun,runID)
            calls.append(cancel ? "CANCEL" : "GET")
            await beforeRead(cancel)
            return CloudHermesRun(runId:runID,sessionId:sessionID,branchId:branchID,state:cancel ? "cancelled" : state,generation:2,
                result:state == "completed" ? .init(response:"recovered answer",history:[.object(["role":.string("tool"),"content":.string("preserved hidden result")])]) : nil)
        }
        return (ConversationManager(services:services),conversationID,{calls})
    }
    func testRestoreReadsSameRunAndAppliesCompletedReplyOnceWithoutCreatingOrGrantingConsent() async throws {
        let (manager,id,calls) = try fixture(state:"completed")
        await manager.restore(loadRemoteModels:false);manager.selection = id
        await manager.resumeCloudHermes();await manager.resumeCloudHermes()
        XCTAssertFalse(calls().contains("POST"));XCTAssertFalse(calls().contains("CONSENT"))
        XCTAssertEqual(manager.current?.messages.count,2)
        XCTAssertEqual(manager.current?.messages.last?.content,"recovered answer")
        XCTAssertEqual(manager.current?.messages.last?.completion,.completed)
        XCTAssertEqual(manager.current?.title,"Preserved title")
        XCTAssertFalse(manager.currentCloudHermesPending)
    }
    func testIndeterminateRestoreDoesNotInvokeLocalRecoveryOrReplayAndCanCancel() async throws {
        let (manager,id,calls) = try fixture(state:"awaiting_resolution")
        await manager.restore(loadRemoteModels:false);manager.selection = id
        await manager.resumeCloudHermes()
        XCTAssertTrue(manager.currentCloudHermesPending)
        XCTAssertEqual(manager.currentCloudHermesStatus,"awaiting_resolution")
        XCTAssertNotNil(manager.cloudHermesRecoveryRun);XCTAssertNil(manager.hermesRecovery)
        XCTAssertFalse(calls().contains("POST"))
        await manager.cancelPendingCloudHermes()
        XCTAssertEqual(manager.currentCloudHermesStatus,"cancelled")
        XCTAssertFalse(manager.currentCloudHermesPending);XCTAssertTrue(calls().contains("CANCEL"))
    }
    func testCancellationWinsAgainstLateCompletedRecoveryRead() async throws {
        var pending: CheckedContinuation<Void,Never>?
        let (manager,id,_) = try fixture(state:"completed",beforeRead:{cancel in
            if !cancel { await withCheckedContinuation { pending = $0 } }
        })
        await manager.restore(loadRemoteModels:false);manager.selection = id
        let recovering = Task { await manager.resumeCloudHermes() }
        while pending == nil { await Task.yield() }
        await manager.cancelPendingCloudHermes()
        XCTAssertEqual(manager.currentCloudHermesStatus,"cancelled")
        pending?.resume();await recovering.value
        XCTAssertFalse(manager.currentCloudHermesPending)
        XCTAssertEqual(manager.currentCloudHermesStatus,"cancelled")
        XCTAssertEqual(manager.current?.messages.last?.content,"")
    }

}

@MainActor final class CloudHermesLocalPublicationTests: XCTestCase {
    private func fixture(approved: Bool) throws -> (ConversationManager, () -> [CloudAgentMutation], () -> Int) {
        let id = { UUID().uuidString.lowercased() }
        let account = id(), conversationID = UUID(), turnID = UUID()
        var binding = CloudHermesBinding(accountId:account,conversationId:conversationID.uuidString.lowercased(),sessionId:id(),branchId:id(),operationId:id(),versionId:id(),deviceId:id(),importApproved:true)
        binding.localExportSources = ["downloaded-local"]
        binding.recordLocalIntent(turnId:turnID,modelId:"downloaded-fixture",source:"downloaded-local",parents:[binding.versionId])
        let conversation = Conversation(id:conversationID,model:"downloaded-fixture",messages:[ChatMessage(id:turnID,role:"user",content:"Offline question"),ChatMessage(role:"assistant",content:"Offline answer",completion:.completed)])
        let bindings = try JSONSerialization.jsonObject(with:JSONEncoder().encode([conversationID:binding]))
        let conversations = try JSONSerialization.jsonObject(with:JSONEncoder().encode([conversation]))
        let data = try JSONSerialization.data(withJSONObject:["cloudHermesBindings":bindings,"conversations":conversations,"baseline":[],"conversationIDs":[:],"messageIDs":[:]])
        let auth = NativeSession(accessToken:"fixture",refreshToken:"fixture",expiresAt:.distantFuture,accountId:account)
        var submitted:[CloudAgentMutation] = [], changes:[CloudAgentChange] = [], creates = 0
        var services = isolatedServices(load:{auth},readLocalHistory:{_ in data})
        services.hermesLocalCheckpoint = { context in
            XCTAssertEqual(context.turnID,turnID);XCTAssertEqual(context.accountID,account)
            return #"[{"role":"user","content":"Offline question"},{"role":"assistant","content":"Offline answer"}]"#
        }
        services.hermesConsent = {_ in .init(accountId:account,cloudEnabled:true,revision:1,exportSources:approved ? ["downloaded-local"] : [])}
        services.hermesChanges = { after,_ in .init(accountId:account,changes:changes.filter{$0.cursor > after},cursor:Int64(changes.count),hasMore:false) }
        services.hermesMutations = { received,operations,_ in
            XCTAssertEqual(received,account)
            var receipts:[CloudAgentReceipt] = []
            for operation in operations {
                submitted.append(operation)
                let cursor = Int64(changes.count + 1)
                changes.append(.init(operationId:operation.operationId,objectId:operation.objectId,versionId:operation.versionId,deviceId:operation.deviceId,kind:operation.kind,parents:operation.parents,deleted:false,value:operation.value,cursor:cursor,erased:false))
                receipts.append(.init(operationId:operation.operationId,versionId:operation.versionId,cursor:cursor,heads:[operation.versionId],deleted:false))
            }
            return .init(accountId:account,receipts:receipts)
        }
        services.hermesCreate = {_,_,_ in creates += 1;throw APIError.invalidResponse}
        return (ConversationManager(services:services),{submitted},{creates})
    }
    func testReconnectPublishesCompletedLocalStateExactlyOnceWithoutInference() async throws {
        let (manager,submitted,creates) = try fixture(approved:true)
        await manager.restore(loadRemoteModels:false)
        await manager.synchronizeCloudAgentState()
        for _ in 0..<100 where manager.cloudAgentSyncing { await Task.yield() }
        await manager.synchronizeCloudAgentState()
        XCTAssertEqual(submitted().count,3) // initial session, immutable checkpoint, session revision
        XCTAssertEqual(submitted().filter{$0.kind == "message"}.count,1)
        XCTAssertEqual(creates(),0)
        XCTAssertNil(manager.cloudAgentSyncError)
    }
    func testRevokedSourcePublishesNothingAndCreatesNoRun() async throws {
        let (manager,submitted,creates) = try fixture(approved:false)
        await manager.restore(loadRemoteModels:false)
        await manager.synchronizeCloudAgentState()
        for _ in 0..<100 where manager.cloudAgentSyncing { await Task.yield() }
        XCTAssertTrue(submitted().isEmpty);XCTAssertEqual(creates(),0)
    }
}
