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
