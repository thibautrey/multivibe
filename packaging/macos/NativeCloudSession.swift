import AppKit
import AuthenticationServices
import Combine
import CryptoKit
import Foundation
import Security

/// Official macOS account credentials. Never populated from Host proxy/admin keys.
struct NativeCloudCredential: Codable, Sendable, Equatable {
    var accessToken: String
    var refreshToken: String
    var expiresAt: Date
    var accountID: String
}

enum NativeCloudSessionError: LocalizedError {
    case disconnected, invalidCallback, invalidResponse, presentationUnavailable, rejected(Int), storage(OSStatus)
    var errorDescription: String? {
        switch self {
        case .disconnected: "Connectez votre compte MultiVibe Cloud."
        case .invalidCallback: "Le retour de connexion MultiVibe est invalide ou expiré."
        case .invalidResponse: "La réponse de MultiVibe Cloud est invalide."
        case .presentationUnavailable: "La fenêtre de connexion n’a pas pu être ouverte."
        case .rejected(let status): "MultiVibe Cloud a refusé la connexion (HTTP \(status))."
        case .storage: "Le Trousseau n’a pas pu enregistrer la session MultiVibe."
        }
    }
}

@MainActor struct NativeCloudSessionStorage {
    var load: () throws -> NativeCloudCredential?
    var save: (NativeCloudCredential) throws -> Void
    var clear: () throws -> Void
    static var keychain: Self {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "cloud.multivibe.host.account-session.v1", kSecAttrAccount as String: "multivibe-macos"]
        return Self(load: {
            var request = query; request[kSecReturnData as String] = true
            var result: CFTypeRef?
            let status = SecItemCopyMatching(request as CFDictionary, &result)
            if status == errSecItemNotFound { return nil }
            guard status == errSecSuccess, let data = result as? Data else { throw NativeCloudSessionError.storage(status) }
            return try JSONDecoder().decode(NativeCloudCredential.self, from: data)
        }, save: { credential in
            let data = try JSONEncoder().encode(credential)
            let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            if status == errSecItemNotFound {
                var request = query; request[kSecValueData as String] = data
                request[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
                let added = SecItemAdd(request as CFDictionary, nil)
                guard added == errSecSuccess else { throw NativeCloudSessionError.storage(added) }
            } else if status != errSecSuccess { throw NativeCloudSessionError.storage(status) }
        }, clear: {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeCloudSessionError.storage(status) }
        })
    }
}

