import Foundation
import Observation
import CryptoKit

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
    var models: @MainActor (String) async throws -> [ModelOption] = { try await ChatAPI.shared.models(token: $0) }
}

@MainActor @Observable final class ConversationManager {
    static let shared = ConversationManager()
    private let services: SessionServices
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
    private struct HistoryCache: Codable {
        var conversations: [Conversation]
        var snapshot: AccountHistorySnapshot?
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
    var passwordRecovery: PasswordRecoveryRequest?
    private var activeReply: (conversation: UUID, message: UUID)?
    private var generation: Task<Void, Never>?
    private var refreshTask: Task<NativeSession, Error>?
    private var refreshRevision = UUID()
    private var sessionRevision = UUID()
    private var generationRevision = UUID()
    var current: Conversation? { conversations.first { $0.id == selection } }

    func restore() async {
        let restoration = UUID()
        restorationRevision = restoration
        isRestoring = true
        defer { if restorationRevision == restoration { isRestoring = false } }
        guard session != nil else { return }
        let revision = sessionRevision
        do {
            let session = try await validSession()
            guard sessionRevision == revision else { return }
            if let data = try? Data(contentsOf: historyURL(session.accountId)) {
                if let cache = try? JSONDecoder().decode(HistoryCache.self, from: data) {
                    conversations = cache.conversations
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
            let availableModels = try await services.models(session.accessToken)
            guard sessionRevision == revision else { return }
            models = availableModels
            if let current {
                selectedModel = models.contains(where: { $0.id == current.model }) ? current.model : ""
            } else { selectedModel = models.first?.id ?? "" }
        } catch { if sessionRevision == revision { self.error = error.localizedDescription } }
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
                    let failedRevision = sessionRevision
                    services.clear()
                    session = nil
                    conversations = []; selection = nil
                    models = []; selectedModel = ""
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
        isRestoring = true
        resetHistorySync()
        self.session = session
        error = nil; models = []; selectedModel = ""
        conversations = []; selection = nil
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
        stop()
        let conversation = Conversation(model: selectedModel)
        conversations.insert(conversation, at: 0); selection = conversation.id
    }
    @discardableResult func send(_ text: String) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isStreaming, !isSynchronizing else { return false }
        guard session != nil else { error = APIError.authenticationRequired.localizedDescription; return false }
        guard !selectedModel.isEmpty else { error = APIError.noModel.localizedDescription; return false }
        if current == nil { newConversation() }
        guard let id = selection, let index = conversations.firstIndex(where: { $0.id == id }) else { return false }
        conversations[index].model = selectedModel
        conversations[index].messages.append(ChatMessage(role: "user", content: text))
        if conversations[index].messages.count == 1 { conversations[index].title = String(text.prefix(70)) }
        return startReply(conversation: id, index: index)
    }
    /// Retry only the current tail, never truncate later turns or duplicate the prompt.
    @discardableResult func retry(conversation id: UUID, message: UUID) -> Bool {
        guard !isStreaming, !isSynchronizing, session != nil, selection == id,
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
        isStreaming = true; error = nil; persist()
        let revision = generationRevision
        let accountRevision = sessionRevision
        let model = selectedModel
        generation = Task {
            defer {
                if generationRevision == revision && sessionRevision == accountRevision {
                    isStreaming = false; generation = nil; activeReply = nil; persist()
                }
            }
            do {
                let session = try await validSession()
                try Task.checkCancellation()
                guard generationRevision == revision && sessionRevision == accountRevision else { return }
                try await services.stream(model, input, session.accessToken) { delta in
                    await self.append(delta, conversation: id, message: reply.id, generation: revision, account: accountRevision)
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
                    self.error = error.localizedDescription
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
        generation?.cancel(); generation = nil
        isStreaming = false
        persist()
    }
    func delete(_ id: UUID) {
        if selection == id { stop(); selection = nil }
        conversations.removeAll { $0.id == id }; persist()
    }
    func logout() async {
        voice.silence()
        let previous = session
        let inFlightRefresh = refreshTask
        stop()
        refreshRevision = UUID()
        refreshTask = nil
        sessionRevision = UUID()
        let revision = sessionRevision
        resetHistorySync()
        services.clear(); session = nil; conversations = []; selection = nil
        models = []; selectedModel = ""; wantsNewConversation = false; wantsVoice = false; wantsVoiceConversation = false; wantsImmediateVoiceCapture = false; pendingDraft = nil; error = nil
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
        historySnapshot = nil; historyBaseline = []; historyConversationIDs = [:]; historyMessageIDs = [:]
        historyStatus = nil
    }
    /// Explicit synchronization: no upload of legacy local history without a tap.
    /// Never resolve concurrent edits by silently choosing one device's snapshot.
    func synchronizeHistory() async {
        guard !isSynchronizing, !isStreaming, !isRestoring, session != nil else { return }
        isSynchronizing = true
        defer { isSynchronizing = false }
        let accountRevision = sessionRevision
        let local = conversations
        do {
            let session = try await validSession()
            let remote = try await services.readHistory(session.accessToken)
            guard sessionRevision == accountRevision, !isStreaming, conversations == local else { return }
            guard remote.accountId == session.accountId else { throw APIError.invalidResponse }
            if let previous = historySnapshot, previous.revision != remote.revision, local != historyBaseline {
                historyStatus = "Des modifications existent sur cet appareil et sur un autre. Rien n’a été écrasé. La résolution du conflit est nécessaire."
                return
            }
            var merged = remote
            var conversationIDs = historyConversationIDs
            var messageIDs = historyMessageIDs
            if historySnapshot == nil || local != historyBaseline {
                let localIDs = Set(local.map(\.id))
                let deleted = Set(historyBaseline.map(\.id)).subtracting(localIDs)
                merged.conversations.removeAll { item in
                    guard let key = item.object?["id"]?.string, let id = conversationIDs[key] else { return false }
                    return deleted.contains(id)
                }
                for conversation in local {
                    let key = conversationIDs.first { $0.value == conversation.id }?.key ?? conversation.id.uuidString
                    // On first import, retain any independently existing server chat.
                    if historySnapshot == nil, merged.conversations.contains(where: { $0.object?["id"]?.string == key }) {
                        throw APIError.server(409, "history_import_collision")
                    }
                    conversationIDs[key] = conversation.id
                    try merged.store(conversation, serverID: key, messageIDs: &messageIDs)
                }
                merged = try await services.saveHistory(merged, session.accessToken)
                guard sessionRevision == accountRevision, !isStreaming, conversations == local else {
                    // Server save may have committed, but never replace subsequent local work.
                    if sessionRevision == accountRevision { historyStatus = "Copie distante enregistrée ; de nouvelles modifications locales restent à synchroniser." }
                    return
                }
            }
            var projected: [Conversation] = []
            var remoteIDs = Set<String>()
            for index in merged.conversations.indices {
                guard let key = merged.conversations[index].object?["id"]?.string, remoteIDs.insert(key).inserted else { throw APIError.invalidResponse }
                let id = conversationIDs[key] ?? UUID()
                conversationIDs[key] = id
                projected.append(try merged.projectedConversation(at: index, id: id, messageIDs: &messageIDs))
            }
            historySnapshot = merged; historyConversationIDs = conversationIDs; historyMessageIDs = messageIDs
            conversations = projected.sorted { $0.updatedAt > $1.updatedAt }; historyBaseline = conversations
            if let selection, !conversations.contains(where: { $0.id == selection }) { self.selection = nil }
            persist()
            historyStatus = "Historique synchronisé avec votre compte."
        } catch {
            if sessionRevision == accountRevision { historyStatus = "Synchronisation non terminée. Vos conversations locales sont conservées. " + error.localizedDescription }
        }
    }
    private func historyURL(_ account: String) throws -> URL {
        // Hash account identifiers rather than accepting path components from a server.
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return directory.appendingPathComponent("history-" + SHA256.hash(data: Data(account.utf8)).map { String(format: "%02x", $0) }.joined() + ".json")
    }
    private func persist() {
        guard let session else { return }
        do {
            let url = try historyURL(session.accountId)
            try services.writeHistory(JSONEncoder().encode(HistoryCache(conversations: conversations,
                snapshot: historySnapshot, baseline: historyBaseline,
                conversationIDs: historyConversationIDs, messageIDs: historyMessageIDs)), url)
        } catch { self.error = "Impossible d’enregistrer les conversations sur cet appareil." }
    }
}
