import AppKit
import Combine
import CryptoKit
import Foundation

/// Account-owned journal, independent from the device-owned Host chat archive.
@MainActor final class NativeChatAgentCoordinator: ObservableObject {
    @Published private(set) var accountID: String?
    @Published private(set) var consent: NativeAgentConsent?
    @Published private(set) var busy = false
    @Published private(set) var importedConversationIDs: Set<UUID> = []
    @Published var error: String?
    @Published private(set) var cloudObjects: [String: [NativeAgentChange]] = [:]
    @Published private(set) var models: [NativeAgentCatalogModel] = []
    @Published private(set) var runs: [String: NativeAgentRun] = [:]
    private(set) var loginEpoch = UUID()
    private let session: NativeCloudSession?
    private let client: NativeAgentClient?
    private let root: URL
    private var journal: Journal?
    private struct Journal: Codable {
        let accountID: String
        let deviceID: String
        var imported: Set<UUID> = []
        var pending: [NativeAgentMutation] = []
        var cursor: Int64? = 0
        var versions: [String: [NativeAgentChange]]? = [:]
        var runRequests: [String: NativeAgentRunInput]? = [:]
        var runStates: [String: NativeAgentRun]? = [:]
        var pendingCancels: Set<String>? = []
        var histories: [String: [NativeAgentJSON]]? = [:]
        var runOrder: [String]? = []
        var titles: [String: String]? = [:]
        var historyCursors: [String: Int64]? = [:]
        var historySources: [String: String]? = [:]
        var blockedHistorySessions: Set<String>? = []
        var workspaceSelections: [String: String]? = [:]
        var workspaceMutations: [String: NativeAgentMutation]? = [:]
    }
    init(session: NativeCloudSession? = nil, client: NativeAgentClient? = nil, root: URL? = nil) {
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("MultiVibe/NativeAgent")
        do {
            let resolved = try session ?? NativeCloudSession(storage: nil)
            self.session = resolved; self.client = client ?? NativeAgentClient(session: resolved)
        } catch { self.session = nil; self.client = nil; self.error = "Connexion Cloud indisponible : \(error.localizedDescription)" }
    }
    private func journalURL(_ id: String) -> URL {
        let key = SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent(key).appendingPathComponent("journal.json")
    }
    private func check(_ account: String, _ epoch: UUID) throws {
        guard accountID == account, session?.accountID == account, loginEpoch == epoch else { throw NativeAgentClientError.accountMismatch }
        try Task.checkCancellation()
    }
    private func persist() throws {
        guard let journal, accountID == journal.accountID else { throw NativeAgentClientError.accountMismatch }
        let url = journalURL(journal.accountID)
        let data = try JSONEncoder().encode(journal)
        guard data.count <= 16 * 1024 * 1024 else { throw NativeAgentClientError.tooLarge }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try data.write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true
        var folder = url.deletingLastPathComponent(); try folder.setResourceValues(excluded)
    }
    /// User initiated only: opening a device chat never uploads its history.
    func connect(window: NSWindow) async {
        guard !busy, let session else { return }
        busy = true; error = nil
        let epoch = UUID(); loginEpoch = epoch
        defer { if loginEpoch == epoch { busy = false } }
        do {
            try await session.signIn(window: window)
            guard loginEpoch == epoch else { return }
            try await activate()
        } catch { if loginEpoch == epoch { self.error = error.localizedDescription } }
    }
    func restore() async {
        guard !busy, accountID == nil, let session else { return }
        busy = true; let epoch = loginEpoch
        defer { if epoch == loginEpoch { busy = false } }
        do {
            _ = try await session.token()
            guard epoch == loginEpoch else { return }
            try await activate()
        } catch { /* An absent or expired session does not obstruct device chat. */ }
    }
    private func activate() async throws {
        guard let account = session?.accountID, let client else { throw NativeAgentClientError.accountMismatch }
        accountID = account; journal = nil; consent = nil; importedConversationIDs = []; cloudObjects = [:]; runs = [:]; models = []
        let epoch = loginEpoch
        let url = journalURL(account)
        if FileManager.default.fileExists(atPath: url.path) {
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= 16 * 1024 * 1024 else { throw NativeAgentClientError.tooLarge }
            let saved = try JSONDecoder().decode(Journal.self, from: Data(contentsOf: url))
            guard saved.accountID == account else { throw NativeAgentClientError.accountMismatch }
            journal = saved; importedConversationIDs = saved.imported
            cloudObjects = saved.versions ?? [:]; runs = saved.runStates ?? [:]
        } else { journal = Journal(accountID: account, deviceID: UUID().uuidString.lowercased()) }
        let remote = try await client.consent(accountID: account)
        try check(account, epoch); consent = remote
    }
    func disconnect() async {
        loginEpoch = UUID(); accountID = nil; consent = nil; journal = nil; importedConversationIDs = []; cloudObjects = [:]; runs = [:]; models = []; busy = false
        do { try await session?.disconnect() } catch { self.error = error.localizedDescription }
    }
    /// Each checked conversation is a separate explicit export. Pending operations survive errors.
    func enableCloud(import conversations: [NativeChatConversation]) async {
        guard !busy, let account = accountID, let client, let consent, journal != nil else { return }
        busy = true; error = nil; let epoch = loginEpoch
        defer { if loginEpoch == epoch { busy = false } }
        do {
            let granted = try await client.setConsent(.init(accountId: account, cloudEnabled: true, exportSources: Array(Set(consent.exportSources + ["macos-device"])).sorted(), revision: consent.revision))
            try check(account, epoch); self.consent = granted
            for conversation in conversations where !journal!.imported.contains(conversation.id) {
                // A queued import is retried with exactly its original IDs and payload.
                let objectID = conversation.id.uuidString.lowercased()
                guard !journal!.pending.contains(where: { $0.objectId == objectID }) else { continue }
                let messages = conversation.messages.map { NativeAgentJSON.object(["id": .string($0.id.uuidString.lowercased()), "role": .string($0.role), "content": .string($0.content), "interrupted": .bool($0.interrupted)]) }
                var histories = journal!.histories ?? [:]
                histories[objectID] = conversation.messages.map { .object(["role": .string($0.role), "content": .string($0.content)]) }
                journal!.histories = histories
                var titles = journal!.titles ?? [:]; titles[objectID] = conversation.title; journal!.titles = titles
                let value = NativeAgentJSON.object(["title": .string(conversation.title), "messages": .array(messages), "model": .string(conversation.model), "source": .string("macos-device")])
                guard try JSONEncoder().encode(value).count <= 131_072 else { throw NativeAgentClientError.tooLarge }
                journal!.pending.append(.init(operationId: UUID().uuidString.lowercased(), objectId: objectID, versionId: UUID().uuidString.lowercased(), deviceId: journal!.deviceID, kind: .session, parents: [], deleted: false, value: value))
            }
            try persist()
            try await flush(account: account, epoch: epoch)
        } catch { if loginEpoch == epoch { self.error = "Synchronisation interrompue : \(error.localizedDescription)" } }
    }
    func retryImports() async {
        guard !busy, let account = accountID, consent?.cloudEnabled == true else { return }
        busy = true; error = nil; let epoch = loginEpoch
        defer { if loginEpoch == epoch { busy = false } }
        do { try await flush(account: account, epoch: epoch) }
        catch { if loginEpoch == epoch { self.error = error.localizedDescription } }
    }
    private func flush(account: String, epoch: UUID) async throws {
        guard let client else { return }
        while let operations = journal?.pending, !operations.isEmpty {
            try check(account, epoch)
            try persist()
            let batch = Array(operations.prefix(5))
            _ = try await client.mutate(accountID: account, operations: batch)
            try check(account, epoch)
            var next = journal!
            next.pending.removeFirst(batch.count)
            for operation in batch { if let id = UUID(uuidString: operation.objectId) { next.imported.insert(id) } }
            let previous = journal; journal = next
            do { try persist() } catch { journal = previous; throw error }
            importedConversationIDs = next.imported
        }
    }
    struct CloudConversation: Identifiable {
        let id: UUID
        let title: String
        let conflicted: Bool
    }
    var cloudConversations: [CloudConversation] {
        let ids = Set((journal?.titles ?? [:]).keys).union(cloudObjects.keys)
        return ids.compactMap { id in
            guard let uuid = UUID(uuidString: id) else { return nil }
            let heads = cloudObjects[id] ?? []
            if !heads.isEmpty && (heads.allSatisfy { $0.kind != .session } || heads.contains { $0.deleted || $0.erased }) { return nil }
            var title = journal?.titles?[id] ?? "Conversation Cloud"
            if heads.count == 1, case .object(let object) = heads[0].value, case .string(let remoteTitle) = object["title"] { title = remoteTitle }
            return CloudConversation(id: uuid, title: title, conflicted: heads.count > 1)
        }.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }
    struct CloudProject: Identifiable { let id: String; let title: String }
    var cloudProjects: [CloudProject] {
        cloudObjects.compactMap { id, heads in
            guard UUID(uuidString: id) != nil, heads.count == 1, heads[0].kind == .project,
                  !heads[0].deleted, !heads[0].erased, case .object(let value) = heads[0].value else { return nil }
            let title: String
            if case .string(let name) = value["name"] ?? value["title"] { title = name } else { title = "Projet Hermes" }
            return CloudProject(id: id, title: title)
        }.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }
    func selectedWorkspaceProject(_ conversation: UUID?) -> String {
        guard let conversation else { return "" }; let key = conversation.uuidString.lowercased()
        if let selected = journal?.workspaceSelections?[key] { return selected }
        if let heads = cloudObjects[key], heads.count == 1, !heads[0].deleted, !heads[0].erased,
           case .object(let value) = heads[0].value, case .string(let id) = value["workspaceProjectId"] { return id }
        return ""
    }
    func selectWorkspaceProject(_ project: String, conversation: UUID?) throws {
        guard !busy, accountID == session?.accountID, let conversation, journal != nil,
              project.isEmpty || cloudProjects.contains(where: { $0.id == project }) else { throw NativeAgentClientError.invalidRequest }
        let id = conversation.uuidString.lowercased()
        guard journal!.workspaceMutations?[id] == nil, let heads = cloudObjects[id], heads.count == 1,
              heads[0].kind == .session, !heads[0].deleted, !heads[0].erased,
              case .object(var value) = heads[0].value else { throw NativeAgentClientError.invalidRequest }
        if project.isEmpty { value.removeValue(forKey: "workspaceProjectId") } else { value["workspaceProjectId"] = .string(project) }
        let mutation = NativeAgentMutation(operationId: UUID().uuidString.lowercased(), objectId: id,
            versionId: UUID().uuidString.lowercased(), deviceId: journal!.deviceID, kind: .session,
            parents: [heads[0].versionId], deleted: false, value: .object(value))
        let previous = journal
        var selections = journal!.workspaceSelections ?? [:]; selections[id] = project
        var pending = journal!.workspaceMutations ?? [:]; pending[id] = mutation
        journal!.workspaceSelections = selections; journal!.workspaceMutations = pending
        do { try persist() } catch { journal = previous; throw error }
        objectWillChange.send()
    }
    /// Commit selected workspace to the shared session before dispatching its next run.
    /// Unknown HTTP outcomes retry the durable operation, never create another session version.
    private func publishWorkspaceSelection(_ conversation: UUID) async throws {
        let id = conversation.uuidString.lowercased()
        guard let mutation = journal?.workspaceMutations?[id] else { return }
        guard !busy, let account = accountID, let client else { throw NativeAgentClientError.invalidRequest }
        busy = true; let epoch = loginEpoch
        defer { if loginEpoch == epoch { busy = false } }
        let receipts = try await client.mutate(accountID: account, operations: [mutation])
        try check(account, epoch)
        guard receipts.count == 1, let receipt = receipts.first, receipt.operationId == mutation.operationId,
              receipt.versionId == mutation.versionId, !receipt.deleted, receipt.heads == [mutation.versionId] else { throw NativeAgentClientError.invalidResponse }
        let version = NativeAgentChange(operationId: mutation.operationId, objectId: id, versionId: mutation.versionId,
            deviceId: mutation.deviceId, kind: .session, parents: mutation.parents, deleted: false, value: mutation.value,
            cursor: receipt.cursor, erased: false)
        let previous = journal
        var versions = journal!.versions ?? [:]; versions[id] = [version]; journal!.versions = versions
        journal!.workspaceMutations?.removeValue(forKey: id); journal!.workspaceSelections?.removeValue(forKey: id)
        do { try persist() } catch { journal = previous; throw error }
        cloudObjects = versions // Global pull cursor remains unchanged until changes are durably pulled.
    }
    struct CloudMessage: Identifiable {
        let id: Int
        let role: String
        let content: String
    }
    func synchronizedMessages(_ id: UUID?) -> [CloudMessage] {
        guard let id else { return [] }
        let key = id.uuidString.lowercased()
        guard journal?.blockedHistorySessions?.contains(key) != true else { return [] }
        let heads = cloudObjects[key] ?? []
        let messages: [NativeAgentJSON]
        guard heads.isEmpty || (heads.count == 1 && heads[0].kind == .session && !heads[0].deleted && !heads[0].erased) else { return [] }
        messages = journal?.histories?[key] ?? []
        return messages.enumerated().compactMap { index, message in
            guard case .object(let value) = message, case .string(let role) = value["role"],
                  ["user", "assistant"].contains(role), case .string(let content) = value["content"] else { return nil }
            return CloudMessage(id: index, role: role, content: content)
        }
    }
    func newCloudConversation() async throws -> UUID {
        guard !busy, let account = accountID, consent?.cloudEnabled == true, journal != nil else { throw NativeAgentClientError.invalidRequest }
        let id = UUID(), objectID = id.uuidString.lowercased(), epoch = loginEpoch
        journal!.pending.append(.init(operationId: UUID().uuidString.lowercased(), objectId: objectID,
            versionId: UUID().uuidString.lowercased(), deviceId: journal!.deviceID, kind: .session, parents: [], deleted: false,
            value: .object(["title": .string("Nouvelle conversation Cloud"), "messages": .array([])])))
        var titles = journal!.titles ?? [:]; titles[objectID] = "Nouvelle conversation Cloud"; journal!.titles = titles
        try persist()
        busy = true; defer { if loginEpoch == epoch { busy = false } }
        try await flush(account: account, epoch: epoch)
        return id
    }
    func loadModels() async throws {
        guard let account = accountID, let client else { throw NativeAgentClientError.accountMismatch }
        let epoch = loginEpoch
        let catalog = try await client.models(accountID: account)
        try check(account, epoch); models = catalog
        do {
            let relay = try await client.relayModels(accountID: account)
            try check(account, epoch); models = catalog + relay
        } catch NativeAgentClientError.http(503) {
            // Relay is an optional server capability; managed models remain usable.
        }
    }
    var orderedRuns: [NativeAgentRun] { (journal?.runOrder ?? []).compactMap { runs[$0] } }
    func runPrompt(_ id: String) -> String { journal?.runRequests?[id]?.message ?? "" }
    func responseText(_ run: NativeAgentRun) -> String? {
        guard case .object(let result) = run.result, case .string(let response) = result["response"] else { return nil }
        return response
    }
    private func branchID(_ sessionID: String, versions: [String: [NativeAgentChange]]) throws -> String {
        guard let heads = versions[sessionID], heads.count == 1, heads[0].kind == .session,
              !heads[0].deleted, !heads[0].erased else { throw NativeAgentClientError.invalidRequest }
        if case .object(let value) = heads[0].value, let branch = value["branchId"] {
            guard case .string(let id) = branch, UUID(uuidString: id) != nil else { throw NativeAgentClientError.invalidResponse }
            return id
        }
        return sessionID // Explicit legacy imports use the session as their original branch.
    }
    private func validatedHistory(_ raw: NativeAgentJSON?) throws -> [NativeAgentJSON] {
        guard case .array(let history) = raw, !history.isEmpty, history.count <= 1000,
              try JSONEncoder().encode(history).count <= 512 * 1024 else { throw NativeAgentClientError.invalidResponse }
        var pending = Set<String>()
        for message in history {
            guard case .object(let value) = message, case .string(let role) = value["role"],
                  ["system", "user", "assistant", "tool"].contains(role) else { throw NativeAgentClientError.invalidResponse }
            if role == "tool" {
                guard case .string(let id) = value["tool_call_id"], pending.remove(id) != nil else { throw NativeAgentClientError.invalidResponse }
            } else if !pending.isEmpty { throw NativeAgentClientError.invalidResponse }
            if let calls = value["tool_calls"] {
                guard role == "assistant", case .array(let items) = calls else { throw NativeAgentClientError.invalidResponse }
                for item in items {
                    guard case .object(let call) = item, case .string(let id) = call["id"], !id.isEmpty,
                          case .object(let function) = call["function"], case .string = function["name"],
                          case .string = function["arguments"], pending.insert(id).inserted else { throw NativeAgentClientError.invalidResponse }
                }
            }
        }
        guard pending.isEmpty else { throw NativeAgentClientError.invalidResponse }
        return history
    }
    /// Pull status and complete hidden transcripts only. Discovery never creates a run.
    func synchronize() async throws {
        guard !busy, let account = accountID, consent?.cloudEnabled == true, let client, journal != nil else { throw NativeAgentClientError.invalidRequest }
        busy = true; let epoch = loginEpoch
        defer { if loginEpoch == epoch { busy = false } }
        try await flush(account: account, epoch: epoch)
        var more = true
        while more {
            let page = try await client.changes(accountID: account, after: journal!.cursor ?? 0)
            try check(account, epoch)
            var next = journal!
            var versions = next.versions ?? [:]
            for change in page.changes.sorted(by: { $0.cursor < $1.cursor }) {
                var heads = versions[change.objectId] ?? []
                // A tombstone cannot be resurrected by a later stale divergent version.
                if heads.contains(where: { $0.deleted || $0.erased }) && !change.deleted && !change.erased { continue }
                heads.removeAll { change.parents.contains($0.versionId) || $0.versionId == change.versionId }
                if change.deleted || change.erased { heads = [] }
                heads.append(change); versions[change.objectId] = heads
            }
            next.versions = versions; next.cursor = page.cursor
            var histories = next.histories ?? [:], cursors = next.historyCursors ?? [:]
            var states = next.runStates ?? [:]
            var sources = next.historySources ?? [:]
            for (sessionID, sourceID) in sources {
                let source = versions[sourceID] ?? []
                var invalid = source.count != 1 || source[0].deleted || source[0].erased
                if !invalid, sourceID != sessionID, case .object(let value) = source[0].value {
                    if case .string(let branch) = value["branchId"], let expected = try? branchID(sessionID, versions: versions) { invalid = branch != expected }
                    else { invalid = true }
                }
                if invalid {
                    histories.removeValue(forKey: sessionID); cursors.removeValue(forKey: sessionID); sources.removeValue(forKey: sessionID)
                }
            }
            for (id, heads) in versions where heads.count != 1 || heads[0].deleted || heads[0].erased {
                histories.removeValue(forKey: id); cursors.removeValue(forKey: id)
                states = states.filter { $0.value.sessionId != id && $0.key != id }
            }
            let candidates = versions.values.compactMap { heads -> NativeAgentChange? in
                guard heads.count == 1, !heads[0].deleted, !heads[0].erased else { return nil }; return heads[0]
            }.sorted { $0.cursor < $1.cursor }
            let anchoredIDs = Set(candidates.compactMap { change -> String? in
                guard change.kind == .session, case .object(let value) = change.value, value["historyAnchor"] != nil else { return nil }
                return change.objectId
            })
            // Persist the execution block before async source reads. A failed read must not leave
            // an older branch available for a run or display after restart.
            if !anchoredIDs.isEmpty {
                let previous = journal
                journal!.blockedHistorySessions = (journal!.blockedHistorySessions ?? []).union(anchoredIDs)
                do { try persist() } catch { journal = previous; throw error }
            }
            for change in candidates {
                guard case .object(let value) = change.value else { continue }
                if change.kind == .session {
                    if let rawAnchor = value["historyAnchor"] {
                        guard case .object(let anchor) = rawAnchor, anchor["type"] == .string("hermes_history_anchor"),
                              case .string(let sourceBranch) = anchor["sourceBranchId"], UUID(uuidString: sourceBranch) != nil,
                              let currentBranch = try? branchID(change.objectId, versions: versions), sourceBranch != currentBranch else { throw NativeAgentClientError.invalidResponse }
                        let history: [NativeAgentJSON]
                        if anchor["source"] == .string("run"), case .string(let runID) = anchor["runId"], UUID(uuidString: runID) != nil {
                            if let source = versions[runID], source.count != 1 || source[0].deleted || source[0].erased { throw NativeAgentClientError.invalidResponse }
                            let run = try await client.readRun(accountID: account, runID: runID); try check(account, epoch)
                            guard run.state == .completed, run.runId == runID, run.sessionId == change.objectId,
                                  run.branchId == sourceBranch, case .object(let result) = run.result else { throw NativeAgentClientError.invalidResponse }
                            history = try validatedHistory(result["history"])
                        } else if anchor["source"] == .string("message"), case .string(let objectID) = anchor["objectId"],
                                  case .string(let versionID) = anchor["versionId"], let source = versions[objectID], source.count == 1,
                                  source[0].versionId == versionID, source[0].kind == .message, !source[0].deleted, !source[0].erased,
                                  case .object(let payload) = source[0].value, payload["type"] == .string("hermes_local_turn"),
                                  payload["sessionId"] == .string(change.objectId), payload["branchId"] == .string(sourceBranch) {
                            history = try validatedHistory(payload["history"])
                        } else { throw NativeAgentClientError.invalidResponse }
                        if change.cursor >= (cursors[change.objectId] ?? -1) {
                            histories[change.objectId] = history; cursors[change.objectId] = change.cursor; sources[change.objectId] = change.objectId
                        }
                    } else {
                        let source = value["history"] ?? value["messages"]
                        if case .array(let history) = source, change.cursor > (cursors[change.objectId] ?? -1) {
                            histories[change.objectId] = history; cursors[change.objectId] = change.cursor; sources[change.objectId] = change.objectId
                        }
                    }
                    continue
                }
                guard (change.kind == .task || change.kind == .message), case .string(let type) = value["type"],
                      ((type == "hermes_run" && change.kind == .task) || (type == "hermes_local_turn" && change.kind == .message)),
                      case .string(let sessionID) = value["sessionId"],
                      case .string(let branch) = value["branchId"],
                      let expected = try? branchID(sessionID, versions: versions), branch == expected else { continue }
                let history: [NativeAgentJSON]?
                if type == "hermes_run" {
                    guard case .string(let runID) = value["runId"] else { throw NativeAgentClientError.invalidResponse }
                    let run = try await client.readRun(accountID: account, runID: runID)
                    try check(account, epoch)
                    guard run.runId == runID, run.sessionId == sessionID, run.branchId == branch else { throw NativeAgentClientError.invalidResponse }
                    states[runID] = run
                    if run.state == .completed, case .object(let result) = run.result, case .array(let values) = result["history"] { history = values }
                    else { history = nil }
                } else if case .array(let values) = value["history"] { history = values }
                else { history = nil }
                if let history, change.cursor > (cursors[sessionID] ?? -1) {
                    histories[sessionID] = history; cursors[sessionID] = change.cursor; sources[sessionID] = change.objectId
                }
            }
            next.blockedHistorySessions = (next.blockedHistorySessions ?? []).subtracting(anchoredIDs)
            next.histories = histories; next.historyCursors = cursors; next.historySources = sources; next.runStates = states
            let previous = journal; journal = next
            do { try persist() } catch { journal = previous; throw error }
            cloudObjects = versions; runs = states; more = page.hasMore
        }
    }
    /// Creates a new durable turn. Existing device history requires explicit import beforehand.
    func execute(modelID: String, source: NativeAgentRunInput.Model.Source, conversationID: UUID,
                 message: String, accessID: String? = nil, deviceID: String? = nil) async throws -> NativeAgentRun {
        guard !busy, let account = accountID, consent?.cloudEnabled == true, let client, journal != nil,
              source != .device else { throw NativeAgentClientError.invalidRequest }
        guard journal!.blockedHistorySessions?.contains(conversationID.uuidString.lowercased()) != true else { throw NativeAgentClientError.invalidRequest }
        let selectedWorkspace = selectedWorkspaceProject(conversationID)
        guard selectedWorkspace.isEmpty || cloudProjects.contains(where: { $0.id == selectedWorkspace }) else { throw NativeAgentClientError.invalidRequest }
        try await publishWorkspaceSelection(conversationID)
        guard accountID == account, session?.accountID == account, journal != nil else { throw NativeAgentClientError.accountMismatch }
        let sessionID = conversationID.uuidString.lowercased()
        guard journal!.imported.contains(conversationID) || cloudObjects[sessionID]?.count == 1 else { throw NativeAgentClientError.invalidRequest }
        if let heads = cloudObjects[sessionID], heads.count != 1 || heads[0].deleted || heads[0].erased { throw NativeAgentClientError.invalidRequest }
        guard !(journal!.runRequests ?? [:]).values.contains(where: {
            guard $0.sessionId == sessionID else { return false }
            let state = journal!.runStates?[$0.runId]?.state
            return state != .completed && state != .cancelled
        }) else { throw NativeAgentClientError.invalidRequest }
        let branch: String
        if cloudObjects[sessionID] != nil { branch = try branchID(sessionID, versions: cloudObjects) }
        else { branch = sessionID }
        let workspace = selectedWorkspaceProject(conversationID)
        guard workspace.isEmpty || cloudProjects.contains(where: { $0.id == workspace }) else { throw NativeAgentClientError.invalidRequest }
        var billingProject: String?
        if let heads = cloudObjects[sessionID], heads.count == 1, case .object(let value) = heads[0].value,
           let raw = value["projectId"], raw != .null {
            guard case .string(let id) = raw, UUID(uuidString: id) != nil else { throw NativeAgentClientError.invalidResponse }
            billingProject = id
        }
        let request = NativeAgentRunInput(operationId: UUID().uuidString.lowercased(), runId: UUID().uuidString.lowercased(), sessionId: sessionID,
            branchId: branch, projectId: billingProject, workspaceProjectId: workspace.isEmpty ? nil : workspace, model: .init(id: modelID, accessId: accessID, source: source, deviceId: deviceID), message: message, history: journal!.histories?[sessionID])
        let previous = journal
        var requests = journal!.runRequests ?? [:]; requests[request.runId] = request; journal!.runRequests = requests
        var order = journal!.runOrder ?? []; order.append(request.runId); journal!.runOrder = order
        // Journal before network: unknown create outcomes are retried with these same identifiers.
        do { try persist() } catch { journal = previous; throw error }
        busy = true; let epoch = loginEpoch
        defer { if loginEpoch == epoch { busy = false } }
        let run = try await client.createRun(accountID: account, run: request)
        try check(account, epoch); try record(run); return run
    }
    private func record(_ run: NativeAgentRun) throws {
        let previous = journal
        var states = journal!.runStates ?? [:]; states[run.runId] = run; journal!.runStates = states
        if run.state == .completed, previous?.runStates?[run.runId]?.state != .completed, case .object(let result) = run.result, case .array(let history) = result["history"] {
            var histories = journal!.histories ?? [:]; histories[run.sessionId] = history; journal!.histories = histories
        }
        do { try persist() } catch { journal = previous; throw error }
        runs = states
    }
    /// Reconciles status only. awaiting_resolution never triggers a new run or command replay.
    func recoverRuns() async throws {
        guard !busy, let account = accountID, consent?.cloudEnabled == true, let client, journal != nil else { throw NativeAgentClientError.invalidRequest }
        busy = true; let epoch = loginEpoch
        defer { if loginEpoch == epoch { busy = false } }
        try persist()
        for request in (journal!.runOrder ?? []).compactMap({ journal!.runRequests?[$0] }) {
            try check(account, epoch)
            let run: NativeAgentRun
            do { run = try await client.readRun(accountID: account, runID: request.runId) }
            catch NativeAgentClientError.http(404) {
                // Only an unacknowledged creation may be retried. A missing known run must not replay work.
                guard journal!.runStates?[request.runId] == nil else { throw NativeAgentClientError.http(404) }
                run = try await client.createRun(accountID: account, run: request)
            }
            try check(account, epoch); try record(run)
            if journal!.pendingCancels?.contains(request.runId) == true {
                let cancelled = try await client.cancelRun(accountID: account, runID: request.runId)
                try check(account, epoch); try record(cancelled)
                journal!.pendingCancels?.remove(request.runId); try persist()
            }
        }
    }
    func cancel(runID: String) async throws {
        guard !busy, let account = accountID, let client, journal?.runRequests?[runID] != nil else { throw NativeAgentClientError.invalidRequest }
        var cancels = journal!.pendingCancels ?? []; cancels.insert(runID); journal!.pendingCancels = cancels
        try persist()
        busy = true; let epoch = loginEpoch
        defer { if loginEpoch == epoch { busy = false } }
        let run = try await client.cancelRun(accountID: account, runID: runID)
        try check(account, epoch); try record(run)
        journal!.pendingCancels?.remove(runID); try persist()
    }
    func poll(runID: String, intervalNanoseconds: UInt64 = 2_000_000_000) async throws -> NativeAgentRun {
        let epoch = loginEpoch
        guard let account = accountID else { throw NativeAgentClientError.accountMismatch }
        while true {
            try check(account, epoch)
            try await recoverRuns()
            guard let run = runs[runID] else { throw NativeAgentClientError.invalidResponse }
            switch run.state {
            case .completed, .cancelled, .awaiting_resolution, .waiting_device: return run
            case .queued, .running: try await Task.sleep(nanoseconds: intervalNanoseconds)
            }
        }
    }

}
