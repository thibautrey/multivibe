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
