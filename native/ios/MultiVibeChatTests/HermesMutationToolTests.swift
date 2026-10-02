import XCTest
@testable import MultiVibeChat

private actor MutationToolProbe {
    var memoryProposals: [HermesSelectedMemory.Proposal] = []
    var fileCalls = 0
    var nativeMemoryCalls = 0
    var nativeDocumentCalls = 0
    var successEvents = 0
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false
    func wait() async {
        if released { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func release() { released = true; continuation?.resume(); continuation = nil }
    func memory(_ proposal: HermesSelectedMemory.Proposal) { memoryProposals.append(proposal) }
    func file() { fileCalls += 1 }
    func nativeMemory() { nativeMemoryCalls += 1 }
    func nativeDocument() { nativeDocumentCalls += 1 }
    func event(_ event: LocalAgentEvent) { if event.status == "success" { successEvents += 1 } }
}

@MainActor final class HermesMutationToolTests: XCTestCase {
    private func selection() throws -> HermesSelectedMemory {
        let account = UUID().uuidString.lowercased()
        return try .init(accountID: account, snapshots: [.init(accountID: account,
            objectID: UUID().uuidString.lowercased(), parents: [UUID().uuidString.lowercased()],
            type: "hermes_core_memory", target: "memory", content: "Original")])
    }
    private func project() -> CloudHermesContext.WorkspaceProject {
        .init(accountId: UUID().uuidString.lowercased(), projectId: UUID().uuidString.lowercased(), parents: [UUID().uuidString.lowercased()])
    }
    private func args(_ value: [String: String]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }
    private func assertRefused(_ workspace: LocalAgentWorkspace, name: String, arguments: String,
                               file: StaticString = #filePath, line: UInt = #line) async {
        do {
            let result = try await workspace.executeHarnessTool(name: name, arguments: arguments)
            XCTFail("Rejected mutation unexpectedly returned: \(result?.content ?? "nil")", file: file, line: line)
        } catch {}
    }
    private func assertNoNativeWrites(_ probe: MutationToolProbe) async {
        let memory = await probe.nativeMemoryCalls
        let documents = await probe.nativeDocumentCalls
        XCTAssertEqual(memory, 0)
        XCTAssertEqual(documents, 0)
    }

    func testMemorySuccessWaitsForPersistenceAndOriginalTargetCannotBeWrittenTwice() async throws {
        let selected = try selection(), probe = MutationToolProbe()
        let entered = expectation(description: "Persistence entered")
        let workspace = LocalAgentWorkspace(conversations: [], documents: [], selectedMemory: selected,
            saveMemory: { proposal in
                await probe.memory(proposal); entered.fulfill(); await probe.wait()
            }, event: { await probe.event($0) }, saveDocument: { _ in await probe.nativeDocument() },
            memory: { _, _, _ in await probe.nativeMemory(); return "NATIVE_MEMORY_MUST_NOT_BE_IMPORTED" })
        let arguments = try args(["action": "add", "target": "memory", "content": "New"])
        let operation = Task { try await workspace.executeHarnessTool(name: "memory", arguments: arguments) }
        await fulfillment(of: [entered], timeout: 3)
        let prematureSuccesses = await probe.successEvents
        XCTAssertEqual(prematureSuccesses, 0)
        // A second operation is refused even while the original durable write is suspended.
        await assertRefused(workspace, name: "memory", arguments: arguments)
        await probe.release()
        let completed = try await operation.value
        let result = try XCTUnwrap(completed)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(result.content.utf8)) as? [String: Any])
        XCTAssertEqual(json["success"] as? Bool, true)
        XCTAssertEqual(json["status"] as? String, "saved_locally_sync_pending")
        await assertRefused(workspace, name: "memory", arguments: arguments)
        let proposals = await probe.memoryProposals
        XCTAssertEqual(proposals.count, 1)
        XCTAssertEqual(proposals.first?.original, selected.snapshots.first)
        XCTAssertEqual(proposals.first?.content, "Original\n§\nNew")
        await assertNoNativeWrites(probe)
    }

    func testMemoryPersistenceFailureThrowsAndLeavesOriginalSnapshotRetryable() async throws {
        let selected = try selection(), probe = MutationToolProbe()
        let workspace = LocalAgentWorkspace(conversations: [], documents: [], selectedMemory: selected,
            saveMemory: { proposal in await probe.memory(proposal); throw CocoaError(.fileWriteOutOfSpace) },
            event: { await probe.event($0) }, saveDocument: { _ in await probe.nativeDocument() },
            memory: { _, _, _ in await probe.nativeMemory(); return "native" })
        let arguments = try args(["action": "add", "target": "memory", "content": "Unsaved"])
        await assertRefused(workspace, name: "memory", arguments: arguments)
        await assertRefused(workspace, name: "memory", arguments: arguments)
        let proposals = await probe.memoryProposals
        XCTAssertEqual(proposals.count, 2)
        XCTAssertTrue(proposals.allSatisfy { $0.original == selected.snapshots[0] })
        let retained = await workspace.selectedMemory
        XCTAssertEqual(retained, selected)
        let successes = await probe.successEvents
        XCTAssertEqual(successes, 0)
        await assertNoNativeWrites(probe)
    }

    func testMissingMemoryTargetAndMissingAuthorizationAreRefusedWithoutNativeFallback() async throws {
        let selected = try selection(), probe = MutationToolProbe()
        let authorized = LocalAgentWorkspace(conversations: [], documents: [], selectedMemory: selected,
            saveMemory: { await probe.memory($0) }, event: { await probe.event($0) }, saveDocument: { _ in await probe.nativeDocument() },
            memory: { _, _, _ in await probe.nativeMemory(); return "native" })
        await assertRefused(authorized, name: "memory", arguments: try args(["action": "add", "target": "user", "content": "No target"]))
        let unauthorized = LocalAgentWorkspace(conversations: [], documents: [], selectedMemory: selected,
            event: { await probe.event($0) }, saveDocument: { _ in await probe.nativeDocument() },
            memory: { _, _, _ in await probe.nativeMemory(); return "native" })
        await assertRefused(unauthorized, name: "memory", arguments: try args(["action": "add", "target": "memory", "content": "No authority"]))
        let unselected = LocalAgentWorkspace(conversations: [], documents: [],
            saveMemory: { await probe.memory($0) }, event: { await probe.event($0) }, saveDocument: { _ in await probe.nativeDocument() })
        await assertRefused(unselected, name: "memory", arguments: try args(["action": "add", "target": "memory", "content": "No selection"]))
        let proposals = await probe.memoryProposals
        XCTAssertTrue(proposals.isEmpty)
        await assertNoNativeWrites(probe)
    }

    func testCreatedWorkspaceFileBecomesReadableOnlyAfterPersistenceWithoutLocalDocumentImport() async throws {
        let selected = project(), probe = MutationToolProbe()
        let id = CloudAgentState.workspaceFileID(projectId: selected.projectId, path: "notes/new.txt")
        let entered = expectation(description: "File persistence entered")
        let workspace = LocalAgentWorkspace(conversations: [], documents: [], selectedProject: selected,
            createWorkspaceFile: { project, path, content in
                await probe.file(); entered.fulfill(); await probe.wait()
                return .init(accountId: project.accountId, projectId: project.projectId, objectId: id,
                    path: path, content: content, parents: [], projectParents: project.parents, pending: true)
            }, event: { await probe.event($0) }, saveDocument: { _ in await probe.nativeDocument() },
            memory: { _, _, _ in await probe.nativeMemory(); return "native" })
        let arguments = try args(["path": "notes/new.txt", "content": "Durable content"])
        let operation = Task { try await workspace.executeHarnessTool(name: "workspace_create_file", arguments: arguments) }
        await fulfillment(of: [entered], timeout: 3)
        let prematureSuccesses = await probe.successEvents
        XCTAssertEqual(prematureSuccesses, 0)
        let read = try args(["documentID": id])
        await assertRefused(workspace, name: "document_snapshot", arguments: read)
        await probe.release()
        let completed = try await operation.value
        let result = try XCTUnwrap(completed)
        XCTAssertTrue(result.content.contains("saved_locally_sync_pending"))
        let snapshot = try await workspace.executeHarnessTool(name: "document_snapshot", arguments: read)
        XCTAssertEqual(snapshot?.content, "Durable content")
        let calls = await probe.fileCalls
        XCTAssertEqual(calls, 1)
        await assertNoNativeWrites(probe)
    }

    func testFailedWorkspacePersistenceNeverAddsReadableSnapshot() async throws {
        let selected = project(), probe = MutationToolProbe()
        let workspace = LocalAgentWorkspace(conversations: [], documents: [], selectedProject: selected,
            createWorkspaceFile: { _, _, _ in await probe.file(); throw CocoaError(.fileWriteOutOfSpace) },
            event: { await probe.event($0) }, saveDocument: { _ in await probe.nativeDocument() },
            memory: { _, _, _ in await probe.nativeMemory(); return "native" })
        await assertRefused(workspace, name: "workspace_create_file", arguments: try args(["path": "unsaved.txt", "content": "Unsaved"]))
        let id = CloudAgentState.workspaceFileID(projectId: selected.projectId, path: "unsaved.txt")
        await assertRefused(workspace, name: "document_snapshot", arguments: try args(["documentID": id]))
        let calls = await probe.fileCalls
        XCTAssertEqual(calls, 1)
        let successes = await probe.successEvents
        XCTAssertEqual(successes, 0)
        await assertNoNativeWrites(probe)
    }
}
