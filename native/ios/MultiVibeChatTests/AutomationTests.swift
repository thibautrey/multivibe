import XCTest
@testable import MultiVibeChat

@MainActor final class AutomationTests: XCTestCase {
    private func job(_ kind: String = "interval") -> AgentAutomation {
        AgentAutomation(title: "Test", prompt: "Donne la date", trigger: AutomationTrigger(kind: kind, at: Date(timeIntervalSince1970: 1000), seconds: 900), model: LocalModel.id)
    }
    func testDueAdmissionIsAtomicAndMissedOccurrencesCoalesce() throws {
        var disk = Data()
        let store = try AutomationStore { disk = $0 }
        let saved = try store.upsert(job(), now: Date(timeIntervalSince1970: 1000))
        try store.enqueueDue(now: Date(timeIntervalSince1970: 10000))
        XCTAssertEqual(store.runs.count, 1)
        XCTAssertEqual(store.jobs.first?.nextRun, Date(timeIntervalSince1970: 10900))
        try store.enqueueDue(now: Date(timeIntervalSince1970: 11000))
        XCTAssertEqual(store.runs.count, 1)
        let restored = try AutomationStore(data: disk) { _ in }
        XCTAssertEqual(restored.runs.first?.automationID, saved.id)
    }
    func testOneShotDoesNotRepeatAndDuplicatesSurviveRestart() throws {
        var disk = Data()
        let store = try AutomationStore { disk = $0 }
        let saved = try store.upsert(job("at"))
        try store.enqueueDue(); try store.enqueueDue()
        XCTAssertEqual(store.runs.count, 1)
        let original = try XCTUnwrap(store.runs.first)
        try store.mark(original.id, status: "succeeded", output: "Done")
        let restored = try AutomationStore(data: disk) { _ in }
        let id = try restored.admit(saved.id, eventID: original.eventID)
        XCTAssertEqual(id, original.id)
        XCTAssertEqual(restored.runs.count, 1)
    }
    func testWriteFailureDoesNotAdvanceScheduleOrAdmitWork() throws {
        var fail = false
        let store = try AutomationStore { _ in if fail { throw CocoaError(.fileWriteOutOfSpace) } }
        _ = try store.upsert(job("at"))
        let before = store.jobs.first?.nextRun
        fail = true
        XCTAssertThrowsError(try store.enqueueDue())
        XCTAssertTrue(store.runs.isEmpty)
        XCTAssertEqual(store.jobs.first?.nextRun, before)
    }
    func testPauseCancelsQueuedWorkAndRevisionRejectsStaleEdit() throws {
        let store = try AutomationStore { _ in }
        var saved = try store.upsert(job())
        _ = try store.admit(saved.id, eventID: "a")
        saved.enabled = false
        _ = try store.upsert(saved)
        XCTAssertEqual(store.runs.first?.status, "cancelled")
        XCTAssertThrowsError(try store.upsert(saved))
        XCTAssertNil(try store.admit(saved.id, eventID: "b"))
    }
    func testInterruptedRunIsNotReplayedOnRestart() throws {
        var disk = Data()
        let store = try AutomationStore { disk = $0 }
        let saved = try store.upsert(job())
        let id = try XCTUnwrap(store.admit(saved.id, eventID: "a"))
        try store.mark(id, status: "running")
        let restored = try AutomationStore(data: disk) { _ in }
        XCTAssertEqual(restored.runs.first?.status, "interrupted")
    }
    func testValidationAndCalendarDST() throws {
        XCTAssertThrowsError(try AutomationTrigger(kind: "interval", seconds: 1).validate())
        XCTAssertThrowsError(try AutomationTrigger(kind: "geofence", latitude: 500, longitude: 0, radius: 200, transition: "enter").validate())
        let format = ISO8601DateFormatter()
        let t = AutomationTrigger(kind: "daily", hour: 9, minute: 0, timeZone: "Europe/Paris")
        let next = t.next(after: format.date(from: "2026-03-28T09:00:00Z")!)
        XCTAssertEqual(next, format.date(from: "2026-03-29T07:00:00Z"))
        let fall = t.next(after: format.date(from: "2026-10-24T08:00:00Z")!)
        XCTAssertEqual(fall, format.date(from: "2026-10-25T08:00:00Z"))
    }
    func testSeparateStoresDoNotShareAccountData() throws {
        let a = try AutomationStore { _ in }, b = try AutomationStore { _ in }
        _ = try a.upsert(job())
        XCTAssertTrue(b.jobs.isEmpty)
        XCTAssertNil(try b.admit(a.jobs[0].id, eventID: "cross-account"))
    }
    func testAutomationSchemaIsOnlyExposedWhenRequested() throws {
        XCTAssertFalse(LocalDownloadedTools.schema(deviceActions: []).contains("automation_manage"))
        XCTAssertTrue(LocalDownloadedTools.schema(deviceActions: [], automation: true).contains("automation_manage"))
        XCTAssertFalse(LocalDownloadedTools.schema(deviceActions: [], weather: true, automation: true).contains("automation_manage"))
        XCTAssertTrue(AutomationTools.requested([ChatMessage(role: "user", content: "Programme une tâche chaque matin")]))
    }
}
