import Foundation
import Observation

@MainActor @Observable public final class MultiVibeClient {
    public enum Mode: Sendable { case application, accountOwner }
    public let configuration: MultiVibeConfiguration
    public let mode: Mode
    public private(set) var conversations: [MultiVibeConversation] = []
    public private(set) var models: [MultiVibeModel] = []
    public private(set) var relayAllowance: MultiVibeRelayAllowance?
    public private(set) var relayCatalogueError: String?
    public private(set) var accountID: String?
    public private(set) var isConnected = false
    private let ownerHistory: OwnerEncryptedHistory
    public var isHistoryUnlocked: Bool { ownerHistory.unlocked }
    public private(set) var historyAuthorizationRequired = false
    public var hasPendingHistoryWrite: Bool { ownerHistory.hasPending }
    let localProvider:(any MultiVibeLocalModelProvider)?
    private let tokenProvider: (@Sendable () async throws -> String)?
    private let transport: URLSession
    @ObservationIgnored var dataTransportOverride: (@MainActor (URLRequest) async throws -> (Data, URLResponse))?
    private let storage: SDKKeychain
    private var stored: StoredSession?
    private var refreshTask: Task<StoredSession, Error>?
    private var authorization: MultiVibeAuthorization?
    private var authorizationDate: Date?
    private var generation = UUID()
    public init(configuration: MultiVibeConfiguration, mode: Mode = .application, localProvider:(any MultiVibeLocalModelProvider)? = nil, tokenProvider: (@Sendable () async throws -> String)? = nil) {
        precondition(configuration.baseURL.scheme == "https" && configuration.baseURL.user == nil && configuration.baseURL.password == nil)
        precondition(configuration.redirectURI.scheme == "https" && configuration.redirectURI.query == nil && configuration.redirectURI.fragment == nil)
        precondition(mode == .accountOwner ? tokenProvider != nil : tokenProvider == nil)
        self.configuration = configuration; self.mode = mode; self.tokenProvider = tokenProvider; self.localProvider = localProvider
        ownerHistory = OwnerEncryptedHistory(namespace: configuration.baseURL.absoluteString + (mode == .application ? configuration.clientID : ""), applicationId: mode == .application ? configuration.clientID : nil)
        storage = SDKKeychain(service: "cloud.multivibe.sdk.\(configuration.baseURL.host ?? "").\(configuration.clientID)")
        let config = URLSessionConfiguration.ephemeral; config.httpCookieStorage = nil; config.urlCache = nil; config.timeoutIntervalForRequest = 60; config.timeoutIntervalForResource = 300
        transport = URLSession(configuration: config, delegate: SDKTransportDelegate(), delegateQueue: nil)
        if mode == .application { stored = try? storage.load() }
    }
    public func beginAuthorization() throws -> MultiVibeAuthorization {
        guard mode == .application else { throw MultiVibeError.invalidCallback }
        let value = try MultiVibeAuthorization(configuration: configuration)
        lockHistory(); generation = UUID(); refreshTask?.cancel(); refreshTask = nil
        authorization = value; authorizationDate = Date(); return value
    }
    public func handleOpenURL(_ url: URL) async throws {
        guard let pending = authorization, let date = authorizationDate, Date().timeIntervalSince(date) < 600 else { throw MultiVibeError.invalidCallback }
        let code = try pending.code(from: url)
        let epoch = generation
        authorization = nil; authorizationDate = nil
        let session = try await exchange(["grant_type":"authorization_code", "code":code, "code_verifier":pending.verifier, "redirect_uri":configuration.redirectURI.absoluteString])
        guard generation == epoch else {
            revokeAbandoned(session)
            throw MultiVibeError.invalidCallback
        }
        guard !Task.isCancelled else {
            revokeAbandoned(session)
            throw CancellationError()
        }
        conversations = []; models = []; accountID = nil
        try storage.save(session); stored = session
        try await connect()
    }
    /// Handles a return from the official app to an already synchronized thread.
    public func conversationFromOpenURL(_ url:URL) async throws -> MultiVibeConversation? {
        guard let incoming = URLComponents(url:url,resolvingAgainstBaseURL:false),let expected = URLComponents(url:configuration.redirectURI,resolvingAgainstBaseURL:false), incoming.scheme == expected.scheme,incoming.host == expected.host,incoming.port == expected.port,incoming.path == expected.path,incoming.user == nil,incoming.password == nil,incoming.fragment == nil else {return nil}
        let items = incoming.queryItems ?? []
        guard items.filter({$0.name == "conversationId"}).count == 1, let id = items.first(where:{$0.name == "conversationId"})?.value,UUID(uuidString:id) != nil, items.allSatisfy({$0.name == "conversationId"}) else {return nil}
        try await reload()
        guard let conversation = conversations.first(where:{$0.id.lowercased() == id.lowercased()}) else {throw MultiVibeError.invalidArguments}
        return conversation
    }
    public func connect() async throws {
        struct Identity: Decodable { let accountId: String; let appId: String? }
        if mode == .application {
            let identity: Identity = try await read("/sdk/v2/session")
            guard identity.appId == configuration.clientID else { throw MultiVibeError.authenticationRequired }
            if accountID != identity.accountId { ownerHistory.lock(); conversations = []; models = [] }
            accountID = identity.accountId
            let key = try ApplicationHistoryKeychain(service: storage.service).loadOrCreate()
            do {
                try await ownerHistory.unlockApplication(accountId: identity.accountId, privateKey: key, transport: historyTransport)
                historyAuthorizationRequired = false
            } catch MultiVibeError.historyAuthorizationRequired { historyAuthorizationRequired = true }
        }
        if mode == .accountOwner { _ = try await token() }
        isConnected = true
        try await reload()
    }
    public func reload() async throws {
        let epoch = generation
        struct List<T: Decodable>: Decodable { let data: [T] }
        if ownerHistory.unlocked {
            if !ownerHistory.hasPending { try await ownerHistory.reload(transport: historyTransport) }
            conversations = ownerHistory.conversations
        } else { conversations = [] }
        var loaded: [MultiVibeModel]
        relayAllowance = nil; relayCatalogueError = nil
        if mode == .accountOwner {
            let catalogue: List<MultiVibeModel> = try await read("/native/v1/models")
            loaded = catalogue.data
            struct RelayCatalogue: Decodable { let data: [MultiVibeModel]; let allowance: MultiVibeRelayAllowance }
            do {
                let relay: RelayCatalogue = try await read("/relay/v1/models")
                guard relay.data.allSatisfy({ $0.id.hasPrefix("relay/") && $0.section == .relay }) else { throw MultiVibeError.invalidResponse }
                loaded.removeAll { $0.section == .relay }
                loaded.append(contentsOf: relay.data); relayAllowance = relay.allowance
            } catch {
                if case MultiVibeError.authenticationRequired = error { throw error }
                if case MultiVibeError.server(let code, _) = error, [401, 403].contains(code) { throw error }
                loaded.removeAll { $0.section == .relay }
                relayCatalogueError = "Relay est indisponible. Réessayez de charger les modèles."
            }
        } else {
            struct ApplicationCatalogue: Decodable { let data: [MultiVibeModel]; let relayAllowance: MultiVibeRelayAllowance? }
            let catalogue: ApplicationCatalogue = try await read("/sdk/v2/models")
            guard catalogue.data.allSatisfy({ $0.section != .relay || $0.id.hasPrefix("relay/") }) else { throw MultiVibeError.invalidResponse }
            loaded = catalogue.data; relayAllowance = catalogue.relayAllowance
        }
        guard Set(loaded.map(\.id)).count == loaded.count else { throw MultiVibeError.invalidResponse }
        models = loaded
        if let localProvider, await localProvider.isAvailable() {
            guard epoch == generation else { throw MultiVibeError.authenticationRequired }
            models.append(MultiVibeModel(id:localProvider.modelID,supportsTools:false))
        }
    }
    private func historyTransport(_ path: String, _ method: String, _ body: Data?) async throws -> Data {
        let permitted = mode == .accountOwner ? path.hasPrefix("/native/v2/") : path.hasPrefix("/sdk/v2/")
        guard permitted else { throw MultiVibeError.authenticationRequired }
        return try await data(path, method: method, body: body)
    }
    /// Only the official account-owner surface may collect this code. Developer
    /// grants cannot use the native owner routes or request the global keyring.
    public func unlockHistory(recoveryCode: String) async throws {
        guard mode == .accountOwner else { throw MultiVibeError.authenticationRequired }
        let epoch = generation
        _ = try await token()
        guard epoch == generation else { throw MultiVibeError.historyLocked }
        guard let accountID else { throw MultiVibeError.authenticationRequired }
        conversations = []
        try await ownerHistory.unlock(accountId: accountID, code: recoveryCode, transport: historyTransport)
        if !ownerHistory.hasPending { try await reload() }
    }
    public func lockHistory() { ownerHistory.lock(); generation = UUID(); conversations = [] }
    @discardableResult public func retryHistoryWrite() async throws -> MultiVibeConversation? {
        let saved = try await ownerHistory.retry(transport: historyTransport)
        conversations = ownerHistory.conversations
        return saved
    }
    public func discardHistoryWrite() async throws {
        try ownerHistory.discardPending(); conversations = []; try await reload()
    }
    public func disconnect() async throws {
        lockHistory(); relayAllowance = nil; relayCatalogueError = nil
        let token = mode == .application ? stored?.refreshToken : nil
        // Invalidate before the network suspension: an older authorization or
        // refresh must never restore credentials while revocation is in flight.
        generation = UUID(); stored = nil; if mode == .application {storage.clear()}; refreshTask?.cancel(); refreshTask = nil; authorization = nil; authorizationDate = nil; accountID = nil; isConnected = false; conversations = []; models = []
        if let token { _ = try await form("/developers/oauth/revoke", fields:["client_id":configuration.clientID,"token":token]) }
    }
    private func revokeAbandoned(_ session:StoredSession) {
        // Revoke only this newly minted, abandoned grant; do not delay or
        // mutate the winning session while best-effort cleanup is underway.
        Task { _ = try? await form("/developers/oauth/revoke",fields:["client_id":configuration.clientID,"token":session.refreshToken]) }
    }
    public func newConversation() -> MultiVibeConversation { MultiVibeConversation(appId: configuration.clientID, model: models.first(where: { $0.available != false })?.id ?? "") }
    public func save(_ conversation: MultiVibeConversation, operationID: String = UUID().uuidString) async throws -> MultiVibeConversation {
        guard UUID(uuidString: conversation.id) != nil, mode == .accountOwner || conversation.appId == configuration.clientID else { throw MultiVibeError.invalidArguments }
        let saved = try await ownerHistory.save(conversation, operationId: operationID, transport: historyTransport)
        conversations = ownerHistory.conversations; return saved
    }
    public func delete(_ conversation: MultiVibeConversation) async throws {
        guard UUID(uuidString: conversation.id) != nil, mode == .accountOwner || conversation.appId == configuration.clientID else { throw MultiVibeError.invalidArguments }
        try await ownerHistory.delete(conversation, transport: historyTransport)
        conversations = ownerHistory.conversations
    }
    func token() async throws -> String {
        if let tokenProvider {
            let epoch = generation
            let token = try await tokenProvider()
            guard epoch == generation else { throw MultiVibeError.authenticationRequired }
            var request = URLRequest(url:configuration.baseURL.appending(path:"/native/v1/auth/session"))
            request.setValue("Bearer \(token)",forHTTPHeaderField:"Authorization")
            let (data,response) = try await transportData(request)
            guard epoch == generation else { throw MultiVibeError.authenticationRequired }
            try validate(response,data:data)
            struct Identity:Decodable {let accountId:String}
            let identity = try JSONDecoder().decode(Identity.self,from:data)
            guard accountID == nil || accountID == identity.accountId else {
                lockHistory(); throw MultiVibeError.authenticationRequired
            }
            accountID = identity.accountId; return token
        }
        guard mode == .application, let previous = stored else { throw MultiVibeError.authenticationRequired }
        if previous.expiresAt > Date().addingTimeInterval(60) { return previous.accessToken }
        if let refreshTask {
            let renewed = try await refreshTask.value
            try Task.checkCancellation()
            return renewed.accessToken
        }
        let epoch = generation
        let task = Task {
            let renewed = try await self.exchange(["grant_type":"refresh_token", "refresh_token":previous.refreshToken])
            guard epoch == self.generation else {
                self.revokeAbandoned(renewed)
                throw MultiVibeError.authenticationRequired
            }
            // The shared operation owns rotation persistence. Cancellation of
            // an awaiting UI task must not discard a successfully rotated token.
            try self.storage.save(renewed); self.stored = renewed
            return renewed
        }
        refreshTask = task
        defer {if epoch == generation {refreshTask = nil}}
        let renewed:StoredSession
        do {renewed = try await task.value}
        catch {
            if epoch == generation {ownerHistory.lock(); stored = nil; storage.clear(); isConnected = false; accountID = nil; conversations = []; models = []; generation = UUID(); refreshTask = nil}
            throw error
        }
        try Task.checkCancellation()
        return renewed.accessToken
    }

