import XCTest
@testable import MultiVibeChat

final class CloudHermesContextTests: XCTestCase {
    let account = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    let device = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    func state() -> CloudAgentState { .init(accountId: account, deviceId: device) }
    @discardableResult func insert(_ graph: inout CloudAgentState, id: String = UUID().uuidString.lowercased(), kind: String, value: HistoryJSON) -> String {
        let version = UUID().uuidString.lowercased()
        let change = CloudAgentChange(operationId: UUID().uuidString.lowercased(), objectId: id, versionId: version, deviceId: device, kind: kind, parents: [], deleted: false, value: value, cursor: 1, erased: false)
        graph.objects[id] = CloudAgentObject(kind: kind, versions: [version: change], heads: [version])
        return id
    }
    func testExplicitSelectionAndLiteralSkillReferences() throws {
        var graph = state()
        let memory = insert(&graph, kind: "memory", value: .object(["type": .string("hermes_core_memory"), "target": .string("user"), "content": .string("Selected user memory")]))
        let skill = insert(&graph, kind: "skill", value: .object(["type": .string("hermes_skill"), "name": .string("sample"), "files": .object(["SKILL.md": .string("---\ncommand: rm -rf /\n---\nLiteral instruction"), "references/guide.md": .string("Selected reference"), "scripts/run.sh": .string("UNSELECTED_SCRIPT")])]))
        _ = insert(&graph, kind: "memory", value: .object(["type": .string("hermes_core_memory"), "target": .string("memory"), "content": .string("UNSELECTED_MEMORY")]))
        let empty = try CloudHermesContext.build(state: graph, accountID: account)
        XCTAssertEqual(empty, .init(memory: "", skills: "", files: ""))
        let context = try CloudHermesContext.build(state: graph, accountID: account, memoryObjectIDs: [memory], skillObjectIDs: [skill])
        XCTAssertTrue(context.memory.contains("Selected user memory")); XCTAssertFalse(context.memory.contains("UNSELECTED"))
        XCTAssertTrue(context.skills.contains("command: rm -rf")); XCTAssertTrue(context.skills.contains("Selected reference")); XCTAssertFalse(context.skills.contains("UNSELECTED_SCRIPT"))
        XCTAssertTrue(context.skills.contains("untrusted data")); XCTAssertEqual(context.files, "")
    }
    func testConflictsDeletedAndWrongAccountFailClosed() throws {
        var graph = state()
        let memory = insert(&graph, kind: "memory", value: .object(["type": .string("hermes_core_memory"), "target": .string("memory"), "content": .string("private")]))
        XCTAssertThrowsError(try CloudHermesContext.build(state: graph, accountID: device, memoryObjectIDs: [memory])) { XCTAssertEqual($0 as? CloudHermesContext.Failure, .accountMismatch) }
        graph.objects[memory]!.heads.append(UUID().uuidString.lowercased())
        XCTAssertThrowsError(try CloudHermesContext.build(state: graph, accountID: account, memoryObjectIDs: [memory])) { XCTAssertEqual($0 as? CloudHermesContext.Failure, .conflictedObject) }
        graph.objects[memory]!.deleted = true
        XCTAssertThrowsError(try CloudHermesContext.build(state: graph, accountID: account, memoryObjectIDs: [memory])) { XCTAssertEqual($0 as? CloudHermesContext.Failure, .deletedObject) }
    }
    func testFilesRequireSelectedProjectAndStableIdentity() throws {
        var graph = state(); let project = insert(&graph, kind: "project", value: .object(["name": .string("Project")]))
        let file = CloudHermesContext.workspaceFileID(projectID: project, path: "src/main.txt")
        insert(&graph, id: file, kind: "file", value: .object(["type": .string("hermes_workspace_file"), "projectId": .string(project), "path": .string("src/main.txt"), "content": .string("Selected file")]))
        XCTAssertThrowsError(try CloudHermesContext.build(state: graph, accountID: account, fileObjectIDs: [file]))
        let context = try CloudHermesContext.build(state: graph, accountID: account, projectID: project, fileObjectIDs: [file])
        XCTAssertTrue(context.files.contains("Selected file")); XCTAssertEqual(context.memory, "")
        let other = insert(&graph, kind: "project", value: .object([:]))
        XCTAssertThrowsError(try CloudHermesContext.build(state: graph, accountID: account, projectID: other, fileObjectIDs: [file])) { XCTAssertEqual($0 as? CloudHermesContext.Failure, .projectMismatch) }
        let forged = insert(&graph, kind: "file", value: graph.objects[file]!.versions.values.first!.value!)
        XCTAssertThrowsError(try CloudHermesContext.build(state: graph, accountID: account, projectID: project, fileObjectIDs: [forged]))
    }
    func testBoundsAndTraversalAndUnsupportedMemoryAreRejected() throws {
        var graph = state()
        let memory = insert(&graph, kind: "memory", value: .object(["type": .string("hermes_core_memory"), "target": .string("memory"), "content": .string(String(repeating: "é", count: 16_385))]))
        XCTAssertThrowsError(try CloudHermesContext.build(state: graph, accountID: account, memoryObjectIDs: [memory])) { XCTAssertEqual($0 as? CloudHermesContext.Failure, .limitExceeded) }
        let skill = insert(&graph, kind: "skill", value: .object(["type": .string("hermes_skill"), "name": .string("bad"), "files": .object(["SKILL.md": .string("safe"), "references/../private": .string("unsafe")])]))
        XCTAssertThrowsError(try CloudHermesContext.build(state: graph, accountID: account, skillObjectIDs: [skill]))
        let unsupported = insert(&graph, kind: "memory", value: .object(["type": .string("native_memory"), "target": .string("user"), "content": .string("native")]))
        XCTAssertThrowsError(try CloudHermesContext.build(state: graph, accountID: account, memoryObjectIDs: [unsupported]))
    }
    func testImplicitSessionWorkspaceRequiresExplicitLiveSessionSelection() throws {
        var graph=state()
        let session=insert(&graph,kind:"session",value:.object(["type":.string("hermes_session")]))
        let file=CloudHermesContext.workspaceFileID(projectID:session,path:"notes.txt")
        insert(&graph,id:file,kind:"file",value:.object(["type":.string("hermes_workspace_file"),"projectId":.string(session),"path":.string("notes.txt"),"content":.string("Session-owned file")]))
        XCTAssertThrowsError(try CloudHermesContext.build(state:graph,accountID:account,fileObjectIDs:[file]))
        XCTAssertTrue(try CloudHermesContext.build(state:graph,accountID:account,projectID:session,fileObjectIDs:[file]).files.contains("Session-owned"))
        graph.objects[session]!.deleted=true
        XCTAssertThrowsError(try CloudHermesContext.build(state:graph,accountID:account,projectID:session,fileObjectIDs:[file]))
    }

    func testPendingNewFileRemainsReadableAfterRestartWithoutCloudObject() throws {
        var graph = state()
        let project = insert(&graph, kind: "project", value: .object(["name": .string("Project")]))
        let id = CloudAgentState.workspaceFileID(projectId: project, path: "new.txt")
        let operation = try graph.workspaceMutation(projectId: project, objectId: id, path: "new.txt", content: "offline output",
            parents: [], projectParents: graph.objects[project]!.heads, delete: false)
        try graph.enqueue(operation)
        let restored = try JSONDecoder().decode(CloudAgentState.self, from: JSONEncoder().encode(graph))
        let snapshot = try CloudHermesContext.build(state: restored, accountID: account, projectID: project, fileObjectIDs: [id])
        XCTAssertEqual(snapshot.workspaceFiles.first?.content, "offline output")
        XCTAssertEqual(snapshot.workspaceFiles.first?.parents, [])
        XCTAssertEqual(snapshot.workspaceFiles.first?.pending, true)
    }

}
