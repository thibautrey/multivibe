import Foundation
import CryptoKit
import Security
import Network
import Observation
import OSLog

struct RemoteMachine: Codable, Identifiable, Sendable {
    struct Model: Codable, Sendable { let id: String }
    let id: String; let name: String; let online: Bool; let models: [Model]
    var supportsHarness: Bool { models.contains { $0.id == RemoteInstanceAPI.model } }
}
struct RemoteHarness: Codable, Identifiable, Sendable {
    let id: String; let name: String; let available: Bool; let configured: Bool; let reason: String?
    let authentication: String; let capabilities: [String: HistoryJSON]
}
struct RemoteHarnessModel: Codable, Identifiable, Sendable {
    let id: String; let name: String?; let provider: String?
    var displayName: String { name ?? id }
    var selectionID: String { (provider ?? "") + ":" + id }
}
struct RemoteHarnessEffort: Codable, Sendable {
    struct Option: Codable, Identifiable, Sendable { let value: String; let label: String; var id: String { value } }
    let options: [Option]; let currentValue: String?; let defaultValue: String?
}
struct RemoteHarnessProject: Codable, Identifiable, Sendable {
    let id: String; let harnessId: String; let name: String; let updatedAt: Double
}
struct RemoteDeviceAuthorization: Codable, Sendable {
    let deviceId: String; let deviceToken: String; let expiresAt: Double
    var trustToken: String? = nil
    var trustPending: Bool? = nil
    var pendingUntil: Double? = nil
    var pendingCancelled: Bool? = nil
    var deviceName: String? = nil
    static func secret() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw APIError.invalidResponse }
        return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
struct RemoteVoiceCapabilities: Decodable, Sendable {
    let enabled: Bool; let voices: [VoiceOption]; let llmModel: String
    let transcriptionModel: String; let backgroundAudio: Bool
    var transcriptionModels: [VoiceModelOption]? = nil
    var synthesisModels: [VoiceModelOption]? = nil
}
struct RemoteVoiceConnection: Sendable {
    let session: VoiceSession; let headers: [String: String]
}
struct RemotePairing: Identifiable, Equatable {
    let machine: String; let handoff: String
    var id: String { machine }
    static func parse(_ url: URL) -> Self? {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false), c.scheme == "multivibe-chat", c.host == "instance", c.path == "/pair",
              c.user == nil, c.password == nil, c.port == nil, c.fragment == nil, let q = c.queryItems, q.count == 2,
              q.filter({ $0.name == "machine" }).count == 1, q.filter({ $0.name == "handoff" }).count == 1,
              let machine = q.first(where: { $0.name == "machine" })?.value, UUID(uuidString: machine) != nil,
              let code = q.first(where: { $0.name == "handoff" })?.value,
              code.range(of: "^[A-Z0-9_-]{12}$", options: .regularExpression) != nil else { return nil }
        return .init(machine: machine.lowercased(), handoff: code)
    }
}
enum RemoteAuthorizationStore {
    private static func query(_ account: String, _ machine: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: NativeApplicationIdentity.identifier("instance-device"), kSecAttrAccount as String: account + ":" + machine]
    }
    static func load(_ account: String, _ machine: String) throws -> RemoteDeviceAuthorization? {
        var q = query(account, machine); q[kSecReturnData as String] = true
        var result: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw APIError.invalidResponse }
        return try JSONDecoder().decode(RemoteDeviceAuthorization.self, from: data)
    }
    static func save(_ value: RemoteDeviceAuthorization, _ account: String, _ machine: String) throws {
        let q = query(account, machine), data = try JSONEncoder().encode(value)
        let status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var q = q; q[kSecValueData as String] = data; q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw APIError.invalidResponse }
        } else if status != errSecSuccess { throw APIError.invalidResponse }
    }
    static func clear(_ account: String, _ machine: String) {
        SecItemDelete(query(account, machine) as CFDictionary)
    }
    static func clearAccount(_ account: String) {
        let service = NativeApplicationIdentity.identifier("instance-device")
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
        var result: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let entries = result as? [[String: Any]] else { return }
        for entry in entries {
            if let name = entry[kSecAttrAccount as String] as? String, name.hasPrefix(account + ":") {
                SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: name] as CFDictionary)
            }
        }
    }
}

actor RemoteInstanceAPI {
    static let shared = RemoteInstanceAPI()
    static let model = "multivibe/host-harness-v1"
    private let session: URLSession
    static func sessionConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        // A remote harness turn has no product-level duration limit. Transport
        // failures are recovered at the command cursor by RemoteInstances.
        configuration.timeoutIntervalForRequest = .greatestFiniteMagnitude
        configuration.timeoutIntervalForResource = .greatestFiniteMagnitude
        return configuration
    }
    init(session supplied: URLSession? = nil) {
        session = supplied ?? URLSession(configuration: Self.sessionConfiguration(), delegate: RemoteInstanceRedirectPolicy(), delegateQueue: nil)
    }
    func request(_ route: String, token: String, body: Data? = nil, method: String? = nil) throws -> URLRequest {
        // Scanned material can never supply a host, destination or account token.
        guard route == "machines" || route == "completions" || route.range(of: "^machines/[0-9a-f-]{36}$", options: .regularExpression) != nil else { throw APIError.invalidResponse }
        var r = URLRequest(url: URL(string: "https://app.multivibe.cloud/relay/v1/" + route)!)
        r.httpMethod = method ?? (body == nil ? "GET" : "POST"); r.httpBody = body
        r.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return r
    }
    private func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse, http.url?.scheme == "https", http.url?.host == "app.multivibe.cloud" else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.server(http.statusCode, http.statusCode == 401 ? "instance_session_expired" : "instance_relay_unavailable")
        }
    }
    func machines(token: String) async throws -> [RemoteMachine] {
        var request = try request("machines", token: token); request.timeoutInterval = 20
        let (data, response) = try await session.data(for: request); try validate(response)
        guard data.count <= 1_048_576 else { throw APIError.invalidResponse }
        struct Reply: Decodable { let data: [RemoteMachine] }
        return try JSONDecoder().decode(Reply.self, from: data).data
    }
    func revokeMachine(_ machine: String, token: String) async throws {
        let (_, response) = try await session.data(for: request("machines/" + machine, token: token, method: "DELETE")); try validate(response)
    }
    static func voiceEndpoint(_ machine: String, operation: String, voice: String? = nil) throws -> URL {
        guard UUID(uuidString: machine) != nil, ["capabilities", "realtime"].contains(operation) else { throw APIError.invalidResponse }
        var url = URLComponents(string: "https://app.multivibe.cloud/relay/voice/v1/machines/\(machine)/\(operation)")!
        if operation == "realtime" { url.scheme = "wss" }
        if let voice { url.queryItems = [URLQueryItem(name: "voice", value: voice)] }
        guard let result = url.url else { throw APIError.invalidResponse }; return result
    }
    func voiceCapabilities(_ machine: String, token: String, fields: [String: HistoryJSON]) async throws -> RemoteVoiceCapabilities {
        var request = URLRequest(url: try Self.voiceEndpoint(machine, operation: "capabilities"))
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue(fields["deviceId"]?.string, forHTTPHeaderField: "X-MultiVibe-Device-Id")
        request.setValue(fields["deviceToken"]?.string, forHTTPHeaderField: "X-MultiVibe-Device-Token")
        let (data, response) = try await session.data(for: request); try validate(response)
        guard data.count <= 1_048_576 else { throw APIError.invalidResponse }
        return try JSONDecoder().decode(RemoteVoiceCapabilities.self, from: data)
    }
    private func bridgeRequest(_ machine: String, account: String, token: String, fields: [String: HistoryJSON]) throws -> URLRequest {
        guard UUID(uuidString: machine) != nil else { throw APIError.invalidResponse }
        var e = fields; e["version"] = .number(1); e["accountId"] = .string(account); e["machineId"] = .string(machine)
        let content = String(decoding: try JSONEncoder().encode(HistoryJSON.object(e)), as: UTF8.self)
        let body = HistoryJSON.object(["model": .string("relay/" + machine + "/" + Self.model), "stream": .bool(true),
            "messages": .array([.object(["role": .string("user"), "content": .string(content)])])])
        let data = try JSONEncoder().encode(body); guard data.count <= 1_048_576 else { throw APIError.invalidResponse }
        return try request("completions", token: token, body: data)
    }
    func control(_ machine: String, account: String, token: String, fields: [String: HistoryJSON]) async throws -> HistoryJSON {
        var request = try bridgeRequest(machine, account: account, token: token, fields: fields); request.timeoutInterval = 20
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode), data.count <= 1_048_576,
           let reply = try? JSONDecoder().decode(HistoryJSON.self, from: data), let code = reply.object?["code"]?.string,
           ["instance_device_revoked", "instance_device_renew_required", "instance_update_required"].contains(code) { throw APIError.server(http.statusCode, code) }
        try validate(response)
        guard data.count <= 8_388_608 else { throw APIError.invalidResponse }
        let result = try JSONDecoder().decode(HistoryJSON.self, from: data)
        guard result.object?["version"]?.number == 1 else { throw APIError.invalidResponse }; return result
    }
    func events(_ machine: String, account: String, token: String, fields: [String: HistoryJSON], update: @Sendable (HistoryJSON) async throws -> Void) async throws {
        let (bytes, response) = try await session.bytes(for: bridgeRequest(machine, account: account, token: token, fields: fields)); try validate(response)
        guard (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "content-type")?.hasPrefix("text/event-stream") == true else { throw APIError.invalidResponse }
        var total = 0
        for try await line in bytes.lines {
            try Task.checkCancellation(); total += line.utf8.count
            guard line.utf8.count <= 1_048_576, total <= 8_388_608 else { throw APIError.invalidResponse }
            if line.hasPrefix("data: ") {
                let event = try JSONDecoder().decode(HistoryJSON.self, from: Data(line.dropFirst(6).utf8))
                try await update(event)
                if event.object?["type"]?.string == "terminal" { return }
            }
        }
        throw APIError.server(502, "instance_stream_interrupted")
    }
}

