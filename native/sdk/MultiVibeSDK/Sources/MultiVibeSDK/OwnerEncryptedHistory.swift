import Foundation
import CryptoKit
import Observation

/// Shared encrypted store with separate owner and application key acquisition.
/// The route and app boundary are fixed at initialization.
@MainActor @Observable final class OwnerEncryptedHistory {
    typealias Transport = @MainActor (String, String, Data?) async throws -> Data
    private struct Summary: Decodable { let id: String; let appId: String; let revision: Int; let updatedAt: String }
    private struct Page: Decodable { let data: [Summary]; let nextCursor: String? }
    private struct Record: Decodable {
        let id: String; let accountId: String; let appId: String; let revision: Int; let updatedAt: String; let envelope: HistoryEnvelope
    }
    private struct Receipt: Decodable { let id: String; let revision: Int; let deleted: Bool }
    private struct Pending: Codable {
        let id: String; let accountId: String; let appId: String; let operationId: String; let revision: Int
        let envelope: HistoryEnvelope?
        var method: String { envelope == nil ? "DELETE" : "POST" }
        func body() throws -> Data {
            var value: [String: JSONValue] = ["accountId": .string(accountId), "appId": .string(appId), "operationId": .string(operationId), "revision": .number(Double(revision))]
            if let envelope { value["envelope"] = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(envelope)) }
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            return try encoder.encode(value)
        }
    }
    private struct Cached { let revision: Int; let document: [String: JSONValue] }
    private var keys: HistoryKeys?
    private var pending: Pending?
    private var documents: [String: Cached] = [:]
    private var epoch = UUID()
    private var busy = false
    private let directory: URL
    private(set) var conversations: [MultiVibeConversation] = []
    var unlocked: Bool { keys != nil }
    var hasPending: Bool { pending != nil }
    private let applicationId: String?
    private var path: String { applicationId == nil ? "/native/v2/sdk/conversations" : "/sdk/v2/conversations" }

    init(namespace: String, directory: URL? = nil, applicationId: String? = nil) {
        self.applicationId = applicationId
        let name = SHA256.hash(data: Data(namespace.utf8)).map { String(format: "%02x", $0) }.joined()
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("MultiVibeSDK/EncryptedPending/" + name)
    }
    func lock() {
        epoch = UUID(); keys?.lock(); keys = nil; pending = nil; documents = [:]; conversations = []
        // An in-flight operation retains busy until its defer runs. Its epoch
        // cannot restore plaintext or remove a later operation's pending file.
    }
    private func check(_ expected: UUID) throws {
        guard epoch == expected, keys != nil else { throw MultiVibeError.historyLocked }
    }
    private func file(_ account: String) throws -> URL {
        guard UUID(uuidString: account) != nil, account == account.lowercased() else { throw MultiVibeError.invalidResponse }
        return directory.appendingPathComponent(account + ".json")
    }
    private func retain(_ value: Pending) throws {
        guard !FileManager.default.fileExists(atPath: try file(value.accountId).path) else { throw MultiVibeError.historyWritePending }
        let data = try JSONEncoder().encode(value)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        try data.write(to: file(value.accountId), options: [.atomic, .completeFileProtection])
        pending = value
    }
    private func removePendingFile(_ value: Pending) throws {
        let location = try file(value.accountId)
        guard FileManager.default.fileExists(atPath: location.path) else { return }
        let stored = try JSONDecoder().decode(Pending.self, from: Data(contentsOf: location))
        guard stored.id == value.id, stored.operationId == value.operationId,
              try stored.body() == value.body() else { throw MultiVibeError.historyWritePending }
        try FileManager.default.removeItem(at: location)
    }
    func unlock(accountId: String, code: String, transport: Transport) async throws {
        guard applicationId == nil else { throw MultiVibeError.authenticationRequired }
        guard !busy else { throw MultiVibeError.historyBusy }
        busy = true; defer { busy = false }
        lock(); let expected = epoch
        struct Reply: Decodable { let accountId: String; let keyring: HistoryKeyRecord? }
        let response = try await transport("/native/v2/history-keys", "GET", nil)
        guard expected == epoch else { throw MultiVibeError.historyLocked }
        let reply = try JSONDecoder().decode(Reply.self, from: response)
        guard reply.accountId == accountId, let record = reply.keyring else { throw MultiVibeError.historyNotConfigured }
        let unlocked = try HistoryKeys.unlock(record, recoveryCode: code, expectedAccountId: accountId)
        try install(unlocked, accountId: accountId)
    }
    func unlockApplication(accountId: String, privateKey: P256.KeyAgreement.PrivateKey, transport: Transport) async throws {
        guard let applicationId else { throw MultiVibeError.authenticationRequired }
        guard !busy else { throw MultiVibeError.historyBusy }
        busy = true; defer { busy = false }; lock(); let expected = epoch
        struct Reply: Decodable { let grant: ApplicationHistoryGrant }
        let bytes = try await transport("/sdk/v2/history-keys", "GET", nil)
        guard expected == epoch else { throw MultiVibeError.historyLocked }
        let grant = try JSONDecoder().decode(Reply.self, from: bytes).grant
        let unlocked = try grant.unwrap(privateKey: privateKey, account: accountId, application: applicationId)
        try install(unlocked, accountId: accountId)
    }
    private func install(_ unlocked: HistoryKeys, accountId: String) throws {
        do {
            let location = try file(accountId)
            if FileManager.default.fileExists(atPath: location.path) {
                let data = try Data(contentsOf: location)
                guard data.count <= 1_500_000 else { throw MultiVibeError.invalidResponse }
                let value = try JSONDecoder().decode(Pending.self, from: data)
                guard value.accountId == accountId, [value.id, value.appId, value.operationId].allSatisfy({ UUID(uuidString: $0) != nil && $0 == $0.lowercased() }), value.revision >= (applicationId == nil ? 1 : 0), value.revision < 9_007_199_254_740_991 else { throw MultiVibeError.invalidResponse }
                guard applicationId == nil || value.appId == applicationId else { throw MultiVibeError.invalidResponse }
                if let envelope = value.envelope {
                    let _: JSONValue = try unlocked.decrypt(envelope, binding: binding(value, next: true), as: JSONValue.self)
                }
                pending = value
            }
            keys = unlocked
        } catch { unlocked.lock(); throw error }
    }
    func reload(transport: Transport) async throws {
        guard let keys else { throw MultiVibeError.historyLocked }
        guard !busy else { throw MultiVibeError.historyBusy }
        guard pending == nil else { throw MultiVibeError.historyWritePending }
        busy = true; defer { busy = false }; let expected = epoch
        var loaded: [MultiVibeConversation] = [], cache: [String: Cached] = [:], cursor: String?
        var cursors = Set<String>(), ids = Set<String>()
        repeat {
            let raw = try await transport(path + (cursor.map { "?after=" + $0 } ?? ""), "GET", nil)
            try check(expected)
            let page = try JSONDecoder().decode(Page.self, from: raw)
            guard page.data.count <= 50, loaded.count + page.data.count <= 500 else { throw MultiVibeError.invalidResponse }
            for summary in page.data {
                guard UUID(uuidString: summary.id) != nil, ids.insert(summary.id).inserted else { throw MultiVibeError.invalidResponse }
                let bytes = try await transport(path + "/" + summary.id, "GET", nil)
                try check(expected)
                let record = try JSONDecoder().decode(Record.self, from: bytes)
                guard record.id == summary.id, record.appId == summary.appId, record.accountId == keys.record.accountId else { throw MultiVibeError.invalidResponse }
                let value = try keys.decrypt(record.envelope, binding: HistoryBinding(accountId: record.accountId, appId: record.appId, conversationId: record.id, revision: record.revision), as: JSONValue.self)
                let conversation = try conversation(value, id: record.id, appId: record.appId, revision: record.revision, updatedAt: record.updatedAt)
                guard case .object(let document) = value else { throw MultiVibeError.invalidResponse }
                cache[record.id] = Cached(revision: record.revision, document: document); loaded.append(conversation)
            }
            cursor = page.nextCursor
            if let cursor { guard UUID(uuidString: cursor) != nil, cursors.insert(cursor).inserted else { throw MultiVibeError.invalidResponse } }
        } while cursor != nil
        try check(expected); documents = cache; conversations = loaded.sorted { $0.updatedAt > $1.updatedAt }
    }
    func save(_ conversation: MultiVibeConversation, operationId: String, transport: Transport) async throws -> MultiVibeConversation {
        guard let keys else { throw MultiVibeError.historyLocked }
        guard !busy else { throw MultiVibeError.historyBusy }
        guard pending == nil else { throw MultiVibeError.historyWritePending }
        guard HistoryWire.uuid(operationId.lowercased()), HistoryWire.uuid(conversation.id),
              applicationId == nil || conversation.appId == applicationId else { throw MultiVibeError.invalidArguments }
        let cached = documents[conversation.id]
        if let cached {
            guard cached.revision == conversation.revision, conversations.contains(where: { $0.id == conversation.id && $0.appId == conversation.appId }) else { throw MultiVibeError.conflict }
        } else {
            guard applicationId != nil, conversation.revision == 0 else { throw MultiVibeError.conflict }
        }
        var document = cached?.document ?? [:]
        document["title"] = .string(conversation.title); document["model"] = .string(conversation.model)
        document["context"] = .string(conversation.context)
        // Retain fields belonging to other clients, including future tool receipts.
        var oldMessages: [String: [String: JSONValue]] = [:]
        if case .array(let values) = document["messages"] {
            for case .object(let value) in values { if case .string(let id) = value["id"] { oldMessages[id] = value } }
        }
        document["messages"] = .array(try conversation.messages.map { message in
            guard case .object(let fields) = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(message)) else { throw MultiVibeError.invalidResponse }
            var merged = oldMessages[message.id] ?? [:]
            for field in ["toolCallId", "toolCalls", "status"] { merged.removeValue(forKey: field) }
            merged.merge(fields) { _, new in new }; return .object(merged)
        })
        let envelope = try keys.encrypt(JSONValue.object(document), binding: HistoryBinding(accountId: keys.record.accountId, appId: conversation.appId, conversationId: conversation.id, revision: conversation.revision + 1))
        try retain(Pending(id: conversation.id, accountId: keys.record.accountId, appId: conversation.appId, operationId: operationId.lowercased(), revision: conversation.revision, envelope: envelope))
        guard let saved = try await retry(transport: transport) else { throw MultiVibeError.invalidResponse }; return saved
    }
    func delete(_ conversation: MultiVibeConversation, transport: Transport) async throws {
        guard let keys else { throw MultiVibeError.historyLocked }
        guard !busy else { throw MultiVibeError.historyBusy }
        guard pending == nil else { throw MultiVibeError.historyWritePending }
        guard conversations.contains(where: { $0.id == conversation.id && $0.appId == conversation.appId && $0.revision == conversation.revision }) else { throw MultiVibeError.conflict }
        try retain(Pending(id: conversation.id, accountId: keys.record.accountId, appId: conversation.appId, operationId: UUID().uuidString.lowercased(), revision: conversation.revision, envelope: nil))
        _ = try await retry(transport: transport)
    }
    private func binding(_ value: Pending, next: Bool) -> HistoryBinding {
        HistoryBinding(accountId: value.accountId, appId: value.appId, conversationId: value.id, revision: value.revision + (next ? 1 : 0))
    }
    @discardableResult func retry(transport: Transport) async throws -> MultiVibeConversation? {
        guard let keys else { throw MultiVibeError.historyLocked }
        guard !busy else { throw MultiVibeError.historyBusy }
        guard let pending else { return nil }
        busy = true; defer { busy = false }; let expected = epoch
        let bytes = try await transport(path + "/" + pending.id, pending.method, pending.body())
        try check(expected)
        let receipt = try JSONDecoder().decode(Receipt.self, from: bytes)
        guard receipt.id == pending.id, receipt.revision == pending.revision + 1, receipt.deleted == (pending.envelope == nil) else { throw MultiVibeError.invalidResponse }
        var saved: MultiVibeConversation?, cache: Cached?
        if let envelope = pending.envelope {
            let document = try keys.decrypt(envelope, binding: binding(pending, next: true), as: JSONValue.self)
            saved = try conversation(document, id: pending.id, appId: pending.appId, revision: receipt.revision, updatedAt: ISO8601DateFormatter().string(from: Date()))
            guard case .object(let fields) = document else { throw MultiVibeError.invalidResponse }
            cache = Cached(revision: receipt.revision, document: fields)
        }
        try removePendingFile(pending)
        self.pending = nil; documents[pending.id] = cache
        conversations.removeAll { $0.id == pending.id }; if let saved { conversations.insert(saved, at: 0) }
        return saved
    }
    /// Explicit abandonment does not roll back a request already committed by Cloud.
    func discardPending() throws {
        guard !busy else { throw MultiVibeError.historyBusy }
        guard let pending else { return }
        try removePendingFile(pending)
        self.pending = nil; conversations = []; documents = [:]
    }
    private func conversation(_ value: JSONValue, id: String, appId: String, revision: Int, updatedAt: String) throws -> MultiVibeConversation {
        guard case .object(let document) = value, case .string(let title) = document["title"], case .string(let model) = document["model"], case .array(let messages) = document["messages"], messages.count <= 500 else { throw MultiVibeError.invalidResponse }
        var result = MultiVibeConversation(id: id, appId: appId, title: title, model: model)
        result.appName = appId; result.revision = revision; result.updatedAt = updatedAt
        result.messages = try JSONDecoder().decode([MultiVibeMessage].self, from: JSONEncoder().encode(messages))
        guard Set(result.messages.map(\.id)).count == result.messages.count, result.messages.allSatisfy({ ["user", "assistant", "tool"].contains($0.role) }) else { throw MultiVibeError.invalidResponse }
        if case .string(let context) = document["context"] { result.context = context }
        return result
    }
}
