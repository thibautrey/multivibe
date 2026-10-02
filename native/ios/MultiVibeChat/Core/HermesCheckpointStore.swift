import CryptoKit
import Foundation

/// Identity is supplied by ConversationManager, never by generated model output.
/// Anonymous journals live in a separate device-only namespace and are never imported.
struct HermesRunContext: Sendable, Equatable {
    let accountID: String?
    let conversationID: UUID
    let turnID: UUID
    let modelID: String
    var source = "downloaded-local"
    var scope: String {
        let identity = accountID.map { "account:\($0)" } ?? "anonymous-device-local"
        return SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

struct HermesCheckpointLease: Sendable {
    let context: HermesRunContext
    let runID: UUID
    let generation: Int
    let resumeJSON: String?
    let recoveredText: String?
    let completed: Bool
}

struct HermesIndeterminateCall: Codable, Equatable, Sendable {
    let id: String
    let name: String
}

enum HermesCheckpointError: LocalizedError {
    case indeterminate([HermesIndeterminateCall]), staleGeneration, incompatible, invalid, tooLarge
    var errorDescription: String? {
        switch self {
        case .indeterminate(let calls):
            "Résultat inconnu pour \(calls.map(\.name).joined(separator: ", ")). Vérifiez les effets de ces actions avant de reprendre. Elles ne seront pas relancées automatiquement."
        case .staleGeneration: "Cette exécution Hermes a été remplacée ; aucune nouvelle action n’a été lancée."
        case .incompatible: "Le modèle ou le moteur de ce point de reprise a changé. Ouvrez un nouveau message pour continuer sans rejouer les anciennes actions."
        case .invalid: "Le point de reprise Hermes est invalide. Aucune action n’a été rejouée."
        case .tooLarge: "Le point de reprise Hermes dépasse la limite locale. Aucune nouvelle action n’a été lancée."
        }
    }
}

/// Device-only protected journal. This is NOT Cloud sync or the canonical Hermes SessionDB.
actor HermesCheckpointStore {
    static let shared = HermesCheckpointStore()
    static let maximumBytes = 8 * 1_048_576
    private let root: URL?
    private let writeFile: @Sendable (Data, URL) throws -> Void
    private var leases: [String: UUID] = [:]
    private struct Envelope: Codable {
        var version = 1
        var engine: String
        var scope: String
        var conversationID: UUID
        var turnID: UUID
        var modelID: String
        var source: String
        var runID: UUID
        var generation: Int
        var messages: String
        var state: String
        var updatedAt = Date()
    }
    init(root: URL? = nil, writeFile: @escaping @Sendable (Data, URL) throws -> Void = { data, url in
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: url, options: .atomic)
        #endif
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var file = url; try file.setResourceValues(values)
    }) { self.root = root; self.writeFile = writeFile }

    private func location(_ context: HermesRunContext) throws -> URL {
        let base = try root ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("hermes-checkpoints", isDirectory: true)
        let directory = base.appendingPathComponent(context.scope, isDirectory: true).appendingPathComponent(context.conversationID.uuidString, isDirectory: true)
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
        #if os(iOS)
        attributes[.protectionKey] = FileProtectionType.complete
        #endif
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: attributes)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var excluded = base; try excluded.setResourceValues(values)
        return directory.appendingPathComponent(context.turnID.uuidString + ".json")
    }
    private func read(_ url: URL) throws -> Envelope? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= Self.maximumBytes else { throw HermesCheckpointError.tooLarge }
        let data = try Data(contentsOf: url)
        guard data.count <= Self.maximumBytes else { throw HermesCheckpointError.tooLarge }
        guard let result = try? JSONDecoder().decode(Envelope.self, from: data), result.version == 1 else { throw HermesCheckpointError.invalid }
        return result
    }
    private func write(_ envelope: Envelope, to url: URL) throws {
        let data = try JSONEncoder().encode(envelope)
        guard data.count <= Self.maximumBytes else { throw HermesCheckpointError.tooLarge }
        try writeFile(data, url)
    }
    private func checkIdentity(_ envelope: Envelope, _ context: HermesRunContext, engine: String) throws {
        guard envelope.scope == context.scope, envelope.conversationID == context.conversationID, envelope.turnID == context.turnID else { throw HermesCheckpointError.invalid }
        guard envelope.modelID == context.modelID, envelope.source == context.source, envelope.engine == engine else { throw HermesCheckpointError.incompatible }
    }
    private func objects(_ messages: String, _ state: String) throws -> ([[String: Any]], [String: Any]) {
        guard let transcript = try JSONSerialization.jsonObject(with: Data(messages.utf8)) as? [[String: Any]],
              let runtime = try JSONSerialization.jsonObject(with: Data(state.utf8)) as? [String: Any] else { throw HermesCheckpointError.invalid }
        return (transcript, runtime)
    }
    /// Every assistant call must have exactly one result. A resultless call is
    /// indeterminate even when it may not have started: disk cannot prove that.
    private func pending(_ transcript: [[String: Any]]) throws -> [HermesIndeterminateCall] {
        var open: [HermesIndeterminateCall] = []
        for message in transcript {
            if message["role"] as? String == "tool" {
                guard let id = message["tool_call_id"] as? String, let index = open.firstIndex(where: { $0.id == id }) else { throw HermesCheckpointError.invalid }
                open.remove(at: index)
            } else {
                guard open.isEmpty else { throw HermesCheckpointError.invalid }
                for call in message["tool_calls"] as? [[String: Any]] ?? [] {
                    guard let id = call["id"] as? String, !id.isEmpty, !open.contains(where: { $0.id == id }),
                          let function = call["function"] as? [String: Any], let name = function["name"] as? String else { throw HermesCheckpointError.invalid }
                    open.append(.init(id: id, name: name))
                }
            }
        }
        return open
    }
    /// Read-only publication boundary. Never claims a lease or resumes any model/tool work.
    func completedMessages(_ context: HermesRunContext, engine: String) throws -> String? {
        guard let envelope = try read(location(context)) else { return nil }
        try checkIdentity(envelope, context, engine: engine)
        let (messages, state) = try objects(envelope.messages, envelope.state)
        let unresolved = try pending(messages)
        guard unresolved.isEmpty else { throw HermesCheckpointError.indeterminate(unresolved) }
        guard state["completed"] as? Bool == true else { return nil }
        return envelope.messages
    }
    func begin(_ context: HermesRunContext, engine: String) throws -> HermesCheckpointLease {
        let url = try location(context)
        guard var envelope = try read(url) else {
            let runID = UUID(); leases[url.path] = runID
            return .init(context: context, runID: runID, generation: 1, resumeJSON: nil, recoveredText: nil, completed: false)
        }
        try checkIdentity(envelope, context, engine: engine)
        let (messages, state) = try objects(envelope.messages, envelope.state)
        let unresolved = try pending(messages)
        guard unresolved.isEmpty else { throw HermesCheckpointError.indeterminate(unresolved) }
        envelope.generation += 1; envelope.updatedAt = Date()
        try write(envelope, to: url)
        leases[url.path] = envelope.runID
        let resume = String(decoding: try JSONSerialization.data(withJSONObject: ["messages": messages, "state": state]), as: UTF8.self)
        let text = state["finalText"] as? String ?? state["outputText"] as? String
        return .init(context: context, runID: envelope.runID, generation: envelope.generation, resumeJSON: resume,
                     recoveredText: text, completed: state["completed"] as? Bool == true || state["terminal"] as? Bool == true)
    }
    func save(_ lease: HermesCheckpointLease, engine: String, messages: String, state: String) throws {
        let url = try location(lease.context)
        guard leases[url.path] == lease.runID else { throw HermesCheckpointError.staleGeneration }
        let (transcript, _) = try objects(messages, state)
        _ = try pending(transcript) // Open tail allowed while a run owns the lease.
        if let current = try read(url) {
            try checkIdentity(current, lease.context, engine: engine)
            guard current.runID == lease.runID, current.generation == lease.generation else { throw HermesCheckpointError.staleGeneration }
        } else if lease.generation != 1 { throw HermesCheckpointError.staleGeneration }
        let context = lease.context
        try write(Envelope(engine: engine, scope: context.scope, conversationID: context.conversationID,
            turnID: context.turnID, modelID: context.modelID, source: context.source, runID: lease.runID,
            generation: lease.generation, messages: messages, state: state), to: url)
    }
    /// Explicit user resolution only: preserve uncertainty and prevent replay.
    /// This never asserts the external effect succeeded or rolled it back.
    func skipIndeterminate(_ context: HermesRunContext, engine: String) throws {
        let url = try location(context)
        guard var envelope = try read(url) else { throw HermesCheckpointError.invalid }
        try checkIdentity(envelope, context, engine: engine)
        var (messages, _) = try objects(envelope.messages, envelope.state)
        let calls = try pending(messages)
        guard !calls.isEmpty else { throw HermesCheckpointError.invalid }
        for call in calls {
            let content = String(decoding: try JSONSerialization.data(withJSONObject: ["isError": true,
                "content": "Execution outcome unknown after interruption. The user explicitly chose to skip replay after being asked to verify effects. Do not automatically repeat this action or claim success."]), as: UTF8.self)
            messages.append(["role": "tool", "tool_call_id": call.id, "name": call.name, "content": content])
        }
        envelope.messages = String(decoding: try JSONSerialization.data(withJSONObject: messages), as: UTF8.self)
        envelope.generation += 1; envelope.updatedAt = Date()
        try write(envelope, to: url)
        leases.removeValue(forKey: url.path)
    }
    func deleteConversation(accountID: String?, conversationID: UUID) throws {
        let context = HermesRunContext(accountID: accountID, conversationID: conversationID, turnID: UUID(), modelID: "")
        let directory = try location(context).deletingLastPathComponent()
        leases = leases.filter { !$0.key.hasPrefix(directory.path + "/") }
        try FileManager.default.removeItem(at: directory)
    }
    func invalidateAccount(_ accountID: String?) {
        let scope = HermesRunContext(accountID: accountID, conversationID: UUID(), turnID: UUID(), modelID: "").scope
        leases = leases.filter { !$0.key.contains("/" + scope + "/") }
    }
    /// Account switches invalidate in-memory writers without deleting account data.
    /// ConversationManager also cancels its generation before another account runs.
    func invalidate(_ context: HermesRunContext) throws { leases.removeValue(forKey: try location(context).path) }
}