enum RemoteFollowRetryPolicy {
    static func delayNanoseconds(afterFailure attempt: Int) -> UInt64 {
        let seconds = min(30, 1 << min(max(attempt, 0), 5))
        return UInt64(seconds) * 1_000_000_000
    }
}
private final class RemoteInstanceRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

struct RemoteConversationSource: Codable, Equatable, Sendable {
    var targetId: String; var kind: String; var id: String; var harnessId: String; var connectionId: String? = nil
    var key: String { [targetId, kind, harnessId, connectionId ?? "", id].joined(separator: "\u{1f}") }
    var fields: HistoryJSON { .object(["targetId": .string(targetId), "kind": .string(kind), "id": .string(id), "harnessId": .string(harnessId)].merging(connectionId.map { ["connectionId": .string($0)] } ?? [:]) { _, new in new }) }
}
struct RemoteConversationSummary: Decodable, Sendable {
    var source: RemoteConversationSource; var title: String; var updatedAt: Double; var model: String?; var canContinue: Bool
    var conversationId: String?; var nativeSourceId: String?; var nativeSessionId: String?; var connectionId: String?
}
struct RemoteConversationMessage: Decodable { var id: String; var role: String; var content: String; var done: Bool; var activities: [RemoteHarnessActivity]? }
struct RemoteConversationPage: Decodable { var conversations: [RemoteConversationSummary]; var nextPage: Int? }
struct RemoteConversationHistory: Decodable { var messages: [RemoteConversationMessage]; var revision: String; var model: String?; var nextOffset: Int? }
struct RemoteConversationTarget: Decodable { var id: String; var name: String }

/// Matches the Host's bounded display projection, not the native harness payload.
struct RemoteHarnessActivity: Codable, Sendable {
    var id: String; var kind: String; var title: String?; var status: String?
    var text: String?; var input: String?; var output: String?; var append: Bool? = nil
    func applying(to events: inout [LocalAgentEvent], scope: String, live: Bool = true) {
        guard ["tool", "message", "agent", "plan", "status"].contains(kind) else { return }
        let bytes = Array(SHA256.hash(data: Data((scope + ":" + kind + ":" + id).utf8)).prefix(16))
        let uuid = UUID(uuid: (bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15]))
        let index = events.firstIndex { $0.id == uuid }
        let fallback = kind == "message" ? "Message intermédiaire" : kind == "agent" ? "Sous-agent" : kind == "plan" ? "Plan" : kind == "status" ? "Activité" : "Outil"
        var event = index.map { events[$0] } ?? LocalAgentEvent(id: uuid, kind: kind, tool: title ?? fallback, detail: "", status: kind == "message" ? "info" : "running")
        event.kind = kind
        if let title { event.tool = title }
        if let status { event.status = status }
        if let text {
            event.detail = String(((live && append == true ? event.detail : "") + text).prefix(12_000))
        }
        if let input { event.input = String(((live && append == true ? event.input ?? "" : "") + input).prefix(12_000)) }
        if let output { event.output = String(((live && append == true ? event.output ?? "" : "") + output).prefix(12_000)) }
        if let index { events[index] = event } else if events.count < 256 { events.append(event) }
    }
}

struct RemoteChat: Codable, Identifiable, Sendable {
    var id = UUID(); var machine: String; var harness: String; var model: String; var provider: String? = nil
    var effort: String? = nil; var projectId: String? = nil; var projectName: String? = nil
    var title = "Nouvelle conversation"; var messages: [ChatMessage] = []
    /// Optional so archives written before sidebar ordering was introduced remain readable.
    var updatedAt: Date? = Date()
    var command: String?; var cursor = 0; var state = "idle"; var items: [String: String] = [:]; var itemOrder: [String] = []
    var source: RemoteConversationSource? = nil
    var sourceAliases: [RemoteConversationSource]? = nil
    var canContinue: Bool? = nil
    var environmentName: String? = nil
    var historyRevision: String? = nil
    var pendingConfiguration: RemoteConfiguration? = nil
    mutating func receiveActivity(_ activity: RemoteHarnessActivity, sequence: Int) {
        receiveActivities([activity], sequence: sequence)
    }
    mutating func receiveActivities(_ activities: [RemoteHarnessActivity], sequence: Int) {
        guard sequence > cursor, let last = messages.indices.last, messages[last].role == "assistant" else { return }
        var events = messages[last].localEvents ?? []
        for activity in activities.prefix(32) { activity.applying(to: &events, scope: messages[last].id.uuidString) }
        messages[last].localEvents = events
        cursor = sequence; updatedAt = Date()
    }
    mutating func finishActivities(state: String) {
        guard let last = messages.indices.last, var events = messages[last].localEvents else { return }
        let finalStatus = state == "completed" ? "success" : state == "cancelled" ? "stopped" : "error"
        for index in events.indices where events[index].kind != "message" && events[index].status == "running" {
            events[index].status = finalStatus
        }
        messages[last].localEvents = events
    }
}
struct RemoteConfiguration: Codable, Sendable {
    var id = UUID().uuidString.lowercased()
    var model: String?; var provider: String?; var effort: String?
    var fields: [String: HistoryJSON] {
        var result: [String: HistoryJSON] = ["commandId": .string(id)]
        if let model { result["model"] = .string(model); if let provider { result["provider"] = .string(provider) } }
        else { result["effort"] = effort.map(HistoryJSON.string) ?? .null }
        return result
    }
}
struct RemoteModelPreference: Codable {
    var harness: String; var model: String; var provider: String? = nil; var effort: String? = nil; var projectId: String? = nil; var projectName: String? = nil
}

