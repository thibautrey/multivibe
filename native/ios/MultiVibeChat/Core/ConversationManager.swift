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
    var readLocalHistory: @MainActor (URL) throws -> Data = { try Data(contentsOf: $0) }
    var localAvailability: @MainActor () -> String? = { LocalModel.unavailableReason }
    var localRespond: @Sendable ([ChatMessage], LocalAgentWorkspace, @escaping @Sendable (String) async -> Void) async throws -> Void = {
        try await LocalAgent.respond(messages: $0, workspace: $1, onText: $2)
    }
    var webFetch: @Sendable (URL, String) async throws -> LocalWebResponse = { try await LocalWebFetch.fetch(url: $0, method: $1) }
    var memoryIndex: @MainActor (URL) throws -> MemoryIndex = { try MemoryIndex(url: $0) }
    var monitorConnectivity = true
    var syncDelay: @Sendable (Int) async throws -> Void = { attempt in try await Task.sleep(for: .seconds(min(60, 2 << attempt))) }
    var models: @MainActor (String) async throws -> [ModelOption] = { try await ChatAPI.shared.models(token: $0) }
}

@MainActor @Observable final class ConversationManager {
    static let shared = makeShared()
    private static func makeShared() -> ConversationManager {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-local-agent-ui-fixture") {
            // Deterministic UI transport: no account, disk data, live inference, or network.
            return ConversationManager(services: SessionServices(writeHistory: { _, _ in }, load: { nil },
                readLocalHistory: { _ in throw CocoaError(.fileReadNoSuchFile) }, localAvailability: { nil },
                localRespond: { _, workspace, output in
                    let result = try await workspace.execute(action: "fetch_website", query: "https://example.com", documentID: "", text: "", lhs: 0, rhs: 0)
                    await output(result)
                }, webFetch: { url, _ in
                    LocalWebResponse(url: url, status: 200, contentType: "text/plain", text: "EXAMPLE-FETCH-SUCCEEDED")
                }, memoryIndex: { _ in try MemoryIndex(url: nil) }, monitorConnectivity: false))
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
    var memoryItems: [MemoryItem] { MemoryPolicy.items(memoryRecords) }

    var authenticationPresented = false
    private(set) var internetApproval: InternetApprovalRequest?
    private var internetWaiters: [CheckedContinuation<Bool, Never>] = []
    private var generationExpiresAt: Date?
    private var approvalStartedAt: Date?
    private let networkMonitor = NWPathMonitor()
    private var monitoringNetwork = false
    private var online = false
    private var syncTask: Task<Void, Never>?
    var session: NativeSession?
    init(services: SessionServices = SessionServices()) {
        self.services = services
        session = services.load()
    }
    private(set) var isRestoring = true
    private var restorationRevision = UUID()
    var conversations: [Conversation] = []
    var selection: UUID? {
        didSet {
            guard selection != oldValue else { return }
            stop()
            voice.silence()
            error = nil
            if let current {
                // Do not silently substitute a different model for an existing chat.
                selectedModel = models.contains(where: { $0.id == current.model }) ? current.model : ""
            }
        }
    }
    var models: [ModelOption] = []
    private(set) var isLoadingModels = false
    private(set) var modelsError: String?
    private var modelLoadRevision = UUID()
    var selectedModel = ""
    var error: String?
    var isStreaming = false
    private(set) var completedReply: UUID?
    let voice = VoiceController()
    enum ShortcutRequest { case newConversation, dictation, draft(String), voiceConversation, assistantVoiceConversation }
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
    private var pendingHistorySave: PendingHistorySave?
    private struct HistoryCache: Codable {
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
    var current: Conversation? { conversations.first { $0.id == selection } }

    func restore(loadRemoteModels: Bool = true) async {
        let restoration = UUID()
        restorationRevision = restoration
        isRestoring = true
        defer { if restorationRevision == restoration { isRestoring = false; scheduleAutomaticSync() } }
        startNetworkMonitoring()
        models = [LocalModel.option]
        selectedModel = LocalModel.id
        storageLoaded = false
        memoryRecords = []; memoryBaseline = []; memoryIndex = nil; memoryDraft = nil; memorySyncEnabled = false; memoryError = nil
        calendarEnabled = false; remindersEnabled = false
        do {
            let data: Data?
            do { data = try services.readLocalHistory(storageURL()) }
            catch CocoaError.fileReadNoSuchFile { data = nil }
            if let data {
                if let cache = try? JSONDecoder().decode(HistoryCache.self, from: data) {
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
            let available = [LocalModel.option] + remoteModels.filter { $0.id != LocalModel.id }
            models = available
            if !selectedModel.isEmpty {
                if !available.contains(where: { $0.id == selectedModel }) { selectedModel = "" }
            } else if let current {
                selectedModel = available.contains(where: { $0.id == current.model }) ? current.model : ""
            } else { selectedModel = available.first?.id ?? "" }

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
            let renewed = try await services.refresh(previous)
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
                    localDocuments = []; automaticSync = false
                    await restore(loadRemoteModels: false)
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
    func accept(_ session: NativeSession) async throws {
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
        conversations = []; localDocuments = []; automaticSync = false; selection = nil
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
    func newConversation() {
        guard !isRestoring, storageLoaded else { return }
        stop()
        let conversation = Conversation(model: selectedModel)
        conversations.insert(conversation, at: 0); selection = conversation.id
        persist()
    }
    @discardableResult func send(_ text: String) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isRestoring, !isStreaming, !isSynchronizing || selectedModel == LocalModel.id else { return false }
        guard session != nil || selectedModel == LocalModel.id else { error = APIError.authenticationRequired.localizedDescription; return false }
        guard storageLoaded else { error = "L’historique local n’a pas pu être ouvert. Il est conservé sans modification. Relancez l’app après avoir déverrouillé l’appareil."; return false }
        if selectedModel == LocalModel.id, let reason = localUnavailableReason { error = reason; return false }
        guard !selectedModel.isEmpty else { error = APIError.noModel.localizedDescription; return false }
        if current == nil { newConversation() }
        guard let id = selection, let index = conversations.firstIndex(where: { $0.id == id }) else { return false }
        conversations[index].model = selectedModel
        conversations[index].messages.append(ChatMessage(role: "user", content: text))
        if conversations[index].messages.count == 1 { conversations[index].title = String(text.prefix(70)) }
        if let remembered = MemoryCommand.remember(text) {
            let source = conversations[index].messages.last!
            memoryDraft = MemoryDraft(text: remembered, evidence: MemoryEvidence(origin: .userMessage, quote: source.content,
                date: Date(), conversationID: current?.memorySourceID ?? id, messageID: source.id, sourceRole: "user"), scope: current?.memoryScope ?? "")
            conversations[index].messages.append(ChatMessage(role: "assistant", content: "Validez le souvenir et sa source dans la fiche Mémoire avant son utilisation.", completion: .completed))
            return persist()
        }
        if MemoryCommand.isForget(text) { memoryPresented = true; return persist() }
        return startReply(conversation: id, index: index)
    }
    /// Retry only the current tail, never truncate later turns or duplicate the prompt.
    @discardableResult func retry(conversation id: UUID, message: UUID) -> Bool {
        guard !isStreaming, !isSynchronizing || current?.model == LocalModel.id, selection == id,
              let index = conversations.firstIndex(where: { $0.id == id }),
              let last = conversations[index].messages.last, last.id == message, last.canRetry,
              conversations[index].messages.dropLast().last?.role == "user",
              models.contains(where: { $0.id == conversations[index].model }) else { return false }
        selectedModel = conversations[index].model
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
        if model == LocalModel.id {
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
                }
            }
            do {
                if model == LocalModel.id {
                    let deviceData = LocalDeviceSnapshot()
                    try Task.checkCancellation()
                    guard generationRevision == revision && sessionRevision == accountRevision else { return }
                    let workspace = LocalAgentWorkspace(conversations: conversations, documents: localDocuments, deviceData: deviceData,
                        event: { event in
                            await self.recordLocalEvent(event, generation: revision, account: accountRevision)
                        }, saveDocument: { document in
                            try await self.saveLocalDocument(document, generation: revision, account: accountRevision)
                        }, readDevice: { action, query in
                            try await self.readDeviceData(action: action, query: query, generation: revision, account: accountRevision)
                        }, allowedDeviceActions: LocalDeviceScope.actions(for: input.last?.content ?? ""), authorizeInternet: { url in
                            try await self.requestInternet(url: url, conversation: id, generation: revision, account: accountRevision)
                        }, webFetch: services.webFetch, memory: { action, query, text in
                            try await self.memoryTool(action: action, query: query, text: text, conversation: id,
                                source: input.last, generation: revision, account: accountRevision)
                        })
                    try await services.localRespond(input, workspace) { delta in
                        await self.append(delta, conversation: id, message: reply.id, generation: revision, account: accountRevision)
                    }
                } else {
                    let session = try await validSession()
                    try Task.checkCancellation()
                    guard generationRevision == revision && sessionRevision == accountRevision else { return }
                    try await services.stream(model, input, session.accessToken) { delta in
                        await self.append(delta, conversation: id, message: reply.id, generation: revision, account: accountRevision)
                    }
                }
                try Task.checkCancellation()
                guard generationRevision == revision && sessionRevision == accountRevision else { return }
                // Only a successfully terminated stream authorizes automatic playback.
                setReplyCompletion(.completed)
                completedReply = reply.id
            } catch is CancellationError {
                if generationRevision == revision && sessionRevision == accountRevision { setReplyCompletion(.stopped) }
            } catch {
                if generationRevision == revision && sessionRevision == accountRevision {
                    setReplyCompletion(.failed)
                    self.error = model == LocalModel.id
                        ? (error as? LocalAgentError)?.localizedDescription ?? "L’agent local n’a pas pu terminer cette demande. Réessayez avec une demande plus précise ; les étapes déjà enregistrées sont conservées."
                        : error.localizedDescription
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
    }
    private func setReplyCompletion(_ completion: ChatMessage.Completion) {
        guard let activeReply,
              let i = conversations.firstIndex(where: { $0.id == activeReply.conversation }),
              let j = conversations[i].messages.firstIndex(where: { $0.id == activeReply.message }) else { return }
        conversations[i].messages[j].completion = completion
        conversations[i].updatedAt = Date()
    }
    func stop() {
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
        refreshMemoryIndex(); scheduleAutomaticSync()
    }
    func logout() async {
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
        services.clear(); session = nil; conversations = []; selection = nil
        models = []; selectedModel = ""; wantsNewConversation = false; wantsVoice = false; wantsVoiceConversation = false; wantsImmediateVoiceCapture = false; pendingDraft = nil; error = nil
        localDocuments = []; automaticSync = false
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
                conversation.internetPermission = conversations.first { $0.id == id }?.internetPermission
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
    private func readDeviceData(action: String, query: String, generation: UUID, account: UUID) async throws -> String {
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
    private func saveLocalDocument(_ document: LocalDocument, generation: UUID, account: UUID) throws {
        guard generationRevision == generation, sessionRevision == account else { throw CancellationError() }
        localDocuments.append(document)
        guard persist() else { localDocuments.removeAll { $0.id == document.id }; throw LocalAgentError.unavailable("Enregistrement du document impossible.") }
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
    func draftMemory(from message: ChatMessage) {
        guard !isRestoring, !isStreaming, !isSynchronizing else { return }
        memoryDraft = MemoryDraft(text: String(message.content.prefix(600)),
            evidence: MemoryEvidence(origin: message.role == "user" ? .userMessage : .userConfirmation,
                quote: String(message.content.prefix(4000)), date: current?.updatedAt ?? Date(),
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
    private func memoryTool(action: String, query: String, text: String, conversation: UUID,
                            source: ChatMessage?, generation: UUID, account: UUID) throws -> String {
        guard generationRevision == generation, sessionRevision == account else { throw CancellationError() }
        let scope = conversations.first { $0.id == conversation }?.memoryScope ?? ""
        switch action {
        case "context_memory", "search_memory":
            guard let memoryIndex else { return MemoryError.storage.localizedDescription }
            let matches = try memoryIndex.search(query, scope: scope)
            let conflicts = memoryItems.contains { $0.conflicting && ($0.memory.scope.isEmpty || MemoryPolicy.normalized($0.memory.scope) == MemoryPolicy.normalized(scope)) }
            let candidates = action == "context_memory" ? Array(matches.prefix(1)) : matches
            var rendered = ""
            for item in candidates {
                let source = MemoryPolicy.render(item)
                if rendered.count + source.count > 3600 { break }
                rendered += (rendered.isEmpty ? "" : "\n\n") + source
            }
            return (conflicts ? "Des souvenirs contradictoires sont exclus. Demandez de les résoudre dans Mémoire.\n" : "")
                + (rendered.isEmpty ? "Aucun souvenir validé, non expiré et pertinent. Ne rien déduire de cette absence." : rendered)
        case "read_memory":
            guard let id = UUID(uuidString: query), let item = memoryItems.first(where: { $0.id == id }),
                  item.usable(now: Date()), item.memory.scope.isEmpty || MemoryPolicy.normalized(item.memory.scope) == MemoryPolicy.normalized(scope) else {
                return "Souvenir absent, expiré ou contradictoire. Revérifiez auprès de l’utilisateur ou de l’outil approprié."
            }
            return MemoryPolicy.render(item)
        case "propose_memory":
            guard let source, source.role == "user", !text.isEmpty, text.count <= 600, !query.isEmpty, query.count <= 80,
                  source.content.count <= 4000, source.content.contains(text) else {
                return "Proposition refusée : utilisez une citation exacte du dernier message utilisateur, jamais une réponse assistant ou une inférence."
            }
            if memoryRecords.contains(where: { $0.evidence?.messageID == source.id && $0.text == text }) {
                return "Cette proposition existe déjà. Elle doit être validée dans Mémoire."
            }
            guard memoryRecords.count < 1000 else { return "Mémoire pleine. Gérez les souvenirs dans Mémoire." }
            let record = AgentMemory(topic: query, text: text, kind: .preference, scope: scope, state: .proposed,
                evidence: MemoryEvidence(origin: .userMessage, quote: source.content, date: Date(),
                    conversationID: conversations.first(where: { $0.id == conversation })?.memorySourceID ?? conversation, messageID: source.id, sourceRole: "user"))
            memoryRecords.append(record)
            guard persist() else { memoryRecords.removeAll { $0.id == record.id }; throw MemoryError.storage }
            return "Proposition enregistrée, NON utilisable et NON confirmée. Invitez l’utilisateur à la valider dans Mémoire."
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
            try services.writeHistory(JSONEncoder().encode(HistoryCache(memory: memoryRecords, memoryBaseline: memoryBaseline, memorySyncEnabled: memorySyncEnabled, calendarEnabled: calendarEnabled, remindersEnabled: remindersEnabled, documents: localDocuments, importedGuestSnapshots: importedGuestSnapshots, automaticSync: automaticSync, conversations: conversations,
                snapshot: historySnapshot, pending: pendingHistorySave, baseline: historyBaseline,
                conversationIDs: historyConversationIDs, messageIDs: historyMessageIDs)), url)
            return true
        } catch {
            self.error = "Impossible d’enregistrer les conversations sur cet appareil."
            return false
        }
    }
}
