import XCTest
@testable import MultiVibeChat

final class CloudAgentStateTests:XCTestCase {
    private func id(_ n:Int)->String { "00000000-0000-4000-8000-" + String(format:"%012d",n) }
    private func change(_ version:Int,parents:[Int]=[],deleted:Bool=false,erased:Bool=false)->CloudAgentChange {
        .init(operationId:id(version+100),objectId:id(2),versionId:id(version),deviceId:id(3),kind:"memory",parents:parents.map(id),deleted:deleted,value:deleted || erased ? nil : .string("private-\(version)"),cursor:Int64(version-3),erased:erased)
    }
    func testConcurrentHeadsRemainVisibleUntilExplicitMerge() throws {
        var state=CloudAgentState(accountId:id(1),deviceId:id(3))
        state=try state.applying(.init(accountId:id(1),changes:[change(4),change(5,parents:[4]),change(6,parents:[4])],cursor:3,hasMore:false))
        XCTAssertEqual(state.objects[id(2)]?.heads,[id(5),id(6)])
        XCTAssertEqual(state.conflicts[id(2)],"agent_conflict_requires_resolution")
        XCTAssertThrowsError(try state.enqueue(.init(operationId:id(110),objectId:id(2),versionId:id(10),deviceId:id(3),kind:"memory",parents:[id(5)],deleted:false,value:.string("wrong merge"))))
        state=try state.applying(.init(accountId:id(1),changes:[change(7,parents:[5,6])],cursor:4,hasMore:false))
        XCTAssertEqual(state.objects[id(2)]?.heads,[id(7)]);XCTAssertNil(state.conflicts[id(2)])
    }
    func testExplicitResolutionPreservesSelectedValueAndAllParents() throws {
        var state=try CloudAgentState(accountId:id(1),deviceId:id(3)).applying(.init(accountId:id(1),changes:[change(4),change(5,parents:[4]),change(6,parents:[4])],cursor:3,hasMore:false))
        let operation=try state.resolution(objectId:id(2),reviewedHeads:[id(6),id(5)],selectedHead:id(5),account:id(1))
        XCTAssertEqual(operation.value,.string("private-5")); XCTAssertEqual(operation.parents,[id(5),id(6)])
        try state.enqueue(operation)
        let restored=try JSONDecoder().decode(CloudAgentState.self,from:JSONEncoder().encode(state))
        XCTAssertEqual(restored.outbox,[operation]);XCTAssertEqual(restored.objects[id(2)]?.versions.count,3)
    }
    func testResolutionRejectsStaleHeadsOtherAccountAndDeletion() throws {
        var state=try CloudAgentState(accountId:id(1),deviceId:id(3)).applying(.init(accountId:id(1),changes:[change(4),change(5,parents:[4]),change(6,parents:[4])],cursor:3,hasMore:false))
        XCTAssertThrowsError(try state.resolution(objectId:id(2),reviewedHeads:[id(5)],selectedHead:id(5),account:id(1)))
        XCTAssertThrowsError(try state.resolution(objectId:id(2),reviewedHeads:[id(5),id(6)],selectedHead:id(5),account:id(9)))
        state=try state.applying(.init(accountId:id(1),changes:[change(7,parents:[5],deleted:true)],cursor:4,hasMore:false))
        XCTAssertThrowsError(try state.resolution(objectId:id(2),reviewedHeads:[id(5),id(6)],selectedHead:id(5),account:id(1)))
    }
    func testErasurePurgesPayloadsAndOutboxWithoutResurrection() throws {
        var state=try CloudAgentState(accountId:id(1),deviceId:id(3)).applying(.init(accountId:id(1),changes:[change(4)],cursor:1,hasMore:false))
        try state.enqueue(.init(operationId:id(110),objectId:id(2),versionId:id(10),deviceId:id(3),kind:"memory",parents:[id(4)],deleted:false,value:.string("pending secret")))
        state=try state.applying(.init(accountId:id(1),changes:[change(5,parents:[4],deleted:true)],cursor:2,hasMore:false))
        XCTAssertTrue(state.outbox.isEmpty);XCTAssertEqual(state.objects[id(2)]?.deleted,true)
        XCTAssertFalse(String(decoding:try JSONEncoder().encode(state),as:UTF8.self).contains("private"))
        state=try state.applying(.init(accountId:id(1),changes:[change(6,parents:[4])],cursor:3,hasMore:false))
        XCTAssertNil(state.objects[id(2)]?.versions[id(6)]?.value)
        XCTAssertThrowsError(try state.enqueue(.init(operationId:id(111),objectId:id(2),versionId:id(11),deviceId:id(3),kind:"memory",parents:[id(6)],deleted:false,value:.string("resurrect"))))
    }
    func testRejectedPageLeavesCursorAndProjectionUnchanged() throws {
        let state=CloudAgentState(accountId:id(1),deviceId:id(3))
        for page in [CloudAgentPage(accountId:id(9),changes:[change(4)],cursor:1,hasMore:false),.init(accountId:id(1),changes:[change(4)],cursor:2,hasMore:false),.init(accountId:id(1),changes:[],cursor:0,hasMore:true)] { XCTAssertThrowsError(try state.applying(page)) }
        XCTAssertEqual(state.cursor,0);XCTAssertTrue(state.objects.isEmpty)
    }
    func testOutboxRetriesAndAcknowledgementsKeepCursorIndependent() throws {
        var state=CloudAgentState(accountId:id(1),deviceId:id(3));let operation=change(4).mutation
        try state.enqueue(operation);try state.enqueue(operation);XCTAssertEqual(state.outbox.count,1)
        let restored=try JSONDecoder().decode(CloudAgentState.self,from:JSONEncoder().encode(state));XCTAssertEqual(restored,state)
        let next=try state.acknowledging(.init(accountId:id(1),receipts:[.init(operationId:operation.operationId,versionId:operation.versionId,cursor:1,heads:[operation.versionId],deleted:false)]),submitted:[operation])
        XCTAssertTrue(next.outbox.isEmpty);XCTAssertEqual(next.cursor,0)
        XCTAssertThrowsError(try state.acknowledging(.init(accountId:id(9),receipts:[]),submitted:[operation]))
    }
}

