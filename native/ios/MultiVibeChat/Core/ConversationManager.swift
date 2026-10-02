import CryptoKit
import Foundation
import Observation
import CryptoKit
import Network

/// Injectable boundary so rotation races can be exercised without real tokens,
/// network requests, or changes to the user's Keychain.
@MainActor struct SessionServices {
    var writeHistory: (Data, URL) throws -> Void = { data, url in
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var file = url; try file.setResourceValues(values)
    }
    var load: () -> NativeSession? = { SecureStore.load() }
    var save: (NativeSession) throws -> Void = { try SecureStore.save($0) }
    var clear: () -> Void = { SecureStore.clear() }
    var refresh: @MainActor (NativeSession) async throws -> NativeSession = { try await ChatAPI.shared.refresh($0) }
    var revoke: @MainActor (String) async throws -> Void = { try await ChatAPI.shared.revoke(token: $0) }
    var readHistory: @MainActor (String) async throws -> AccountHistorySnapshot = { try await ChatAPI.shared.history(token: $0) }
    var saveHistory: @MainActor (AccountHistorySnapshot, String) async throws -> AccountHistorySnapshot = { try await ChatAPI.shared.saveHistory($0, token: $1) }
    var stream: @MainActor (String, [ChatMessage], String, @Sendable (String) async -> Void) async throws -> Void = {
        try await ChatAPI.shared.stream(model: $0, messages: $1, token: $2, onDelta: $3)
    }
    var hermesChanges: @MainActor (Int64,String) async throws -> CloudAgentPage = { try await ChatAPI.shared.hermesChanges(after:$0,token:$1) }
    var hermesMutations: @MainActor (String,[CloudAgentMutation],String) async throws -> CloudAgentReceipts = { try await ChatAPI.shared.hermesMutations(accountId:$0,operations:$1,token:$2) }
    var hermesConsent: @MainActor (String) async throws -> CloudHermesConsent = { try await ChatAPI.shared.hermesConsent(token:$0) }
    var hermesEnable: @MainActor (String, Int, String) async throws -> CloudHermesConsent = { try await ChatAPI.shared.hermesSetConsent(accountId:$0,revision:$1,enabled:true,token:$2) }
    var hermesAuthorizeSources: @MainActor (String,Int,[String],String) async throws -> CloudHermesConsent = { try await ChatAPI.shared.hermesSetConsent(accountId:$0,revision:$1,enabled:true,token:$3,exportSources:$2) }
    var hermesLocalCheckpoint: @Sendable (HermesRunContext) async throws -> String? = { try await HermesCheckpointStore.shared.completedMessages($0,engine:CloudHermesBinding.mobileEngine) }
    var hermesPrepare: @MainActor (String, CloudHermesBinding, String) async throws -> Void = { try await ChatAPI.shared.hermesPrepare(accountId:$0,binding:$1,token:$2) }
    var hermesCreate: @MainActor (String, CloudHermesRunInput, String) async throws -> CloudHermesRun = { try await ChatAPI.shared.hermesRun(accountId:$0,run:$1,token:$2) }
    var hermesRead: @MainActor (String, String, String, Bool) async throws -> CloudHermesRun = { try await ChatAPI.shared.hermesRead(accountId:$0,runId:$1,token:$2,cancel:$3) }
    var remoteHermesModel: @MainActor (String,String) async throws -> CloudHermesModel = { model,token in
        if model.hasPrefix("relay/") { return try CloudHermesModel.selected(model,access:nil) }
        let reply = try await ChatAPI.shared.modelAccess(model:model,token:token)
        guard let cloud = reply.data.first(where: { $0.method == "cloud" && $0.state == "ready" && $0.modelId == model }) else { throw APIError.server(409,"model_access_unavailable") }
        return try CloudHermesModel.selected(model,access:cloud.selection)
    }
    var hermesPollDelay: @Sendable () async throws -> Void = { try await Task.sleep(for:.seconds(1.5)) }
    var streamAccess: (@MainActor (String, SelectedModelAccess?, [ChatMessage], String, @Sendable (String) async -> Void) async throws -> Void)?
    var readLocalHistory: @MainActor (URL) throws -> Data = { try Data(contentsOf: $0) }
    var localAvailability: @MainActor () -> String? = { LocalModel.unavailableReason }
    var downloadedModels: @MainActor () -> [ModelOption] = { LocalModelLibrary.shared.installed.map(\.option) }
    var downloadedAvailability: @MainActor (String) -> String? = { id in
        LocalModelLibrary.shared.installation(id)?.state == .installed ? nil : "Téléchargez ce modèle pour l’utiliser sur cet appareil."
    }
    var downloadedRespond: @MainActor (String, [ChatMessage], LocalAgentWorkspace?, @escaping @Sendable (String) async -> Void) async throws -> Void = { id, messages, workspace, delta in
        guard let entry = LocalModelLibrary.shared.installation(id), entry.state == .installed else {
            throw LocalAgentError.unavailable("Téléchargez ce modèle pour l’utiliser sur cet appareil.")
        }
        try await DownloadedModelRuntime.shared.respond(model: LocalModelLibrary.shared.validated(entry.model), path: LocalModelLibrary.shared.file(entry.model),
            messages: messages, workspace: workspace, onText: delta)
    }

    var localRespond: @Sendable ([ChatMessage], LocalAgentWorkspace, @escaping @Sendable (String) async -> Void) async throws -> Void = {
        try await LocalAgent.respond(messages: $0, workspace: $1, onText: $2)
    }
    var webFetch: @Sendable (URL, String) async throws -> LocalWebResponse = { try await LocalWebFetch.fetch(url: $0, method: $1) }
    var memoryIndex: @MainActor (URL) throws -> MemoryIndex = { try MemoryIndex(url: $0) }
    var reviewLocalMemory: @Sendable (String) async throws -> String = { try await LocalAgent.reviewMemory($0) }
    /// Dedicated, workspace-free title summarization for local and downloaded
    /// models. It never reuses the chat responder, which expects a real turn.
    var summarizeTitle: @Sendable (String, String) async throws -> String = { model, prompt in
        try await TitleSummarizer.summarize(model: model, prompt: prompt)
    }
    var memoryReviewDelay: @Sendable () async throws -> Void = { try await Task.sleep(for: .seconds(2)) }
    var monitorConnectivity = true
    var syncDelay: @Sendable (Int) async throws -> Void = { attempt in try await Task.sleep(for: .seconds(min(60, 2 << attempt))) }
    var models: @MainActor (String) async throws -> [ModelOption] = { try await ChatAPI.shared.models(token: $0) }
    var lastUsedModel: @MainActor (String) -> String? = { LastUsedModelStore.model(for: $0) }
    var rememberLastUsedModel: @MainActor (String, String) -> Void = { LastUsedModelStore.save($0, for: $1) }
}