    func exchange(_ fields: [String:String]) async throws -> StoredSession {
        var fields = fields; fields["client_id"] = configuration.clientID
        let data = try await form("/developers/oauth/token", fields: fields)
        struct Reply: Decodable { let access_token: String; let refresh_token: String; let expires_in: Int }
        let r = try JSONDecoder().decode(Reply.self, from:data)
        guard !r.access_token.isEmpty, !r.refresh_token.isEmpty, r.expires_in > 0 else { throw MultiVibeError.invalidResponse }
        return StoredSession(accessToken:r.access_token,refreshToken:r.refresh_token,expiresAt:Date().addingTimeInterval(Double(r.expires_in)))
    }
    private func transportData(_ request:URLRequest) async throws -> (Data,URLResponse) {
        if let dataTransportOverride {return try await dataTransportOverride(request)}
        return try await transport.data(for:request)
    }
    func form(_ path: String, fields: [String:String]) async throws -> Data {
        var request = URLRequest(url: URL(string:path,relativeTo:configuration.baseURL)!.absoluteURL); request.httpMethod = "POST"
        var form = URLComponents(); form.queryItems = fields.sorted(by:{$0.key < $1.key}).map {URLQueryItem(name:$0.key,value:$0.value)}
        request.httpBody = form.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B").data(using:.utf8); request.setValue("application/x-www-form-urlencoded",forHTTPHeaderField:"Content-Type")
        let (data,response) = try await transportData(request); try validate(response,data:data); return data
    }
    public func accountRequest<T: Decodable>(_ path: String, body: Data? = nil, as type: T.Type) async throws -> T {
        guard mode == .accountOwner, path.hasPrefix("/native/v1/sdk/") else { throw MultiVibeError.authenticationRequired }
        return try await read(path, method: body == nil ? "GET" : "POST", body: body)
    }
    func request(_ path: String, method: String = "GET", body: Data? = nil, relayContinuation: String? = nil) async throws -> URLRequest {
        let epoch = generation
        let accessToken = try await token()
        guard epoch == generation else { throw MultiVibeError.authenticationRequired }
        var request = URLRequest(url: URL(string:path,relativeTo:configuration.baseURL)!.absoluteURL)
        request.httpMethod = method; request.httpBody = body
        request.setValue("application/json",forHTTPHeaderField:"Content-Type")
        if let relayContinuation {
            guard UUID(uuidString: relayContinuation) != nil else { throw MultiVibeError.invalidArguments }
            request.setValue(relayContinuation, forHTTPHeaderField: "x-multivibe-relay-continuation")
        }
        request.setValue("Bearer \(accessToken)",forHTTPHeaderField:"Authorization"); return request
    }
    func data(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
        let epoch = generation
        let (data,response) = try await transportData(request(path,method:method,body:body))
        guard epoch == generation else {throw MultiVibeError.authenticationRequired}
        try validate(response,data:data); return data
    }
    func read<T:Decodable>(_ path:String,method:String = "GET",body:Data? = nil) async throws -> T { try JSONDecoder().decode(T.self,from:await data(path,method:method,body:body)) }
    func validate(_ response:URLResponse,data:Data = Data()) throws {
        guard let response = response as? HTTPURLResponse else {throw MultiVibeError.invalidResponse}
        if mode == .application, !(200..<300).contains(response.statusCode),
           let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let code = body["error"] as? String, ["history_delegation_unavailable", "history_keys_changed"].contains(code) {
            lockHistory(); historyAuthorizationRequired = true; throw MultiVibeError.historyAuthorizationRequired
        }
        if response.statusCode == 409 {throw MultiVibeError.conflict}
        guard (200..<300).contains(response.statusCode) else {throw MultiVibeError.server(response.statusCode,String(data:data,encoding:.utf8) ?? "request_failed")}
    }
    func completionPath(body: Data) throws -> String {
        struct Selection: Decodable { let model: String }
        let selection = try JSONDecoder().decode(Selection.self, from: body)
        guard let model = models.first(where: { $0.id == selection.model }), model.available != false else {
            throw MultiVibeError.server(503, "selected_model_unavailable")
        }
        if model.section == .relay {
            guard model.id.hasPrefix("relay/") else { throw MultiVibeError.invalidArguments }
            return mode == .accountOwner ? "/relay/v1/completions" : "/sdk/v2/completions"
        }
        return mode == .accountOwner ? "/native/v1/completions" : "/sdk/v2/completions"
    }
    func stream(body:Data,previousRelayContinuation:String? = nil,receivedRelayContinuation:(String)->Void = {_ in},onEvent:@MainActor (String) throws -> Void) async throws {
        let epoch = generation
        if !isHistoryUnlocked { throw MultiVibeError.historyLocked }
        let path = try completionPath(body: body)
        struct Selection: Decodable { let model: String }
        let isRelay = try JSONDecoder().decode(Selection.self, from: body).model.hasPrefix("relay/")
        guard previousRelayContinuation == nil || isRelay else { throw MultiVibeError.invalidArguments }
        let (bytes,response) = try await transport.bytes(for:request(path,method:"POST",body:body,relayContinuation:previousRelayContinuation))
        try validate(response)
        guard (response as? HTTPURLResponse)?.value(forHTTPHeaderField:"Content-Type")?.hasPrefix("text/event-stream") == true else {throw MultiVibeError.invalidResponse}
        var parser = SSEByteParser()
        for try await byte in bytes {try Task.checkCancellation(); guard epoch == generation else {throw MultiVibeError.authenticationRequired}; if let event = try parser.consume(byte) {if event == "[DONE]" {if isRelay, let receipt = (response as? HTTPURLResponse)?.value(forHTTPHeaderField:"x-multivibe-relay-continuation"), UUID(uuidString:receipt) != nil {receivedRelayContinuation(receipt)}; return}; try onEvent(event)}}
        throw MultiVibeError.invalidResponse
    }
}
