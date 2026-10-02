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
