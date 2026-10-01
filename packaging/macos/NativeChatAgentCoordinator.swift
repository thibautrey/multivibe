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
        accountID = account; journal = nil; consent = nil; importedConversationIDs = []
        let epoch = loginEpoch
        let url = journalURL(account)
        if FileManager.default.fileExists(atPath: url.path) {
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= 16 * 1024 * 1024 else { throw NativeAgentClientError.tooLarge }
            let saved = try JSONDecoder().decode(Journal.self, from: Data(contentsOf: url))
            guard saved.accountID == account else { throw NativeAgentClientError.accountMismatch }
            journal = saved; importedConversationIDs = saved.imported
        } else { journal = Journal(accountID: account, deviceID: UUID().uuidString.lowercased()) }
        let remote = try await client.consent(accountID: account)
        try check(account, epoch); consent = remote
    }
    func disconnect() async {
        loginEpoch = UUID(); accountID = nil; consent = nil; journal = nil; importedConversationIDs = []; busy = false
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
}
