import Foundation
import CryptoKit
import Security
import Network
import Observation

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
}
struct RemoteDeviceAuthorization: Codable, Sendable {
    let deviceId: String; let deviceToken: String; let expiresAt: Double
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
}

actor RemoteInstanceAPI {
    static let shared = RemoteInstanceAPI()
    static let model = "multivibe/host-harness-v1"
    private let session: URLSession
    init(session supplied: URLSession? = nil) {
        let c = URLSessionConfiguration.ephemeral; c.urlCache = nil; c.httpCookieStorage = nil
        c.timeoutIntervalForRequest = 60; c.timeoutIntervalForResource = 300
        session = supplied ?? URLSession(configuration: c, delegate: RemoteInstanceRedirectPolicy(), delegateQueue: nil)
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
        let (data, response) = try await session.data(for: request("machines", token: token)); try validate(response)
        guard data.count <= 1_048_576 else { throw APIError.invalidResponse }
        struct Reply: Decodable { let data: [RemoteMachine] }
        return try JSONDecoder().decode(Reply.self, from: data).data
    }
    func revokeMachine(_ machine: String, token: String) async throws {
        let (_, response) = try await session.data(for: request("machines/" + machine, token: token, method: "DELETE")); try validate(response)
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
        let (data, response) = try await session.data(for: bridgeRequest(machine, account: account, token: token, fields: fields)); try validate(response)
        guard data.count <= 2_097_152 else { throw APIError.invalidResponse }
        let result = try JSONDecoder().decode(HistoryJSON.self, from: data)
        guard result.object?["version"]?.number == 1 else { throw APIError.invalidResponse }; return result
    }
    func events(_ machine: String, account: String, token: String, fields: [String: HistoryJSON], update: @Sendable (HistoryJSON) async throws -> Void) async throws {
        let (bytes, response) = try await session.bytes(for: bridgeRequest(machine, account: account, token: token, fields: fields)); try validate(response)
        guard (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "content-type")?.hasPrefix("text/event-stream") == true else { throw APIError.invalidResponse }
        var total = 0, terminal = false
        for try await line in bytes.lines {
            try Task.checkCancellation(); total += line.utf8.count
            guard line.utf8.count <= 1_048_576, total <= 8_388_608 else { throw APIError.invalidResponse }
            if line.hasPrefix("data: ") {
                let event = try JSONDecoder().decode(HistoryJSON.self, from: Data(line.dropFirst(6).utf8))
                try await update(event)
                if ["terminal", "approval_required"].contains(event.object?["type"]?.string ?? "") { terminal = true }
            }
        }
        guard terminal else { throw APIError.server(502, "instance_stream_interrupted") }
    }
}
private final class RemoteInstanceRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

struct RemoteChat: Codable, Identifiable, Sendable {
    var id = UUID(); var machine: String; var harness: String; var model: String; var provider: String?
    var title = "Nouvelle conversation"; var messages: [ChatMessage] = []
    var command: String?; var cursor = 0; var state = "idle"; var items: [String: String] = [:]; var itemOrder: [String] = []
}
struct RemoteModelPreference: Codable { var harness: String; var model: String; var provider: String? }

