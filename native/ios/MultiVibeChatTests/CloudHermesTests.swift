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
        binding.recordLocalIntent(turnId:turn,modelId:"downloaded",source:"downloaded-local",parents:[parent],parentValue:.object(["branchId":.string(binding.branchId)]))
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
    func testOfflinePublicationPreservesCapturedWorkspaceBillingAndCustomMetadata() throws {
        let id={UUID().uuidString.lowercased()}
        var binding=CloudHermesBinding(accountId:id(),conversationId:id(),sessionId:id(),branchId:id(),operationId:id(),versionId:id(),deviceId:id(),importApproved:true)
        binding.localExportSources=["downloaded-local"]
        let parent=id(), billing=id(), workspace=id()
        let original:HistoryJSON = .object(["type":.string("hermes_session"),"branchId":.string(binding.branchId),"projectId":.string(billing),"workspaceProjectId":.string(workspace),"title":.string("Custom title"),"custom":.object(["value":.number(42)])])
        binding.recordLocalIntent(turnId:UUID(),modelId:"local",source:"downloaded-local",parents:[parent],parentValue:original)
        binding=try JSONDecoder().decode(CloudHermesBinding.self,from:JSONEncoder().encode(binding))
        let operations=try binding.localPublication(index:0,checkpoint:[.object(["role":.string("user"),"content":.string("question")]),.object(["role":.string("assistant"),"content":.string("answer")])])
        XCTAssertEqual(operations[1].parents,[parent])
        for key in ["projectId","workspaceProjectId","title","custom"] { XCTAssertEqual(operations[1].value?.object?[key],original.object?[key]) }
        var missing=binding
        missing.localTurns?[0].published=false;missing.localTurns?[0].parentValue=nil
        XCTAssertThrowsError(try missing.localPublication(index:0,checkpoint:[.object(["role":.string("user"),"content":.string("question")])]))
    }
    func testLocalRevocationRejectsQueuedMutationAndNewTurnUsesCurrentHead() throws {
        let id={UUID().uuidString.lowercased()}
        var binding=CloudHermesBinding(accountId:id(),conversationId:id(),sessionId:id(),branchId:id(),operationId:id(),versionId:id(),deviceId:id(),importApproved:true)
        binding.localExportSources=["downloaded-local"]
        binding.recordLocalIntent(turnId:UUID(),modelId:"local",source:"downloaded-local",parents:[id()],parentValue:.object(["branchId":.string(binding.branchId)]))
        let operations=try binding.localPublication(index:0,checkpoint:[.object(["role":.string("user"),"content":.string("question")]),.object(["role":.string("assistant"),"content":.string("answer")])])
        XCTAssertTrue(operations.allSatisfy(binding.permitsLocalOperation))
        binding.localExportSources=[]
        XCTAssertFalse(operations.contains(where:binding.permitsLocalOperation))
        let current=id()
        binding.recordLocalIntent(turnId:UUID(),modelId:"local",source:"downloaded-local",parents:[current])
        XCTAssertEqual(binding.localTurns?.last?.parents,[current])
        let unpublished=binding.localTurns!.last!.sessionVersionId
        binding.recordLocalIntent(turnId:UUID(),modelId:"local",source:"downloaded-local",parents:[id()])
        XCTAssertEqual(binding.localTurns?.last?.parents,[unpublished])
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

final class RemoteHermesHistoryTests: XCTestCase {
    func testClosedToolIDsMayRepeatAcrossTurnsButUnknownEffectsFail() throws {
        let assistant: HistoryJSON = .object(["role":.string("assistant"),"content":.null,"tool_calls":.array([.object(["id":.string("same"),"function":.object(["name":.string("read"),"arguments":.string("{}")])])])])
        let tool: HistoryJSON = .object(["role":.string("tool"),"tool_call_id":.string("same"),"content":.string("data")])
        try RemoteHermesSession.validateHistory([assistant,tool,assistant,tool])
        XCTAssertThrowsError(try RemoteHermesSession.validateHistory([assistant]))
        XCTAssertThrowsError(try RemoteHermesSession.validateHistory([tool]))
    }
}

@MainActor final class RemoteHermesConversationTests: XCTestCase {
    private func fixture(projectSelection: Bool = false, legacyBilling: Bool = false) throws -> (ConversationManager,String,()->[String],()->Int,()->Data?,String) {
        let id = { UUID().uuidString.lowercased() }
        let account=id(), sessionID=id(), branch=id(), version=id(), billing=id()
        var payload:[String:HistoryJSON] = ["type":.string("hermes_session"),"title":.string("Remote session"),"branchId":.string(branch),"messages":.array([.object(["role":.string("user"),"content":.string("Remote context")]),.object(["role":.string("assistant"),"content":.string("Remote answer")])])]
        if legacyBilling { payload["projectId"] = .string(billing) }
        let sessionChange=CloudAgentChange(operationId:id(),objectId:sessionID,versionId:version,deviceId:id(),kind:"session",parents:[],deleted:false,value:.object(payload),cursor:1,erased:false)
        var state=CloudAgentState(accountId:account,deviceId:id())
        state=try state.applying(.init(accountId:account,changes:[sessionChange],cursor:1,hasMore:false))
        let projectID=id()
        if projectSelection {
            let change=CloudAgentChange(operationId:id(),objectId:projectID,versionId:id(),deviceId:id(),kind:"project",parents:[],deleted:false,value:.object(["title":.string("Selected project")]),cursor:2,erased:false)
            state=try state.applying(.init(accountId:account,changes:[change],cursor:2,hasMore:false))
        }
        var serverCursor=state.cursor, serverChanges:[CloudAgentChange]=[]
        let json=try JSONSerialization.jsonObject(with:JSONEncoder().encode(state))
        let data=try JSONSerialization.data(withJSONObject:["cloudAgentState":json,"conversations":[],"baseline":[],"conversationIDs":[:],"messageIDs":[:]])
        let auth=NativeSession(accessToken:"fixture",refreshToken:"fixture",expiresAt:.distantFuture,accountId:account)
        var calls:[String]=[], creates=0, saved:Data?, runs:[String:CloudHermesRun]=[:]
        var services=isolatedServices(load:{auth},readLocalHistory:{_ in data})
        services.writeHistory={value,_ in saved=value}
        services.hermesChanges={after,_ in .init(accountId:account,changes:serverChanges.filter{$0.cursor>after},cursor:serverCursor,hasMore:false)}
        services.hermesMutations={_,operations,_ in
            calls.append("MUTATION")
            var receipts:[CloudAgentReceipt]=[]
            for operation in operations {
                XCTAssertEqual(operation.objectId,sessionID);XCTAssertEqual(operation.parents,[version])
                XCTAssertEqual(operation.value?.object?["workspaceProjectId"]?.string,projectID)
                XCTAssertEqual(operation.value?.object?["messages"]?.array?.count,2)
                serverCursor += 1
                serverChanges.append(.init(operationId:operation.operationId,objectId:operation.objectId,versionId:operation.versionId,deviceId:operation.deviceId,kind:operation.kind,parents:operation.parents,deleted:false,value:operation.value,cursor:serverCursor,erased:false))
                receipts.append(.init(operationId:operation.operationId,versionId:operation.versionId,cursor:serverCursor,heads:[operation.versionId],deleted:false))
            }
            return .init(accountId:account,receipts:receipts)
        }
        services.hermesConsent={_ in .init(accountId:account,cloudEnabled:true,revision:1)}
        services.remoteHermesModel={model,_ in .init(id:model,source:"cloud",accessId:nil)}
        services.hermesRead={_,runID,_,cancel in
            calls.append(cancel ? "CANCEL" : "GET")
            guard let run=runs[runID] else { throw APIError.server(404,"missing") }
            if cancel { return .init(runId:runID,sessionId:sessionID,branchId:branch,state:"cancelled",generation:1,result:nil) }
            return run
        }
        services.hermesCreate={_,input,_ in
            calls.append("POST");creates += 1
            XCTAssertNotNil(saved)
            XCTAssertEqual(input.sessionId,sessionID);XCTAssertEqual(input.history.count,2)
            XCTAssertEqual(input.workspaceProjectId,legacyBilling ? nil : (projectSelection ? projectID : sessionID))
            let wire=try JSONSerialization.jsonObject(with:JSONEncoder().encode(input)) as! [String:Any]
            if legacyBilling { XCTAssertEqual(wire["projectId"] as? String,billing) } else { XCTAssertNil(wire["projectId"]) }
            let run=CloudHermesRun(runId:input.runId,sessionId:sessionID,branchId:branch,state:"completed",generation:1,
                result:.init(response:"Cloud answer",history:input.history + [.object(["role":.string("user"),"content":.string(input.message)]),.object(["role":.string("assistant"),"content":.string("Cloud answer")])]))
            runs[input.runId]=run;return run
        }
        return (ConversationManager(services:services),sessionID,{calls},{creates},{saved},projectID)
    }
    func testLegacyBillingWorkspaceDoesNotGainAnAgentWorkspaceOverride() async throws {
        let (manager,id,calls,_,_,_)=try fixture(legacyBilling:true)
        await manager.restore(loadRemoteModels:false)
        for _ in 0..<100 where manager.cloudAgentSyncing { await Task.yield() }
        manager.models=[ModelOption(id:"cloud-fixture")]
        try await manager.sendRemoteHermes(sessionId:id,model:"cloud-fixture",message:"Legacy continue")
        XCTAssertFalse(calls().contains("MUTATION"))
    }
    func testSelectedWorkspacePublishesSessionVersionBeforeRunAndSurvivesProjection() async throws {
        let (manager,id,calls,_,_,project)=try fixture(projectSelection:true)
        await manager.restore(loadRemoteModels:false)
        for _ in 0..<100 where manager.cloudAgentSyncing { await Task.yield() }
        manager.models=[ModelOption(id:"cloud-fixture")]
        try await manager.sendRemoteHermes(sessionId:id,model:"cloud-fixture",message:"Continue",workspaceProjectId:project)
        XCTAssertEqual(calls().first,"MUTATION")
        XCTAssertEqual(manager.remoteHermesWorkspaceProject(id),project)
        XCTAssertEqual(manager.remoteHermesTranscript(id).last?.object?["content"]?.string,"Cloud answer")
    }
    func testRemoteSendUsesDurableGETBeforePOSTAndNeverCreatesDeviceConversation() async throws {
        let (manager,id,calls,creates,saved,_)=try fixture()
        await manager.restore(loadRemoteModels:false)
        for _ in 0..<100 where manager.cloudAgentSyncing { await Task.yield() }
        manager.models=[ModelOption(id:"cloud-fixture")]
        let count=manager.conversations.count
        try await manager.sendRemoteHermes(sessionId:id,model:"cloud-fixture",message:"Continue",workspaceProjectId:id)
        XCTAssertEqual(Array(calls().prefix(2)),["GET","POST"])
        XCTAssertEqual(manager.conversations.count,count)
        XCTAssertEqual(manager.remoteHermesTranscript(id).last?.object?["content"]?.string,"Cloud answer")
        await manager.recoverRemoteHermes()
        XCTAssertEqual(creates(),1)
        let cache=try JSONSerialization.jsonObject(with:XCTUnwrap(saved())) as! [String:Any]
        XCTAssertNotNil(cache["remoteHermes"])
    }
}

@MainActor final class CloudHermesLocalSeedTests: XCTestCase {
    func testActualLocalResponderReceivesHiddenCloudHistoryAndOnlySelectedCloudContext() async throws {
        let id={UUID().uuidString.lowercased()}, account=UUID().uuidString.lowercased(), conversationID=UUID()
        let oldUser:HistoryJSON = .object(["role":.string("user"),"content":.string("Old question")])
        let call:HistoryJSON = .object(["role":.string("assistant"),"content":.null,"tool_calls":.array([.object(["id":.string("cloud-call"),"function":.object(["name":.string("read_file"),"arguments":.string("{}")])])])])
        let tool:HistoryJSON = .object(["role":.string("tool"),"tool_call_id":.string("cloud-call"),"content":.string("Hidden Cloud evidence")])
        var binding=CloudHermesBinding(accountId:account,conversationId:conversationID.uuidString.lowercased(),sessionId:id(),branchId:id(),operationId:id(),versionId:id(),deviceId:id(),importApproved:true)
        binding.history=[oldUser,call,tool,.object(["role":.string("assistant"),"content":.string("Old answer")])]
        let memoryID=id(), memoryVersion=id()
        let memory=CloudAgentChange(operationId:id(),objectId:memoryID,versionId:memoryVersion,deviceId:id(),kind:"memory",parents:[],deleted:false,value:.object(["type":.string("hermes_core_memory"),"target":.string("user"),"content":.string("Selected Cloud memory")]),cursor:1,erased:false)
        var graph=CloudAgentState(accountId:account,deviceId:id())
        graph.objects[memoryID] = .init(kind:"memory",versions:[memoryVersion:memory],heads:[memoryVersion])
        binding.contextMemoryIDs=[memoryID]
        let conversation=Conversation(id:conversationID,model:LocalModel.id,messages:[ChatMessage(role:"user",content:"Old question"),ChatMessage(role:"assistant",content:"Old answer",completion:.completed)])
        let payload=try JSONSerialization.data(withJSONObject:["cloudHermesBindings":JSONSerialization.jsonObject(with:JSONEncoder().encode([conversationID:binding])),"cloudAgentState":JSONSerialization.jsonObject(with:JSONEncoder().encode(graph)),"conversations":JSONSerialization.jsonObject(with:JSONEncoder().encode([conversation])),"baseline":[],"conversationIDs":[:],"messageIDs":[:]])
        let auth=NativeSession(accessToken:"fixture",refreshToken:"fixture",expiresAt:.distantFuture,accountId:account)
        let received=expectation(description:"Local responder got complete seeded history")
        let services=isolatedServices(load:{auth},readLocalHistory:{_ in payload},localAvailability:{nil},localRespond:{_,workspace,delta in
            let history=await workspace.initialHermesHistory
            let context=await workspace.selectedCloudContext
            XCTAssertTrue(history?.contains(tool) == true)
            XCTAssertEqual(history?.last?.object?["content"]?.string,"Continue offline")
            XCTAssertTrue(context.contains("Selected Cloud memory"));XCTAssertTrue(context.contains("untrusted data"))
            await delta("Local answer");received.fulfill()
        })
        let manager=ConversationManager(services:services)
        await manager.restore(loadRemoteModels:false);manager.selection=conversationID;manager.selectedModel=LocalModel.id
        XCTAssertTrue(manager.send("Continue offline"))
        await fulfillment(of:[received],timeout:3)
        manager.stop()
    }
}

@MainActor final class CloudConflictResolutionTests: XCTestCase {
    func testPendingResolutionRetainsIdentityAndConcurrentHeadNeverReportsSuccess() async throws {
        for concurrent in [false,true] {
            let id = { UUID().uuidString.lowercased() }
            let account=id(), object=id(), device=id(), first=id(), second=id()
            var changes = [first,second].enumerated().map { index,version in
                CloudAgentChange(operationId:id(),objectId:object,versionId:version,deviceId:device,kind:"memory",parents:[],deleted:false,value:.string("version-\(index)"),cursor:Int64(index+1),erased:false)
            }
            let state=try CloudAgentState(accountId:account,deviceId:device).applying(.init(accountId:account,changes:changes,cursor:2,hasMore:false))
            let json=try JSONSerialization.jsonObject(with:JSONEncoder().encode(state))
            let data=try JSONSerialization.data(withJSONObject:["cloudAgentState":json,"conversations":[],"baseline":[],"conversationIDs":[:],"messageIDs":[:]])
            let auth=NativeSession(accessToken:"fixture",refreshToken:"fixture",expiresAt:.distantFuture,accountId:account)
            var submitted:[String]=[]
            var services=isolatedServices(load:{auth},readLocalHistory:{_ in data})
            services.hermesChanges={after,_ in .init(accountId:account,changes:changes.filter{$0.cursor>after},cursor:changes.last!.cursor,hasMore:false)}
            services.hermesConsent={_ in .init(accountId:account,cloudEnabled:true,revision:1)}
            services.hermesMutations={_,operations,_ in
                let op=operations[0];submitted.append(op.versionId)
                if !concurrent { throw APIError.server(503,"offline") }
                changes.append(.init(operationId:op.operationId,objectId:object,versionId:op.versionId,deviceId:device,kind:"memory",parents:op.parents,deleted:false,value:op.value,cursor:3,erased:false))
                changes.append(.init(operationId:id(),objectId:object,versionId:id(),deviceId:device,kind:"memory",parents:[first],deleted:false,value:.string("concurrent"),cursor:4,erased:false))
                return .init(accountId:account,receipts:[.init(operationId:op.operationId,versionId:op.versionId,cursor:3,heads:[op.versionId],deleted:false)])
            }
            let manager=ConversationManager(services:services)
            await manager.restore(loadRemoteModels:false)
            for _ in 0..<100 where manager.cloudAgentSyncing { await Task.yield() }
            let review=try XCTUnwrap(manager.cloudConflictReview(object))
            let version=try await manager.resolveCloudConflict(review,selectedHead:first)
            XCTAssertFalse(manager.cloudConflictResolved(review,version:version))
            if !concurrent {
                XCTAssertEqual(manager.pendingCloudConflictVersion(review),version)
                await manager.synchronizeCloudAgentState()
                XCTAssertEqual(Set(submitted),[version]);XCTAssertGreaterThanOrEqual(submitted.count,2)
            } else { XCTAssertEqual(manager.cloudConflictReview(object)?.versions.count,2) }
            XCTAssertTrue(manager.cloudConflictReviewVisible(review))
            await manager.logout()
            XCTAssertFalse(manager.cloudConflictReviewVisible(review))
            XCTAssertNil(manager.pendingCloudConflictVersion(review))
        }
    }
    func testRevocationBlocksReviewedResolutionWithoutMutationOrExecution() async throws {
        let id = { UUID().uuidString.lowercased() }
        let account=id(), object=id(), device=id(), first=id(), second=id()
        let changes = [first,second].enumerated().map { index,version in
            CloudAgentChange(operationId:id(),objectId:object,versionId:version,deviceId:device,kind:"memory",parents:[],deleted:false,value:.object(["content":.string("version-\(index)")]),cursor:Int64(index+1),erased:false)
        }
        let state=try CloudAgentState(accountId:account,deviceId:device).applying(.init(accountId:account,changes:changes,cursor:2,hasMore:false))
        let json=try JSONSerialization.jsonObject(with:JSONEncoder().encode(state))
        let data=try JSONSerialization.data(withJSONObject:["cloudAgentState":json,"conversations":[],"baseline":[],"conversationIDs":[:],"messageIDs":[:]])
        let auth=NativeSession(accessToken:"fixture",refreshToken:"fixture",expiresAt:.distantFuture,accountId:account)
        var enabled=true, mutations=0, executions=0
        var services=isolatedServices(load:{auth},readLocalHistory:{_ in data})
        services.hermesChanges={_,_ in .init(accountId:account,changes:[],cursor:2,hasMore:false)}
        services.hermesConsent={_ in .init(accountId:account,cloudEnabled:enabled,revision:1)}
        services.hermesMutations={_,_,_ in mutations += 1;throw APIError.invalidResponse}
        services.hermesCreate={_,_,_ in executions += 1;throw APIError.invalidResponse}
        let manager=ConversationManager(services:services)
        await manager.restore(loadRemoteModels:false)
        for _ in 0..<100 where manager.cloudAgentSyncing { await Task.yield() }
        let review=try XCTUnwrap(manager.cloudConflictReview(object))
        enabled=false
        do { try await manager.resolveCloudConflict(review,selectedHead:first);XCTFail("Revoked resolution must fail") } catch {}
        XCTAssertEqual(mutations,0);XCTAssertEqual(executions,0)
        XCTAssertEqual(manager.cloudConflictReview(object)?.versions.count,2)
    }
}

@MainActor final class CloudHistoryAnchorTests: XCTestCase {
    func testExplicitRunHistoryChoicePreservesMetadataAndHiddenToolsWithoutReplay() async throws {
        let id={UUID().uuidString.lowercased()}
        let account=id(),sessionID=id(),branch=id(),device=id(),first=id(),second=id(),runA=id(),runB=id(),billing=id()
        func history(_ hidden:String)->[HistoryJSON] {
            [.object(["role":.string("user"),"content":.string("Question")]),
             .object(["role":.string("assistant"),"content":.string(""),"tool_calls":.array([.object(["id":.string("call"),"type":.string("function"),"function":.object(["name":.string("read"),"arguments":.string("{}")])])])]),
             .object(["role":.string("tool"),"tool_call_id":.string("call"),"content":.string(hidden)]),
             .object(["role":.string("assistant"),"content":.string("Same visible answer")])]
        }
        var runs=[runA:CloudHermesRun(runId:runA,sessionId:sessionID,branchId:branch,state:"completed",generation:1,result:.init(response:"Same visible answer",history:history("hidden A"))),
                  runB:CloudHermesRun(runId:runB,sessionId:sessionID,branchId:branch,state:"completed",generation:1,result:.init(response:"Same visible answer",history:history("hidden B")))]
        var changes:[CloudAgentChange]=[]
        for (index,head) in [first,second].enumerated() {
            changes.append(.init(operationId:id(),objectId:sessionID,versionId:head,deviceId:device,kind:"session",parents:[],deleted:false,value:.object(["type":.string("hermes_session"),"branchId":.string(branch),"title":.string("Metadata \(index)"),"projectId":.string(billing),"custom":.string("Preserved")]),cursor:Int64(index+1),erased:false))
        }
        for (index,run) in [runA,runB].enumerated() {
            changes.append(.init(operationId:id(),objectId:run,versionId:id(),deviceId:device,kind:"task",parents:[],deleted:false,value:.object(["type":.string("hermes_run"),"sessionId":.string(sessionID),"branchId":.string(branch),"runId":.string(run)]),cursor:Int64(index+3),erased:false))
        }
        let state=try CloudAgentState(accountId:account,deviceId:device).applying(.init(accountId:account,changes:changes,cursor:4,hasMore:false))
        let json=try JSONSerialization.jsonObject(with:JSONEncoder().encode(state))
        let data=try JSONSerialization.data(withJSONObject:["cloudAgentState":json,"conversations":[],"baseline":[],"conversationIDs":[:],"messageIDs":[:]])
        let auth=NativeSession(accessToken:"fixture",refreshToken:"fixture",expiresAt:.distantFuture,accountId:account)
        var mutations:[CloudAgentMutation]=[],creates=0,cancels=0
        var services=isolatedServices(load:{auth},readLocalHistory:{_ in data})
        services.hermesChanges={after,_ in .init(accountId:account,changes:changes.filter{$0.cursor>after},cursor:changes.last!.cursor,hasMore:false)}
        services.hermesConsent={_ in .init(accountId:account,cloudEnabled:true,revision:1)}
        services.hermesRead={_,run,_,cancel in if cancel { cancels += 1 };return runs[run]!}
        services.hermesCreate={_,_,_ in creates += 1;throw APIError.invalidResponse}
        services.hermesMutations={_,ops,_ in
            mutations += ops
            var receipts:[CloudAgentReceipt]=[]
            for op in ops {
                let cursor=changes.last!.cursor+1
                changes.append(.init(operationId:op.operationId,objectId:op.objectId,versionId:op.versionId,deviceId:op.deviceId,kind:op.kind,parents:op.parents,deleted:false,value:op.value,cursor:cursor,erased:false))
                receipts.append(.init(operationId:op.operationId,versionId:op.versionId,cursor:cursor,heads:[op.versionId],deleted:false))
            }
            return .init(accountId:account,receipts:receipts)
        }
        let manager=ConversationManager(services:services)
        await manager.restore(loadRemoteModels:false)
        for _ in 0..<100 where manager.cloudAgentSyncing { await Task.yield() }
        let review=try XCTUnwrap(manager.cloudConflictReview(sessionID))
        let choices=try await manager.cloudHistoryChoices(review,selectedHead:first)
        XCTAssertEqual(choices.count,2)
        let chosen=try XCTUnwrap(choices.first(where:{$0.id == runA}))
        let version=try await manager.resolveCloudConflict(review,selectedHead:first,historyChoice:chosen)
        XCTAssertTrue(manager.cloudConflictResolved(review,version:version))
        XCTAssertEqual(mutations.count,1);XCTAssertEqual(creates,0);XCTAssertEqual(cancels,0)
        let op=try XCTUnwrap(mutations.first)
        XCTAssertEqual(Set(op.parents),Set([first,second]));XCTAssertNotEqual(op.value?.object?["branchId"]?.string,branch)
        XCTAssertEqual(op.value?.object?["projectId"]?.string,billing);XCTAssertEqual(op.value?.object?["custom"]?.string,"Preserved")
        XCTAssertEqual(manager.remoteHermesTranscript(sessionID),history("hidden A"))
        XCTAssertFalse(manager.remoteHermesTranscript(sessionID).contains { $0.object?["content"]?.string == "hidden B" })
        // Metadata edits must not hide a completed run on the newly resolved branch.
        let laterRun=id(),metadataVersion=id()
        let resolvedBranch=try XCTUnwrap(op.value?.object?["branchId"]?.string)
        runs[laterRun] = CloudHermesRun(runId:laterRun,sessionId:sessionID,branchId:resolvedBranch,state:"completed",generation:1,result:.init(response:"Later",history:history("later run")))
        changes.append(.init(operationId:id(),objectId:laterRun,versionId:id(),deviceId:device,kind:"task",parents:[],deleted:false,value:.object(["type":.string("hermes_run"),"sessionId":.string(sessionID),"branchId":.string(resolvedBranch),"runId":.string(laterRun)]),cursor:6,erased:false))
        changes.append(.init(operationId:id(),objectId:sessionID,versionId:metadataVersion,deviceId:device,kind:"session",parents:[version],deleted:false,value:op.value,cursor:7,erased:false))
        await manager.synchronizeCloudAgentState()
        XCTAssertEqual(manager.remoteHermesTranscript(sessionID),history("later run"))
        // A later local checkpoint on the new branch supersedes the immutable anchor.
        let local=id(),localVersion=id(),nextSessionVersion=id()
        let newBranch=try XCTUnwrap(op.value?.object?["branchId"]?.string)
        changes.append(.init(operationId:id(),objectId:local,versionId:localVersion,deviceId:device,kind:"message",parents:[],deleted:false,
            value:.object(["type":.string("hermes_local_turn"),"sessionId":.string(sessionID),"branchId":.string(newBranch),"turnId":.string(local),"history":.array(history("new local hidden"))]),cursor:8,erased:false))
        var updated=try XCTUnwrap(op.value?.object);updated["localTurnId"] = .string(local)
        changes.append(.init(operationId:id(),objectId:sessionID,versionId:nextSessionVersion,deviceId:device,kind:"session",parents:[metadataVersion],deleted:false,value:.object(updated),cursor:9,erased:false))
        await manager.synchronizeCloudAgentState()
        XCTAssertEqual(manager.remoteHermesTranscript(sessionID),history("new local hidden"))
        XCTAssertEqual(creates,0);XCTAssertEqual(cancels,0)
        changes.append(.init(operationId:id(),objectId:local,versionId:id(),deviceId:device,kind:"message",parents:[localVersion],deleted:true,value:nil,cursor:10,erased:false))
        await manager.synchronizeCloudAgentState()
        XCTAssertTrue(manager.remoteHermesTranscript(sessionID).isEmpty) // Never fall back to old anchor after deletion.
    }
}

@MainActor final class CloudWorkspaceFileTests: XCTestCase {
    func testEditQueuedDuringFinalPullTriggersOneDeferredJournalDrain() async throws {
        let id={UUID().uuidString.lowercased()}
        let account=id(),project=id(),head=id(),device=id()
        let state=try CloudAgentState(accountId:account,deviceId:device).applying(.init(accountId:account,changes:[.init(operationId:id(),objectId:project,versionId:head,deviceId:device,kind:"project",parents:[],deleted:false,value:.object(["title":.string("Project")]),cursor:1,erased:false)],cursor:1,hasMore:false))
        let data=try JSONSerialization.data(withJSONObject:["cloudAgentState":JSONSerialization.jsonObject(with:JSONEncoder().encode(state)),"conversations":[],"baseline":[],"conversationIDs":[:],"messageIDs":[:]])
        let auth=NativeSession(accessToken:"fixture",refreshToken:"fixture",expiresAt:.distantFuture,accountId:account)
        let entered=expectation(description:"Final pull suspended"),drained=expectation(description:"Deferred write drained")
        var reads=0,release:CheckedContinuation<Void,Never>?,changes:[CloudAgentChange]=[],writes=0
        var services=isolatedServices(load:{auth},readLocalHistory:{_ in data})
        services.hermesConsent={_ in .init(accountId:account,cloudEnabled:true,revision:1)}
        services.hermesChanges={after,_ in
            reads += 1
            if reads==2 { await withCheckedContinuation { continuation in release=continuation;entered.fulfill() } }
            return .init(accountId:account,changes:changes.filter{$0.cursor>after},cursor:changes.last?.cursor ?? 1,hasMore:false)
        }
        services.hermesMutations={_,ops,_ in
            writes += 1
            let op=ops[0]
            changes.append(.init(operationId:op.operationId,objectId:op.objectId,versionId:op.versionId,deviceId:op.deviceId,kind:op.kind,parents:op.parents,deleted:op.deleted,value:op.value,cursor:2,erased:false))
            drained.fulfill()
            return .init(accountId:account,receipts:[.init(operationId:op.operationId,versionId:op.versionId,cursor:2,heads:[op.versionId],deleted:false)])
        }
        let manager=ConversationManager(services:services)
        await manager.restore(loadRemoteModels:false)
        await fulfillment(of:[entered],timeout:3)
        let draft=try manager.cloudWorkspaceDraft(projectId:project,fileId:nil)
        let version=try await manager.saveCloudWorkspaceFile(draft,path:"during-pull.txt",content:"saved")
        XCTAssertEqual(manager.cloudWorkspaceWriteStatus(draft,version:version),"pending")
        release?.resume();release=nil
        await fulfillment(of:[drained],timeout:3)
        for _ in 0..<100 where manager.cloudAgentSyncing { await Task.yield() }
        XCTAssertEqual(writes,1)
        XCTAssertEqual(manager.cloudWorkspaceWriteStatus(draft,version:version),"synced")
    }
    func testOfflineWriteRetryIsDurableAndPersistenceFailureNeverQueuesOrExecutes() async throws {
        let id={UUID().uuidString.lowercased()}
        let account=id(),project=id(),head=id(),device=id()
        let state=try CloudAgentState(accountId:account,deviceId:device).applying(.init(accountId:account,changes:[.init(operationId:id(),objectId:project,versionId:head,deviceId:device,kind:"project",parents:[],deleted:false,value:.object(["title":.string("Project")]),cursor:1,erased:false)],cursor:1,hasMore:false))
        let json=try JSONSerialization.jsonObject(with:JSONEncoder().encode(state))
        let data=try JSONSerialization.data(withJSONObject:["cloudAgentState":json,"conversations":[],"baseline":[],"conversationIDs":[:],"messageIDs":[:]])
        let auth=NativeSession(accessToken:"fixture",refreshToken:"fixture",expiresAt:.distantFuture,accountId:account)
        var failWrite=false,saved:Data?,operations:[CloudAgentMutation]=[],creates=0,cancels=0
        var services=isolatedServices(load:{auth},readLocalHistory:{_ in data})
        services.writeHistory={value,_ in if failWrite { throw CocoaError(.fileWriteOutOfSpace) };saved=value}
        services.hermesChanges={_,_ in .init(accountId:account,changes:[],cursor:1,hasMore:false)}
        services.hermesConsent={_ in .init(accountId:account,cloudEnabled:true,revision:1)}
        services.hermesMutations={_,ops,_ in operations += ops;throw APIError.server(503,"offline")}
        services.hermesCreate={_,_,_ in creates += 1;throw APIError.invalidResponse}
        services.hermesRead={_,_,_,cancel in if cancel { cancels += 1 };throw APIError.invalidResponse}
        let manager=ConversationManager(services:services)
        await manager.restore(loadRemoteModels:false)
        for _ in 0..<100 where manager.cloudAgentSyncing { await Task.yield() }
        let draft=try manager.cloudWorkspaceDraft(projectId:project,fileId:nil)
        let version=try await manager.saveCloudWorkspaceFile(draft,path:"notes.txt",content:"offline text")
        XCTAssertEqual(manager.cloudWorkspaceWriteStatus(draft,version:version),"pending")
        XCTAssertEqual(manager.cloudWorkspacePendingFiles(projectId:project).first?.value?.object?["content"]?.string,"offline text")
        XCTAssertTrue(String(decoding:try XCTUnwrap(saved),as:UTF8.self).contains("offline text"))
        let retry=try await manager.saveCloudWorkspaceFile(draft,path:"notes.txt",content:"offline text")
        XCTAssertEqual(retry,version);XCTAssertEqual(Set(operations.map(\.operationId)).count,1)
        do { _=try await manager.saveCloudWorkspaceFile(draft,path:"notes.txt",content:"changed pending");XCTFail("Pending mutation is immutable") } catch {}
        failWrite=true
        do { _=try await manager.saveCloudWorkspaceFile(draft,path:"failed.txt",content:"unsaved");XCTFail("Persistence failure must fail") } catch {}
        XCTAssertEqual(manager.cloudWorkspacePendingFiles(projectId:project).count,1)
        failWrite=false
        await manager.logout()
        XCTAssertFalse(manager.cloudWorkspaceDraftVisible(draft))
        XCTAssertEqual(manager.cloudWorkspaceWriteStatus(draft,version:version),"unavailable")
        XCTAssertEqual(creates,0);XCTAssertEqual(cancels,0)
    }
}

@MainActor final class CloudAgentSyncOwnershipTests: XCTestCase {
    private func awaitIdle(_ manager: ConversationManager) async {
        let idle = expectation(description:"synchronization releases its owner")
        let observer = Task { @MainActor in
            while manager.cloudAgentSyncing && !Task.isCancelled { await Task.yield() }
            if !Task.isCancelled { idle.fulfill() }
        }
        await fulfillment(of:[idle],timeout:5)
        observer.cancel()
    }
    func testAccountSwitchStartsNewSyncAndLateOldCompletionCannotReleaseItsLock() async throws {
        let oldAccount=UUID().uuidString.lowercased(),newAccount=UUID().uuidString.lowercased()
        let oldAuth=NativeSession(accessToken:"old",refreshToken:"old-refresh",expiresAt:Date().addingTimeInterval(3600),accountId:oldAccount)
        let newAuth=NativeSession(accessToken:"new",refreshToken:"new-refresh",expiresAt:Date().addingTimeInterval(3600),accountId:newAccount)
        var saved=oldAuth
        var suspended=false,oldRequests=0,newRequests=0
        var oldReply:CheckedContinuation<CloudAgentPage,Never>?
        var newReply:CheckedContinuation<CloudAgentPage,Never>?
        let initial=expectation(description:"initial account synchronization reaches consent")
        let oldEntered=expectation(description:"old request suspended")
        let newEntered=expectation(description:"new account synchronizes despite old request")
        var services=isolatedServices(load:{saved},save:{saved=$0})
        services.hermesConsent={token in
            if !suspended { initial.fulfill() }
            return .init(accountId:token == "old" ? oldAccount:newAccount,cloudEnabled:false,revision:1)
        }
        services.hermesChanges={after,token in
            if !suspended { return .init(accountId:oldAccount,changes:[],cursor:after,hasMore:false) }
            if token == "old" {
                oldRequests += 1
                return await withCheckedContinuation { continuation in oldReply=continuation;oldEntered.fulfill() }
            }
            newRequests += 1
            if newRequests == 1 {
                return await withCheckedContinuation { continuation in newReply=continuation;newEntered.fulfill() }
            }
            return .init(accountId:newAccount,changes:[],cursor:after,hasMore:false)
        }
        let manager=ConversationManager(services:services)
        await manager.restore(loadRemoteModels:false)
        await fulfillment(of:[initial],timeout:5);await awaitIdle(manager)
        suspended=true
        let oldTask=Task { await manager.synchronizeCloudAgentState() }
        await fulfillment(of:[oldEntered],timeout:5)
        try await manager.accept(newAuth)
        await fulfillment(of:[newEntered],timeout:5)
        XCTAssertTrue(manager.cloudAgentSyncing);XCTAssertEqual(newRequests,1)
        oldReply?.resume(returning:.init(accountId:oldAccount,changes:[],cursor:0,hasMore:false));oldReply=nil
        await oldTask.value // Observe the old operation's entire defer, not merely transport completion.
        XCTAssertTrue(manager.cloudAgentSyncing,"old epoch must not release the new owner's lock")
        await manager.synchronizeCloudAgentState() // Must coalesce, not enter another concurrent request.
        XCTAssertEqual(newRequests,1);XCTAssertEqual(oldRequests,1)
        newReply?.resume(returning:.init(accountId:newAccount,changes:[],cursor:0,hasMore:false));newReply=nil
        await awaitIdle(manager)
        XCTAssertEqual(manager.session?.accountId,newAccount)
        XCTAssertNil(manager.cloudAgentSyncError)
    }
}

final class CloudWorkspaceArtifactGraphTests: XCTestCase {
    private func id(_ number:Int) -> String { String(format:"00000000-0000-4000-8000-%012d",number) }
    private func seeded() throws -> CloudAgentState {
        try CloudAgentState(accountId:id(1),deviceId:id(2)).applying(.init(accountId:id(1),changes:[
            .init(operationId:id(10),objectId:id(3),versionId:id(11),deviceId:id(2),kind:"project",parents:[],deleted:false,value:.object(["type":.string("hermes_project"),"name":.string("Artifacts")]),cursor:1,erased:false)
        ],cursor:1,hasMore:false))
    }
    private func artifact(_ path:String="asset.bin",size:Int=70000,artifactID:String?=nil) -> CloudWorkspaceArtifact {
        .init(id:CloudAgentState.workspaceFileID(projectId:id(3),path:path),projectId:id(3),path:path,artifactId:artifactID ?? id(4),byteLength:size,sha256:String(repeating:"a",count:64))
    }
    private func binary(_ state:CloudAgentState,_ value:CloudWorkspaceArtifact,parents:[String]=[]) throws -> CloudAgentMutation {
        try state.workspaceArtifactMutation(projectId:id(3),objectId:value.id,path:value.path,artifact:value,parents:parents,projectParents:[id(11)])
    }
    private func published(_ state:CloudAgentState,_ operation:CloudAgentMutation) throws -> CloudAgentState {
        try state.applying(.init(accountId:id(1),changes:[.init(operationId:operation.operationId,objectId:operation.objectId,versionId:operation.versionId,deviceId:operation.deviceId,kind:operation.kind,parents:operation.parents,deleted:operation.deleted,value:operation.value,cursor:state.cursor+1,erased:false)],cursor:state.cursor+1,hasMore:false))
    }
    func testBinaryMetadataRoundTripCanonicalIdentityAndPathValidation() throws {
        let value=artifact()
        XCTAssertEqual(try JSONDecoder().decode(CloudWorkspaceArtifact.self,from:JSONEncoder().encode(value)),value)
        XCTAssertEqual(try value.validated(),value)
        let state=try seeded(),operation=try binary(state,value)
        XCTAssertEqual(operation.objectId,value.id)
        XCTAssertEqual(operation.value?.object?["byteLength"]?.number,70000)
        XCTAssertEqual(operation.value?.object?["type"]?.string,"hermes_artifact_file")
        XCTAssertNil(operation.value?.object?["content"])
        for path in ["../escape","/absolute","a//b","a\\b",String(repeating:"💙",count:257)] {
            XCTAssertThrowsError(try artifact(path).validated())
        }
        for size in [-1,64*1024*1024+1] { XCTAssertThrowsError(try artifact(size:size).validated()) }
        _ = try artifact(size:64*1024*1024).validated()
        _ = try artifact(size:0).validated()
        XCTAssertThrowsError(try state.workspaceArtifactMutation(projectId:id(3),objectId:id(90),path:value.path,artifact:value,parents:[],projectParents:[id(11)]))
        let foreign=CloudWorkspaceArtifact(id:value.id,projectId:id(99),path:value.path,artifactId:value.artifactId,byteLength:value.byteLength,sha256:value.sha256)
        XCTAssertThrowsError(try binary(state,foreign))
        let malformed=CloudWorkspaceArtifact(id:value.id,projectId:value.projectId,path:value.path,artifactId:value.artifactId,byteLength:1,sha256:String(repeating:"F",count:64))
        XCTAssertThrowsError(try malformed.validated())
    }
    func testTextBinaryTextConversionsPreserveCustomMetadataAndOriginalParents() throws {
        var state=try seeded()
        let value=artifact()
        let text=try state.workspaceMutation(projectId:id(3),objectId:"",path:value.path,content:"initial",parents:[],projectParents:[id(11)],delete:false)
        var raw=try XCTUnwrap(text.value?.object);raw["custom"] = .object(["keep":.number(42)]);raw["mediaType"] = .string("text/plain")
        let original=CloudAgentMutation(operationId:text.operationId,objectId:text.objectId,versionId:text.versionId,deviceId:text.deviceId,kind:text.kind,parents:text.parents,deleted:false,value:.object(raw))
        state=try published(state,original)
        XCTAssertThrowsError(try binary(state,value))
        XCTAssertThrowsError(try binary(state,value,parents:[original.versionId,original.versionId]))
        let converted=try binary(state,value,parents:[original.versionId])
        XCTAssertEqual(converted.value?.object?["custom"],raw["custom"])
        XCTAssertNil(converted.value?.object?["content"]);XCTAssertNil(converted.value?.object?["mediaType"])
        state=try published(state,converted)
        XCTAssertThrowsError(try state.workspaceMutation(projectId:id(3),objectId:value.id,path:value.path,content:"back",parents:[original.versionId],projectParents:[id(11)],delete:false))
        let restored=try state.workspaceMutation(projectId:id(3),objectId:value.id,path:value.path,content:"back",parents:[converted.versionId],projectParents:[id(11)],delete:false)
        XCTAssertEqual(restored.value?.object?["custom"],raw["custom"])
        XCTAssertEqual(restored.value?.object?["content"]?.string,"back")
        for key in ["artifactId","byteLength","sha256","mediaType"] { XCTAssertNil(restored.value?.object?[key]) }
    }
    func testPendingBinaryRetryIsImmutableAndRechecksProjectAndFileHeads() throws {
        var state=try seeded();let value=artifact(),operation=try binary(state,value)
        try state.enqueue(operation)
        XCTAssertEqual(try binary(state,value),operation)
        XCTAssertThrowsError(try binary(state,artifact(size:70001)))
        state.outbox=[];state=try published(state,operation)
        let replacement=artifact(size:17,artifactID:id(5))
        let pending=try binary(state,replacement,parents:[operation.versionId]);try state.enqueue(pending)
        XCTAssertEqual(try binary(state,replacement,parents:[operation.versionId]),pending)
        let changed=CloudAgentMutation(operationId:id(51),objectId:value.id,versionId:id(52),deviceId:id(2),kind:"file",parents:[operation.versionId],deleted:false,value:operation.value)
        state=try published(state,changed)
        XCTAssertThrowsError(try binary(state,replacement,parents:[operation.versionId]))
        var newProject=try seeded();newProject.objects[id(3)]?.heads=[id(91)]
        XCTAssertThrowsError(try binary(newProject,value))
        var pendingProject=try seeded()
        try pendingProject.enqueue(.init(operationId:id(60),objectId:id(3),versionId:id(61),deviceId:id(2),kind:"project",parents:[id(11)],deleted:false,value:.object(["name":.string("pending")])) )
        XCTAssertThrowsError(try binary(pendingProject,value))
    }
    func testMixedCountsAndIndependentTextBinaryByteBudgetsIncludeOutbox() throws {
        var state=try seeded()
        for index in 0..<4 { try state.enqueue(binary(state,artifact("binary-\(index)",size:64*1024*1024,artifactID:id(100+index)))) }
        let text=try state.workspaceMutation(projectId:id(3),objectId:"",path:"text",content:String(repeating:"x",count:65536),parents:[],projectParents:[id(11)],delete:false)
        try state.enqueue(text)
        XCTAssertThrowsError(try binary(state,artifact("too-much",size:1)))
        _ = try binary(state,artifact("empty",size:0))
        state=try seeded()
        for index in 0..<199 { try state.enqueue(state.workspaceMutation(projectId:id(3),objectId:"",path:"text-\(index)",content:"",parents:[],projectParents:[id(11)],delete:false)) }
        try state.enqueue(binary(state,artifact(size:1)))
        XCTAssertThrowsError(try state.workspaceMutation(projectId:id(3),objectId:"",path:"text-overflow",content:"",parents:[],projectParents:[id(11)],delete:false))
        XCTAssertThrowsError(try binary(state,artifact("binary-overflow",size:0)))
        state=try seeded()
        for index in 0..<8 { try state.enqueue(state.workspaceMutation(projectId:id(3),objectId:"",path:"large-\(index)",content:String(repeating:"x",count:65536),parents:[],projectParents:[id(11)],delete:false)) }
        _ = try binary(state,artifact(size:64*1024*1024))
        XCTAssertThrowsError(try state.workspaceMutation(projectId:id(3),objectId:"",path:"text-overflow",content:"x",parents:[],projectParents:[id(11)],delete:false))
    }
    func testBinaryGraphConflictsTombstonesAndMalformedPendingBlockPublication() throws {
        var state=try seeded();let value=artifact(),operation=try binary(state,value)
        state=try published(state,operation)
        let conflict=CloudAgentMutation(operationId:id(70),objectId:value.id,versionId:id(71),deviceId:id(2),kind:"file",parents:[],deleted:false,value:operation.value)
        let conflicted=try published(state,conflict)
        XCTAssertThrowsError(try binary(conflicted,artifact("other")))
        XCTAssertThrowsError(try binary(conflicted,value,parents:[operation.versionId,id(71)]))
        let deletion=try state.workspaceMutation(projectId:id(3),objectId:value.id,path:value.path,content:"",parents:[operation.versionId],projectParents:[id(11)],delete:true)
        XCTAssertNil(deletion.value);state=try published(state,deletion)
        XCTAssertThrowsError(try binary(state,value))
        var malformed=try seeded(),raw=try XCTUnwrap(operation.value?.object)
        raw["byteLength"] = .number(0.5)
        malformed.outbox=[.init(operationId:operation.operationId,objectId:operation.objectId,versionId:operation.versionId,deviceId:operation.deviceId,kind:"file",parents:[],deleted:false,value:.object(raw))]
        XCTAssertThrowsError(try malformed.workspaceMutation(projectId:id(3),objectId:"",path:"new",content:"",parents:[],projectParents:[id(11)],delete:false))
        var deletedProject=try seeded();deletedProject.objects[id(3)]?.deleted=true
        XCTAssertThrowsError(try binary(deletedProject,value))
    }
}

@MainActor final class CloudArtifactJournalTests: XCTestCase {
    private func fixture() throws -> (NativeSession,String,Data) {
        let account=UUID().uuidString.lowercased(),project=UUID().uuidString.lowercased(),device=UUID().uuidString.lowercased()
        let state=try CloudAgentState(accountId:account,deviceId:device).applying(.init(accountId:account,changes:[.init(operationId:UUID().uuidString.lowercased(),objectId:project,versionId:UUID().uuidString.lowercased(),deviceId:device,kind:"project",parents:[],deleted:false,value:.object(["title":.string("Project")]),cursor:1,erased:false)],cursor:1,hasMore:false))
        let data=try JSONSerialization.data(withJSONObject:["cloudAgentState":JSONSerialization.jsonObject(with:JSONEncoder().encode(state)),"conversations":[],"baseline":[],"conversationIDs":[:],"messageIDs":[:]])
        return (.init(accessToken:"fixture",refreshToken:"fixture",expiresAt:.distantFuture,accountId:account),project,data)
    }
    private func idle(_ manager:ConversationManager) async {
        for _ in 0..<200 { await Task.yield();if !manager.cloudAgentSyncing { return } }
    }
    private func manifest(_ identity:CloudArtifactIdentity,_ complete:Bool) -> CloudArtifactManifest {
        .init(artifactId:identity.artifactId,projectId:identity.projectId,fileId:identity.fileId,byteLength:identity.byteLength,sha256:identity.sha256,chunkBytes:CloudArtifactIdentity.chunkBytes,state:complete ? "complete" : "uploading",received:[])
    }
    func testLostCompletionResumesSameIdentityAndPublishesOnlyAfterDurableComplete() async throws {
        let (auth,project,data)=try fixture()
        var saved=data,completed=false,beginIDs:[String]=[],completeCalls=0,publications=0,removals=0
        let file=CloudArtifactLocalFile(id:UUID().uuidString.lowercased(),byteLength:0,sha256:String(repeating:"a",count:64))
        var services=isolatedServices(load:{auth},readLocalHistory:{_ in saved})
        services.writeHistory={bytes,_ in saved=bytes}
        services.hermesChanges={_,_ in .init(accountId:auth.accountId,changes:[],cursor:1,hasMore:false)}
        services.hermesConsent={_ in .init(accountId:auth.accountId,cloudEnabled:true,revision:1)}
        services.artifactBegin={_,identity,_ in beginIDs.append(identity.artifactId);return self.manifest(identity,completed)}
        services.artifactComplete={_,_,_ in completeCalls += 1;completed=true;throw APIError.server(503,"lost_response")}
        services.artifactRemove={_,local in
            XCTAssertEqual(local,file)
            let cache=try JSONSerialization.jsonObject(with:saved) as! [String:Any]
            XCTAssertEqual((cache["pendingCloudArtifacts"] as? [Any])?.count,0)
            removals += 1
        }
        services.hermesMutations={_,operations,_ in
            XCTAssertTrue(completed)
            let cache=try JSONSerialization.jsonObject(with:saved) as! [String:Any]
            let journal=try XCTUnwrap((cache["pendingCloudArtifacts"] as? [[String:Any]])?.first)
            XCTAssertEqual(journal["phase"] as? String,"uploaded")
            publications += 1
            return .init(accountId:auth.accountId,receipts:operations.map{.init(operationId:$0.operationId,versionId:$0.versionId,cursor:2,heads:[$0.versionId],deleted:false)})
        }
        let first=ConversationManager(services:services)
        await first.restore(loadRemoteModels:false);await idle(first)
        let draft=try first.cloudWorkspaceArtifactDraft(projectId:project,fileId:nil)
        _=try await first.importCloudWorkspaceArtifact(draft,path:"empty.bin",file:file)
        XCTAssertEqual(publications,0);XCTAssertEqual(removals,0)
        XCTAssertEqual(first.cloudWorkspacePendingFiles(projectId:project).first?.title,"empty.bin")
        let restarted=ConversationManager(services:services)
        await restarted.restore(loadRemoteModels:false);await idle(restarted)
        XCTAssertEqual(completeCalls,1);XCTAssertEqual(Set(beginIDs).count,1)
        XCTAssertEqual(publications,1);XCTAssertEqual(removals,1)
    }
    func testCopyFinishingAfterAccountSwitchIsDiscardedWithoutNetwork() async throws {
        let (auth,project,data)=try fixture()
        let file=CloudArtifactLocalFile(id:UUID().uuidString.lowercased(),byteLength:0,sha256:String(repeating:"a",count:64))
        var release:CheckedContinuation<CloudArtifactLocalFile,Never>?,removals=0,begins=0
        let copied=expectation(description:"Copy started")
        var services=isolatedServices(load:{auth},readLocalHistory:{_ in data})
        services.hermesChanges={_,_ in .init(accountId:auth.accountId,changes:[],cursor:1,hasMore:false)}
        services.hermesConsent={_ in .init(accountId:auth.accountId,cloudEnabled:false,revision:1)}
        services.artifactImport={_,_ in await withCheckedContinuation { release=$0;copied.fulfill() } }
        services.artifactRemove={account,local in XCTAssertEqual(account,auth.accountId);XCTAssertEqual(local,file);removals += 1}
        services.artifactBegin={_,_,_ in begins += 1;throw APIError.invalidResponse}
        let manager=ConversationManager(services:services)
        await manager.restore(loadRemoteModels:false);await idle(manager)
        let draft=try manager.cloudWorkspaceArtifactDraft(projectId:project,fileId:nil)
        let task=Task { try await manager.beginCloudWorkspaceArtifactImport(draft,path:"a.bin",sourceURL:URL(fileURLWithPath:"/fixture")) }
        await fulfillment(of:[copied],timeout:3)
        manager.session=nil
        release?.resume(returning:file)
        do { _=try await task.value;XCTFail("Old account import must cancel") } catch {}
        XCTAssertEqual(removals,1);XCTAssertEqual(begins,0)
    }
}