extension CloudAgentStateTests {
    func testHistoryAnchorsSelectExactMessageVersionAndRejectErasureAccountAndMissingRun() throws {
        let session=id(20),branch=id(21),message=id(22),version=id(23),other=id(24)
        let history:[HistoryJSON]=[.object(["role":.string("user"),"content":.string("Exact context")])]
        let value:HistoryJSON = .object(["type":.string("hermes_local_turn"),"sessionId":.string(session),"branchId":.string(branch),"turnId":.string(message),"history":.array(history)])
        var state=CloudAgentState(accountId:id(1),deviceId:id(3))
        state=try state.applying(.init(accountId:id(1),changes:[
            .init(operationId:id(25),objectId:message,versionId:version,deviceId:id(3),kind:"message",parents:[],deleted:false,value:value,cursor:1,erased:false),
            .init(operationId:id(26),objectId:message,versionId:other,deviceId:id(3),kind:"message",parents:[version],deleted:false,value:.object(["different":.bool(true)]),cursor:2,erased:false)
        ],cursor:2,hasMore:false))
        let anchor:HistoryJSON = .object(["type":.string("hermes_history_anchor"),"source":.string("message"),"objectId":.string(message),"versionId":.string(version),"sourceBranchId":.string(branch)])
        XCTAssertEqual(try state.anchoredHistory(anchor,sessionId:session,account:id(1),runs:[:]),history)
        XCTAssertThrowsError(try state.anchoredHistory(anchor,sessionId:session,account:id(9),runs:[:]))
        let runAnchor:HistoryJSON = .object(["type":.string("hermes_history_anchor"),"source":.string("run"),"runId":.string(id(30)),"sourceBranchId":.string(branch)])
        XCTAssertThrowsError(try state.anchoredHistory(runAnchor,sessionId:session,account:id(1),runs:[:]))
        state=try state.applying(.init(accountId:id(1),changes:[.init(operationId:id(27),objectId:message,versionId:id(28),deviceId:id(3),kind:"message",parents:[other],deleted:true,value:nil,cursor:3,erased:false)],cursor:3,hasMore:false))
        XCTAssertThrowsError(try state.anchoredHistory(anchor,sessionId:session,account:id(1),runs:[:]))
    }
}