/// macOS 13-compatible native OAuth. Endpoints and client identity are fixed.
/// The account ID is verified through Cloud, never decoded from an ID-token claim.
@MainActor final class NativeCloudSession: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    static let clientID = "multivibe-macos"
    static let redirectURI = "multivibe://oauth/callback/macos"
    @Published private(set) var accountID: String?
    @Published private(set) var isSigningIn = false
    private let storage: NativeCloudSessionStorage
    private let transport: @MainActor (URLRequest) async throws -> (Data, URLResponse)
    private var credential: NativeCloudCredential?
    private var generation = UUID()
    private var refreshTask: Task<NativeCloudCredential, Error>?
    private var authentication: ASWebAuthenticationSession?
    private weak var window: NSWindow?
    private var continuation: CheckedContinuation<URL, Error>?
    private var pending: Authorization?
    struct Authorization: Sendable {
        let generation: UUID
        let state: String
        let verifier: String
        let started: Date
        let url: URL
    }
    convenience override init() {
        try! self.init(storage: .keychain)
    }
    init(storage: NativeCloudSessionStorage,
         transport: (@MainActor (URLRequest) async throws -> (Data, URLResponse))? = nil) throws {
        self.storage = storage
        if let transport { self.transport = transport }
        else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil; configuration.urlCache = nil
            configuration.timeoutIntervalForRequest = 30; configuration.timeoutIntervalForResource = 60
            let session = URLSession(configuration: configuration, delegate: NativeCloudNoRedirect(), delegateQueue: nil)
            self.transport = { request in try await session.data(for: request) }
        }
        credential = try storage.load()
        super.init()
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { window ?? NSWindow() }

    static func randomToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw NativeCloudSessionError.invalidResponse }
        return encode(Data(bytes))
    }
    private static func encode(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    /// Internal seam for protocol/race tests; UI calls signIn(window:).
    func beginAuthorization() throws -> Authorization {
        guard pending == nil else { throw NativeCloudSessionError.presentationUnavailable }
        generation = UUID()
        // A refresh in flight retains responsibility for its rotated-token cleanup.
        refreshTask = nil
        let state = try Self.randomToken(), verifier = try Self.randomToken()
        var url = URLComponents(string: "https://auth.multivibe.cloud/oauth/authorize")!
        url.queryItems = [URLQueryItem(name: "client_id", value: Self.clientID), URLQueryItem(name: "redirect_uri", value: Self.redirectURI),
            URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "scope", value: "openid profile projects:read provider:read provider:write"),
            URLQueryItem(name: "state", value: state), URLQueryItem(name: "code_challenge", value: Self.encode(Data(SHA256.hash(data: Data(verifier.utf8))))),
            URLQueryItem(name: "code_challenge_method", value: "S256")]
        let value = Authorization(generation: generation, state: state, verifier: verifier, started: Date(), url: url.url!)
        pending = value; isSigningIn = true
        return value
    }
    func signIn(window: NSWindow) async throws {
        try Task.checkCancellation()
        let authorization = try beginAuthorization()
        self.window = window
        defer {
            if pending?.generation == authorization.generation { pending = nil; isSigningIn = false }
            if generation == authorization.generation { authentication = nil; self.window = nil }
        }
        let callback = try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
                self.continuation = continuation
                let authentication = ASWebAuthenticationSession(url: authorization.url, callbackURLScheme: "multivibe") { callback, error in
                    Task { @MainActor in
                        guard self.generation == authorization.generation else { return }
                        self.finishBrowser(callback.map(Result.success) ?? .failure(error ?? NativeCloudSessionError.invalidCallback))
                    }
                }
                authentication.presentationContextProvider = self
                authentication.prefersEphemeralWebBrowserSession = true
                self.authentication = authentication
                if !authentication.start() { finishBrowser(.failure(NativeCloudSessionError.presentationUnavailable)) }
            }
        } onCancel: {
            Task { @MainActor in
                guard self.generation == authorization.generation else { return }
                self.authentication?.cancel()
                self.finishBrowser(.failure(CancellationError()))
            }
        }
        try Task.checkCancellation()
        try await completeAuthorization(callback, authorization: authorization)
    }
    private func finishBrowser(_ result: Result<URL, Error>) {
        let continuation = self.continuation; self.continuation = nil
        continuation?.resume(with: result)
    }
    static func authorizationCode(_ callback: URL, expectedState: String) throws -> String {
        guard let value = URLComponents(url: callback, resolvingAgainstBaseURL: false), value.scheme == "multivibe", value.host == "oauth",
              value.path == "/callback/macos", value.port == nil, value.user == nil, value.password == nil, value.fragment == nil else { throw NativeCloudSessionError.invalidCallback }
        let items = value.queryItems ?? []
        guard items.count == 2, items.filter({ $0.name == "state" }).count == 1, items.first(where: { $0.name == "state" })?.value == expectedState,
              items.filter({ $0.name == "code" }).count == 1, let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty, code.utf8.count <= 4096 else { throw NativeCloudSessionError.invalidCallback }
        return code
    }
    func completeAuthorization(_ callback: URL, authorization: Authorization) async throws {
        guard generation == authorization.generation, pending?.generation == authorization.generation,
              Date().timeIntervalSince(authorization.started) < 600 else { throw NativeCloudSessionError.invalidCallback }
        let code = try Self.authorizationCode(callback, expectedState: authorization.state)
        pending = nil
        defer { if generation == authorization.generation { isSigningIn = false } }
        let issued = try await exchange(["grant_type": "authorization_code", "code": code, "code_verifier": authorization.verifier, "redirect_uri": Self.redirectURI])
        do {
            let identity = try await verifiedIdentity(issued.accessToken)
            guard generation == authorization.generation else { throw NativeCloudSessionError.disconnected }
            try Task.checkCancellation()
            var value = issued; value.accountID = identity
            try storage.save(value)
            let previous = credential; credential = value; accountID = identity
            if let previous, previous.refreshToken != value.refreshToken { Task { try? await revoke(previous.refreshToken) } }
        } catch {
            // Fresh tokens must not survive a failed identity check, logout or cancelled sign-in.
            Task { try? await revoke(issued.refreshToken) }
            throw error
        }
    }
    func token() async throws -> String {
        try Task.checkCancellation()
        guard !isSigningIn, let previous = credential else { throw NativeCloudSessionError.disconnected }
        let epoch = generation
        if previous.expiresAt > Date().addingTimeInterval(60) {
            let identity = try await verifiedIdentity(previous.accessToken)
            guard generation == epoch, identity == previous.accountID else { throw NativeCloudSessionError.disconnected }
            try Task.checkCancellation()
            accountID = identity; return previous.accessToken
        }
        if let refreshTask {
            let value = try await refreshTask.value
            guard generation == epoch else { throw NativeCloudSessionError.disconnected }
            try Task.checkCancellation(); return value.accessToken
        }
        let task = Task { @MainActor () throws -> NativeCloudCredential in
            let issued = try await self.exchange(["grant_type": "refresh_token", "refresh_token": previous.refreshToken])
            do {
                let identity = try await self.verifiedIdentity(issued.accessToken)
                guard self.generation == epoch, identity == previous.accountID else { throw NativeCloudSessionError.disconnected }
                var value = issued; value.accountID = identity
                try self.storage.save(value)
                self.credential = value; self.accountID = identity
                return value
            } catch {
                try? await self.revoke(issued.refreshToken)
                throw error
            }
        }
        refreshTask = task
        defer { if generation == epoch { refreshTask = nil } }
        let value = try await task.value
        guard generation == epoch else { throw NativeCloudSessionError.disconnected }
        try Task.checkCancellation(); return value.accessToken
    }
    func disconnect() async throws {
        let previous = credential
        generation = UUID(); authentication?.cancel(); authentication = nil; pending = nil; isSigningIn = false
        finishBrowser(.failure(CancellationError()))
        window = nil; refreshTask = nil; credential = nil; accountID = nil
        // Clearing before suspension fences every older completion.
        do { try storage.clear() }
        catch {
            if let previous { try? await revoke(previous.refreshToken) }
            throw error
        }
        if let previous { try await revoke(previous.refreshToken) }
    }
    private func form(_ path: String, fields: [String: String]) async throws -> Data {
        var request = URLRequest(url: URL(string: "https://auth.multivibe.cloud" + path)!)
        request.httpMethod = "POST"
        var fields = fields; fields["client_id"] = Self.clientID
        var form = URLComponents(); form.queryItems = fields.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        request.httpBody = form.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B").data(using: .utf8)
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        return try await send(request)
    }
    private func exchange(_ fields: [String: String]) async throws -> NativeCloudCredential {
        struct Tokens: Decodable { let access_token: String; let refresh_token: String; let expires_in: Int }
        let value = try JSONDecoder().decode(Tokens.self, from: await form("/oauth/token", fields: fields))
        guard !value.access_token.isEmpty, !value.refresh_token.isEmpty, value.access_token.utf8.count <= 16_384,
              value.refresh_token.utf8.count <= 16_384, (1...604_800).contains(value.expires_in) else { throw NativeCloudSessionError.invalidResponse }
        return .init(accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: Date().addingTimeInterval(Double(value.expires_in)), accountID: "")
    }
    private func verifiedIdentity(_ token: String) async throws -> String {
        var request = URLRequest(url: URL(string: "https://app.multivibe.cloud/native/v1/auth/session")!)
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        struct Identity: Decodable { let accountId: String }
        let value = try JSONDecoder().decode(Identity.self, from: await send(request))
        guard !value.accountId.isEmpty, value.accountId.utf8.count <= 256 else { throw NativeCloudSessionError.invalidResponse }
        return value.accountId
    }
    private func revoke(_ token: String) async throws { _ = try await form("/oauth/revoke", fields: ["token": token, "token_type_hint": "refresh_token"]) }
    private func send(_ request: URLRequest) async throws -> Data {
        let permitted = ["https://auth.multivibe.cloud/oauth/token", "https://auth.multivibe.cloud/oauth/revoke", "https://app.multivibe.cloud/native/v1/auth/session"]
        guard let url = request.url, permitted.contains(url.absoluteString) else { throw NativeCloudSessionError.invalidResponse }
        let (data, response) = try await transport(request)
        guard data.count <= 1_048_576, let response = response as? HTTPURLResponse, response.url == url else { throw NativeCloudSessionError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else { throw NativeCloudSessionError.rejected(response.statusCode) }
        return data
    }
}

private final class NativeCloudNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