@MainActor @Observable final class RemoteInstances {
    static let shared = RemoteInstances()
    private(set) var account: String?
    private(set) var machines: [RemoteMachine] = []
    private(set) var harnesses: [String: [RemoteHarness]] = [:]
    private(set) var modelCatalog: [String: [RemoteHarnessModel]] = [:]
    private(set) var effortCatalog: [String: RemoteHarnessEffort] = [:]
    private(set) var projectCatalog: [String: [RemoteHarnessProject]] = [:]
    private(set) var synchronizationErrors: [String: String] = [:]
    private var synchronizing = false
    private var renewals: [String: Task<RemoteDeviceAuthorization, Error>] = [:]
    private(set) var pairingStates: [String: String] = [:]
    private var pollingPairings = false
    private var connectionRequests = Set<String>()
    private var hiddenSources: Set<String> = []
    private var projectCatalogFetchedAt: [String: Date] = [:]
    private(set) var chats: [RemoteChat] = []
    private(set) var preferences: [String: RemoteModelPreference] = [:]
    private(set) var paired: Set<String> = []
    private(set) var busy = false
    private(set) var activeChat: UUID?
    var selection: UUID?
    var error: String?
    var pendingPairing: RemotePairing?
    private var generation = UUID()
    private var streamGeneration = UUID()
    private var task: Task<Void, Never>?
    private var network = "inconnu"
    private var storageLoaded = false
    private let monitor = NWPathMonitor()
    private struct Archive: Codable { var chats: [RemoteChat]; var preferences: [String: RemoteModelPreference]; var selection: UUID? = nil; var hiddenSources: Set<String>? = nil }
    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let label = path.usesInterfaceType(.cellular) ? "Réseau cellulaire" : path.usesInterfaceType(.wifi) ? "Wi-Fi → Relay WAN" : "Relay WAN"
            Task { @MainActor in
                guard let self else { return }; self.network = label
                if path.status == .satisfied { await self.reload() }
            }
        }; monitor.start(queue: DispatchQueue(label: NativeApplicationIdentity.identifier("remote-path")))
    }
    deinit { monitor.cancel() }
    var transportLabel: String { network + " · HTTPS" }
    private func archiveURL(_ account: String) -> URL {
        let key = SHA256.hash(data: Data(account.utf8)).map { String(format: "%02x", $0) }.joined()
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("RemoteInstances/" + key + ".json")
    }
    private func persist() throws {
        guard let account, storageLoaded else { throw APIError.invalidResponse }; let url = archiveURL(account)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        try JSONEncoder().encode(Archive(chats: chats, preferences: preferences, selection: selection, hiddenSources: hiddenSources)).write(to: url, options: [.atomic, .completeFileProtection])
        var values = URLResourceValues(); values.isExcludedFromBackup = true; var folder = url.deletingLastPathComponent(); try folder.setResourceValues(values)
    }
    func activate(_ account: String?) {
        guard self.account != account else { return }; task?.cancel(); task = nil; generation = UUID(); activeChat = nil; busy = false
        for renewal in renewals.values { renewal.cancel() }; renewals = [:]; pairingStates = [:]
        self.account = account; synchronizationErrors = [:]; hiddenSources = []; machines = []; harnesses = [:]; modelCatalog = [:]; effortCatalog = [:]; projectCatalog = [:]; projectCatalogFetchedAt = [:]; chats = []; preferences = [:]; paired = []; error = nil; selection = nil; storageLoaded = false
        guard let account else { pendingPairing = nil; return }
        let url = archiveURL(account)
        do { if FileManager.default.fileExists(atPath: url.path) {
            let data = try Data(contentsOf: url); guard data.count <= 16_777_216 else { throw APIError.invalidResponse }
            let archive = try JSONDecoder().decode(Archive.self, from: data); chats = archive.chats; preferences = archive.preferences; hiddenSources = archive.hiddenSources ?? []; selection = archive.chats.contains { $0.id == archive.selection } ? archive.selection : nil
        }; storageLoaded = true } catch { self.error = "L’historique de vos instances est conservé mais ne peut pas être ouvert." }
    }
    private func check(_ owner: String, _ epoch: UUID) throws {
        try Task.checkCancellation(); guard account == owner, generation == epoch, ConversationManager.shared.session?.accountId == owner else { throw CancellationError() }
    }
    private func control(_ machine: String, operation: String, values: [String: HistoryJSON] = [:]) async throws -> HistoryJSON {
        guard let owner = account else { throw APIError.authenticationRequired }; let epoch = generation
        let (session, auth) = try await authorizedFields(machine, operation: operation)
        do {
            let result = try await RemoteInstanceAPI.shared.control(machine, account: owner, token: session.accessToken, fields: auth.merging(values) { _, new in new })
            try check(owner, epoch); return result
        } catch {
            try check(owner, epoch)
            if case APIError.server(_, "instance_device_revoked") = error { RemoteAuthorizationStore.clear(owner, machine); paired.remove(machine); pairingStates[machine] = "revoked" }
            if case APIError.server(_, "instance_device_renew_required") = error,
               let saved = try RemoteAuthorizationStore.load(owner, machine), saved.trustToken != nil {
                let expired = RemoteDeviceAuthorization(deviceId: saved.deviceId, deviceToken: saved.deviceToken, expiresAt: 0, trustToken: saved.trustToken)
                try RemoteAuthorizationStore.save(expired, owner, machine)
                let (freshSession, freshAuth) = try await authorizedFields(machine, operation: operation)
                let result = try await RemoteInstanceAPI.shared.control(machine, account: owner, token: freshSession.accessToken, fields: freshAuth.merging(values) { _, new in new })
                try check(owner, epoch); return result
            }
            throw error
        }
    }
    private func decode<T: Decodable>(_ type: T.Type, _ value: HistoryJSON) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
    }
    static func merge(_ summaries: [RemoteConversationSummary], into chats: inout [RemoteChat], machine: String, environment: String, hidden: Set<String> = []) {
        for summary in summaries {
            var aliases: [RemoteConversationSource] = []
            if let native = summary.nativeSourceId { aliases.append(.init(targetId: summary.source.targetId, kind: "native", id: native, harnessId: summary.source.harnessId)) }
            if let native = summary.nativeSessionId, let connection = summary.connectionId { aliases.append(.init(targetId: summary.source.targetId, kind: "server", id: native, harnessId: summary.source.harnessId, connectionId: connection)) }
            if ([summary.source] + aliases).contains(where: { hidden.contains(machine + ":" + $0.key) }) { continue }
            let match = chats.firstIndex { chat in
                guard chat.machine == machine else { return false }
                if let id = summary.conversationId, chat.id.uuidString.lowercased() == id.lowercased() { return true }
                guard let source = chat.source, source.targetId == summary.source.targetId, source.harnessId == summary.source.harnessId else { return false }
                return source == summary.source || chat.sourceAliases?.contains(summary.source) == true || (source.kind == "native" && source.id == summary.nativeSourceId)
                    || (source.kind == "server" && source.id == summary.nativeSessionId && source.connectionId == summary.connectionId)
            }
            let index: Int
            if let match { index = match } else {
                chats.append(RemoteChat(machine: machine, harness: summary.source.harnessId, model: summary.model ?? "")); index = chats.count - 1
            }
            // A native/server row is an alias of a supervised conversation once attached.
            if chats[index].source?.kind == "session", summary.source.kind != "session" { continue }
            if let previous = chats[index].source, previous != summary.source {
                var aliases = chats[index].sourceAliases ?? []; if !aliases.contains(previous) { aliases.append(previous) }; chats[index].sourceAliases = aliases
            }
            var knownAliases = chats[index].sourceAliases ?? []
            for alias in aliases where !knownAliases.contains(alias) { knownAliases.append(alias) }
            chats[index].sourceAliases = knownAliases
            chats[index].source = summary.source; chats[index].canContinue = summary.canContinue
            chats[index].environmentName = environment
            if chats[index].command == nil {
                chats[index].title = summary.title; chats[index].updatedAt = Date(timeIntervalSince1970: summary.updatedAt / 1000)
                if let model = summary.model { chats[index].model = model }
            }
        }
    }
    func synchronizeConversations() async {
        guard !synchronizing, !busy, activeChat == nil, account != nil else { return }; synchronizing = true
        defer { synchronizing = false }
        for machine in machines where paired.contains(machine.id) && machine.online && machine.supportsHarness {
            do {
                let result = try await control(machine.id, operation: "conversation-targets")
                let targets = try decode([RemoteConversationTarget].self, result.object?["targets"] ?? .array([]))
                for target in targets {
                    let key = machine.id + ":" + target.id
                    do {
                        var page = 0
                        while true {
                            let value = try await control(machine.id, operation: "conversations", values: ["targetId": .string(target.id), "page": .number(Double(page))])
                            let batch = try decode(RemoteConversationPage.self, value)
                            Self.merge(batch.conversations, into: &chats, machine: machine.id, environment: target.name, hidden: hiddenSources)
                            try persist()
                            guard let next = batch.nextPage else { break }
                            guard next == page + 1, next <= 1000 else { throw APIError.invalidResponse }; page = next
                        }
                        synchronizationErrors[key] = nil
                    } catch is CancellationError { return }
                    catch { synchronizationErrors[key] = "Historique indisponible sur \(machine.name) · \(target.name). Les messages déjà chargés sont conservés." }
                    for harness in ["librechat", "openwebui"] {
                        do {
                            let value = try await control(machine.id, operation: "server-conversations", values: ["targetId": .string(target.id), "harnessId": .string(harness)])
                            let batch = try decode(RemoteConversationPage.self, value)
                            Self.merge(batch.conversations, into: &chats, machine: machine.id, environment: target.name, hidden: hiddenSources)
                            synchronizationErrors[key + ":" + harness] = nil; try persist()
                        } catch is CancellationError { return }
                        catch { synchronizationErrors[key + ":" + harness] = "Synchronisation du serveur indisponible." }
                    }
                }
                synchronizationErrors[machine.id] = nil
            } catch is CancellationError { return }
            catch { synchronizationErrors[machine.id] = "La découverte des conversations nécessite un Host à jour et une connexion active." }
        }
    }
    func refreshConversation(_ id: UUID) async throws {
        guard let initial = chats.first(where: { $0.id == id }), let source = initial.source, initial.command == nil else { return }
        var offset = 0, revision: String?, messages: [RemoteConversationMessage] = [], model: String?
        while true {
            var values: [String: HistoryJSON] = ["source": source.fields, "offset": .number(Double(offset))]
            if let revision { values["revision"] = .string(revision) }
            let value = try await control(initial.machine, operation: "conversation-history", values: values)
            let batch = try decode(RemoteConversationHistory.self, value)
            if let revision, revision != batch.revision { throw APIError.invalidResponse }
            revision = batch.revision; model = batch.model; messages.append(contentsOf: batch.messages)
            guard messages.count <= 20000 else { throw APIError.invalidResponse }
            guard let next = batch.nextOffset else { break }
            guard next > offset, next == messages.count else { throw APIError.invalidResponse }; offset = next
        }
        guard let index = chats.firstIndex(where: { $0.id == id }), chats[index].source == source, chats[index].command == nil else { return }
        if chats[index].historyRevision != revision {
            let previous = chats[index]
            chats[index].messages = messages.map { value in
                let bytes = Array(SHA256.hash(data: Data((initial.machine + ":" + source.key + ":" + value.id).utf8)).prefix(16))
                let id = UUID(uuid: (bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15]))
                var events: [LocalAgentEvent] = []
                for activity in value.activities ?? [] { activity.applying(to: &events, scope: id.uuidString, live: false) }
                return ChatMessage(id: id, role: value.role, content: value.content, localEvents: events.isEmpty ? nil : events, completion: value.role == "assistant" ? (value.done ? .completed : .streaming) : nil)
            }
            chats[index].historyRevision = revision
            if let model { chats[index].model = model }
            do { try persist() } catch { chats[index] = previous; throw error }
        }
    }
    func runSynchronization() async {
        var nextDirectoryRefresh = Date.distantPast
        while !Task.isCancelled {
            if Date() >= nextDirectoryRefresh { await reload(); nextDirectoryRefresh = Date().addingTimeInterval(30) }
            for machine in machines where paired.contains(machine.id) && machine.online && harnesses[machine.id] == nil { try? await catalog(machine.id) }
            await pollPairings()
            await synchronizeConversations()
            do { try await Task.sleep(for: .seconds(5)) } catch { return }
        }
    }
    func runSelectedSynchronization() async {
        while !Task.isCancelled {
            if let chat = current, chat.source != nil, chat.command == nil {
                do { try await refreshConversation(chat.id); synchronizationErrors[chat.id.uuidString] = nil }
                catch is CancellationError { return }
                catch { synchronizationErrors[chat.id.uuidString] = "Messages indisponibles. L’historique déjà chargé est conservé." }
            }
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
        }
    }
    var synchronizationError: String? {
        guard let chat = current else { return nil }
        return synchronizationErrors[chat.id.uuidString] ?? synchronizationErrors[chat.machine]
            ?? chat.source.flatMap { synchronizationErrors[chat.machine + ":" + $0.targetId] ?? synchronizationErrors[chat.machine + ":" + $0.targetId + ":" + $0.harnessId] }
    }
    func reload() async {
        guard let owner = account, !busy else { return }; let epoch = generation; busy = true
        defer { if generation == epoch { busy = false } }
        do {
            let session = try await ConversationManager.shared.validSession(); try check(owner, epoch)
            let result = try await RemoteInstanceAPI.shared.machines(token: session.accessToken); try check(owner, epoch)
            machines = result
            paired = Set(try result.compactMap { machine in
                guard let auth = try RemoteAuthorizationStore.load(owner, machine.id), auth.pendingUntil == nil else { return nil }
                return auth.trustToken != nil || auth.expiresAt > Date().timeIntervalSince1970 * 1000 ? machine.id : nil
            })
            error = nil
        } catch is CancellationError { } catch { if generation == epoch { self.error = "Instances indisponibles. Vérifiez votre compte et la connexion réseau." } }
    }
    private func authorizedFields(_ machine: String, operation: String) async throws -> (NativeSession, [String: HistoryJSON]) {
        guard let owner = account else { throw APIError.authenticationRequired }; let epoch = generation
        let session = try await ConversationManager.shared.validSession(); try check(owner, epoch)
        guard var auth = try RemoteAuthorizationStore.load(owner, machine), auth.pendingUntil == nil else { throw APIError.server(401, "instance_device_expired") }
        if auth.trustToken == nil || auth.expiresAt < Date().addingTimeInterval(300).timeIntervalSince1970 * 1000 {
            if auth.trustToken == nil && auth.expiresAt <= Date().timeIntervalSince1970 * 1000 { throw APIError.server(401, "instance_device_expired") }
            if let renewal = renewals[machine] { auth = try await renewal.value }
            else {
                let original = auth
                let renewal = Task { @MainActor in
                    var next = original
                    var fields = self.credentials(original, operation: "renew")
                    var supportsDurable = original.trustToken != nil
                    if !supportsDurable {
                        do {
                            let capabilities = try await RemoteInstanceAPI.shared.control(machine, account: owner, token: session.accessToken, fields: ["operation": .string("pair-capabilities")])
                            supportsDurable = capabilities.object?["pairingVersion"]?.number == 2
                        } catch APIError.server(400, _) { supportsDurable = false }
                        try self.check(owner, epoch)
                    }
                    let trust = try original.trustToken ?? RemoteDeviceAuthorization.secret()
                    if supportsDurable {
                        next = RemoteDeviceAuthorization(deviceId: original.deviceId, deviceToken: original.trustToken == nil || original.trustPending == true ? original.deviceToken : try RemoteDeviceAuthorization.secret(), expiresAt: 0, trustToken: trust, trustPending: original.trustToken == nil || original.trustPending == true)
                        try RemoteAuthorizationStore.save(next, owner, machine)
                        fields = self.credentials(next, operation: "renew"); fields["trustToken"] = .string(trust)
                    }
                    let result = try await RemoteInstanceAPI.shared.control(machine, account: owner, token: session.accessToken, fields: fields)
                    try self.check(owner, epoch)
                    var issued = try JSONDecoder().decode(RemoteDeviceAuthorization.self, from: JSONEncoder().encode(result))
                    issued.trustToken = result.object?["durable"] == .bool(true) ? next.trustToken : nil
                    try RemoteAuthorizationStore.save(issued, owner, machine)
                    return issued
                }
                renewals[machine] = renewal
                defer { if generation == epoch { renewals[machine] = nil } }
                do { auth = try await renewal.value }
                catch {
                    try check(owner, epoch)
                    if case APIError.server(_, "instance_device_revoked") = error { RemoteAuthorizationStore.clear(owner, machine); paired.remove(machine); pairingStates[machine] = "revoked" }
                    throw error
                }
            }
            try check(owner, epoch)
        }
        return (session, credentials(auth, operation: operation))
    }
    private func credentials(_ auth: RemoteDeviceAuthorization, operation: String) -> [String: HistoryJSON] {
        ["operation": .string(operation), "deviceId": .string(auth.deviceId), "deviceToken": .string(auth.deviceToken)]
    }
    func voiceCapabilities(_ machine: String) async throws -> RemoteVoiceCapabilities {
        let owner = account, epoch = generation
        let (session, fields) = try await authorizedFields(machine, operation: "voice")
        let result = try await RemoteInstanceAPI.shared.voiceCapabilities(machine, token: session.accessToken, fields: fields)
        guard let owner else { throw APIError.authenticationRequired }; try check(owner, epoch)
        return result
    }
    func voiceConnection(_ machine: String, voice: String) async throws -> RemoteVoiceConnection {
        let (accountSession, fields) = try await authorizedFields(machine, operation: "voice")
        guard let device = fields["deviceId"]?.string, let token = fields["deviceToken"]?.string else { throw APIError.authenticationRequired }
        let expires = min(accountSession.expiresAt, Date().addingTimeInterval(900))
        let session = VoiceSession(id: UUID().uuidString.lowercased(), route: "instance", sessionToken: "", expiresAt: expires,
            credential: VoiceCredential(protocolName: "openai-realtime-ga", transport: "websocket",
                endpoint: try RemoteInstanceAPI.voiceEndpoint(machine, operation: "realtime", voice: voice), token: accountSession.accessToken, expiresAt: expires),
            retainsAudio: false, transcriptPersistence: "final_only")
        return RemoteVoiceConnection(session: session, headers: ["X-MultiVibe-Device-Id": device, "X-MultiVibe-Device-Token": token])
    }
    @discardableResult func appendVoiceTurn(chatID: UUID, accountID: String, model: String, role: String, text: String, turnID: String) -> Bool {
        guard account == accountID, ConversationManager.shared.session?.accountId == accountID,
              ["user", "assistant"].contains(role), let index = chats.firstIndex(where: { $0.id == chatID }), !text.isEmpty else { return false }
        let bytes = Array(SHA256.hash(data: Data((accountID + ":" + chatID.uuidString + ":" + turnID).utf8)).prefix(16))
        let id = UUID(uuid: (bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15]))
        if chats[index].messages.contains(where: { $0.id == id }) { return true }
        let previous = chats[index]
        chats[index].messages.append(ChatMessage(id: id, role: role, content: text, completion: role == "assistant" ? .completed : nil))
        chats[index].updatedAt = Date()
        if previous.messages.isEmpty { chats[index].title = String(text.prefix(60)) }
        do { try persist(); return true } catch { chats[index] = previous; return false }
    }
    func pair(_ pairing: RemotePairing, name: String) async throws {
        guard let owner = account, !busy, machines.contains(where: { $0.id == pairing.machine && $0.online && $0.supportsHarness }) else { throw APIError.invalidResponse }
        let epoch = generation; busy = true; defer { if generation == epoch { busy = false } }
        let session = try await ConversationManager.shared.validSession(); try check(owner, epoch)
        let result = try await RemoteInstanceAPI.shared.control(pairing.machine, account: owner, token: session.accessToken,
            fields: ["operation": .string("pair"), "handoff": .string(pairing.handoff), "name": .string(name)]); try check(owner, epoch)
        let auth = try JSONDecoder().decode(RemoteDeviceAuthorization.self, from: JSONEncoder().encode(result))
        guard UUID(uuidString: auth.deviceId) != nil, auth.deviceToken.utf8.count == 43,
              auth.expiresAt > Date().timeIntervalSince1970 * 1000, auth.expiresAt <= Date().addingTimeInterval(25 * 3600).timeIntervalSince1970 * 1000 else { throw APIError.invalidResponse }
        do { try RemoteAuthorizationStore.save(auth, owner, pairing.machine) }
        catch {
            _ = try? await RemoteInstanceAPI.shared.control(pairing.machine, account: owner, token: session.accessToken, fields: credentials(auth, operation: "revoke")); throw error
        }
        harnesses[pairing.machine] = try decodeHarnesses(result); paired.insert(pairing.machine); pendingPairing = nil
    }
    func requestConnection(_ machine: String, name: String) async throws {
        guard let owner = account else { throw APIError.authenticationRequired }
        guard connectionRequests.insert(machine).inserted else { return }
        defer { connectionRequests.remove(machine) }
        if let existing = try RemoteAuthorizationStore.load(owner, machine), existing.pendingUntil != nil {
            await pollPairings(); return
        }
        let epoch = generation, session = try await ConversationManager.shared.validSession()
        try check(owner, epoch)
        let capabilities = try await RemoteInstanceAPI.shared.control(machine, account: owner, token: session.accessToken, fields: ["operation": .string("pair-capabilities")])
        try check(owner, epoch)
        guard capabilities.object?["pairingVersion"]?.number == 2 else { throw APIError.server(409, "instance_update_required") }
        let pending = RemoteDeviceAuthorization(deviceId: UUID().uuidString.lowercased(), deviceToken: try RemoteDeviceAuthorization.secret(), expiresAt: 0,
            trustToken: try RemoteDeviceAuthorization.secret(), pendingUntil: Date().addingTimeInterval(300).timeIntervalSince1970 * 1000, deviceName: name)
        try RemoteAuthorizationStore.save(pending, owner, machine)
        pairingStates[machine] = "pending"
        await pollPairings()
    }
    func cancelConnection(_ machine: String) async throws {
        guard let owner = account, var auth = try RemoteAuthorizationStore.load(owner, machine), auth.pendingUntil != nil else { return }
        auth.pendingCancelled = true; try RemoteAuthorizationStore.save(auth, owner, machine)
        pairingStates[machine] = "cancelling"
        await pollPairings()
    }
    func pollPairings() async {
        guard let owner = account, !pollingPairings else { return }
        let epoch = generation; pollingPairings = true
        defer { pollingPairings = false }
        for machine in machines {
            do {
                guard var auth = try RemoteAuthorizationStore.load(owner, machine.id), let until = auth.pendingUntil, let trust = auth.trustToken else { continue }
                let session = try await ConversationManager.shared.validSession(); try check(owner, epoch)
                let expired = until <= Date().timeIntervalSince1970 * 1000
                let result = try await RemoteInstanceAPI.shared.control(machine.id, account: owner, token: session.accessToken, fields: [
                    "operation": .string(auth.pendingCancelled == true ? "pair-cancel" : expired ? "pair-status" : "pair-request"), "requestId": .string(auth.deviceId), "trustToken": .string(trust),
                    "deviceToken": .string(auth.deviceToken), "name": .string(auth.deviceName ?? "iPhone")])
                try check(owner, epoch)
                if auth.pendingCancelled != true, try RemoteAuthorizationStore.load(owner, machine.id)?.pendingCancelled == true { continue }
                let state = result.object?["state"]?.string ?? "expired"
                pairingStates[machine.id] = state
                if state == "approved" {
                    auth = RemoteDeviceAuthorization(deviceId: auth.deviceId, deviceToken: auth.deviceToken,
                        expiresAt: result.object?["authorizationExpiresAt"]?.number ?? 0, trustToken: trust)
                    try RemoteAuthorizationStore.save(auth, owner, machine.id); paired.insert(machine.id); error = nil
                    try? await catalog(machine.id)
                } else if ["refused", "cancelled", "expired", "revoked"].contains(state) {
                    // An approval whose acknowledgement was missed may outlive
                    // the request. Prove durable trust before discarding it.
                    if state == "expired" && auth.pendingCancelled != true {
                        let reply = try await RemoteInstanceAPI.shared.control(machine.id, account: owner, token: session.accessToken,
                            fields: ["operation": .string("renew"), "deviceId": .string(auth.deviceId), "deviceToken": .string(auth.deviceToken), "trustToken": .string(trust)])
                        try check(owner, epoch)
                        if let expiry = reply.object?["expiresAt"]?.number {
                            auth = RemoteDeviceAuthorization(deviceId: auth.deviceId, deviceToken: auth.deviceToken, expiresAt: expiry, trustToken: trust)
                            try RemoteAuthorizationStore.save(auth, owner, machine.id); paired.insert(machine.id); pairingStates[machine.id] = "approved"; continue
                        }
                    }
                    RemoteAuthorizationStore.clear(owner, machine.id)
                }
            } catch is CancellationError { return }
            catch {
                if generation == epoch {
                    self.error = Self.connectionError(error)
                    if case APIError.server(_, "instance_device_revoked") = error {
                        let pending = try? RemoteAuthorizationStore.load(owner, machine.id)
                        pairingStates[machine.id] = (pending?.pendingUntil ?? .greatestFiniteMagnitude) <= Date().timeIntervalSince1970 * 1000 ? "expired" : "revoked"
                        RemoteAuthorizationStore.clear(owner, machine.id); paired.remove(machine.id)
                    }
                }
            }
        }
    }
    static func connectionError(_ error: Error) -> String {
        Logger(subsystem: NativeApplicationIdentity.identifier("remote-instances"), category: "pairing").error("Connection operation failed: \(String(reflecting: error), privacy: .public)")
        if case APIError.server(_, "instance_update_required") = error { return "Mettez MultiVibe à jour sur le Mac, ou utilisez le QR dans les options avancées." }
        if case APIError.server(_, "instance_device_revoked") = error { return "L’accès de cet iPhone a été révoqué. Connectez-le à nouveau depuis le Mac." }
        if case APIError.server(_, "instance_device_expired") = error { return "Cette ancienne association a expiré. Autorisez une dernière fois cet iPhone sur le Mac." }
        if case APIError.server(_, "instance_session_expired") = error { return "Reconnectez votre compte MultiVibe." }
        if case APIError.authenticationRequired = error { return "Connectez votre compte MultiVibe." }
#if DEBUG
        return "Diagnostic d’appairage : \(String(reflecting: error))"
#else
        return "Connexion au Mac interrompue. Reconnexion automatique en cours ; votre association est conservée."
#endif
    }
    private func decodeHarnesses(_ value: HistoryJSON) throws -> [RemoteHarness] {
        try JSONDecoder().decode([RemoteHarness].self, from: JSONEncoder().encode(value.object?["harnesses"] ?? .array([])))
    }
    func catalog(_ machine: String) async throws {
        guard !busy, let owner = account else { return }; let epoch = generation; busy = true; defer { if epoch == generation { busy = false } }
        let (session, fields) = try await authorizedFields(machine, operation: "catalog")
        let result = try await RemoteInstanceAPI.shared.control(machine, account: owner, token: session.accessToken, fields: fields); try check(owner, epoch)
        harnesses[machine] = try decodeHarnesses(result)
    }
    func models(_ machine: String, harness: String) async throws {
        guard !busy, let owner = account else { return }; let epoch = generation; busy = true; defer { if epoch == generation { busy = false } }
        let (session, auth) = try await authorizedFields(machine, operation: "models"); var fields = auth; fields["harnessId"] = .string(harness)
        if let chat = current, chat.machine == machine, let source = chat.source { fields["source"] = source.fields }
        let result = try await RemoteInstanceAPI.shared.control(machine, account: owner, token: session.accessToken, fields: fields); try check(owner, epoch)
        let values = try JSONDecoder().decode([RemoteHarnessModel].self, from: JSONEncoder().encode(result.object?["models"] ?? .array([])))
        modelCatalog[modelKey(machine, harness: harness)] = values
        var preference = preference(machine, harness: harness) ?? .init(harness: harness, model: "")
        if preference.model.isEmpty, let selected = result.object?["currentModelId"]?.string.flatMap({ id in values.first { $0.id == id } }) ?? values.first {
            preference.model = selected.id; preference.provider = selected.provider
        }
        remember(preference, machine: machine); updateSelectedEmptyChat(from: preference, machine: machine); try persist()
    }
    func efforts(_ machine: String, harness: String, model: String, provider: String?) async throws {
        guard !model.isEmpty, !busy, let owner = account else { return }; let epoch = generation; busy = true; defer { if epoch == generation { busy = false } }
        let (session, auth) = try await authorizedFields(machine, operation: "effort"); var fields = auth
        fields["harnessId"] = .string(harness); fields["model"] = .string(model); if let provider { fields["provider"] = .string(provider) }
        if let chat = current, chat.machine == machine, chat.harness == harness, (!chat.messages.isEmpty || chat.source != nil) { fields["conversationId"] = .string(chat.id.uuidString.lowercased()); if let source = chat.source { fields["source"] = source.fields } }
        let result = try await RemoteInstanceAPI.shared.control(machine, account: owner, token: session.accessToken, fields: fields); try check(owner, epoch)
        let key = machine + ":" + harness + ":" + model
        if let value = result.object?["effort"], value != .null {
            let effort = try JSONDecoder().decode(RemoteHarnessEffort.self, from: JSONEncoder().encode(value)); effortCatalog[key] = effort
            var preference = preference(machine, harness: harness) ?? .init(harness: harness, model: model, provider: provider)
            if !effort.options.contains(where: { $0.value == preference.effort }) { preference.effort = effort.currentValue ?? effort.defaultValue }
            remember(preference, machine: machine); updateSelectedEmptyChat(from: preference, machine: machine); try persist()
        } else { effortCatalog[key] = nil }
    }
    func projects(_ machine: String, harness: String, forceRefresh: Bool = false) async throws {
        let key = machine + ":" + harness
        // Empty catalogues are cached too. Only successful fetches extend freshness.
        if !forceRefresh, projectCatalog[key] != nil, let fetchedAt = projectCatalogFetchedAt[key] {
            let age = Date().timeIntervalSince(fetchedAt)
            if age >= 0 && age < 300 { return }
        }
        guard !busy, let owner = account else { return }; let epoch = generation; busy = true; defer { if epoch == generation { busy = false } }
        let (session, auth) = try await authorizedFields(machine, operation: "projects"); var fields = auth; fields["harnessId"] = .string(harness)
        let result = try await RemoteInstanceAPI.shared.control(machine, account: owner, token: session.accessToken, fields: fields); try check(owner, epoch)
        projectCatalog[key] = try JSONDecoder().decode([RemoteHarnessProject].self, from: JSONEncoder().encode(result.object?["projects"] ?? .array([])))
        projectCatalogFetchedAt[key] = Date()
    }
    func prepare(_ machine: String, harness: String) async throws {
        if harnesses[machine] == nil { try await catalog(machine) }
        try await models(machine, harness: harness)
        try await projects(machine, harness: harness)
        if let chat = current, chat.machine == machine, chat.harness == harness, (!chat.messages.isEmpty || chat.source != nil) {
            try await efforts(machine, harness: harness, model: chat.model, provider: chat.provider)
        } else if let preference = preference(machine, harness: harness), !preference.model.isEmpty {
            try await efforts(machine, harness: harness, model: preference.model, provider: preference.provider)
        }
    }
    func modelKey(_ machine: String, harness: String) -> String {
        if let chat = current, chat.machine == machine, chat.harness == harness, let target = chat.source?.targetId, target != "local" {
            return machine + ":" + target + ":" + harness
        }
        return machine + ":" + harness
    }
    func preference(_ machine: String, harness: String) -> RemoteModelPreference? {
        preferences[machine + ":" + harness] ?? preferences[machine].flatMap { $0.harness == harness ? $0 : nil }
    }
    private func remember(_ preference: RemoteModelPreference, machine: String) {
        preferences[machine] = preference; preferences[machine + ":" + preference.harness] = preference
    }
    func choose(_ machine: String, harness: String, model: RemoteHarnessModel) async throws {
        if let chat = current, chat.machine == machine, chat.harness == harness, (!chat.messages.isEmpty || chat.source != nil) {
            try await configure(chat.id, change: .init(model: model.id, provider: model.provider))
        }
        var preference = preference(machine, harness: harness) ?? .init(harness: harness, model: model.id)
        preference.harness = harness; preference.model = model.id; preference.provider = model.provider; preference.effort = nil
        remember(preference, machine: machine); updateSelectedEmptyChat(from: preference, machine: machine); try persist()
    }
    func chooseEffort(_ value: String?, machine: String) async throws {
        guard let chat = current, chat.machine == machine else { throw APIError.noModel }
        guard var preference = preference(machine, harness: chat.harness) else { throw APIError.noModel }
        if !chat.messages.isEmpty || chat.source != nil { try await configure(chat.id, change: .init(effort: value)) }
        preference.effort = value; remember(preference, machine: machine); updateSelectedEmptyChat(from: preference, machine: machine); try persist()
    }
    func chooseProject(_ project: RemoteHarnessProject?, machine: String) throws {
        guard let chat = current, chat.machine == machine, chat.messages.isEmpty, chat.source == nil,
              var preference = preference(machine, harness: chat.harness) else { throw APIError.noModel }
        preference.projectId = project?.id; preference.projectName = project?.name; remember(preference, machine: machine)
        updateSelectedEmptyChat(from: preference, machine: machine); try persist()
    }
    func configure(_ id: UUID, change: RemoteConfiguration? = nil) async throws {
        guard !busy, let owner = account, let index = chats.firstIndex(where: { $0.id == id }),
              chats[index].canContinue != false, chats[index].command == nil else { throw APIError.invalidResponse }
        let epoch = generation; busy = true; defer { if epoch == generation { busy = false } }
        if chats[index].pendingConfiguration == nil { chats[index].pendingConfiguration = change }
        guard let pending = chats[index].pendingConfiguration else { return }
        try persist()
        let machine = chats[index].machine
        let (session, auth) = try await authorizedFields(machine, operation: "configure")
        var fields = auth.merging(pending.fields) { _, new in new }; if let source = chats[index].source { fields["source"] = source.fields }; fields["conversationId"] = .string(id.uuidString.lowercased())
        let result = try await RemoteInstanceAPI.shared.control(machine, account: owner, token: session.accessToken, fields: fields); try check(owner, epoch)
        guard let currentIndex = chats.firstIndex(where: { $0.id == id }) else { throw CancellationError() }
        if result.object?["state"]?.string == "failed" {
            chats[currentIndex].pendingConfiguration = nil; try persist(); throw APIError.server(409, "instance_configuration_refused")
        }
        guard result.object?["state"]?.string == "completed" else { throw APIError.invalidResponse }
        if let source = result.object?["source"] { chats[currentIndex].sourceAliases = (chats[currentIndex].sourceAliases ?? []) + [chats[currentIndex].source].compactMap { $0 }; chats[currentIndex].source = try decode(RemoteConversationSource.self, source) }
        if let model = pending.model { chats[currentIndex].model = model; chats[currentIndex].provider = pending.provider; chats[currentIndex].effort = nil }
        else { chats[currentIndex].effort = pending.effort }
        chats[currentIndex].pendingConfiguration = nil
        let chat = chats[currentIndex]
        remember(.init(harness: chat.harness, model: chat.model, provider: chat.provider, effort: chat.effort, projectId: chat.projectId, projectName: chat.projectName), machine: machine)
        try persist()
    }
    @discardableResult func newChat(_ machine: String, harness: String? = nil) throws -> UUID {
        guard paired.contains(machine) else { throw APIError.authenticationRequired }
        let p = preferences[machine]
        let chosenHarness = harness ?? p?.harness ?? harnesses[machine]?.first(where: { $0.available })?.id ?? ""
        guard !chosenHarness.isEmpty else { throw APIError.noModel }
        let applied = preference(machine, harness: chosenHarness)
        let chat = RemoteChat(machine: machine, harness: chosenHarness, model: applied?.model ?? "", provider: applied?.provider,
            effort: applied?.effort, projectId: applied?.projectId, projectName: applied?.projectName)
        chats.append(chat); select(chat.id); try persist(); return chat.id
    }
    var current: RemoteChat? { selection.flatMap { id in chats.first { $0.id == id } } }
    func select(_ id: UUID?) {
        guard selection != id else { return }
        stopFollowing(); selection = id
        if id != nil { ConversationManager.shared.stop(); ConversationManager.shared.voice.silence() }
        try? persist()
    }
    func delete(_ id: UUID) throws {
        guard activeChat != id else { return }; if let chat = chats.first(where: { $0.id == id }), let source = chat.source { for source in [source] + (chat.sourceAliases ?? []) { hiddenSources.insert(chat.machine + ":" + source.key) } }; chats.removeAll { $0.id == id }; if selection == id { selection = nil }; try persist()
    }
    private func updateSelectedEmptyChat(from preference: RemoteModelPreference, machine: String) {
        guard let id = selection, let index = chats.firstIndex(where: { $0.id == id && $0.machine == machine && $0.harness == preference.harness && $0.messages.isEmpty && $0.source == nil }) else { return }
        chats[index].harness = preference.harness; chats[index].model = preference.model; chats[index].provider = preference.provider
        chats[index].effort = preference.effort; chats[index].projectId = preference.projectId; chats[index].projectName = preference.projectName
    }
    func stopFollowing() { task?.cancel(); task = nil; activeChat = nil; streamGeneration = UUID() }
    @discardableResult func send(_ text: String, chat id: UUID, recover: Bool = false) -> Bool {
        guard activeChat == nil, let owner = account, let index = chats.firstIndex(where: { $0.id == id }), !busy, chats[index].pendingConfiguration == nil, chats[index].canContinue != false else { return false }
        if !recover {
            guard !chats[index].model.isEmpty, chats[index].command == nil, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
            chats[index].command = UUID().uuidString.lowercased(); chats[index].cursor = 0; chats[index].items = [:]; chats[index].itemOrder = []
            chats[index].messages.append(.init(role: "user", content: text)); chats[index].messages.append(.init(role: "assistant", content: "", completion: .streaming))
            chats[index].updatedAt = Date()
            if chats[index].messages.count == 2 { chats[index].title = ConversationTitle.fallback(for: text) }
        }
        chats[index].state = "running"
        guard chats[index].command != nil else { return false }
        do { try persist() } catch { self.error = "Le message n’a pas pu être enregistré. Il n’a pas été envoyé."; return false }
        let epoch = generation, streamEpoch = streamGeneration, initialChat = chats[index]; activeChat = id; error = nil
        task = Task {
            defer { if generation == epoch && streamGeneration == streamEpoch { activeChat = nil; task = nil; try? persist() } }
            var operation = recover ? "recover" : "prompt"
            var failures = 0
            while generation == epoch && streamGeneration == streamEpoch {
                do {
                    try check(owner, epoch)
                    guard let current = chats.first(where: { $0.id == id }), let command = current.command else { return }
                    let (session, auth) = try await authorizedFields(current.machine, operation: operation); try check(owner, epoch)
                    var fields = auth
                    fields["conversationId"] = .string(id.uuidString.lowercased())
                    fields["commandId"] = .string(command)
                    if let source = current.source { fields["source"] = source.fields }
                    fields["after"] = .number(Double(current.cursor))
                    if operation == "prompt" {
                        fields["harnessId"] = .string(initialChat.harness); fields["model"] = .string(initialChat.model); fields["text"] = .string(text)
                        if let provider = initialChat.provider { fields["provider"] = .string(provider) }
                        if let effort = initialChat.effort { fields["effort"] = .string(effort) }
                        if let projectId = initialChat.projectId { fields["projectId"] = .string(projectId) }
                    }
                    try await RemoteInstanceAPI.shared.events(current.machine, account: owner, token: session.accessToken, fields: fields) { event in
                        guard await self.streamGeneration == streamEpoch else { throw CancellationError() }
                        try await self.receive(event, chat: id, owner: owner, epoch: epoch)
                    }
                    failures = 0
                    guard chats.first(where: { $0.id == id })?.command != nil else { return }
                    operation = "recover"
                } catch is CancellationError { return }
                catch {
                    guard generation == epoch, streamGeneration == streamEpoch,
                          chats.first(where: { $0.id == id })?.command != nil else { return }
                    failures += 1
                    // Retrying the exact prompt command is idempotent on the Host.
                    // Once a stream ends cleanly without a terminal state (for
                    // example with an older Host awaiting approval), subsequent
                    // attempts recover only by command ID and cursor.
                }
                do { try await Task.sleep(nanoseconds: RemoteFollowRetryPolicy.delayNanoseconds(afterFailure: failures - 1)) }
                catch { return }
            }
        }
        return true
    }
    func interrupt(_ id: UUID) async throws {
        guard !busy, let owner = account, let chat = chats.first(where: { $0.id == id }), chat.command != nil else { return }
        let epoch = generation; busy = true; defer { if epoch == generation { busy = false } }
        let (session, auth) = try await authorizedFields(chat.machine, operation: "interrupt")
        var fields = auth; if let source = chat.source { fields["source"] = source.fields }; fields["conversationId"] = .string(id.uuidString.lowercased()); fields["commandId"] = .string(UUID().uuidString.lowercased())
        let result = try await RemoteInstanceAPI.shared.control(chat.machine, account: owner, token: session.accessToken, fields: fields); try check(owner, epoch)
        guard result.object?["state"]?.string == "completed" else { throw APIError.invalidResponse }
        busy = false; stopFollowing(); send("", chat: id, recover: true)
    }
    private func receive(_ event: HistoryJSON, chat id: UUID, owner: String, epoch: UUID) throws {
        try check(owner, epoch); guard let index = chats.firstIndex(where: { $0.id == id }), let object = event.object else { throw APIError.invalidResponse }
        let type = object["type"]?.string
        if type == "conversation.bound", let value = object["source"] {
            let bound = try decode(RemoteConversationSource.self, value)
            if let source = chats[index].source, source != bound {
                var aliases = chats[index].sourceAliases ?? []; if !aliases.contains(source) { aliases.append(source) }; chats[index].sourceAliases = aliases
            }
            chats[index].source = bound
        } else if type == "message.delta" || type == "message.part", let text = object["text"]?.string, let seq = object["seq"]?.number, seq > Double(chats[index].cursor) {
            if chats[index].state == "waiting_user" { chats[index].state = "running"; error = nil }
            let item = object["itemId"]?.string ?? "assistant"
            if chats[index].items[item] == nil { chats[index].itemOrder.append(item) }
            if type == "message.part" { chats[index].items[item] = text } else { chats[index].items[item, default: ""] += text }
            chats[index].cursor = Int(seq)
            chats[index].messages[chats[index].messages.count - 1].content = chats[index].itemOrder.compactMap { chats[index].items[$0] }.joined(separator: "\n")
        } else if ["activity", "activities"].contains(type), let seq = object["seq"]?.number,
                  seq.isFinite, seq.rounded() == seq, seq >= 0, seq < Double(Int.max) {
            let values = type == "activity" ? object["activity"].map { [$0] } ?? [] : object["activities"]?.array ?? []
            guard !values.isEmpty, values.count <= 32 else { throw APIError.invalidResponse }
            chats[index].receiveActivities(try values.map { try decode(RemoteHarnessActivity.self, $0) }, sequence: Int(seq))
        } else if type == "terminal" {
            let state = object["state"]?.string ?? "uncertain"; chats[index].state = state
            chats[index].cursor = Int(object["cursor"]?.number ?? Double(chats[index].cursor))
            if ["completed", "cancelled", "failed"].contains(state), !chats[index].messages.isEmpty {
                chats[index].command = nil
                let messageIndex = chats[index].messages.count - 1
                chats[index].messages[messageIndex].completion = state == "completed" ? .completed : state == "cancelled" ? .stopped : .failed
                chats[index].finishActivities(state: state)
                if state == "failed" { error = "Le harness a refusé ce tour. Vérifiez son accès au modèle sur le Mac." }
            }
            else { error = "Le harness n’a pas confirmé la réussite de ce tour. Consultez le Mac avant toute nouvelle tentative." }
        } else if type == "approval_required" { chats[index].state = "waiting_user"; error = "Le harness attend une autorisation sur le Mac. Le suivi continue et se terminera automatiquement après confirmation." }
        try persist()
    }
    func disconnect(_ machine: String, revokeMachine: Bool = false) async throws {
        guard let owner = account, activeChat == nil, !busy else { return }; let epoch = generation
        busy = true; defer { if epoch == generation { busy = false } }
        defer {
            RemoteAuthorizationStore.clear(owner, machine); paired.remove(machine)
            // Re-pairing must never reuse the previous authorization's catalogue.
            if epoch == generation {
                projectCatalog = projectCatalog.filter { !$0.key.hasPrefix(machine + ":") }
                projectCatalogFetchedAt = projectCatalogFetchedAt.filter { !$0.key.hasPrefix(machine + ":") }
            }
        }
        if revokeMachine {
            let session = try await ConversationManager.shared.validSession(); try check(owner, epoch)
            try await RemoteInstanceAPI.shared.revokeMachine(machine, token: session.accessToken)
        } else {
            let (session, fields) = try await authorizedFields(machine, operation: "revoke")
            _ = try await RemoteInstanceAPI.shared.control(machine, account: owner, token: session.accessToken, fields: fields); try check(owner, epoch)
        }
        harnesses[machine] = nil
    }
    func logout() async {
        stopFollowing()
        guard let owner = account else { return }
        for machine in paired { do { try await disconnect(machine) } catch { } }
        // Also clear credentials restored in an earlier launch, even when the
        // directory was never reopened or a control request was already busy.
        RemoteAuthorizationStore.clearAccount(owner)
        activate(nil)
    }
}