extension CloudAgentStateTests {
    func testWorkspaceIdentityAndUnicodeValidationMatchCloud() throws {
        XCTAssertEqual(CloudAgentState.workspaceFileID(projectId:id(1),path:"notes/cafe.txt"),"f27d8d37-0c00-5b9d-891f-998ffa5de55e")
        try CloudAgentState.validateWorkspaceText(path:String(repeating:"💙",count:256),content:String(repeating:"💙",count:16384))
        XCTAssertThrowsError(try CloudAgentState.validateWorkspaceText(path:String(repeating:"💙",count:257),content:""))
        for path in ["","/a","a/","a//b","a/../b","./b","a\\b","a\u{7f}b",Array(repeating:"a",count:11).joined(separator:"/")] {
            XCTAssertThrowsError(try CloudAgentState.validateWorkspaceText(path:path,content:""))
        }
        XCTAssertThrowsError(try CloudAgentState.validateWorkspaceText(path:"valid",content:String(repeating:"a",count:65537)))
        XCTAssertThrowsError(try CloudAgentState.validateWorkspaceText(path:"valid",content:"nul\0value"))
    }
    func testWorkspaceOriginalParentsMetadataRetryAndTombstone() throws {
        let project=id(1),head=id(2),file=CloudAgentState.workspaceFileID(projectId:project,path:"a.txt")
        var state=CloudAgentState(accountId:id(10),deviceId:id(3))
        state=try state.applying(.init(accountId:id(10),changes:[
            .init(operationId:id(4),objectId:project,versionId:head,deviceId:id(3),kind:"project",parents:[],deleted:false,value:.object(["title":.string("Project")]),cursor:1,erased:false),
            .init(operationId:id(5),objectId:file,versionId:id(6),deviceId:id(3),kind:"file",parents:[],deleted:false,value:.object(["type":.string("hermes_workspace_file"),"projectId":.string(project),"path":.string("a.txt"),"content":.string("old"),"custom":.string("keep")]),cursor:2,erased:false)
        ],cursor:2,hasMore:false))
        let op=try state.workspaceMutation(projectId:project,objectId:file,path:"a.txt",content:"new",parents:[id(6)],projectParents:[head],delete:false)
        XCTAssertEqual(op.parents,[id(6)]);XCTAssertEqual(op.value?.object?["custom"]?.string,"keep")
        try state.enqueue(op)
        XCTAssertEqual(try state.workspaceMutation(projectId:project,objectId:file,path:"a.txt",content:"new",parents:[id(6)],projectParents:[head],delete:false),op)
        XCTAssertThrowsError(try state.workspaceMutation(projectId:project,objectId:file,path:"a.txt",content:"different",parents:[id(6)],projectParents:[head],delete:false))
        XCTAssertThrowsError(try state.workspaceMutation(projectId:project,objectId:file,path:"renamed",content:"new",parents:[id(6)],projectParents:[head],delete:false))
        state.outbox=[]
        XCTAssertThrowsError(try state.workspaceMutation(projectId:project,objectId:file,path:"a.txt",content:"new",parents:[],projectParents:[head],delete:false))
        let deleted=try state.workspaceMutation(projectId:project,objectId:file,path:"a.txt",content:"old",parents:[id(6)],projectParents:[head],delete:true)
        XCTAssertNil(deleted.value)
        state=try state.applying(.init(accountId:id(10),changes:[.init(operationId:deleted.operationId,objectId:file,versionId:deleted.versionId,deviceId:id(3),kind:"file",parents:deleted.parents,deleted:true,value:nil,cursor:3,erased:false)],cursor:3,hasMore:false))
        XCTAssertThrowsError(try state.workspaceMutation(projectId:project,objectId:"",path:"a.txt",content:"resurrect",parents:[],projectParents:[head],delete:false))
    }
    func testWorkspaceAggregateBoundsIncludePendingFiles() throws {
        let project=id(1),head=id(2)
        var state=try CloudAgentState(accountId:id(10),deviceId:id(3)).applying(.init(accountId:id(10),changes:[.init(operationId:id(4),objectId:project,versionId:head,deviceId:id(3),kind:"session",parents:[],deleted:false,value:.object(["title":.string("Session")]),cursor:1,erased:false)],cursor:1,hasMore:false))
        for index in 0..<8 {
            let op=try state.workspaceMutation(projectId:project,objectId:"",path:"file-\(index)",content:String(repeating:"a",count:65536),parents:[],projectParents:[head],delete:false)
            try state.enqueue(op)
        }
        XCTAssertThrowsError(try state.workspaceMutation(projectId:project,objectId:"",path:"overflow",content:"a",parents:[],projectParents:[head],delete:false))
        state.outbox=[]
        for index in 0..<200 {
            try state.enqueue(state.workspaceMutation(projectId:project,objectId:"",path:"file-\(index)",content:"",parents:[],projectParents:[head],delete:false))
        }
        XCTAssertThrowsError(try state.workspaceMutation(projectId:project,objectId:"",path:"file-201",content:"",parents:[],projectParents:[head],delete:false))
    }
}