@MainActor @Observable final class RemoteInstances {
    static let shared = RemoteInstances()
    private(set) var account: String?
    private(set) var machines: [RemoteMachine] = []
    private(set) var harnesses: [String: [RemoteHarness]] = [:]
    private(set) var modelCatalog: [String: [RemoteHarnessModel]] = [:]
    private(set) var chats: [RemoteChat] = []
    private(set) var preferences: [String: RemoteModelPreference] = [:]
    private(set) var paired: Set<String> = []
    private(set) var busy = false
    private(set) var activeChat: UUID?
    var error: String?
    var pendingPairing: RemotePairing?
    private var generation = UUID()
    private var task: Task<Void, Never>?
    private var network = "inconnu"
    private var storageLoaded = false
    private let monitor = NWPathMonitor()
    private struct Archive: Codable { var chats: [RemoteChat]; var preferences: [String: RemoteModelPreference] }
    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let label = path.usesInterfaceType(.cellular) ? "Réseau cellulaire" : path.usesInterfaceType(.wifi) ? "Wi-Fi → Relay WAN" : "Relay WAN"
            Task { @MainActor in self?.network = label }
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
        try JSONEncoder().encode(Archive(chats: chats, preferences: preferences)).write(to: url, options: [.atomic, .completeFileProtection])
        var values = URLResourceValues(); values.isExcludedFromBackup = true; var folder = url.deletingLastPathComponent(); try folder.setResourceValues(values)
    }
    func activate(_ account: String?) {
        guard self.account != account else { return }; task?.cancel(); task = nil; generation = UUID(); activeChat = nil; busy = false
        self.account = account; machines = []; harnesses = [:]; modelCatalog = [:]; chats = []; preferences = [:]; paired = []; error = nil; storageLoaded = false
        guard let account else { pendingPairing = nil; return }
        let url = archiveURL(account)
        do { if FileManager.default.fileExists(atPath: url.path) {
            let data = try Data(contentsOf: url); guard data.count <= 16_777_216 else { throw APIError.invalidResponse }
            let archive = try JSONDecoder().decode(Archive.self, from: data); chats = archive.chats; preferences = archive.preferences
        }; storageLoaded = true } catch { self.error = "L’historique de vos instances est conservé mais ne peut pas être ouvert." }
    }
    private func check(_ owner: String, _ epoch: UUID) throws {
        try Task.checkCancellation(); guard account == owner, generation == epoch, ConversationManager.shared.session?.accountId == owner else { throw CancellationError() }
    }
    func reload() async {
        guard let owner = account, !busy else { return }; let epoch = generation; busy = true
        defer { if generation == epoch { busy = false } }
        do {
            let session = try await ConversationManager.shared.validSession(); try check(owner, epoch)
            let result = try await RemoteInstanceAPI.shared.machines(token: session.accessToken); try check(owner, epoch)
            machines = result
            paired = Set(try result.compactMap { try RemoteAuthorizationStore.load(owner, $0.id) == nil ? nil : $0.id })
            error = nil
        } catch is CancellationError { } catch { if generation == epoch { self.error = "Instances indisponibles. Vérifiez votre compte et la connexion réseau." } }
    }
    private func authorizedFields(_ machine: String, operation: String) async throws -> (NativeSession, [String: HistoryJSON]) {
        guard let owner = account else { throw APIError.authenticationRequired }; let epoch = generation
        let session = try await ConversationManager.shared.validSession(); try check(owner, epoch)
        guard var auth = try RemoteAuthorizationStore.load(owner, machine), auth.expiresAt > Date().timeIntervalSince1970 * 1000 else { throw APIError.server(401, "instance_device_expired") }
        if auth.expiresAt < Date().addingTimeInterval(300).timeIntervalSince1970 * 1000 {
            let result = try await RemoteInstanceAPI.shared.control(machine, account: owner, token: session.accessToken, fields: credentials(auth, operation: "renew")); try check(owner, epoch)
            auth = try JSONDecoder().decode(RemoteDeviceAuthorization.self, from: JSONEncoder().encode(result))
            do { try RemoteAuthorizationStore.save(auth, owner, machine) }
            catch { RemoteAuthorizationStore.clear(owner, machine); paired.remove(machine); throw error }
        }
        return (session, credentials(auth, operation: operation))
    }
    private func credentials(_ auth: RemoteDeviceAuthorization, operation: String) -> [String: HistoryJSON] {
        ["operation": .string(operation), "deviceId": .string(auth.deviceId), "deviceToken": .string(auth.deviceToken)]
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
        let result = try await RemoteInstanceAPI.shared.control(machine, account: owner, token: session.accessToken, fields: fields); try check(owner, epoch)
        let values = try JSONDecoder().decode([RemoteHarnessModel].self, from: JSONEncoder().encode(result.object?["models"] ?? .array([])))
        modelCatalog[machine + ":" + harness] = values
    }
    func choose(_ machine: String, harness: String, model: RemoteHarnessModel) throws {
        preferences[machine] = .init(harness: harness, model: model.id, provider: model.provider); try persist()
    }
    func newChat(_ machine: String) throws -> UUID {
        guard let p = preferences[machine], paired.contains(machine) else { throw APIError.noModel }
        let chat = RemoteChat(machine: machine, harness: p.harness, model: p.model, provider: p.provider); chats.append(chat); try persist(); return chat.id
    }
    func stopFollowing() { task?.cancel(); task = nil; activeChat = nil; generation = UUID() }
    func send(_ text: String, chat id: UUID, recover: Bool = false) {
        guard activeChat == nil, let owner = account, let index = chats.firstIndex(where: { $0.id == id }), !busy else { return }
        if !recover {
            guard chats[index].command == nil, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            chats[index].command = UUID().uuidString.lowercased(); chats[index].cursor = 0; chats[index].items = [:]; chats[index].itemOrder = []
            chats[index].messages.append(.init(role: "user", content: text)); chats[index].messages.append(.init(role: "assistant", content: "", completion: .interrupted))
            if chats[index].messages.count == 2 { chats[index].title = ConversationTitle.fallback(for: text) }
        }
        chats[index].state = "running"
        do { try persist() } catch { self.error = "Le message n’a pas pu être enregistré. Il n’a pas été envoyé."; return }
        let epoch = generation, chat = chats[index]; activeChat = id; error = nil
        task = Task {
            defer { if generation == epoch { activeChat = nil; task = nil; try? persist() } }
            do {
                let (session, auth) = try await authorizedFields(chat.machine, operation: recover ? "recover" : "prompt"); try check(owner, epoch)
                var fields = auth; fields["conversationId"] = .string(id.uuidString.lowercased()); fields["commandId"] = .string(chat.command!); fields["after"] = .number(Double(chat.cursor))
                if !recover { fields["harnessId"] = .string(chat.harness); fields["model"] = .string(chat.model); fields["text"] = .string(text); if let provider = chat.provider { fields["provider"] = .string(provider) } }
                try await RemoteInstanceAPI.shared.events(chat.machine, account: owner, token: session.accessToken, fields: fields) { event in
                    try await self.receive(event, chat: id, owner: owner, epoch: epoch)
                }
            } catch is CancellationError { } catch {
                if generation == epoch { self.error = "Le suivi a été interrompu. Le Mac peut continuer ; utilisez Reprendre pour consulter le résultat sans renvoyer le message." }
            }
        }
    }
    private func receive(_ event: HistoryJSON, chat id: UUID, owner: String, epoch: UUID) throws {
        try check(owner, epoch); guard let index = chats.firstIndex(where: { $0.id == id }), let object = event.object else { throw APIError.invalidResponse }
        let type = object["type"]?.string
        if type == "message.delta" || type == "message.part", let text = object["text"]?.string, let seq = object["seq"]?.number, seq > Double(chats[index].cursor) {
            let item = object["itemId"]?.string ?? "assistant"
            if chats[index].items[item] == nil { chats[index].itemOrder.append(item) }
            if type == "message.part" { chats[index].items[item] = text } else { chats[index].items[item, default: ""] += text }
            chats[index].cursor = Int(seq)
            chats[index].messages[chats[index].messages.count - 1].content = chats[index].itemOrder.compactMap { chats[index].items[$0] }.joined(separator: "\n")
        } else if type == "terminal" {
            let state = object["state"]?.string ?? "uncertain"; chats[index].state = state
            chats[index].cursor = Int(object["cursor"]?.number ?? Double(chats[index].cursor))
            if state == "completed" { chats[index].command = nil; chats[index].messages[chats[index].messages.count - 1].completion = .completed }
            else { error = "Le harness n’a pas confirmé la réussite de ce tour. Consultez le Mac avant toute nouvelle tentative." }
        } else if type == "approval_required" { chats[index].state = "waiting_user"; error = "Le harness attend une autorisation sur le Mac. Confirmez-la sur le Mac, puis reprenez le suivi." }
        try persist()
    }
    func disconnect(_ machine: String, revokeMachine: Bool = false) async throws {
        guard let owner = account, activeChat == nil, !busy else { return }; let epoch = generation
        busy = true; defer { if epoch == generation { busy = false } }
        defer { RemoteAuthorizationStore.clear(owner, machine); paired.remove(machine) }
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
        for machine in paired { do { try await disconnect(machine) } catch { RemoteAuthorizationStore.clear(owner, machine) } }
        activate(nil)
    }
}