@MainActor @Observable final class ConversationManager {
    static let shared = makeShared()
    private static func makeShared() -> ConversationManager {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-local-agent-ui-fixture") {
            // Deterministic UI transport: no account, disk data, live inference, or network.
            let manager = ConversationManager(services: SessionServices(writeHistory: { _, _ in }, load: { nil },
                readLocalHistory: { _ in throw CocoaError(.fileReadNoSuchFile) }, localAvailability: { nil },
                localRespond: { _, workspace, output in
                    if ProcessInfo.processInfo.arguments.contains("-local-agent-ui-immediate-reply") {
                        await output("FIXTURE-REPLY")
                        return
                    }
                    let result = try await workspace.execute(action: "fetch_website", query: "https://example.com", documentID: "", text: "", lhs: 0, rhs: 0)
                    await output(result)
                }, webFetch: { url, _ in
                    LocalWebResponse(url: url, status: 200, contentType: "text/plain", text: "EXAMPLE-FETCH-SUCCEEDED")
                }, memoryIndex: { _ in try MemoryIndex(url: nil) }, monitorConnectivity: false))
            if ProcessInfo.processInfo.arguments.contains("-native-intent-local-draft") {
                manager.queueNativeShortcut(.init(localDraft: "NATIVE-SHORTCUT-DRAFT"))
            }
            if ProcessInfo.processInfo.arguments.contains("-native-intent-memory") {
                manager.queueNativeShortcut(.init(memoryText: "NATIVE-SHORTCUT-MEMORY"))
            }
            return manager
        }
        #endif
        return ConversationManager()
    }
    private let services: SessionServices
    var localUnavailableReason: String? { services.localAvailability() }
    var localDocuments: [LocalDocument] = []
    var localEvents: [LocalAgentEvent] = []
    var calendarEnabled = false
    var remindersEnabled = false
    var automaticSync = false
    var memorySyncEnabled = false
    private(set) var memoryRecords: [AgentMemory] = []
    private var memoryBaseline: [AgentMemory] = []
    private var memoryIndex: MemoryIndex?
    var memoryError: String?
    var memoryPresented = false
    var memoryDraft: MemoryDraft?
    private var memoryReviews: [UUID: Task<Void, Never>] = [:]
    /// One background title request per conversation; never blocks the main reply.
    private var titleTasks: [UUID: Task<Void, Never>] = [:]
    var memoryItems: [MemoryItem] { MemoryPolicy.items(memoryRecords) }

    struct HermesRecovery {
        let context: HermesRunContext
        let replyID: UUID
        let accountRevision: UUID
        let detail: String
    }
    var hermesRecovery: HermesRecovery?
    private var remoteHermes: [String: RemoteHermesSession] = [:]
    private(set) var remoteHermesBusy = false
    private(set) var remoteHermesError: String?
    private var cloudAgentState: CloudAgentState?
    private(set) var cloudAgentSyncing = false
    private(set) var cloudAgentSyncError: String?
    struct CloudAgentSummary:Identifiable {
        let id:String;let kind:String;let title:String;let conflicted:Bool;let deleted:Bool;let value:HistoryJSON?
    }
    var cloudAgentObjects:[CloudAgentSummary] {
        (cloudAgentState?.objects ?? [:]).map { id,object in
            let value = object.heads.count == 1 ? object.versions[object.heads[0]]?.value : nil
            return CloudAgentSummary(id:id,kind:object.kind,title:value?.object?["title"]?.string ?? value?.object?["target"]?.string ?? object.kind,
                conflicted:object.heads.count > 1,deleted:object.deleted,value:value)
        }.sorted { $0.id < $1.id }
    }
    private(set) var discoveredCloudRuns:[String:CloudHermesRun] = [:]
    /// State-only journal exchange: never starts, resumes or replays an execution.
    func synchronizeCloudAgentState() async {
        guard !cloudAgentSyncing, !isRestoring, storageLoaded, session != nil else { return }
        let epoch=sessionRevision;cloudAgentSyncing=true
        defer { if sessionRevision == epoch { cloudAgentSyncing=false } }
        do {
            let auth=try await validSession()
            if cloudAgentState == nil {
                cloudAgentState=CloudAgentState(accountId:auth.accountId,deviceId:UUID().uuidString.lowercased())
                guard persist() else { throw APIError.server(0,"history_cache_write_failed") }
            }
            guard cloudAgentState?.accountId == auth.accountId else { throw APIError.invalidResponse }
            func current() throws {
                guard sessionRevision == epoch, session?.accountId == auth.accountId else { throw CancellationError() }
                try Task.checkCancellation()
            }
            func pull() async throws {
                while let state=cloudAgentState {
                    try current()
                    let page=try await services.hermesChanges(state.cursor,auth.accessToken)
                    try current()
                    // Rebase on current journal so local enqueue during network I/O is retained.
                    let previous=cloudAgentState!
                    let previousRemote = remoteHermes
                    cloudAgentState=try previous.applying(page)
                    for (id, object) in cloudAgentState!.objects where object.deleted {
                        remoteHermes[id] = nil
                        for old in previous.objects[id]?.versions.values ?? Dictionary<String,CloudAgentChange>().values {
                            if let owner = old.value?.object?["sessionId"]?.string { remoteHermes[owner] = nil }
                        }
                    }
                    guard persist() else { remoteHermes=previousRemote;cloudAgentState=previous;throw APIError.server(0,"history_cache_write_failed") }
                    if !page.hasMore { break }
                }
            }
            try await pull()
            let consent=try await services.hermesConsent(auth.accessToken);try current()
            guard consent.accountId == auth.accountId else { throw APIError.invalidResponse }
            if consent.cloudEnabled {
                try await reconcileLocalTurns(consent:consent,epoch:epoch)
                try current()
                while let state=cloudAgentState, !state.outbox.isEmpty {
                    var batch:[CloudAgentMutation]=[]
                    let blockedLocalSessions = Set(state.outbox.compactMap { operation -> String? in
                        guard let source = operation.value?.object?["localSource"]?.string else { return nil }
                        let owner = operation.kind == "session" ? operation.objectId : operation.value?.object?["sessionId"]?.string
                        let approved = (consent.exportSources ?? []).contains(source) && cloudHermesBindings.values.contains(where: { $0.accountId == auth.accountId && $0.permitsLocalOperation(operation) })
                        return approved ? nil : owner
                    })
                    let allowed = state.outbox.filter { operation in
                        guard let source = operation.value?.object?["localSource"]?.string else { return true }
                        guard let owner = operation.kind == "session" ? operation.objectId : operation.value?.object?["sessionId"]?.string else { return false }
                        return !blockedLocalSessions.contains(owner) && (consent.exportSources ?? []).contains(source)
                    }
                    if allowed.isEmpty { break }
                    for operation in allowed.prefix(100) {
                        if try JSONEncoder().encode(batch+[operation]).count > 900_000 { break }
                        batch.append(operation)
                    }
                    guard !batch.isEmpty else { throw APIError.server(413,"agent_batch_too_large") }
                    let reply=try await services.hermesMutations(auth.accountId,batch,auth.accessToken);try current()
                    let previous=cloudAgentState!
                    cloudAgentState=try previous.acknowledging(reply,submitted:batch)
                    guard persist() else { cloudAgentState=previous;throw APIError.server(0,"history_cache_write_failed") }
                }
                try await pull()
            }
            let liveRunIDs=Set(cloudAgentObjects.filter{$0.kind == "task" && !$0.deleted && !$0.conflicted}.compactMap{$0.value?.object?["runId"]?.string})
            discoveredCloudRuns=discoveredCloudRuns.filter{liveRunIDs.contains($0.key)}
            for object in cloudAgentObjects where object.kind == "task" && !object.deleted && !object.conflicted {
                guard let value=object.value?.object,value["type"]?.string == "hermes_run",let runID=value["runId"]?.string else { continue }
                let run=try await services.hermesRead(auth.accountId,runID,auth.accessToken,false);try current()
                guard run.sessionId == value["sessionId"]?.string,run.branchId == value["branchId"]?.string else { throw APIError.invalidResponse }
                discoveredCloudRuns[runID]=run // Separate from legacy conversations and their sync.
            }
            cloudAgentSyncError=nil
        } catch { if sessionRevision == epoch { cloudAgentSyncError=error.localizedDescription } }
    }
    var currentLocalHermesExportApproved: Bool {
        guard let id=selection,let binding=cloudHermesBindings[id],binding.accountId == session?.accountId else { return false }
        return Set(CloudHermesBinding.localSources).isSubset(of:Set(binding.localExportSources ?? []))
    }
    var currentCloudContextSelection: (memory:[String],skills:[String],files:[String],project:String?) {
        guard let id=selection,let binding=cloudHermesBindings[id],binding.accountId == session?.accountId else { return ([],[],[],nil) }
        return (binding.contextMemoryIDs ?? [],binding.contextSkillIDs ?? [],binding.contextFileIDs ?? [],binding.contextProjectID)
    }
    func localHermesSeed(conversation id: UUID, input: [ChatMessage], epoch: UUID) async throws -> (history: [HistoryJSON]?, context: String) {
        guard let binding = cloudHermesBindings[id], binding.accountId == session?.accountId else { return (nil,"") }
        guard binding.pending == nil, let currentTurn = input.last(where: { $0.role == "user" }) else { throw APIError.server(409,"hermes_pending_run_requires_recovery") }
        let account = binding.accountId
        var history = binding.history
        for turn in binding.localTurns ?? [] where !turn.published && turn.turnId != currentTurn.id {
            let context = HermesRunContext(accountID:account,conversationID:id,turnID:turn.turnId,modelID:turn.modelId,source:turn.source)
            guard let raw = try await services.hermesLocalCheckpoint(context) else { throw APIError.server(409,"hermes_local_checkpoint_requires_recovery") }
            guard sessionRevision == epoch, session?.accountId == account, conversations.contains(where: { $0.id == id }) else { throw CancellationError() }
            let messages = try JSONDecoder().decode([HistoryJSON].self,from:Data(raw.utf8))
            try RemoteHermesSession.validateHistory(messages)
            guard let start = messages.lastIndex(where: { $0.object?["role"]?.string == "user" }) else { throw APIError.invalidResponse }
            history = history.isEmpty ? messages : history + Array(messages[start...])
        }
        var context = ""
        if !(binding.contextMemoryIDs ?? []).isEmpty || !(binding.contextSkillIDs ?? []).isEmpty || !(binding.contextFileIDs ?? []).isEmpty {
            guard let state = cloudAgentState else { throw APIError.invalidResponse }
            let snapshot = try CloudHermesContext.build(state:state,accountID:account,projectID:binding.contextProjectID,
                memoryObjectIDs:binding.contextMemoryIDs ?? [],skillObjectIDs:binding.contextSkillIDs ?? [],fileObjectIDs:binding.contextFileIDs ?? [])
            context = [snapshot.memory,snapshot.skills,snapshot.files].filter { !$0.isEmpty }.joined(separator:"\n\n")
        }
        guard sessionRevision == epoch, session?.accountId == account else { throw CancellationError() }
        if history.isEmpty { return (nil,context) }
        history.append(.object(["role":.string("user"),"content":.string(currentTurn.content)]))
        try RemoteHermesSession.validateHistory(history)
        return (history,context)
    }
    /// State-only reconciliation. Checkpoints are read without creating leases or invoking tools/models.
    private func reconcileLocalTurns(consent: CloudHermesConsent, epoch: UUID) async throws {
        let account = consent.accountId
        for (id, captured) in cloudHermesBindings where captured.accountId == account && captured.cloudAuthorized != false {
            for (index, turn) in (captured.localTurns ?? []).enumerated() where !turn.published {
                guard (captured.localExportSources ?? []).contains(turn.source), (consent.exportSources ?? []).contains(turn.source) else { break }
                guard captured.pending == nil else { throw APIError.server(409,"hermes_pending_run_requires_recovery") }
                let context = HermesRunContext(accountID:account,conversationID:id,turnID:turn.turnId,modelID:turn.modelId,source:turn.source)
                guard let checkpoint = try await services.hermesLocalCheckpoint(context) else { break }
                guard sessionRevision == epoch, session?.accountId == account,
                    var binding = cloudHermesBindings[id], binding.accountId == account,
                    binding.localTurns?.indices.contains(index) == true, binding.pending == nil,
                    (binding.localExportSources ?? []).contains(turn.source), binding.cloudAuthorized != false,
                    binding.localTurns?[index].turnId == turn.turnId, binding.localTurns?[index].published == false,
                    conversations.contains(where: { $0.id == id }) else { throw CancellationError() }
                let history = try JSONDecoder().decode([HistoryJSON].self,from:Data(checkpoint.utf8))
                guard var state = cloudAgentState, state.accountId == account else { throw APIError.invalidResponse }
                let previousState = state, previousBinding = binding
                // The first session version is durable and idempotent; later local parents never rebase automatically.
                if state.objects[binding.sessionId] == nil && !state.outbox.contains(where: { $0.objectId == binding.sessionId }) {
                    try state.enqueue(.init(operationId:binding.operationId,objectId:binding.sessionId,versionId:binding.versionId,deviceId:binding.deviceId,kind:"session",parents:[],deleted:false,
                        value:.object(["type":.string("hermes_session"),"branchId":.string(binding.branchId),"conversationId":.string(binding.conversationId),"title":.string("Hermes chat"),"localSource":.string(turn.source)])))
                }
                for operation in try binding.localPublication(index:index,checkpoint:history) { try state.enqueue(operation) }
                cloudAgentState = state; cloudHermesBindings[id] = binding
                guard persist() else { cloudAgentState = previousState; cloudHermesBindings[id] = previousBinding; throw APIError.server(0,"history_cache_write_failed") }
            }
        }
    }
    var remoteHermesModels: [ModelOption] { models.filter { !ModelExecution($0.id).isLocal && !$0.id.hasPrefix("personal/") } }
    private func remoteBase(_ id: String) throws -> (branch: String, history: [HistoryJSON], cursor: Int64, heads: [String]) {
        guard CloudAgentState.uuid(id), let state = cloudAgentState, state.accountId == session?.accountId,
            let object = state.objects[id], object.kind == "session", !object.deleted, object.heads.count == 1,
            let version = object.versions[object.heads[0]], let value = version.value?.object,
            let branch = value["branchId"]?.string, CloudAgentState.uuid(branch) else { throw APIError.server(409,"hermes_session_conflict_or_missing") }
        var history: [HistoryJSON] = [], cursor: Int64 = 0
        if let local = value["localTurnId"]?.string {
            guard CloudAgentState.uuid(local), let message = state.objects[local], message.kind == "message", !message.deleted,
                message.heads.count == 1, let raw = message.versions[message.heads[0]]?.value?.object,
                raw["type"]?.string == "hermes_local_turn", raw["sessionId"]?.string == id, raw["branchId"]?.string == branch,
                raw["turnId"]?.string == local, let saved = raw["history"]?.array else { throw APIError.server(409,"hermes_local_checkpoint_conflict") }
            history = saved; cursor = message.versions[message.heads[0]]!.cursor
        } else if let saved = value["messages"]?.array { history = saved }
        for task in state.objects.values where task.kind == "task" && !task.deleted {
            for head in task.heads {
                guard let change = task.versions[head], let raw = change.value?.object,
                    raw["sessionId"]?.string == id, raw["branchId"]?.string == branch else { continue }
                guard task.heads.count == 1, let runID = raw["runId"]?.string, CloudAgentState.uuid(runID),
                    let run = discoveredCloudRuns[runID], run.sessionId == id, run.branchId == branch,
                    ["completed","cancelled"].contains(run.state) else { throw APIError.server(409,"hermes_remote_run_requires_recovery") }
                if change.cursor > cursor, let result = run.result, run.state == "completed" { history = result.history; cursor = change.cursor }
            }
        }
        if let local = remoteHermes[id] {
            guard local.accountId == state.accountId, local.branchId == branch else { throw APIError.invalidResponse }
            for request in local.requests {
                guard let run = local.results[request.input.runId], run.state == "completed", let result = run.result else { continue }
                if request.baseCursor >= cursor { history = result.history }
            }
        }
        try RemoteHermesSession.validateHistory(history)
        return (branch,history,cursor,object.heads)
    }
    func remoteHermesWorkspaceProject(_ id: String) -> String {
        guard let object=cloudAgentState?.objects[id],object.heads.count == 1,!object.deleted,
            let value=object.versions[object.heads[0]]?.value?.object else { return id }
        return value["workspaceProjectId"]?.string ?? value["projectId"]?.string ?? id
    }
    func remoteHermesTranscript(_ id: String) -> [HistoryJSON] { (try? remoteBase(id).history) ?? [] }
    func remoteHermesPrompt(sessionId: String, runId: String) -> String { remoteHermes[sessionId]?.requests.first { $0.input.runId == runId }?.input.message ?? "" }
    func remoteHermesRuns(_ id: String) -> [CloudHermesRun] {
        guard let local = remoteHermes[id], local.accountId == session?.accountId else { return [] }
        return local.requests.compactMap { local.results[$0.input.runId] }
    }
    func sendRemoteHermes(sessionId id: String, model: String, message: String, workspaceProjectId: String? = nil) async throws {
        guard !remoteHermesBusy, remoteHermesModels.contains(where: { $0.id == model }), !message.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,
            message.count <= 32_000 else { throw APIError.invalidResponse }
        let epoch = sessionRevision, expectedAccount = session?.accountId
        await synchronizeCloudAgentState()
        guard sessionRevision == epoch, session?.accountId == expectedAccount else { throw CancellationError() }
        guard cloudAgentSyncError == nil, !remoteHermesBusy else { throw APIError.server(409,"hermes_session_sync_required") }
        remoteHermesBusy = true
        defer { if sessionRevision == epoch { remoteHermesBusy = false } }
        let auth = try await validSession()
        let consent = try await services.hermesConsent(auth.accessToken)
        let selected = try await services.remoteHermesModel(model,auth.accessToken)
        guard sessionRevision == epoch, session?.accountId == auth.accountId, consent.accountId == auth.accountId,
            consent.cloudEnabled, ["cloud","relay"].contains(selected.source) else { throw APIError.server(403,"agent_cloud_consent_required") }
        var base = try remoteBase(id)
        let metadata = cloudAgentState?.objects[id]?.versions[base.heads[0]]?.value?.object
        let billingProjectID = metadata?["projectId"]?.string
        guard billingProjectID == nil || CloudAgentState.uuid(billingProjectID!) else { throw APIError.invalidResponse }
        let selectedWorkspace = workspaceProjectId ?? metadata?["workspaceProjectId"]?.string
        let projectID = selectedWorkspace ?? billingProjectID ?? id
        if let selectedWorkspace {
            guard CloudAgentState.uuid(selectedWorkspace), let project=cloudAgentState?.objects[selectedWorkspace],
                ["project","session"].contains(project.kind), !project.deleted, project.heads.count == 1 else { throw APIError.server(409,"hermes_workspace_project_unavailable") }
        }
        if workspaceProjectId != nil && projectID != remoteHermesWorkspaceProject(id) {
            guard let state=cloudAgentState, let object=state.objects[id],
                var value=object.versions[base.heads[0]]?.value?.object else { throw APIError.invalidResponse }
            value["workspaceProjectId"] = .string(projectID)
            try enqueueCloudAgentMutation(.init(operationId:UUID().uuidString.lowercased(),objectId:id,versionId:UUID().uuidString.lowercased(),deviceId:state.deviceId,
                kind:"session",parents:base.heads,deleted:false,value:.object(value)))
            await synchronizeCloudAgentState()
            guard sessionRevision == epoch, session?.accountId == auth.accountId, cloudAgentSyncError == nil,
                remoteHermesWorkspaceProject(id) == projectID else { throw APIError.server(409,"hermes_workspace_selection_sync_required") }
            base = try remoteBase(id)
        }
        var local = remoteHermes[id] ?? RemoteHermesSession(accountId:auth.accountId,sessionId:id,branchId:base.branch)
        guard local.requests.allSatisfy({ ["completed","cancelled"].contains(local.results[$0.input.runId]?.state ?? "") }) else { throw APIError.server(409,"hermes_pending_run_requires_recovery") }
        let input = CloudHermesRunInput(operationId:UUID().uuidString.lowercased(),runId:UUID().uuidString.lowercased(),sessionId:id,branchId:base.branch,
            model:selected,message:message,history:base.history,workspaceProjectId:selectedWorkspace,projectId:billingProjectID)
        let previous = remoteHermes[id]
        local.requests.append(.init(input:input,baseCursor:cloudAgentState!.cursor,sessionHeads:base.heads)); remoteHermes[id] = local
        guard persist() else { remoteHermes[id] = previous; throw APIError.server(0,"history_cache_write_failed") }
        try await reconcileRemote(id,auth:auth,epoch:epoch)
    }
    private func reconcileRemote(_ id: String, auth: NativeSession, epoch: UUID) async throws {
        guard let captured = remoteHermes[id], captured.accountId == auth.accountId else { return }
        for request in captured.requests {
            try Task.checkCancellation()
            guard sessionRevision == epoch, session?.accountId == auth.accountId, remoteHermes[id] != nil else { throw CancellationError() }
            guard let object = cloudAgentState?.objects[id], !object.deleted, object.heads.count == 1 else { throw APIError.server(409,"hermes_session_conflict_or_missing") }
            let input = request.input
            if let known = remoteHermes[id]?.results[input.runId], ["completed","cancelled"].contains(known.state), remoteHermes[id]?.cancellations.contains(input.runId) != true { continue }
            var run: CloudHermesRun
            do { run = try await services.hermesRead(auth.accountId,input.runId,auth.accessToken,false) }
            catch APIError.server(let status, _) where status == 404 {
                guard remoteHermes[id]?.results[input.runId] == nil, let state = cloudAgentState,
                    let object = state.objects[id], !object.deleted, object.heads == request.sessionHeads else { throw APIError.server(409,"hermes_remote_request_conflict") }
                if remoteHermes[id]?.cancellations.contains(input.runId) == true {
                    run = CloudHermesRun(runId:input.runId,sessionId:id,branchId:input.branchId,state:"cancelled",generation:0,result:nil)
                    let previous = remoteHermes[id]
                    remoteHermes[id]?.results[input.runId] = run; remoteHermes[id]?.cancellations.remove(input.runId)
                    guard persist() else { remoteHermes[id] = previous; throw APIError.server(0,"history_cache_write_failed") }
                    continue
                }
                let consent = try await services.hermesConsent(auth.accessToken)
                guard sessionRevision == epoch, consent.accountId == auth.accountId, consent.cloudEnabled else { throw APIError.server(403,"agent_cloud_consent_required") }
                run = try await services.hermesCreate(auth.accountId,input,auth.accessToken)
            }
            guard sessionRevision == epoch, session?.accountId == auth.accountId, var live = remoteHermes[id], live.accountId == auth.accountId,
                run.runId == input.runId, run.sessionId == id, run.branchId == input.branchId else { throw CancellationError() }
            if let result = run.result { try RemoteHermesSession.validateHistory(result.history) }
            if live.cancellations.contains(input.runId) {
                run = try await services.hermesRead(auth.accountId,input.runId,auth.accessToken,true)
                guard sessionRevision == epoch, session?.accountId == auth.accountId, remoteHermes[id] != nil,
                    run.runId == input.runId, run.sessionId == id, run.branchId == input.branchId else { throw CancellationError() }
                live.cancellations.remove(input.runId)
            }
            let previous = remoteHermes[id]; live.results[input.runId] = run; remoteHermes[id] = live
            guard persist() else { remoteHermes[id] = previous; throw APIError.server(0,"history_cache_write_failed") }
        }
    }
    func recoverRemoteHermes() async {
        guard !remoteHermesBusy, !remoteHermes.isEmpty, session != nil else { return }
        remoteHermesBusy = true; let epoch = sessionRevision
        defer { if sessionRevision == epoch { remoteHermesBusy = false } }
        do {
            let auth = try await validSession()
            for id in remoteHermes.keys.sorted() { try await reconcileRemote(id,auth:auth,epoch:epoch) }
            remoteHermesError = nil
        } catch { if sessionRevision == epoch { remoteHermesError = error.localizedDescription } }
    }
    func cancelRemoteHermes(sessionId: String, runId: String) async throws {
        guard !remoteHermesBusy, var local = remoteHermes[sessionId], local.accountId == session?.accountId,
            local.requests.contains(where: { $0.input.runId == runId }) else { throw APIError.invalidResponse }
        let previous = local; local.cancellations.insert(runId); remoteHermes[sessionId] = local
        guard persist() else { remoteHermes[sessionId] = previous; throw APIError.server(0,"history_cache_write_failed") }
        await recoverRemoteHermes()
    }
    /// Call only for explicitly authorized Hermes content; local documents/memory are never auto-enqueued.
    func enqueueCloudAgentMutation(_ operation:CloudAgentMutation) throws {
        guard var state=cloudAgentState,state.accountId == session?.accountId else { throw APIError.invalidResponse }
        let previous=state;try state.enqueue(operation);cloudAgentState=state
        guard persist() else { cloudAgentState=previous;throw APIError.server(0,"history_cache_write_failed") }
    }
    private var cloudHermesBindings: [UUID: CloudHermesBinding] = [:]
    private(set) var cloudHermesRecoveryRun: String?
    private(set) var cloudHermesStatus: [UUID:String] = [:]
    private var cloudHermesRestoreTask: Task<Void,Never>?
    var currentCloudHermesAuthorized: Bool { guard let id = selection else { return false }; return cloudHermesBindings[id]?.accountId == session?.accountId && cloudHermesBindings[id]?.cloudAuthorized != false && session != nil }
    var currentCloudHermesStatus: String? { selection.flatMap { cloudHermesStatus[$0] } }
    var currentCloudHermesPending: Bool { selection.flatMap { cloudHermesBindings[$0]?.pending } != nil }
    func resumeCloudHermes() async {
        guard !isRestoring, storageLoaded, !isStreaming, session != nil else { return }
        if let task = cloudHermesRestoreTask { await task.value; return }
        let revision = sessionRevision
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                var auth = try await validSession()
                let deadline = Date().addingTimeInterval(9 * 60)
                for (id,saved) in cloudHermesBindings where saved.accountId == auth.accountId && saved.pending != nil {
                    guard sessionRevision == revision, session?.accountId == auth.accountId, !isStreaming else { return }
                    guard let pending = saved.pending else { continue }
                    do {
                        var result = try await services.hermesRead(auth.accountId,pending.runId,auth.accessToken,false)
                        while ["queued","running","waiting_device"].contains(result.state) {
                            guard !Task.isCancelled, sessionRevision == revision, session?.accountId == auth.accountId, !isStreaming else { return }
                            guard Date() < deadline else { throw APIError.server(409,"hermes_recovery_pending") }
                            guard cloudHermesBindings[id]?.pending?.runId == pending.runId,
                                cloudHermesStatus[id] != "cancelled", cloudHermesStatus[id] != "completed" else { break }
                            cloudHermesStatus[id] = result.state
                            try await services.hermesPollDelay()
                            auth = try await validSession()
                            guard sessionRevision == revision, auth.accountId == saved.accountId else { return }
                            result = try await services.hermesRead(auth.accountId,pending.runId,auth.accessToken,false)
                        }
                        guard !Task.isCancelled, sessionRevision == revision, session?.accountId == auth.accountId, !isStreaming else { return }
                        guard cloudHermesBindings[id]?.pending?.runId == pending.runId else { continue }
                        try applyCloudHermesRecovery(result, conversation:id, binding:saved)
                    } catch {
                        guard sessionRevision == revision, session?.accountId == auth.accountId else { return }
                        guard cloudHermesBindings[id]?.pending?.runId == pending.runId else { continue }
                        cloudHermesStatus[id] = "recovery_unavailable"
                        self.error = "Impossible de vérifier l’exécution Hermes. Aucun nouveau lancement n’a été créé. " + error.localizedDescription
                    }
                }
            } catch { if sessionRevision == revision { self.error = error.localizedDescription } }
        }
        cloudHermesRestoreTask = task; await task.value
        if sessionRevision == revision { cloudHermesRestoreTask = nil }
    }
    private func applyCloudHermesRecovery(_ run:CloudHermesRun, conversation id:UUID, binding saved:CloudHermesBinding) throws {
        guard let pending = saved.pending,
            let current = cloudHermesBindings[id], current.accountId == saved.accountId,
            current.pending?.runId == pending.runId,
            cloudHermesStatus[id] != "cancelled", cloudHermesStatus[id] != "completed",
            run.runId == pending.runId, let stableReplyID = UUID(uuidString:run.runId), run.sessionId == saved.sessionId,
            run.branchId == saved.branchId, let index = conversations.firstIndex(where:{$0.id == id}) else { throw APIError.invalidResponse }
        var binding = current
        if run.state == "completed", let completed = run.result {
            guard let turn = binding.turnId, let userIndex = conversations[index].messages.firstIndex(where:{$0.id == turn}),
                conversations[index].messages[userIndex].content == pending.message else { throw APIError.server(409,"hermes_history_conflict") }
            let following = conversations[index].messages.dropFirst(userIndex+1)
            guard following.count <= 1, following.first?.role != "user" else { throw APIError.server(409,"hermes_history_conflict") }
            if let assistant = following.first, !assistant.content.isEmpty && assistant.content != completed.response { throw APIError.server(409,"hermes_history_conflict") }
            if !following.isEmpty { conversations[index].messages[userIndex+1].content = completed.response; conversations[index].messages[userIndex+1].completion = .completed }
            else { conversations[index].messages.append(ChatMessage(id:stableReplyID,role:"assistant",content:completed.response,completion:.completed)) }
            binding.history = completed.history; binding.pending = nil; cloudHermesRecoveryRun = nil
        } else if run.state == "cancelled" { binding.pending = nil; cloudHermesRecoveryRun = nil }
        else if run.state == "awaiting_resolution" { cloudHermesRecoveryRun = run.runId }
        cloudHermesBindings[id] = binding
        cloudHermesStatus[id] = run.state
        guard persist() else { throw APIError.server(0,"history_cache_write_failed") }
    }
    func cancelPendingCloudHermes() async {
        guard let id = selection, let binding = cloudHermesBindings[id], let pending = binding.pending else { return }
        let revision = sessionRevision
        do {
            let auth = try await validSession()
            guard binding.accountId == auth.accountId else { return }
            let run = try await services.hermesRead(auth.accountId,pending.runId,auth.accessToken,true)
            guard sessionRevision == revision, session?.accountId == auth.accountId, !isStreaming else { return }
            try applyCloudHermesRecovery(run,conversation:id,binding:binding)
        } catch { if sessionRevision == revision { self.error = error.localizedDescription } }
    }
    private var activeCloudHermes: (accountId:String, runId:String, token:String)?
    /// Call only after UI has explained server-readable storage and obtained explicit agreement.
    func authorizeHermesCloud(importExistingConversation: Bool, synchronizeLocalTurns: Bool = false, memoryIDs: [String] = [], skillIDs: [String] = [], fileIDs: [String] = [], projectID: String? = nil) async throws {
        guard !isStreaming, let id = selection, let conversation = current else { throw APIError.invalidResponse }
        if !conversation.messages.isEmpty && !importExistingConversation { throw APIError.server(403,"hermes_history_import_required") }
        let revision = sessionRevision, session = try await validSession()
        let consent = try await services.hermesConsent(session.accessToken)
        guard sessionRevision == revision, consent.accountId == session.accountId else { throw CancellationError() }
        if synchronizeLocalTurns {
            let sources = Array(Set((consent.exportSources ?? []) + CloudHermesBinding.localSources)).sorted()
            let enabled = try await services.hermesAuthorizeSources(session.accountId,consent.revision,sources,session.accessToken)
            guard sessionRevision == revision, selection == id, enabled.accountId == session.accountId, enabled.cloudEnabled,
                Set(CloudHermesBinding.localSources).isSubset(of:Set(enabled.exportSources ?? [])) else { throw CancellationError() }
        } else if !consent.cloudEnabled {
            let enabled = try await services.hermesEnable(session.accountId,consent.revision,session.accessToken)
            guard sessionRevision == revision, enabled.accountId == session.accountId, enabled.cloudEnabled else { throw CancellationError() }
        }
        guard sessionRevision == revision, selection == id else { throw CancellationError() }
        let uuid = { UUID().uuidString.lowercased() }
        var binding = cloudHermesBindings[id] ?? CloudHermesBinding(accountId:session.accountId,conversationId:id.uuidString.lowercased(),sessionId:uuid(),branchId:uuid(),operationId:uuid(),versionId:uuid(),deviceId:uuid(),importApproved:importExistingConversation)
        guard binding.accountId == session.accountId else { throw APIError.invalidResponse }
        if !memoryIDs.isEmpty || !skillIDs.isEmpty || !fileIDs.isEmpty {
            guard let state = cloudAgentState else { throw APIError.invalidResponse }
            _ = try CloudHermesContext.build(state:state,accountID:session.accountId,projectID:projectID,memoryObjectIDs:memoryIDs,skillObjectIDs:skillIDs,fileObjectIDs:fileIDs)
        }
        binding.contextMemoryIDs=memoryIDs;binding.contextSkillIDs=skillIDs;binding.contextFileIDs=fileIDs;binding.contextProjectID=projectID
        binding.cloudAuthorized = true
        binding.localExportSources = synchronizeLocalTurns ? CloudHermesBinding.localSources : []
        binding.importApproved = binding.importApproved || importExistingConversation
        cloudHermesBindings[id] = binding
        guard persist() else { throw APIError.server(0,"history_cache_write_failed") }
    }

    func resolveHermesRecovery(_ recovery: HermesRecovery) async {
        guard !isStreaming,
              recovery.context.accountID == session?.accountId,
              recovery.accountRevision == sessionRevision, selection == recovery.context.conversationID else { hermesRecovery = nil; return }
        do {
            let engine = try PiAgentHarness().version
            try await HermesCheckpointStore.shared.skipIndeterminate(recovery.context, engine: engine)
            guard recovery.accountRevision == sessionRevision, recovery.context.accountID == session?.accountId else { return }
            hermesRecovery = nil
            _ = retry(conversation: recovery.context.conversationID, message: recovery.replyID)
        } catch { self.error = error.localizedDescription }
    }

    var authenticationPresented = false
    private(set) var internetApproval: InternetApprovalRequest?
    private var internetWaiters: [CheckedContinuation<Bool, Never>] = []
    private var generationExpiresAt: Date?
    private var approvalStartedAt: Date?
    private let networkMonitor = NWPathMonitor()
    private var monitoringNetwork = false
    private var online = false
    private var syncTask: Task<Void, Never>?
    var session: NativeSession? {
        didSet {
            if session?.accountId != oldValue?.accountId { hermesRecovery = nil; cloudHermesRecoveryRun = nil; cloudHermesBindings = [:]; cloudAgentState=nil; cloudAgentSyncing=false; discoveredCloudRuns=[:]; remoteHermes=[:]; remoteHermesBusy=false; remoteHermesError=nil; cloudHermesRestoreTask?.cancel(); cloudHermesRestoreTask = nil; cloudHermesStatus = [:]; activeCloudHermes = nil; selectedAccess = nil; requestedAccessModel = nil; accessNotice = nil }
        }
    }
    init(services suppliedServices: SessionServices? = nil) {
        var services = suppliedServices ?? SessionServices()
        if suppliedServices == nil {
            services.streamAccess = { try await ChatAPI.shared.stream(model: $0, access: $1, messages: $2, token: $3, onDelta: $4) }
        }
        self.services = services
        session = services.load()
    }
    private(set) var isRestoring = true
    private var restorationRevision = UUID()
    var conversations: [Conversation] = []
    var selection: UUID? {
        didSet {
            guard selection != oldValue else { return }
            hermesRecovery = nil
            stop()
            voice.silence()
            error = nil
            if let current {
                // Do not silently substitute a different model for an existing chat.
                selectedModel = current.model
                if !current.model.isEmpty && !models.contains(where: { $0.id == current.model }) {
                    models.append(ModelOption(id: current.model))
                }
                selectedAccess = current.modelAccess
            }
        }
    }
    var models: [ModelOption] = []
    private(set) var isLoadingModels = false
    private(set) var modelsError: String?
    private var modelLoadRevision = UUID()
    var selectedModel = "" { didSet { if selectedModel != oldValue { selectedAccess = nil } } }
    /// Account the last-used preference belongs to. Guests keep their own slot so
    /// a signed-out session can never inherit another account's model.
    private var modelPreferenceScope: String { session?.accountId ?? Self.guestModelScope }
    static let guestModelScope = "guest"
    /// Records a model the user actually settled on. Restoration fallbacks and
    /// conversation switching go through `selectedModel` directly and never land here.
    private func rememberSelectedModel() {
        guard !selectedModel.isEmpty else { return }
        services.rememberLastUsedModel(selectedModel, modelPreferenceScope)
    }
    var selectedAccess: SelectedModelAccess?
    var requestedAccessModel: ModelOption?
    var accessNotice: String?
    func chooseModel(_ model: ModelOption, force: Bool = false) async {
        if ModelExecution(model.id).isLocal {
            guard !isStreaming else { return }
            if ModelExecution(model.id) == .downloaded, let reason = services.downloadedAvailability(model.id) { error = reason; return }
            selectedModel = model.id; selectedAccess = nil
            if !models.contains(where: { $0.id == model.id }) { models.append(model) }
            rememberSelectedModel()
            return
        }
        let account = session?.accountId
        do {
            let token = try await validSession().accessToken
            let reply = try await ChatAPI.shared.modelAccess(model: model.id, token: token)
            guard session?.accountId == account, !isStreaming else { return }
            let existing = current?.model == model.id ? current?.modelAccess : nil
            let preferred = existing?.id ?? reply.preferred
            if !force, let choice = reply.data.first(where: { $0.id == preferred && $0.state == "ready" }) {
                applyAccess(choice.selection)
            } else {
                accessNotice = preferred == nil ? nil : "Choisissez le mode d’accès à utiliser."
                requestedAccessModel = reply.model.option
            }
        } catch { self.error = error.localizedDescription }
    }
    func applyAccess(_ access: SelectedModelAccess) {
        guard !isStreaming else { return }
        selectedModel = access.modelId; selectedAccess = access
        rememberSelectedModel()
        if let id = selection, let index = conversations.firstIndex(where: { $0.id == id }) {
            conversations[index].model = access.modelId; conversations[index].modelAccess = access
            conversations[index].updatedAt = Date(); _ = persist()
        }
        requestedAccessModel = nil
    }
    private func streamUsingAccess(_ model: String, access: SelectedModelAccess?, messages: [ChatMessage], token: String,
                                   delta: @Sendable (String) async -> Void) async throws {
        if let stream = services.streamAccess { try await stream(model, access, messages, token, delta) }
        else { try await services.stream(model, messages, token, delta) }
    }
    var error: String?
    var isStreaming = false
    /// Explicitly publishes nested message mutations to SwiftUI while a reply streams.
    private(set) var streamingTextRevision = 0
    private(set) var completedReply: UUID?
    let voice = VoiceController()
    enum ShortcutRequest { case newConversation, dictation, draft(String), voiceConversation, assistantVoiceConversation }
    enum NativeDestination: String, Equatable { case history, documents, memory, privacy, synchronization }
    struct NativeShortcut: Equatable {
        var id = UUID()
        var destination: NativeDestination?
        var conversationID: UUID?
        var accountID: String?
        var localDraft: String?
        var memoryText: String?
        var documentName: String?
        var documentText: String?
    }
    var nativeShortcut: NativeShortcut?
    var wantsNewConversation = false
    var wantsVoice = false
    var wantsImmediateVoiceCapture = false
    var wantsVoiceConversation = false
    var pendingDraft: String?
    private struct PendingHistorySave: Codable {
        var snapshot: AccountHistorySnapshot
        var memory: [AgentMemory]?
        var local: [Conversation]
        var conversationIDs: [String: UUID]
        var messageIDs: [String: UUID]
    }
    private var importedGuestSnapshots: [UUID: Conversation] = [:]
    private var storageLoaded = false
    var nativeDataReady: Bool { !isRestoring && storageLoaded }
    private var pendingHistorySave: PendingHistorySave?
    private struct HistoryCache: Codable {
        var cloudHermesBindings: [UUID: CloudHermesBinding]?
        var cloudAgentState: CloudAgentState?
        var remoteHermes: [String:RemoteHermesSession]?
        var memory: [AgentMemory]?
        var memoryBaseline: [AgentMemory]?
        var memorySyncEnabled: Bool?
        var calendarEnabled: Bool?
        var remindersEnabled: Bool?
        var documents: [LocalDocument]?
        var importedGuestSnapshots: [UUID: Conversation]?
        var automaticSync: Bool?
        var conversations: [Conversation]
        var snapshot: AccountHistorySnapshot?
        var pending: PendingHistorySave?
        var baseline: [Conversation]
        var conversationIDs: [String: UUID]
        var messageIDs: [String: UUID]
    }
    private var historySnapshot: AccountHistorySnapshot?
    private var historyBaseline: [Conversation] = []
    private var historyConversationIDs: [String: UUID] = [:]
    private var historyMessageIDs: [String: UUID] = [:]
    private(set) var isSynchronizing = false
    var historyStatus: String?
    private(set) var hasHistoryConflict = false
    var passwordRecovery: PasswordRecoveryRequest?
    private var activeReply: (conversation: UUID, message: UUID)?
    private var generation: Task<Void, Never>?
    private var generationDeadline: Task<Void, Never>?
    private var refreshTask: Task<NativeSession, Error>?
    private var refreshRevision = UUID()
    private var sessionRevision = UUID()
    private var generationRevision = UUID()
    var historyConversations: [Conversation] { conversations.filter { !$0.messages.isEmpty } }
    var current: Conversation? { conversations.first { $0.id == selection } }

    private var initialRestoration: Task<Void, Never>?
    /// App launch and entity resolution share one restoration without remote model
    /// discovery. Existing opt-in automatic history sync keeps its normal policy.
    func restoreForNativeEntry() async {
        if let task = initialRestoration { await task.value; return }
        guard isRestoring else { return }
        let task = Task { await self.restore(loadRemoteModels: false) }
        initialRestoration = task
        await task.value
    }

    func restore(loadRemoteModels: Bool = true) async {
        let restoration = UUID()
        restorationRevision = restoration
        isRestoring = true
        defer { if restorationRevision == restoration { isRestoring = false; scheduleAutomaticSync(); Task { await self.synchronizeCloudAgentState(); await self.resumeCloudHermes(); await self.recoverRemoteHermes() } } }
        startNetworkMonitoring()
        models = [LocalModel.option] + services.downloadedModels()
        selectedModel = restoredModel(for: modelPreferenceScope, in: models) ?? LocalModel.id
        storageLoaded = false
        memoryReviews.values.forEach { $0.cancel() }; memoryReviews = [:]
        titleTasks.values.forEach { $0.cancel() }; titleTasks = [:]
        memoryRecords = []; memoryBaseline = []; memoryIndex = nil; memoryDraft = nil; memorySyncEnabled = false; memoryError = nil
        calendarEnabled = false; remindersEnabled = false; cloudHermesBindings = [:]; cloudAgentState=nil; discoveredCloudRuns=[:]; remoteHermes=[:]; remoteHermesBusy=false; remoteHermesError=nil; cloudHermesRecoveryRun = nil
        do {
            let data: Data?
            do { data = try services.readLocalHistory(storageURL()) }
            catch CocoaError.fileReadNoSuchFile { data = nil }
            if let data {
                if let cache = try? JSONDecoder().decode(HistoryCache.self, from: data) {
                    cloudAgentState = cache.cloudAgentState?.accountId == session?.accountId ? cache.cloudAgentState : nil
                    remoteHermes = (cache.remoteHermes ?? [:]).filter { $0.value.accountId == session?.accountId }
                    cloudHermesBindings = (cache.cloudHermesBindings ?? [:]).filter { $0.value.accountId == session?.accountId }
                    memoryRecords = cache.memory ?? []; memoryBaseline = cache.memoryBaseline ?? []; memorySyncEnabled = cache.memorySyncEnabled ?? false
                    calendarEnabled = cache.calendarEnabled ?? false
                    remindersEnabled = cache.remindersEnabled ?? false
                    localDocuments = cache.documents ?? []
                    automaticSync = cache.automaticSync ?? false
                    importedGuestSnapshots = cache.importedGuestSnapshots ?? [:]
                    conversations = cache.conversations
                    pendingHistorySave = cache.pending
                    historySnapshot = cache.snapshot; historyBaseline = cache.baseline
                    historyConversationIDs = cache.conversationIDs; historyMessageIDs = cache.messageIDs
                } else { conversations = try JSONDecoder().decode([Conversation].self, from: data) }
                // A persisted in-flight response cannot still be running after launch.
                for i in conversations.indices {
                    for j in conversations[i].messages.indices where conversations[i].messages[j].completion == .streaming {
                        conversations[i].messages[j].completion = .stopped
                    }
                }
            }
            storageLoaded = true
            do {
                memoryIndex = try services.memoryIndex(storageURL().deletingPathExtension().appendingPathExtension("memory.sqlite"))
                try memoryIndex?.rebuild(memoryItems)
            } catch { memoryError = MemoryError.storage.localizedDescription }
            if loadRemoteModels && session != nil { Task { await self.reloadModels() } }
        } catch { self.error = error.localizedDescription }
    }
    /// Explicit network recovery without re-reading or replacing local history.
    func refreshDownloadedModels() {
        let downloaded = services.downloadedModels()
        models.removeAll { option in ModelExecution(option.id) == .downloaded && !downloaded.contains(where: { $0.id == option.id }) }
        for model in downloaded where !models.contains(where: { $0.id == model.id }) { models.append(model) }
    }
    /// The remembered model is a preference, not an entitlement: reuse it only
    /// when it is present in the given catalog, otherwise fall back to the local model.
    private func restoredModel(for scope: String, in available: [ModelOption]) -> String? {
        guard let remembered = services.lastUsedModel(scope),
              available.contains(where: { $0.id == remembered }) else { return nil }
        return remembered
    }
    func reloadModels() async {
        guard session != nil, !isLoadingModels, !isStreaming else { return }
        let accountRevision = sessionRevision
        let loadRevision = UUID()
        modelLoadRevision = loadRevision
        isLoadingModels = true
        modelsError = nil
        defer { if modelLoadRevision == loadRevision { isLoadingModels = false } }
        do {
            let credentials = try await validSession()
            let remoteModels = try await services.models(credentials.accessToken)
            guard sessionRevision == accountRevision, modelLoadRevision == loadRevision else { return }
            // Sending can begin while this request is in flight; never switch its model.
            guard !isStreaming else { return }
            var available = [LocalModel.option] + services.downloadedModels() + remoteModels.filter { !ModelExecution($0.id).isLocal }
            for favorite in ModelFavoriteStore.load().sorted() where !available.contains(where: { $0.id == favorite }) {
                available.append(models.first { $0.id == favorite } ?? ModelOption(id: favorite))
            }
            if let current, !current.model.isEmpty, !available.contains(where: { $0.id == current.model }) {
                available.append(models.first { $0.id == current.model } ?? ModelOption(id: current.model))
            }
            models = available
            if !selectedModel.isEmpty {
                if !available.contains(where: { $0.id == selectedModel }) { selectedModel = "" }
            } else if let current {
                selectedModel = available.contains(where: { $0.id == current.model }) ? current.model : ""
            } else if let remembered = restoredModel(for: modelPreferenceScope, in: available) {
                // No conversation selected: start from the last model this account used.
                selectedModel = remembered
            } else { selectedModel = available.first?.id ?? "" }
            if let current, current.model == selectedModel { selectedAccess = current.modelAccess }

        } catch {
            if sessionRevision == accountRevision, modelLoadRevision == loadRevision {
                modelsError = "Impossible de charger les modèles. Vérifiez votre connexion puis réessayez."
            }
        }
    }
    private func resetModelLoading() {
        modelLoadRevision = UUID()
        isLoadingModels = false
        modelsError = nil
    }
    func validSession() async throws -> NativeSession {
        guard let previous = session else { throw APIError.authenticationRequired }
        if previous.expiresAt > Date().addingTimeInterval(60) { return previous }
        let revision = sessionRevision
        if let refreshTask {
            let renewed = try await refreshTask.value
            guard sessionRevision == revision else { throw CancellationError() }
            return renewed
        }
        let flight = UUID()
        refreshRevision = flight
        // One owner persists the rotated token; concurrent callers only await it.
        let task = Task { @MainActor in
            defer { if refreshRevision == flight { refreshTask = nil } }
            let renewed: NativeSession
            do {
                renewed = try await services.refresh(previous)
            } catch APIError.server(400, "invalid_grant") {
                guard sessionRevision == revision else { throw CancellationError() }
                await closeRejectedSession(
                    message: "Votre session a expiré. Reconnectez-vous pour retrouver les modèles Cloud."
                )
                throw APIError.authenticationRequired
            }
            if sessionRevision == revision {
                do {
                    try services.save(renewed)
                    session = renewed
                } catch {
                    // The previous refresh token may already be consumed. Never
                    // keep it as an apparently usable local session after failure.
                    stop()
                    voice.silence()
                    sessionRevision = UUID()
                    resetModelLoading()
                    let failedRevision = sessionRevision
                    isRestoring = true
                    services.clear()
                    session = nil
                    conversations = []; selection = nil
                    resetHistorySync()
                    models = []; selectedModel = ""
                    localDocuments = []; automaticSync = false; cloudHermesBindings = [:]; cloudAgentState=nil; discoveredCloudRuns=[:]; remoteHermes=[:]; remoteHermesBusy=false; remoteHermesError=nil; cloudHermesRecoveryRun = nil
                    await restore(loadRemoteModels: false)
                    nativeShortcut = nil
        wantsNewConversation = false; wantsVoice = false
                    wantsVoiceConversation = false; wantsImmediateVoiceCapture = false; pendingDraft = nil
                    self.error = "Impossible de sauvegarder la session dans le Trousseau. Reconnectez-vous."
                    do { try await services.revoke(renewed.refreshToken) }
                    catch {
                        if sessionRevision == failedRevision {
                            self.error = "Session locale fermée. La révocation distante n’a pas pu être confirmée. Reconnectez-vous."
                        }
                    }
                    throw APIError.authenticationRequired
                }
            } else {
                // An account switch can orphan a rotation even without logout.
                // Revoke only the old account's token, never touch the new session.
                try? await services.revoke(renewed.refreshToken)
            }
            // Logout may need this rotated token for revocation even after the UI
            // session was cleared. Never restore UI state across account revisions.
            return renewed
        }
        refreshTask = task
        let renewed = try await task.value
        guard sessionRevision == revision else { throw CancellationError() }
        return renewed
    }

    /// A rejected refresh token cannot become usable again. Clear only the
    /// authentication state, then restore the guest workspace from local disk.
    private func closeRejectedSession(message: String) async {
        stop()
        voice.silence()
        sessionRevision = UUID()
        resetModelLoading()
        isRestoring = true
        services.clear()
        session = nil
        conversations = []; selection = nil
        resetHistorySync()
        models = [LocalModel.option]; selectedModel = LocalModel.id
        localDocuments = []; automaticSync = false; cloudHermesBindings = [:]; cloudAgentState=nil; discoveredCloudRuns=[:]; remoteHermes=[:]; remoteHermesBusy=false; remoteHermesError=nil; cloudHermesRecoveryRun = nil
        await restore(loadRemoteModels: false)
        nativeShortcut = nil
        wantsNewConversation = false; wantsVoice = false
        wantsVoiceConversation = false; wantsImmediateVoiceCapture = false; pendingDraft = nil
        error = message
        authenticationPresented = true
    }
    func accept(_ session: NativeSession) async throws {
        nativeShortcut = nil
        do { try services.save(session) }
        catch {
            // All sign-in paths issue a real server session before persistence.
            // A failed Keychain write must not leave that session orphaned.
            let persistenceError = error
            try? await services.revoke(session.refreshToken)
            throw persistenceError
        }
        stop()
        refreshRevision = UUID()
        refreshTask = nil
        sessionRevision = UUID()
        resetModelLoading()
        isRestoring = true
        resetHistorySync()
        self.session = session
        error = nil; models = []; selectedModel = ""
        conversations = []; localDocuments = []; automaticSync = false; cloudHermesBindings = [:]; cloudAgentState=nil; discoveredCloudRuns=[:]; remoteHermes=[:]; remoteHermesBusy=false; remoteHermesError=nil; cloudHermesRecoveryRun = nil; selection = nil
        await restore()
    }
    /// Keep only the latest foreground request while authentication restores.
    /// Preparing an intent never edits history or starts microphone/network work.
    func prepareShortcut(_ request: ShortcutRequest) {
        wantsNewConversation = false; wantsVoice = false
        wantsVoiceConversation = false; wantsImmediateVoiceCapture = false; pendingDraft = nil
        switch request {
        case .newConversation: wantsNewConversation = true
        case .dictation: wantsVoice = true
        case .draft(let text): pendingDraft = String(text.prefix(32_000))
        case .voiceConversation: wantsVoiceConversation = true
        case .assistantVoiceConversation:
            wantsVoiceConversation = true
            wantsImmediateVoiceCapture = true
        }
    }
    /// Foreground-only handoff. Account identity and selected IDs are revalidated
    /// after restoration, never trusted from cached Shortcuts entity labels.
    func queueNativeShortcut(_ request: NativeShortcut) {
        prepareShortcut(.draft(""))
        pendingDraft = nil
        nativeShortcut = request
    }
    func applyNativeShortcut() throws -> NativeShortcut? {
        guard !isRestoring, storageLoaded else { return nil }
        guard let request = nativeShortcut else { return nil }
        nativeShortcut = nil
        guard request.accountID == session?.accountId else { throw NativeShortcutError.missing }
        guard !isStreaming, !isSynchronizing else { throw NativeShortcutError.busy }
        if let id = request.conversationID {
            guard conversations.contains(where: { $0.id == id }) else { throw NativeShortcutError.missing }
            selection = id
        }
        if let draft = request.localDraft {
            if let reason = localUnavailableReason { throw LocalAgentError.unavailable(reason) }
            selectedModel = LocalModel.id
            newConversation()
            pendingDraft = String(draft.prefix(32_000))
        }
        if let text = request.memoryText {
            let text = String(text.prefix(600)).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { throw NativeShortcutError.empty }
            memoryDraft = MemoryDraft(text: text, evidence: MemoryEvidence(origin: .userEntry,
                quote: text, date: Date(), sourceRole: "user"))
        }
        if let name = request.documentName, let text = request.documentText {
            guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw NativeShortcutError.empty }
            try importDocument(name: name, text: text)
        }
        return request
    }
    func shortcutConversation(_ id: UUID, accountID: String?) throws -> Conversation {
        guard !isRestoring, storageLoaded else { throw NativeShortcutError.notReady }
        guard accountID == session?.accountId,
              let conversation = conversations.first(where: { $0.id == id }) else { throw NativeShortcutError.missing }
        return conversation
    }
    func askLocalFromShortcut(_ prompt: String) async throws -> String {
        try Task.checkCancellation()
        guard !isRestoring, storageLoaded else { throw NativeShortcutError.notReady }
        guard !isStreaming, !isSynchronizing else { throw NativeShortcutError.busy }
        guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              prompt.count <= 32_000 else { throw LocalAgentError.invalidInput }
        if let reason = localUnavailableReason { throw LocalAgentError.unavailable(reason) }
        prepareShortcut(.draft(""))
        pendingDraft = nil
        selectedModel = LocalModel.id
        newConversation()
        let account = sessionRevision
        guard let conversation = selection, send(prompt) else { throw NativeShortcutError.busy }
        let reply = current?.messages.last?.id
        do {
            let deadline = Date().addingTimeInterval(125)
            while isStreaming {
                try Task.checkCancellation()
                guard sessionRevision == account, selection == conversation else { throw CancellationError() }
                guard Date() < deadline else { throw LocalAgentError.budget }
                try await Task.sleep(for: .milliseconds(100))
            }
            guard sessionRevision == account, selection == conversation,
                  let result = current?.messages.last, result.id == reply,
                  result.role == "assistant", result.completion == .completed,
                  !result.content.isEmpty else { throw NativeShortcutError.noReply }
            return result.content
        } catch {
            // Never stop a different run started while this intent was suspended.
            if sessionRevision == account, selection == conversation,
               current?.messages.last?.id == reply { stop() }
            throw error
        }
    }

    func newConversation() {
        guard !isRestoring, storageLoaded else { return }
        if current?.messages.isEmpty == true { return }
        stop()
        // A new conversation opens on the model the user last used, not on
        // whatever the previously selected conversation happened to use.
        if let remembered = restoredModel(for: modelPreferenceScope, in: models) { selectedModel = remembered }
        if let unused = conversations.first(where: { $0.messages.isEmpty }) {
            selection = unused.id
            return
        }
        let conversation = Conversation(model: selectedModel, modelAccess: selectedAccess)
        conversations.insert(conversation, at: 0); selection = conversation.id
        persist()
    }
    @discardableResult func send(_ text: String) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isRestoring, !isStreaming, !isSynchronizing || ModelExecution(selectedModel).isLocal else { return false }
        guard session != nil || ModelExecution(selectedModel).isLocal else { error = APIError.authenticationRequired.localizedDescription; return false }
        guard storageLoaded else { error = "L’historique local n’a pas pu être ouvert. Il est conservé sans modification. Relancez l’app après avoir déverrouillé l’appareil."; return false }
        if selectedModel == LocalModel.id, let reason = localUnavailableReason { error = reason; return false }
        if ModelExecution(selectedModel) == .downloaded, let reason = services.downloadedAvailability(selectedModel) { error = reason; return false }
        guard !selectedModel.isEmpty else { error = APIError.noModel.localizedDescription; return false }
        if !ModelExecution(selectedModel).isLocal && selectedAccess?.modelId != selectedModel && services.streamAccess != nil {
            requestedAccessModel = models.first { $0.id == selectedModel } ?? ModelOption(id: selectedModel)
            return false
        }
        if current == nil { newConversation() }
        guard let id = selection, let index = conversations.firstIndex(where: { $0.id == id }) else { return false }
        memoryReviews[id]?.cancel(); memoryReviews[id] = nil
        conversations[index].model = selectedModel
        conversations[index].modelAccess = selectedAccess
        conversations[index].messages.append(ChatMessage(role: "user", content: text))
        if conversations[index].messages.count == 1 { conversations[index].title = ConversationTitle.fallback(for: text) }
        if MemoryCommand.isForget(text) { memoryPresented = true; return persist() }
        // Runs in the background against the same model; the reply is not delayed.
        if conversations[index].messages.count == 1 { scheduleTitle(conversation: id) }
        return startReply(conversation: id, index: index)
    }
    @discardableResult func appendVoiceTurn(conversationID: UUID, accountID: String, model: String, role: String, text: String, turnID: String) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard session?.accountId == accountID, ["user", "assistant"].contains(role), !text.isEmpty, storageLoaded,
              let index = conversations.firstIndex(where: { $0.id == conversationID }) else { return false }
        // Stable across retries and history sync, without retaining provider credentials.
        let bytes = Array(SHA256.hash(data: Data((conversationID.uuidString + ":" + turnID).utf8)).prefix(16))
        let id = UUID(uuid: (bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15]))
        if conversations[index].messages.contains(where: { $0.id == id }) { return true }
        let previous = conversations[index]
        conversations[index].model = model
        conversations[index].messages.append(ChatMessage(id: id, role: role, content: text, completion: role == "assistant" ? .completed : nil))
        if conversations[index].messages.count == 1 { conversations[index].title = ConversationTitle.fallback(for: text) }
        conversations[index].updatedAt = Date()
        guard persist() else { conversations[index] = previous; return false }
        if conversations[index].messages.count == 1 { scheduleTitle(conversation: conversationID) }
        scheduleAutomaticSync()
        return true
    }
    /// Retry only the current tail, never truncate later turns or duplicate the prompt.
    @discardableResult func retry(conversation id: UUID, message: UUID) -> Bool {
        guard !isStreaming, !isSynchronizing || ModelExecution(current?.model ?? "").isLocal, selection == id,
              let index = conversations.firstIndex(where: { $0.id == id }),
              let last = conversations[index].messages.last, last.id == message, last.canRetry,
              conversations[index].messages.dropLast().last?.role == "user",
              models.contains(where: { $0.id == conversations[index].model }) else { return false }
        selectedModel = conversations[index].model
        selectedAccess = conversations[index].modelAccess
        voice.silence()
        conversations[index].messages.removeLast()
        return startReply(conversation: id, index: index)
    }
    private func startReply(conversation id: UUID, index: Int) -> Bool {
        let input = conversations[index].messages
        let reply = ChatMessage(role: "assistant", content: "", completion: .streaming)
        conversations[index].messages.append(reply)
        activeReply = (id, reply.id)
        completedReply = nil
        localEvents = []
        isStreaming = true; error = nil
        guard persist() else { isStreaming = false; setReplyCompletion(.failed); activeReply = nil; return false }
        let revision = generationRevision
        let accountRevision = sessionRevision
        let model = selectedModel
        if ModelExecution(model).isLocal {
            if let account = session?.accountId, let turn = input.last(where: { $0.role == "user" }) {
                let uuid = { UUID().uuidString.lowercased() }
                var binding = cloudHermesBindings[id] ?? CloudHermesBinding(accountId:account,conversationId:id.uuidString.lowercased(),sessionId:uuid(),branchId:uuid(),operationId:uuid(),versionId:uuid(),deviceId:uuid(),cloudAuthorized:false,importApproved:false)
                let queuedParent = cloudAgentState?.outbox.last(where: { $0.objectId == binding.sessionId })?.versionId
                let parents = queuedParent.map { [$0] } ?? cloudAgentState?.objects[binding.sessionId]?.heads ?? [binding.versionId]
                binding.recordLocalIntent(turnId:turn.id,modelId:model,source:model == LocalModel.id ? "apple-foundation-local" : "downloaded-local",parents:parents)
                let previous = cloudHermesBindings[id]; cloudHermesBindings[id] = binding
                guard persist() else { cloudHermesBindings[id] = previous; isStreaming = false; setReplyCompletion(.failed); activeReply = nil; return false }
            }
            generationExpiresAt = Date().addingTimeInterval(120)
            armGenerationDeadline(generation: revision, account: accountRevision)
        }
        generation = Task {
            defer {
                if generationRevision == revision && sessionRevision == accountRevision {
                    cancelInternetApproval()
                    generationExpiresAt = nil
                    generationDeadline?.cancel(); generationDeadline = nil
                    isStreaming = false; generation = nil; activeReply = nil; persist(); scheduleAutomaticSync()
                    if ModelExecution(model).isLocal { Task { await self.synchronizeCloudAgentState() } }
                }
            }
            do {
                await AutomationCoordinator.shared.yieldToUser()
                if ModelExecution(model).isLocal {
                    let deviceData = LocalDeviceSnapshot()
                    try Task.checkCancellation()
                    guard generationRevision == revision && sessionRevision == accountRevision else { return }
                    let checkpointContext = input.last(where: { $0.role == "user" }).map {
                        HermesRunContext(accountID: session?.accountId, conversationID: id, turnID: $0.id, modelID: model, source: model == LocalModel.id ? "apple-foundation-local" : "downloaded-local")
                    }
                    let initial = try await localHermesSeed(conversation:id,input:input,epoch:accountRevision)
                    guard generationRevision == revision && sessionRevision == accountRevision else { throw CancellationError() }
                    let workspace = LocalAgentWorkspace(conversations: conversations, documents: localDocuments,
                        hermesContext: checkpointContext, initialHermesHistory:initial.history, selectedCloudContext:initial.context, deviceData: deviceData,
                        event: { event in
                            await self.recordLocalEvent(event, generation: revision, account: accountRevision)
                        }, saveDocument: { document in
                            try await self.saveLocalDocument(document, generation: revision, account: accountRevision)
                        }, readDevice: { action, query in
                            try await self.readDeviceData(action: action, query: query, generation: revision, account: accountRevision)
                        }, render: { blocks in
                            await self.appendNativeContent(blocks, conversation: id, message: reply.id,
                                generation: revision, account: accountRevision)
                        }, allowedDeviceActions: LocalDeviceScope.actions(for: input), authorizeInternet: { url in
                            try await self.requestInternet(url: url, conversation: id, generation: revision, account: accountRevision)
                        }, webFetch: services.webFetch, automation: { arguments in
                            try await self.manageAutomation(arguments, model: model, account: accountRevision)
                        }, memory: { action, query, text in
                            try await self.memoryTool(action: action, query: query, text: text, conversation: id,
                                source: input.last, generation: revision, account: accountRevision)
                        })
                    let delta: @Sendable (String) async -> Void = { delta in
                        await self.append(delta, conversation: id, message: reply.id, generation: revision, account: accountRevision)
                        await Task.yield()
                    }
                    if ModelExecution(model) == .downloaded {
                        try await services.downloadedRespond(model, input, workspace, delta)
                    } else { try await services.localRespond(input, workspace, delta) }
                } else {
                    let session = try await validSession()
                    try Task.checkCancellation()
                    guard generationRevision == revision && sessionRevision == accountRevision else { return }
                    await synchronizeCloudAgentState()
                    guard cloudAgentSyncError == nil else { throw APIError.server(409,"hermes_local_reconciliation_required") }
                    guard var binding = cloudHermesBindings[id], binding.accountId == session.accountId, binding.cloudAuthorized != false,
                        let turn = input.last(where: { $0.role == "user" }) else { throw APIError.server(403,"agent_cloud_consent_required") }
                    guard (binding.localTurns ?? []).allSatisfy(\.published),
                        !(cloudAgentState?.outbox.contains(where: { $0.objectId == binding.sessionId || $0.value?.object?["sessionId"]?.string == binding.sessionId }) ?? false) else {
                        throw APIError.server(403,"hermes_local_export_consent_or_reconciliation_required")
                    }
                    if !(binding.localTurns ?? []).isEmpty {
                        let liveConsent = try await services.hermesConsent(session.accessToken)
                        guard sessionRevision == accountRevision, liveConsent.accountId == session.accountId,
                            liveConsent.cloudEnabled, (binding.localTurns ?? []).allSatisfy({ (liveConsent.exportSources ?? []).contains($0.source) && (binding.localExportSources ?? []).contains($0.source) }) else {
                            throw APIError.server(403,"hermes_local_export_consent_required")
                        }
                    }
                    let prior = input.dropLast()
                    if binding.history.isEmpty && !prior.isEmpty && !binding.importApproved { throw APIError.server(403,"hermes_history_import_required") }
                    if binding.pending != nil && binding.turnId != turn.id { throw APIError.server(409,"hermes_pending_run_requires_recovery") }
                    if binding.pending == nil && binding.turnId == turn.id { throw APIError.server(409,"hermes_completed_turn_requires_explicit_branch") }
                    if binding.pending == nil {
                        let history: [HistoryJSON] = binding.history.isEmpty ? prior.map { .object(["role":.string($0.role),"content":.string($0.content)]) } : binding.history
                        binding.pending = CloudHermesRunInput(operationId:UUID().uuidString.lowercased(),runId:UUID().uuidString.lowercased(),sessionId:binding.sessionId,branchId:binding.branchId,
                            model:try CloudHermesModel.selected(model,access:conversations.first(where:{$0.id == id})?.modelAccess),message:turn.content,history:history)
                        binding.turnId = turn.id; cloudHermesBindings[id] = binding
                        guard persist() else { throw APIError.server(0,"history_cache_write_failed") }
                    }
                    let request = binding.pending!
                    cloudHermesStatus[id] = "queued"
                    activeCloudHermes = (session.accountId,request.runId,session.accessToken)
                    defer { if activeCloudHermes?.runId == request.runId { activeCloudHermes = nil } }
                    await synchronizeCloudAgentState()
                    guard cloudAgentSyncError == nil, cloudAgentState?.accountId == session.accountId else { throw APIError.server(409,"hermes_session_sync_required") }
                    if cloudAgentState?.objects[binding.sessionId] == nil {
                        try enqueueCloudAgentMutation(.init(operationId:binding.operationId,objectId:binding.sessionId,versionId:binding.versionId,deviceId:binding.deviceId,
                            kind:"session",parents:[],deleted:false,value:.object(["type":.string("hermes_chat"),"conversationId":.string(binding.conversationId),"branchId":.string(binding.branchId),"title":.string("Hermes chat")])))
                        await synchronizeCloudAgentState()
                    }
                    guard cloudAgentSyncError == nil, let synced=cloudAgentState?.objects[binding.sessionId], !synced.deleted, synced.heads.count == 1 else {
                        throw APIError.server(409,"hermes_session_sync_required")
                    }
                    try Task.checkCancellation()
                    guard generationRevision == revision && sessionRevision == accountRevision else { throw CancellationError() }
                    var result: CloudHermesRun
                    do { result = try await services.hermesRead(session.accountId,request.runId,session.accessToken,false) }
                    catch APIError.server(let status, _) where status == 404 {
                        result = try await services.hermesCreate(session.accountId,request,session.accessToken)
                    }
                    if Task.isCancelled || generationRevision != revision || sessionRevision != accountRevision {
                        let cancel = services.hermesRead
                        Task { _ = try? await cancel(session.accountId,request.runId,session.accessToken,true) }
                        throw CancellationError()
                    }
                    cloudHermesStatus[id] = result.state
                    while ["queued","running","waiting_device"].contains(result.state) {
                        try Task.checkCancellation()
                        guard generationRevision == revision && sessionRevision == accountRevision else { throw CancellationError() }
                        try await services.hermesPollDelay()
                        result = try await services.hermesRead(session.accountId,request.runId,session.accessToken,false)
                    }
                    try Task.checkCancellation()
                    guard generationRevision == revision && sessionRevision == accountRevision,
                        result.sessionId == binding.sessionId, result.branchId == binding.branchId else { throw CancellationError() }
                    cloudHermesStatus[id] = result.state
                    if result.state == "awaiting_resolution" { cloudHermesRecoveryRun = request.runId; throw APIError.server(409,"hermes_awaiting_resolution") }
                    guard result.state == "completed", let completed = result.result else { throw APIError.server(409,"hermes_run_cancelled") }
                    binding.history = completed.history; binding.pending = nil; cloudHermesBindings[id] = binding
                    guard persist() else { throw APIError.server(0,"history_cache_write_failed") }
                    append(completed.response,conversation:id,message:reply.id,generation:revision,account:accountRevision)
                }
                try Task.checkCancellation()
                guard generationRevision == revision && sessionRevision == accountRevision else { return }
                // Only a successfully terminated stream authorizes automatic playback.
                setReplyCompletion(.completed)
                completedReply = reply.id
                scheduleMemoryReview(conversation: id)
            } catch is CancellationError {
                if generationRevision == revision && sessionRevision == accountRevision { setReplyCompletion(.stopped) }
            } catch {
                if generationRevision == revision && sessionRevision == accountRevision {
                    setReplyCompletion(.failed)
                    if !ModelExecution(model).isLocal, case APIError.server(let status, let code) = error, !code.hasPrefix("hermes_"), code != "agent_cloud_consent_required", [400, 401, 402, 403, 409, 429, 503].contains(status) {
                        accessNotice = "Cet accès est indisponible. Réessayez ou choisissez un autre mode."
                        requestedAccessModel = models.first { $0.id == model } ?? ModelOption(id: model)
                    }
                    if let checkpointError = error as? HermesCheckpointError {
                        self.error = checkpointError.localizedDescription
                        if case .indeterminate = checkpointError, let turn = input.last(where: { $0.role == "user" }) {
                            hermesRecovery = HermesRecovery(context: .init(accountID: session?.accountId, conversationID: id, turnID: turn.id, modelID: model, source: model == LocalModel.id ? "apple-foundation-local" : "downloaded-local"), replyID: reply.id,
                                accountRevision: accountRevision, detail: checkpointError.localizedDescription)
                        }
                    } else { self.error = ModelExecution(model).isLocal
                        ? (error as? LocalAgentError)?.localizedDescription ?? "L’agent local n’a pas pu terminer cette demande. Réessayez avec une demande plus précise ; les étapes déjà enregistrées sont conservées."
                        : error.localizedDescription
                    }
                }
            }
        }
        return true
    }
    private func append(_ delta: String, conversation: UUID, message: UUID, generation: UUID, account: UUID) {
        guard generationRevision == generation, sessionRevision == account else { return }
        guard let i = conversations.firstIndex(where: { $0.id == conversation }),
              let j = conversations[i].messages.firstIndex(where: { $0.id == message }) else { return }
        conversations[i].messages[j].content += delta
        conversations[i].updatedAt = Date()
        streamingTextRevision &+= 1
    }
    private func setReplyCompletion(_ completion: ChatMessage.Completion) {
        guard let activeReply,
              let i = conversations.firstIndex(where: { $0.id == activeReply.conversation }),
              let j = conversations[i].messages.firstIndex(where: { $0.id == activeReply.message }) else { return }
        conversations[i].messages[j].completion = completion
        conversations[i].updatedAt = Date()
    }
    func stop() {
        if let active = activeCloudHermes {
            activeCloudHermes = nil
            let cancel = services.hermesRead
            Task { _ = try? await cancel(active.accountId,active.runId,active.token,true) }
        }
        if isStreaming { setReplyCompletion(.stopped) }
        activeReply = nil
        completedReply = nil
        generationRevision = UUID()
        cancelInternetApproval()
        generationExpiresAt = nil
        generationDeadline?.cancel(); generationDeadline = nil
        generation?.cancel(); generation = nil
        isStreaming = false
        persist()
    }
    func delete(_ id: UUID) {
        memoryReviews[id]?.cancel(); memoryReviews[id] = nil
        titleTasks[id]?.cancel(); titleTasks[id] = nil
        if selection == id { stop(); selection = nil }
        let sourceID = conversations.first(where: { $0.id == id })?.memorySourceID ?? id
        let oldConversations = conversations; let oldMemory = memoryRecords
        let oldBaseline = memoryBaseline; let oldSnapshot = historySnapshot; let oldPending = pendingHistorySave
        for memoryID in Set(memoryRecords.filter { $0.evidence?.conversationID == sourceID || $0.evidence?.conversationID == id }.map(\.id)) { forgetMemoryRecords(memoryID) }
        conversations.removeAll { $0.id == id }
        guard persist() else {
            conversations = oldConversations; memoryRecords = oldMemory; memoryBaseline = oldBaseline
            historySnapshot = oldSnapshot; pendingHistorySave = oldPending; return
        }
        let checkpointAccount = session?.accountId
        Task {
            do { try await HermesCheckpointStore.shared.deleteConversation(accountID: checkpointAccount, conversationID: id) }
            catch { if session?.accountId == checkpointAccount { self.error = "La conversation a été supprimée, mais son point de reprise local n’a pas pu être effacé : " + error.localizedDescription } }
        }
        refreshMemoryIndex(); scheduleAutomaticSync()
    }
    func logout() async {
        nativeShortcut = nil
        voice.silence()
        let previous = session
        let inFlightRefresh = refreshTask
        stop()
        isRestoring = true
        refreshRevision = UUID()
        refreshTask = nil
        sessionRevision = UUID()
        resetModelLoading()
        let revision = sessionRevision
        resetHistorySync()
        await HermesCheckpointStore.shared.invalidateAccount(previous?.accountId)
        services.clear(); session = nil; conversations = []; selection = nil
        models = []; selectedModel = ""; wantsNewConversation = false; wantsVoice = false; wantsVoiceConversation = false; wantsImmediateVoiceCapture = false; pendingDraft = nil; error = nil
        localDocuments = []; automaticSync = false; cloudHermesBindings = [:]; cloudAgentState=nil; discoveredCloudRuns=[:]; remoteHermes=[:]; remoteHermesBusy=false; remoteHermesError=nil; cloudHermesRecoveryRun = nil
        await restore()
        if let previous {
            do {
                // Do not cancel a possibly committed server rotation. Await it and
                // revoke its result; otherwise revoke the last known family token.
                let rotated = try? await inFlightRefresh?.value
                try await services.revoke(rotated?.refreshToken ?? previous.refreshToken)
            }
            catch {
                if sessionRevision == revision {
                    self.error = "Session locale effacée. La révocation distante a échoué : \(error.localizedDescription)"
                }
            }
        }
    }
    private func resetHistorySync() {
        syncTask?.cancel(); syncTask = nil
        isSynchronizing = false
        importedGuestSnapshots = [:]
        pendingHistorySave = nil
        historySnapshot = nil; historyBaseline = []; historyConversationIDs = [:]; historyMessageIDs = [:]
        historyStatus = nil; hasHistoryConflict = false
    }
    /// Account-scoped synchronization; automatic invocation requires persisted opt-in.
    /// Never resolve concurrent edits by silently choosing one device's snapshot.
    func synchronizeHistory(keepingBothVersions: Bool = false, automatic: Bool = false) async {
        guard !isSynchronizing, !isStreaming, !isRestoring, storageLoaded, session != nil, !automatic || automaticSync else { return }
        isSynchronizing = true
        let accountRevision = sessionRevision
        defer { if sessionRevision == accountRevision { isSynchronizing = false } }
        let local = conversations
        let localMemory = memoryRecords
        let syncMemory = memorySyncEnabled
        do {
            let session = try await validSession()
            var remote = try await services.readHistory(session.accessToken)
            if syncMemory {
                guard remote.memory != nil else { throw APIError.server(503, "memory_sync_not_supported") }
                guard remote.memory!.count <= 1000, remote.memory!.allSatisfy(\.valid) else { throw APIError.invalidResponse }
            } else { remote.memory = nil }
            guard sessionRevision == accountRevision, !isStreaming, conversations == local else { return }
            try Task.checkCancellation()
            guard (!automatic || automaticSync), memorySyncEnabled == syncMemory else { return }
            guard remote.accountId == session.accountId else { throw APIError.invalidResponse }
            // Validate the downloaded projection before any mutating request.
            var validationIDs: [String: UUID] = [:]
            var validatedKeys = Set<String>()
            for index in remote.conversations.indices {
                guard let key = remote.conversations[index].object?["id"]?.string,
                      validatedKeys.insert(key).inserted else { throw APIError.invalidResponse }
                _ = try remote.projectedConversation(at: index, id: UUID(), messageIDs: &validationIDs)
            }
            // Reconcile a lost POST response using the exact persisted payload,
            // never just a colliding conversation ID or an assumed success.
            if let pending = pendingHistorySave,
               remote.revision == pending.snapshot.revision + 1,
               remote.accountId == pending.snapshot.accountId,
               remote.conversations == pending.snapshot.conversations,
               remote.folders == pending.snapshot.folders,
               remote.memory == pending.snapshot.memory {
                historySnapshot = remote; historyBaseline = pending.local
                if syncMemory { memoryBaseline = pending.memory ?? [] }
                historyConversationIDs = pending.conversationIDs; historyMessageIDs = pending.messageIDs
                pendingHistorySave = nil
                guard persist() else { throw APIError.server(0, "history_cache_write_failed") }
            }
            let uncertainSave = pendingHistorySave.map { remote.revision > $0.snapshot.revision } ?? false
            let conflict = uncertainSave || (historySnapshot.map { $0.revision != remote.revision && local != historyBaseline } ?? false)
            if conflict && !keepingBothVersions {
                hasHistoryConflict = true
                historyStatus = "Des modifications existent sur cet appareil et sur un autre. Rien n’a été écrasé. La résolution du conflit est nécessaire."
                return
            }
            var merged = remote
            if syncMemory { merged.memory = MemoryPolicy.merge(localMemory.filter { $0.state != .proposed }, remote.memory ?? []) }
            var conversationIDs = historyConversationIDs
            var messageIDs = historyMessageIDs
            if historySnapshot == nil || local != historyBaseline || (syncMemory && merged.memory != remote.memory) {
                let localIDs = Set(local.map(\.id))
                let deleted = conflict ? Set<UUID>() : Set(historyBaseline.map(\.id)).subtracting(localIDs)
                merged.conversations.removeAll { item in
                    guard let key = item.object?["id"]?.string, let id = conversationIDs[key] else { return false }
                    return deleted.contains(id)
                }
                for original in local {
                    var conversation = original
                    if conflict {
                        // Preserve the server version, including remotely deleted chats.
                        // Only dirty local chats become explicitly labelled copies.
                        guard historyBaseline.first(where: { $0.id == original.id }) != original else { continue }
                        conversation.id = UUID()
                        conversation.title = String((original.title + " — copie locale").prefix(120))
                    }
                    let key = conversationIDs.first { $0.value == conversation.id }?.key ?? conversation.id.uuidString
                    // On first import, retain any independently existing server chat.
                    if historySnapshot == nil, merged.conversations.contains(where: { $0.object?["id"]?.string == key }) {
                        throw APIError.server(409, "history_import_collision")
                    }
                    conversationIDs[key] = conversation.id
                    try merged.store(conversation, serverID: key, messageIDs: &messageIDs)
                }
                pendingHistorySave = PendingHistorySave(snapshot: merged, memory: syncMemory ? merged.memory : nil, local: local,
                    conversationIDs: conversationIDs, messageIDs: messageIDs)
                // Persist recovery evidence before making the consequential request.
                guard persist() else { throw APIError.server(0, "history_cache_write_failed") }
                try Task.checkCancellation()
                guard !automatic || automaticSync else { return }
                merged = try await services.saveHistory(merged, session.accessToken)
                if !syncMemory { merged.memory = nil }
                if syncMemory {
                    guard let records = merged.memory, records.count <= 1000, records.allSatisfy(\.valid) else { throw APIError.invalidResponse }
                }
                // A confirmed save is a new baseline even if the user edited locally
                // while it was in flight. Never apply it to a different account.
                guard sessionRevision == accountRevision else { return }
            }
            var projected: [Conversation] = []
            var remoteIDs = Set<String>()
            for index in merged.conversations.indices {
                guard let key = merged.conversations[index].object?["id"]?.string, remoteIDs.insert(key).inserted else { throw APIError.invalidResponse }
                let id = conversationIDs[key] ?? UUID()
                conversationIDs[key] = id
                var conversation = try merged.projectedConversation(at: index, id: id, messageIDs: &messageIDs)
                // Internet consent belongs to this device and conversation, never to a server payload.
                if let deviceConversation = conversations.first(where: { $0.id == id }) {
                    conversation.internetPermission = deviceConversation.internetPermission
                    let deviceMessages = Dictionary(uniqueKeysWithValues: deviceConversation.messages.map { ($0.id, $0.nativeContent) })
                    for messageIndex in conversation.messages.indices {
                        conversation.messages[messageIndex].nativeContent = deviceMessages[conversation.messages[messageIndex].id] ?? nil
                    }
                }
                projected.append(conversation)
            }
            if syncMemory && memorySyncEnabled {
                memoryRecords = MemoryPolicy.merge(memoryRecords, merged.memory ?? [])
                memoryBaseline = merged.memory ?? []
                refreshMemoryIndex()
            }
            hasHistoryConflict = false; pendingHistorySave = nil
            historySnapshot = merged; historyConversationIDs = conversationIDs; historyMessageIDs = messageIDs
            historyBaseline = projected.sorted { $0.updatedAt > $1.updatedAt }
            // Reapply only edits made since the request began, including deletion.
            // Imported remote conversations were not in `local` and remain intact.
            let captured = Dictionary(uniqueKeysWithValues: local.map { ($0.id, $0) })
            let current = Dictionary(uniqueKeysWithValues: conversations.map { ($0.id, $0) })
            let removed = Set(captured.keys).subtracting(current.keys)
            projected.removeAll { removed.contains($0.id) }
            for conversation in conversations where captured[conversation.id] != conversation {
                projected.removeAll { $0.id == conversation.id }
                projected.append(conversation)
            }
            conversations = projected.sorted { $0.updatedAt > $1.updatedAt }
            if let selection, !conversations.contains(where: { $0.id == selection }) { self.selection = nil }
            guard persist() else {
                historyStatus = "Copie distante reçue, mais l’enregistrement sur cet appareil a échoué. Réessayez la synchronisation."
                return
            }
            historyStatus = conversations == historyBaseline
                ? "Historique synchronisé avec votre compte."
                : "Copie distante enregistrée ; de nouvelles modifications locales restent à synchroniser."
        } catch {
            if sessionRevision == accountRevision { historyStatus = "Synchronisation non terminée. Vos conversations locales sont conservées. " + error.localizedDescription }
        }
    }
    private func armGenerationDeadline(generation: UUID, account: UUID) {
        generationDeadline?.cancel()
        let remaining = max(0, generationExpiresAt?.timeIntervalSinceNow ?? 0)
        generationDeadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(remaining)) } catch { return }
            guard let self, self.generationRevision == generation, self.sessionRevision == account else { return }
            self.stop(); self.error = LocalAgentError.budget.localizedDescription
        }
    }
    private var deviceReads: [UUID: (count: Int, started: Date)] = [:]
    private func readDeviceData(action: String, query: String, generation: UUID, account: UUID) async throws -> LocalToolResult {
        try Task.checkCancellation()
        guard generationRevision == generation, sessionRevision == account else { throw CancellationError() }
        if deviceReads[generation] == nil {
            deviceReads[generation] = (0, Date())
            generationDeadline?.cancel(); generationDeadline = nil
        }
        deviceReads[generation]!.count += 1
        defer {
            deviceReads[generation]!.count -= 1
            if deviceReads[generation]!.count == 0 {
                if generationRevision == generation, sessionRevision == account,
                   let started = deviceReads[generation]?.started, let expiry = generationExpiresAt {
                    generationExpiresAt = expiry.addingTimeInterval(Date().timeIntervalSince(started))
                    armGenerationDeadline(generation: generation, account: account)
                }
                deviceReads[generation] = nil
            }
        }
        let result = try await LocalDeviceData.read(action: action, query: query)
        try Task.checkCancellation()
        guard generationRevision == generation, sessionRevision == account else { throw CancellationError() }
        return result
    }
    private func appendNativeContent(_ blocks: [NativeContentBlock], conversation: UUID, message: UUID,
                                     generation: UUID, account: UUID) {
        guard generationRevision == generation, sessionRevision == account,
              let i = conversations.firstIndex(where: { $0.id == conversation }),
              let j = conversations[i].messages.firstIndex(where: { $0.id == message }) else { return }
        var existing = conversations[i].messages[j].nativeContent?.blocks ?? []
        existing.append(contentsOf: blocks.filter { block in !existing.contains(where: { $0.id == block.id }) })
        conversations[i].messages[j].nativeContent = NativeContentPayload(blocks: existing)
        persist()
    }
    private func requestInternet(url: URL, conversation: UUID, generation: UUID, account: UUID) async throws -> Bool {
        try Task.checkCancellation()
        guard generationRevision == generation, sessionRevision == account,
              let index = conversations.firstIndex(where: { $0.id == conversation }) else { throw CancellationError() }
        if let decision = conversations[index].internetPermission { return decision == .allowed }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard !Task.isCancelled, generationRevision == generation, sessionRevision == account else {
                    continuation.resume(returning: false); return
                }
                internetWaiters.append(continuation)
                if internetApproval == nil {
                    generationDeadline?.cancel(); generationDeadline = nil
                    approvalStartedAt = Date()
                    internetApproval = InternetApprovalRequest(conversation: conversation, url: url)
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard self?.generationRevision == generation, self?.sessionRevision == account else { return }
                self?.cancelInternetApproval()
            }
        }
    }
    func resolveInternetApproval(allow: Bool) {
        guard let request = internetApproval,
              let index = conversations.firstIndex(where: { $0.id == request.conversation }) else { return }
        conversations[index].internetPermission = allow ? .allowed : .denied
        let saved = persist()
        if !saved { conversations[index].internetPermission = nil }
        if let started = approvalStartedAt, let expiry = generationExpiresAt {
            generationExpiresAt = expiry.addingTimeInterval(Date().timeIntervalSince(started))
            armGenerationDeadline(generation: generationRevision, account: sessionRevision)
        }
        internetApproval = nil; approvalStartedAt = nil
        let waiters = internetWaiters; internetWaiters = []
        for waiter in waiters { waiter.resume(returning: allow && saved) }
    }
    private func cancelInternetApproval() {
        internetApproval = nil; approvalStartedAt = nil
        let waiters = internetWaiters; internetWaiters = []
        for waiter in waiters { waiter.resume(returning: false) }
    }
    private func storageURL() throws -> URL {
        if let session { return try historyURL(session.accountId) }
        return try guestHistoryURL()
    }
    private func guestHistoryURL() throws -> URL {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return directory.appendingPathComponent("history-guest.json")
    }
    private func recordLocalEvent(_ event: LocalAgentEvent, generation: UUID, account: UUID) {
        guard generationRevision == generation, sessionRevision == account else { return }
        if let index = localEvents.firstIndex(where: { $0.id == event.id }) { localEvents[index] = event }
        else { localEvents.append(event) }
        if let activeReply, let i = conversations.firstIndex(where: { $0.id == activeReply.conversation }),
           let j = conversations[i].messages.firstIndex(where: { $0.id == activeReply.message }) {
            conversations[i].messages[j].localEvents = localEvents
            persist()
        }
    }
    private func manageAutomation(_ arguments: String, model: String, account: UUID) async throws -> String {
        guard sessionRevision == account else { throw CancellationError() }
        return try await AutomationTools.execute(arguments, model: model, scope: session?.accountId ?? "guest")
    }
    private func saveLocalDocument(_ document: LocalDocument, generation: UUID, account: UUID) throws {
        guard generationRevision == generation, sessionRevision == account else { throw CancellationError() }
        let previous = localDocuments
        if let index = localDocuments.firstIndex(where: { $0.id == document.id }) { localDocuments[index] = document }
        else { localDocuments.append(document) }
        guard persist() else { localDocuments = previous; throw LocalAgentError.unavailable("Enregistrement du document impossible.") }
    }
    func importDocument(name: String, text: String) throws {
        guard !isRestoring, !isStreaming, text.utf8.count <= 100_000 else { throw LocalAgentError.invalidInput }
        let document = LocalDocument(name: String(name.prefix(120)), text: text)
        localDocuments.append(document)
        guard persist() else { localDocuments.removeAll { $0.id == document.id }; throw LocalAgentError.unavailable("Enregistrement du document impossible.") }
    }
    /// Explicit copy into the signed-in account. Guest originals remain available after logout.
    func importGuestHistory() {
        guard session != nil, !isRestoring, !isStreaming, !isSynchronizing else { return }
        do {
            let cache = try JSONDecoder().decode(HistoryCache.self, from: services.readLocalHistory(guestHistoryURL()))
            let previous = conversations
            let imported = importedGuestSnapshots
            for original in cache.conversations where importedGuestSnapshots[original.id] != original {
                var copy = original
                copy.id = UUID()
                copy.internetPermission = nil
                conversations.append(copy)
                importedGuestSnapshots[original.id] = original
            }
            guard persist() else { conversations = previous; importedGuestSnapshots = imported; return }
            historyStatus = "Conversations invitées copiées dans ce compte. Les originaux restent sur cet appareil."
            scheduleAutomaticSync()
        } catch { historyStatus = "Aucun historique invité lisible à importer." }
    }
    func setCalendarEnabled(_ enabled: Bool) async {
        let revision = sessionRevision
        do {
            let allowed = enabled ? try await LocalDeviceData.authorizeCalendar() : false
            guard sessionRevision == revision else { return }
            calendarEnabled = allowed; persist()
            if enabled && !allowed { error = "Autorisez l’accès au calendrier dans les réglages iOS." }
        } catch { if sessionRevision == revision { self.error = error.localizedDescription } }
    }
    func setRemindersEnabled(_ enabled: Bool) async {
        let revision = sessionRevision
        do {
            let allowed = enabled ? try await LocalDeviceData.authorizeReminders() : false
            guard sessionRevision == revision else { return }
            remindersEnabled = allowed; persist()
            if enabled && !allowed { error = "Autorisez l’accès aux rappels dans les réglages iOS." }
        } catch { if sessionRevision == revision { self.error = error.localizedDescription } }
    }
    func disableAutomaticSync() {
        automaticSync = false; syncTask?.cancel(); syncTask = nil; persist()
    }
    func enableAutomaticSync() {
        guard session != nil else { authenticationPresented = true; return }
        automaticSync = true
        if persist() { scheduleAutomaticSync() }
    }
    func foreground() {
        Task { await self.synchronizeCloudAgentState(); await self.resumeCloudHermes(); await self.recoverRemoteHermes() }
        scheduleAutomaticSync()
    }
    private func startNetworkMonitoring() {
        guard services.monitorConnectivity, !monitoringNetwork else { return }
        monitoringNetwork = true
        networkMonitor.pathUpdateHandler = { [weak self] path in
            let reachable = path.status == .satisfied
            Task { @MainActor [weak self] in
                self?.connectivityChanged(reachable)
            }
        }
        networkMonitor.start(queue: DispatchQueue(label: "cloud.multivibe.chat.connectivity"))
    }
    func connectivityChanged(_ reachable: Bool) {
        if reachable { Task { await self.synchronizeCloudAgentState(); await self.resumeCloudHermes(); await self.recoverRemoteHermes() } }
        online = reachable
        if reachable { scheduleAutomaticSync() }
        else { syncTask?.cancel(); syncTask = nil }
    }
    private func scheduleAutomaticSync() {
        guard automaticSync, online, session != nil, !isRestoring, !isStreaming, !hasHistoryConflict else { return }
        syncTask?.cancel()
        let revision = sessionRevision
        syncTask = Task { [weak self] in
            guard let self else { return }
            for attempt in 0..<5 {
                do { try await services.syncDelay(attempt) } catch { return }
                guard !Task.isCancelled, online, automaticSync, sessionRevision == revision, !hasHistoryConflict else { return }
                await synchronizeHistory(automatic: true)
                if historySnapshot != nil, pendingHistorySave == nil, conversations == historyBaseline, !memorySyncEnabled || memoryRecords.filter({ $0.state != .proposed }) == memoryBaseline { return }
            }
        }
    }
    /// Titles a conversation from its first user request, in the background.
    ///
    /// The request runs against the same model and access as the conversation and
    /// never blocks or cancels the visible reply. It is attempted once per first
    /// user message; any failure simply keeps the local truncation fallback.
    private func scheduleTitle(conversation id: UUID) {
        guard let snapshot = conversations.first(where: { $0.id == id }),
              let firstUser = snapshot.messages.first(where: { $0.role == "user" }),
              !snapshot.messages.isEmpty,
              snapshot.messages.first?.role == "user",
              snapshot.titleGeneratedFor != firstUser.id else { return }
        // Never spend a request on an empty or unusable prompt.
        let request = String(firstUser.content.prefix(ConversationTitle.maximumInputCharacters))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !request.isEmpty else { return }
        // Claim the marker before starting so a second turn cannot enqueue a duplicate.
        titleTasks[id]?.cancel()
        let account = sessionRevision
        titleTasks[id] = Task {
            do {
                let output = try await titleSummary(model: snapshot.model, access: snapshot.modelAccess, request: request)
                try Task.checkCancellation()
                guard sessionRevision == account else { return }
                guard let title = ConversationTitle.normalize(output) else { throw TitleError.unusable }
                applyGeneratedTitle(title, conversation: id, firstUser: firstUser.id)
            } catch is CancellationError {
                // A newer first message or an account change superseded this request.
            } catch {
                // Keep the truncation fallback; still record the attempt so an
                // offline or unavailable model is not retried on every turn.
                guard sessionRevision == account else { return }
                markTitleAttempted(conversation: id, firstUser: firstUser.id)
            }
        }
    }
    private enum TitleError: Error { case unusable }
    private func titleSummary(model: String, access: SelectedModelAccess?, request: String) async throws -> String {
        let prompt = ConversationTitle.instructions + "\n\nDemande de l'utilisateur :\n" + request
        if ModelExecution(model).isLocal { return try await services.summarizeTitle(model, prompt) }
        guard let access, access.modelId == model else { throw APIError.server(409, "model_access_unavailable") }
        let credentials = try await validSession()
        try Task.checkCancellation()
        let buffer = MemoryReviewOutput()
        try await streamUsingAccess(model, access: access, messages: [ChatMessage(role: "user", content: prompt)],
                                    token: credentials.accessToken) { await buffer.append($0) }
        return await buffer.value()
    }
    /// Applies a generated title only if the conversation still holds the same first
    /// request and no title was settled in the meantime.
    private func applyGeneratedTitle(_ title: String, conversation id: UUID, firstUser: UUID) {
        guard let index = conversations.firstIndex(where: { $0.id == id }),
              conversations[index].titleGeneratedFor != firstUser,
              conversations[index].messages.first?.id == firstUser,
              let firstUserMessage = conversations[index].messages.first(where: { $0.id == firstUser }),
              conversations[index].title == ConversationTitle.fallback(for: firstUserMessage.content),
              let normalized = ConversationTitle.normalize(title) else { return }
        let previous = conversations[index].title
        conversations[index].title = normalized
        // The marker records the attempt even if persistence fails, so a message is
        // never re-summarized in a loop.
        conversations[index].titleGeneratedFor = firstUser
        guard persist() else {
            conversations[index].title = previous
            return
        }
        scheduleAutomaticSync()
    }
    private func markTitleAttempted(conversation id: UUID, firstUser: UUID) {
        guard let index = conversations.firstIndex(where: { $0.id == id }),
              conversations[index].titleGeneratedFor != firstUser else { return }
        conversations[index].titleGeneratedFor = firstUser
        persist()
    }
    private func scheduleMemoryReview(conversation id: UUID) {
        guard let snapshot = conversations.first(where: { $0.id == id }),
              let tail = snapshot.messages.last, tail.role == "assistant", tail.completion == .completed,
              snapshot.memoryReviewedThrough != tail.id else { return }
        memoryReviews[id]?.cancel()
        let account = sessionRevision
        let baseline = memoryRecords
        let start = snapshot.memoryReviewedThrough.flatMap { marker in snapshot.messages.firstIndex { $0.id == marker } }.map { $0 + 1 } ?? 0
        let messages = Array(snapshot.messages.dropFirst(start))
        let existing = MemoryPolicy.items(baseline).filter { $0.memory.scope == (snapshot.memoryScope ?? "") }.map(\.memory)
        memoryReviews[id] = Task {
            do {
                try await services.memoryReviewDelay()
                try Task.checkCancellation()
                guard sessionRevision == account else { return }
                let encoder = JSONEncoder()
                let payload = "Existing memories:\n" + String(decoding: try encoder.encode(existing), as: UTF8.self)
                    + "\nConversation messages:\n" + String(decoding: try encoder.encode(messages), as: UTF8.self)
                // Do not silently mark a truncated conversation as reviewed.
                guard payload.utf8.count <= 48_000 else { throw MemoryError.invalid }
                let output: String
                if snapshot.model == LocalModel.id {
                    output = try await services.reviewLocalMemory(payload)
                } else if ModelExecution(snapshot.model) == .downloaded {
                    let buffer = MemoryReviewOutput()
                    try await services.downloadedRespond(snapshot.model, [ChatMessage(role: "system", content: AutomaticMemory.instructions),
                        ChatMessage(role: "user", content: payload)], nil) { await buffer.append($0) }
                    output = await buffer.value()
                } else {
                    let credentials = try await validSession()
                    try Task.checkCancellation()
                    guard sessionRevision == account else { return }
                    let buffer = MemoryReviewOutput()
                    try await streamUsingAccess(snapshot.model, access: snapshot.modelAccess, messages: [ChatMessage(role: "system", content: AutomaticMemory.instructions),
                        ChatMessage(role: "user", content: payload)], token: credentials.accessToken) { await buffer.append($0) }
                    output = await buffer.value()
                }
                try Task.checkCancellation()
                guard sessionRevision == account, !isRestoring,
                      let index = conversations.firstIndex(where: { $0.id == id }),
                      conversations[index].messages == snapshot.messages,
                      conversations[index].memoryScope == snapshot.memoryScope else { return }
                let changes = try AutomaticMemory.changes(output)
                // A manual forget or correction during inference always wins, even for proposed additions.
                guard memoryRecords == baseline else {
                    conversations[index].memoryReviewedThrough = tail.id
                    if !persist() { conversations[index].memoryReviewedThrough = snapshot.memoryReviewedThrough }
                    return
                }
                let updated = AutomaticMemory.apply(changes, messages: messages, conversation: snapshot,
                    baseline: baseline, current: memoryRecords)
                let old = memoryRecords
                memoryRecords = updated
                conversations[index].memoryReviewedThrough = tail.id
                guard persist() else {
                    memoryRecords = old
                    conversations[index].memoryReviewedThrough = snapshot.memoryReviewedThrough
                    return
                }
                refreshMemoryIndex(); scheduleAutomaticSync()
            } catch is CancellationError {
                // A newer user turn or account change superseded this review.
            } catch {
                if sessionRevision == account { memoryError = "La mise à jour automatique de la mémoire n’a pas abouti. Elle sera réessayée après le prochain échange." }
            }
        }
    }

    func draftMemory(from message: ChatMessage) {
        guard !isRestoring, !isStreaming, !isSynchronizing else { return }
        memoryDraft = MemoryDraft(text: String(message.content.prefix(600)),
            evidence: MemoryEvidence(origin: message.role == "user" ? .userMessage : .userConfirmation,
                quote: String(message.content.prefix(4000)), date: Date(),
                conversationID: current?.memorySourceID ?? selection, messageID: message.id, sourceRole: message.role),
            scope: current?.memoryScope ?? "")
    }
    func editMemory(_ item: MemoryItem) {
        guard let evidence = item.memory.evidence else { return }
        memoryDraft = MemoryDraft(id: item.memory.id, text: item.memory.text, evidence: evidence,
            topic: item.memory.topic, kind: item.memory.kind, scope: item.memory.scope, expiresAt: item.memory.expiresAt,
            replaces: item.memory.id)
    }
    @discardableResult func saveMemory(_ draft: MemoryDraft) -> Bool {
        guard !isRestoring, !isStreaming, !isSynchronizing else { return false }
        let old = memoryRecords
        let oldBaseline = memoryBaseline; let oldSnapshot = historySnapshot; let oldPending = pendingHistorySave
        let related = memoryItems.filter { $0.memory.topicKey == MemoryPolicy.normalized(draft.scope) + "|" + MemoryPolicy.normalized(draft.topic) }
        if related.contains(where: { $0.memory.id != draft.replaces && $0.memory.text != draft.text }) && !draft.resolveConflicts {
            memoryError = "Un souvenir différent existe pour ce sujet. Choisissez explicitement de le remplacer."; return false
        }
        let existing = draft.replaces.flatMap { id in memoryRecords.first { $0.id == id && $0.state != .deleted } }
        if let id = draft.replaces, memoryRecords.contains(where: { $0.id == id && $0.state == .deleted }) {
            memoryError = "Ce souvenir a été oublié. Créez-en un nouveau si nécessaire."; return false
        }
        var evidence = draft.evidence
        evidence.origin = draft.replaces == nil && evidence.sourceRole == "user" && draft.text == evidence.quote
            ? (evidence.origin == .userEntry ? .userEntry : .userMessage) : .userConfirmation
        if evidence.origin == .userConfirmation {
            evidence.priorQuote = evidence.quote
            evidence.quote = draft.text
            evidence.date = Date()
        }
        var memory = AgentMemory(id: existing?.id ?? UUID(), topic: draft.topic.trimmingCharacters(in: .whitespacesAndNewlines),
            text: draft.text.trimmingCharacters(in: .whitespacesAndNewlines), kind: draft.kind,
            scope: draft.scope.trimmingCharacters(in: .whitespacesAndNewlines), state: .confirmed, evidence: evidence,
            expiresAt: draft.kind == .temporary ? draft.expiresAt : nil)
        memory.ancestors = memoryRecords.filter { $0.id == memory.id }.map(\.version)
        guard memory.valid, memoryRecords.count < 1000 else { memoryError = MemoryError.invalid.localizedDescription; return false }
        if draft.resolveConflicts {
            for item in related where item.memory.id != memory.id { forgetMemoryRecords(item.memory.id) }
        }
        memoryRecords.append(memory)
        if !persist() { memoryRecords = old; memoryBaseline = oldBaseline; historySnapshot = oldSnapshot; pendingHistorySave = oldPending; return false }
        refreshMemoryIndex(); memoryDraft = nil; scheduleAutomaticSync()
        return true
    }
    @discardableResult func forgetMemory(_ id: UUID) -> Bool {
        guard !isRestoring, !isStreaming, !isSynchronizing else { return false }
        let old = memoryRecords
        let oldBaseline = memoryBaseline; let oldSnapshot = historySnapshot; let oldPending = pendingHistorySave
        forgetMemoryRecords(id)
        guard persist() else { memoryRecords = old; memoryBaseline = oldBaseline; historySnapshot = oldSnapshot; pendingHistorySave = oldPending; return false }
        refreshMemoryIndex(); scheduleAutomaticSync(); return true
    }
    private func forgetMemoryRecords(_ id: UUID) {
        guard let record = memoryRecords.first(where: { $0.id == id }) else { return }
        let tombstone = record.tombstone()
        memoryRecords.removeAll { $0.id == id }; memoryRecords.append(tombstone)
        // Remove forgotten content from cached remote/recovery payloads too.
        memoryBaseline.removeAll { $0.id == id }
        historySnapshot?.memory?.removeAll { $0.id == id }
        pendingHistorySave?.memory?.removeAll { $0.id == id }
        pendingHistorySave?.snapshot.memory?.removeAll { $0.id == id }
    }
    func setMemorySync(_ enabled: Bool) {
        guard session != nil, !isSynchronizing, !isStreaming, !isRestoring else { return }
        let previous = memorySyncEnabled
        memorySyncEnabled = enabled
        if !enabled { historySnapshot?.memory = nil; memoryBaseline = []; pendingHistorySave?.memory = nil; pendingHistorySave?.snapshot.memory = nil }
        if !persist() { memorySyncEnabled = previous; return }
        if enabled { Task { await self.synchronizeHistory() } }
    }
    func setMemoryScope(_ scope: String) {
        guard !isStreaming, !isSynchronizing, let id = selection,
              let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        conversations[index].memoryScope = String(scope.prefix(80)); persist()
    }
    private func refreshMemoryIndex() {
        do { guard let memoryIndex else { throw MemoryError.storage }; try memoryIndex.rebuild(memoryItems); memoryError = nil }
        catch { memoryError = MemoryError.storage.localizedDescription; memoryIndex = nil }
    }
    func source(for reference: MemoryReference) -> AgentMemory? {
        guard !memoryRecords.contains(where: { $0.id == reference.memoryID && $0.state == .deleted }) else { return nil }
        return memoryRecords.first { $0.id == reference.memoryID && $0.version == reference.id && $0.state == .confirmed }
    }
    private func recordMemoryReference(_ record: AgentMemory) {
        guard let activeReply, let i = conversations.firstIndex(where: { $0.id == activeReply.conversation }),
              let j = conversations[i].messages.firstIndex(where: { $0.id == activeReply.message }) else { return }
        let reference = MemoryReference(id: record.version, memoryID: record.id)
        var references = conversations[i].messages[j].memoryReferences ?? []
        if !references.contains(reference), references.count < 36 { references.append(reference) }
        conversations[i].messages[j].memoryReferences = references
    }
    private func memoryTool(action: String, query: String, text: String, conversation: UUID,
                            source: ChatMessage?, generation: UUID, account: UUID) throws -> String {
        guard generationRevision == generation, sessionRevision == account else { throw CancellationError() }
        let scope = conversations.first { $0.id == conversation }?.memoryScope ?? ""
        switch action {
        case "context_memory", "search_memory":
            guard let memoryIndex else { return action == "context_memory" ? "" : MemoryError.storage.localizedDescription }
            let matches = try memoryIndex.search(query, scope: scope)
            let conflicts = memoryItems.contains { $0.conflicting && ($0.memory.scope.isEmpty || MemoryPolicy.normalized($0.memory.scope) == MemoryPolicy.normalized(scope)) }
            let candidates = action == "context_memory" ? Array(matches.prefix(1)) : matches
            var rendered = ""
            for item in candidates {
                let source = MemoryPolicy.render(item)
                if rendered.count + source.count > 3600 { break }
                recordMemoryReference(item.memory)
                rendered += (rendered.isEmpty ? "" : "\n\n") + source
            }
            if action == "context_memory", rendered.isEmpty, !conflicts { return "" }
            return (conflicts ? "Des souvenirs contradictoires sont exclus. Demandez de les résoudre dans Mémoire.\n" : "")
                + (rendered.isEmpty ? "Aucun souvenir validé, non expiré et pertinent. Ne rien déduire de cette absence." : rendered)
        case "read_memory":
            guard let id = UUID(uuidString: query), let item = memoryItems.first(where: { $0.id == id }),
                  item.usable(now: Date()), item.memory.scope.isEmpty || MemoryPolicy.normalized(item.memory.scope) == MemoryPolicy.normalized(scope) else {
                return "Souvenir absent, expiré ou contradictoire. Revérifiez auprès de l’utilisateur ou de l’outil approprié."
            }
            recordMemoryReference(item.memory)
            return MemoryPolicy.render(item)
        case "propose_memory":
            return "La mémoire est gérée automatiquement après la réponse. Aucune validation manuelle n’est nécessaire."
        default: return "Outil mémoire inconnu."
        }
    }

    private func historyURL(_ account: String) throws -> URL {
        // Hash account identifiers rather than accepting path components from a server.
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return directory.appendingPathComponent("history-" + SHA256.hash(data: Data(account.utf8)).map { String(format: "%02x", $0) }.joined() + ".json")
    }
    @discardableResult private func persist() -> Bool {
        guard !isRestoring, storageLoaded else { return false }
        do {
            let url = try storageURL()
            try services.writeHistory(JSONEncoder().encode(HistoryCache(cloudHermesBindings: cloudHermesBindings, cloudAgentState:cloudAgentState, remoteHermes:remoteHermes, memory: memoryRecords, memoryBaseline: memoryBaseline, memorySyncEnabled: memorySyncEnabled, calendarEnabled: calendarEnabled, remindersEnabled: remindersEnabled, documents: localDocuments, importedGuestSnapshots: importedGuestSnapshots, automaticSync: automaticSync, conversations: conversations,
                snapshot: historySnapshot, pending: pendingHistorySave, baseline: historyBaseline,
                conversationIDs: historyConversationIDs, messageIDs: historyMessageIDs)), url)
            return true
        } catch {
            self.error = "Impossible d’enregistrer les conversations sur cet appareil."
            return false
        }
    }
}
