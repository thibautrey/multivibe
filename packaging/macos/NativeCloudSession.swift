import AppKit
import AuthenticationServices
import Combine
import CommonCrypto
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
    case disconnected, invalidCallback, invalidRequest, accessDenied, invalidResponse, presentationUnavailable, rejected(Int), storage(OSStatus)
    case pinRequired, invalidPIN, invalidPINFormat, pinThrottled(Date)
    var errorDescription: String? {
        switch self {
        case .disconnected: "Connectez votre compte MultiVibe Cloud."
        case .invalidCallback: "Le retour de connexion MultiVibe est invalide ou expiré."
        case .invalidRequest: "MultiVibe Cloud a refusé la demande de connexion."
        case .accessDenied: "MultiVibe Cloud a refusé les autorisations demandées."
        case .invalidResponse: "La réponse de MultiVibe Cloud est invalide."
        case .presentationUnavailable: "La fenêtre de connexion n’a pas pu être ouverte."
        case .rejected(let status): "MultiVibe Cloud a refusé la connexion (HTTP \(status))."
        case .storage: "Le Trousseau n’a pas pu enregistrer la session MultiVibe."
        case .pinRequired: "Saisissez le PIN de ce compte."
        case .invalidPIN: "Ce PIN est incorrect."
        case .invalidPINFormat: "Le PIN doit contenir exactement quatre chiffres de 0 à 9."
        case .pinThrottled: "Trop de tentatives. Patientez trente secondes avant de réessayer."
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

/// Only non-sensitive profile metadata is exposed to the account picker.
struct NativeCloudProfile: Identifiable, Equatable, Sendable {
    let id: String
    let displayName: String
    let hasPIN: Bool
}

struct NativeCloudPIN: Codable, Equatable, Sendable {
    var salt: Data
    var verifier: Data
    var rounds: UInt32 = 120_000

    static func isValid(_ value: String) -> Bool {
        value.utf8.count == 4 && value.utf8.allSatisfy { (48...57).contains($0) }
    }
    /// PBKDF2 runs outside MainActor. No PIN or derived verifier leaves the device.
    nonisolated static func derive(_ value: String, salt: Data, rounds: UInt32) throws -> Data {
        guard isValid(value), salt.count == 32, (120_000...1_000_000).contains(rounds) else { throw NativeCloudSessionError.invalidPINFormat }
        var result = Data(count: 32)
        let status = value.utf8CString.withUnsafeBufferPointer { password in
            salt.withUnsafeBytes { saltBytes in
                result.withUnsafeMutableBytes { output in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), password.baseAddress, value.utf8.count,
                        saltBytes.bindMemory(to: UInt8.self).baseAddress, salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), rounds,
                        output.bindMemory(to: UInt8.self).baseAddress, 32)
                }
            }
        }
        guard status == kCCSuccess else { throw NativeCloudSessionError.invalidResponse }
        return result
    }
    nonisolated func matches(_ value: String) throws -> Bool {
        let candidate = try Self.derive(value, salt: salt, rounds: rounds)
        // Fixed-length comparison avoids data-dependent exits.
        return zip(candidate, verifier).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0 && verifier.count == 32
    }
}

struct NativeCloudStoredAccount: Codable, Equatable, Sendable {
    var credential: NativeCloudCredential
    var displayName: String
    var pin: NativeCloudPIN?
    var failedPINAttempts = 0
    var pinRetryAfter: Date?
    /// Replaced on OAuth reauthorization, preserved across token rotation and metadata edits.
    var revision = UUID()
}

struct NativeCloudAccountRegistry: Codable, Equatable, Sendable {
    var version = 1
    var accounts: [NativeCloudStoredAccount] = []
    var selectedAccountID: String?
    var asksEveryTime = false
}

@MainActor struct NativeCloudAccountStorage {
    var load: () throws -> NativeCloudAccountRegistry?
    var save: (NativeCloudAccountRegistry) throws -> Void
    static var keychain: Self {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "cloud.multivibe.host.account-registry.v1", kSecAttrAccount as String: "multivibe-macos"]
        return Self(load: {
            var request = query; request[kSecReturnData as String] = true
            var result: CFTypeRef?
            let status = SecItemCopyMatching(request as CFDictionary, &result)
            if status == errSecItemNotFound { return nil }
            guard status == errSecSuccess, let data = result as? Data else { throw NativeCloudSessionError.storage(status) }
            return try JSONDecoder().decode(NativeCloudAccountRegistry.self, from: data)
        }, save: { registry in
            let data = try JSONEncoder().encode(registry)
            let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            if status == errSecItemNotFound {
                var request = query; request[kSecValueData as String] = data
                request[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
                let added = SecItemAdd(request as CFDictionary, nil)
                guard added == errSecSuccess else { throw NativeCloudSessionError.storage(added) }
            } else if status != errSecSuccess { throw NativeCloudSessionError.storage(status) }
        })
    }
    /// Compatibility for test/preview callers that inject the old single-session storage.
    /// The registry is entirely in memory; it cannot accidentally access the user's Trousseau.
    static func isolated(legacy: NativeCloudSessionStorage) -> Self {
        var saved: NativeCloudAccountRegistry?
        return Self(load: { saved }, save: { value in
            if let selected = value.accounts.first(where: { $0.credential.accountID == value.selectedAccountID }) {
                try legacy.save(selected.credential)
            } else { try legacy.clear() }
            saved = value
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
    @Published private(set) var profiles: [NativeCloudProfile] = []
    @Published private(set) var selectedAccountID: String?
    @Published private(set) var asksEveryTime = false
    let usesIsolatedStorage: Bool
    private let accountStorage: NativeCloudAccountStorage
    private let now: @MainActor () -> Date
    private var registry: NativeCloudAccountRegistry
    private let transport: @MainActor (URLRequest) async throws -> (Data, URLResponse)
    private var credential: NativeCloudCredential?
    private var generation = UUID()
    private struct Refresh {
        let id: UUID
        let revision: UUID
        let task: Task<NativeCloudCredential, Error>
    }
    private var refreshes: [String: Refresh] = [:]
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
    init(storage suppliedStorage: NativeCloudSessionStorage? = nil,
         transport: (@MainActor (URLRequest) async throws -> (Data, URLResponse))? = nil,
         accountStorage suppliedAccountStorage: NativeCloudAccountStorage? = nil,
         now: @escaping @MainActor () -> Date = { Date() }) throws {
        let legacy = suppliedStorage ?? (suppliedAccountStorage == nil ? .keychain :
            NativeCloudSessionStorage(load: { nil }, save: { _ in }, clear: {}))
        let accountStorage = suppliedAccountStorage ?? (suppliedStorage == nil ? .keychain : .isolated(legacy: legacy))
        self.accountStorage = accountStorage
        self.usesIsolatedStorage = suppliedStorage != nil || suppliedAccountStorage != nil
        self.now = now
        var loaded = try accountStorage.load()
        if loaded == nil, let previous = try legacy.load() {
            var migrated = NativeCloudAccountRegistry()
            migrated.accounts = [.init(credential: previous, displayName: "Compte \(previous.accountID.prefix(8))")]
            migrated.selectedAccountID = previous.accountID
            // Never clear the legacy item before a durable replacement exists.
            try Self.validate(migrated)
            try accountStorage.save(migrated)
            if suppliedStorage == nil || suppliedAccountStorage != nil { try legacy.clear() }
            loaded = migrated
        }
        let resolved = loaded ?? NativeCloudAccountRegistry()
        try Self.validate(resolved)
        self.registry = resolved
        if let transport { self.transport = transport }
        else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil; configuration.urlCache = nil
            configuration.timeoutIntervalForRequest = 30; configuration.timeoutIntervalForResource = 60
            let session = URLSession(configuration: configuration, delegate: NativeCloudNoRedirect(), delegateQueue: nil)
            self.transport = { request in try await session.data(for: request) }
        }
        // PIN-protected accounts and Ask everytime always start behind the identity screen.
        if !resolved.asksEveryTime,
           let account = resolved.accounts.first(where: { $0.credential.accountID == resolved.selectedAccountID }), account.pin == nil {
            credential = account.credential
        }
        super.init()
        publishRegistry()
    }
    private static func validate(_ registry: NativeCloudAccountRegistry) throws {
        guard registry.version == 1, registry.accounts.count <= 32,
              Set(registry.accounts.map { $0.credential.accountID }).count == registry.accounts.count,
              registry.selectedAccountID == nil || registry.accounts.contains(where: { $0.credential.accountID == registry.selectedAccountID }) else { throw NativeCloudSessionError.invalidResponse }
        for account in registry.accounts {
            let value = account.credential
            guard !value.accountID.isEmpty, value.accountID.utf8.count <= 256,
                  !value.accessToken.isEmpty, !value.refreshToken.isEmpty,
                  value.accessToken.utf8.count <= 16_384, value.refreshToken.utf8.count <= 16_384,
                  !account.displayName.isEmpty, account.displayName.count <= 80,
                  account.failedPINAttempts >= 0, account.failedPINAttempts <= 5 else { throw NativeCloudSessionError.invalidResponse }
            if let pin = account.pin {
                guard pin.salt.count == 32, pin.verifier.count == 32, (120_000...1_000_000).contains(pin.rounds) else { throw NativeCloudSessionError.invalidResponse }
            }
        }
    }
    private func publishRegistry() {
        profiles = registry.accounts.map { .init(id: $0.credential.accountID, displayName: $0.displayName, hasPIN: $0.pin != nil) }
        selectedAccountID = registry.selectedAccountID
        asksEveryTime = registry.asksEveryTime
    }
    private func persist(_ value: NativeCloudAccountRegistry) throws {
        try Self.validate(value)
        try accountStorage.save(value)
        registry = value
        publishRegistry()
    }
    var needsIdentity: Bool { !profiles.isEmpty && credential == nil }
    func setAsksEveryTime(_ value: Bool) throws {
        var next = registry; next.asksEveryTime = value; try persist(next)
    }
    func renameAccount(_ id: String, name: String) throws {
        guard accountID == id, credential?.accountID == id,
              let index = registry.accounts.firstIndex(where: { $0.credential.accountID == id }) else { throw NativeCloudSessionError.disconnected }
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 80, !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw NativeCloudSessionError.invalidRequest }
        var next = registry; next.accounts[index].displayName = name; try persist(next)
    }
    /// A lock invalidates every in-flight UI operation but keeps stored accounts and token rotation.
    func lock() {
        generation = UUID(); authentication?.cancel(); authentication = nil; pending = nil; isSigningIn = false
        finishBrowser(.failure(CancellationError()))
        window = nil; credential = nil; accountID = nil
    }
    private func checkedAccount(_ id: String, epoch: UUID, revision: UUID) throws -> NativeCloudStoredAccount {
        guard generation == epoch, let account = registry.accounts.first(where: { $0.credential.accountID == id }), account.revision == revision else { throw NativeCloudSessionError.disconnected }
        return account
    }
    private func checkPIN(_ value: String?, account: NativeCloudStoredAccount, epoch: UUID) async throws {
        guard let pin = account.pin else { return }
        guard let value else { throw NativeCloudSessionError.pinRequired }
        guard NativeCloudPIN.isValid(value) else { throw NativeCloudSessionError.invalidPINFormat }
        if let until = account.pinRetryAfter, until > now() { throw NativeCloudSessionError.pinThrottled(until) }
        let matches = try await Task.detached(priority: .userInitiated) { try pin.matches(value) }.value
        let current = try checkedAccount(account.credential.accountID, epoch: epoch, revision: account.revision)
        guard current.pin == pin else { throw NativeCloudSessionError.disconnected }
        if let until = current.pinRetryAfter, until > now() { throw NativeCloudSessionError.pinThrottled(until) }
        var next = registry
        guard let index = next.accounts.firstIndex(where: { $0.credential.accountID == account.credential.accountID }) else { throw NativeCloudSessionError.disconnected }
        if matches {
            next.accounts[index].failedPINAttempts = 0; next.accounts[index].pinRetryAfter = nil
            try persist(next)
        } else {
            let count = (current.pinRetryAfter.map { $0 <= now() } == true ? 0 : current.failedPINAttempts) + 1
            next.accounts[index].failedPINAttempts = min(count, 5)
            if count >= 5 { next.accounts[index].pinRetryAfter = now().addingTimeInterval(30) }
            try persist(next)
            if let until = next.accounts[index].pinRetryAfter { throw NativeCloudSessionError.pinThrottled(until) }
            throw NativeCloudSessionError.invalidPIN
        }
    }
    func selectAccount(_ id: String, pin: String? = nil) async throws {
        guard let account = registry.accounts.first(where: { $0.credential.accountID == id }) else { throw NativeCloudSessionError.disconnected }
        lock()
        let epoch = generation
        do {
            try await checkPIN(pin, account: account, epoch: epoch)
            _ = try checkedAccount(id, epoch: epoch, revision: account.revision)
            let value = try await validatedCredential(accountID: id, epoch: epoch)
            _ = try checkedAccount(id, epoch: epoch, revision: account.revision)
            try Task.checkCancellation()
            var next = registry; next.selectedAccountID = id; try persist(next)
            credential = value; accountID = id
        } catch {
            if generation == epoch { credential = nil; accountID = nil }
            throw error
        }
    }
    func setPIN(_ value: String?, for id: String, currentPIN: String? = nil) async throws {
        guard accountID == id, credential?.accountID == id,
              let account = registry.accounts.first(where: { $0.credential.accountID == id }) else { throw NativeCloudSessionError.disconnected }
        if let value, !NativeCloudPIN.isValid(value) { throw NativeCloudSessionError.invalidPINFormat }
        let epoch = generation
        try await checkPIN(currentPIN, account: account, epoch: epoch)
        let pin: NativeCloudPIN?
        if let value {
            var bytes = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw NativeCloudSessionError.invalidResponse }
            let salt = Data(bytes)
            let verifier = try await Task.detached(priority: .userInitiated) { try NativeCloudPIN.derive(value, salt: salt, rounds: 120_000) }.value
            pin = .init(salt: salt, verifier: verifier)
        } else { pin = nil }
        let current = try checkedAccount(id, epoch: epoch, revision: account.revision)
        guard accountID == id, current.pin == account.pin else { throw NativeCloudSessionError.disconnected }
        try Task.checkCancellation()
        var next = registry
        let index = next.accounts.firstIndex(where: { $0.credential.accountID == id })!
        next.accounts[index].pin = pin; next.accounts[index].failedPINAttempts = 0; next.accounts[index].pinRetryAfter = nil
        try persist(next)
    }
    func removeAccount(_ id: String) async throws {
        guard let account = registry.accounts.first(where: { $0.credential.accountID == id }) else { throw NativeCloudSessionError.disconnected }
        if selectedAccountID == id || credential?.accountID == id { lock() }
        var next = registry; next.accounts.removeAll { $0.credential.accountID == id }
        if next.selectedAccountID == id { next.selectedAccountID = nil }
        // Removal is durable before the first suspension. A late refresh cannot recreate it.
        try persist(next)
        try await revoke(account.credential.refreshToken)
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
        lock()
        let state = try Self.randomToken(), verifier = try Self.randomToken()
        var url = URLComponents(string: "https://auth.multivibe.cloud/oauth/authorize")!
        url.queryItems = [URLQueryItem(name: "client_id", value: Self.clientID), URLQueryItem(name: "redirect_uri", value: Self.redirectURI),
            URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "scope", value: "openid profile projects:read provider:read provider:write"),
            URLQueryItem(name: "state", value: state), URLQueryItem(name: "code_challenge", value: Self.encode(Data(SHA256.hash(data: Data(verifier.utf8))))),
            URLQueryItem(name: "code_challenge_method", value: "S256")]
        let value = Authorization(generation: generation, state: state, verifier: verifier, started: now(), url: url.url!)
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
        guard items.count == 2, items.filter({ $0.name == "state" }).count == 1,
              items.first(where: { $0.name == "state" })?.value == expectedState else { throw NativeCloudSessionError.invalidCallback }
        if items.filter({ $0.name == "error" }).count == 1,
           let error = items.first(where: { $0.name == "error" })?.value {
            if error == "access_denied" { throw NativeCloudSessionError.accessDenied }
            if error == "invalid_request" { throw NativeCloudSessionError.invalidRequest }
            throw NativeCloudSessionError.invalidCallback
        }
        guard items.filter({ $0.name == "code" }).count == 1,
              let code = items.first(where: { $0.name == "code" })?.value,
              !code.isEmpty, code.utf8.count <= 4096 else { throw NativeCloudSessionError.invalidCallback }
        return code
    }
    func completeAuthorization(_ callback: URL, authorization: Authorization) async throws {
        guard generation == authorization.generation, pending?.generation == authorization.generation,
              now().timeIntervalSince(authorization.started) >= 0, now().timeIntervalSince(authorization.started) < 600 else { throw NativeCloudSessionError.invalidCallback }
        let code = try Self.authorizationCode(callback, expectedState: authorization.state)
        pending = nil
        defer { if generation == authorization.generation { isSigningIn = false } }
        let issued = try await exchange(["grant_type": "authorization_code", "code": code, "code_verifier": authorization.verifier, "redirect_uri": Self.redirectURI])
        do {
            let identity = try await verifiedIdentity(issued.accessToken)
            guard generation == authorization.generation else { throw NativeCloudSessionError.disconnected }
            try Task.checkCancellation()
            var value = issued; value.accountID = identity.accountId
            var next = registry
            let previous = next.accounts.first { $0.credential.accountID == identity.accountId }
            let suppliedName = (identity.displayName ?? identity.name ?? identity.email ?? "")
                .components(separatedBy: .controlCharacters).joined().trimmingCharacters(in: .whitespacesAndNewlines)
            let displayName = suppliedName.isEmpty ? "Compte \(identity.accountId.prefix(8))" : String(suppliedName.prefix(80))
            var stored = previous ?? NativeCloudStoredAccount(credential: value, displayName: displayName)
            stored.credential = value; stored.revision = UUID()
            if let index = next.accounts.firstIndex(where: { $0.credential.accountID == identity.accountId }) { next.accounts[index] = stored }
            else { next.accounts.append(stored) }
            next.selectedAccountID = identity.accountId
            try persist(next)
            // Reauthentication never bypasses an existing local PIN.
            credential = stored.pin == nil ? value : nil
            accountID = stored.pin == nil ? identity.accountId : nil
            if let previous, previous.credential.refreshToken != value.refreshToken { Task { try? await revoke(previous.credential.refreshToken) } }
        } catch {
            // Fresh tokens must not survive a failed identity check, removal or cancelled sign-in.
            Task { try? await revoke(issued.refreshToken) }
            throw error
        }
    }
    func token() async throws -> String {
        try Task.checkCancellation()
        guard !isSigningIn, let previous = credential else { throw NativeCloudSessionError.disconnected }
        let epoch = generation
        let value = try await validatedCredential(accountID: previous.accountID, epoch: epoch)
        guard generation == epoch, credential?.accountID == previous.accountID else { throw NativeCloudSessionError.disconnected }
        try Task.checkCancellation()
        credential = value; accountID = value.accountID
        return value.accessToken
    }
    private func validatedCredential(accountID id: String, epoch: UUID) async throws -> NativeCloudCredential {
        guard generation == epoch,
              let account = registry.accounts.first(where: { $0.credential.accountID == id }) else { throw NativeCloudSessionError.disconnected }
        let previous = account.credential
        if previous.expiresAt > now().addingTimeInterval(60) {
            let identity = try await verifiedIdentity(previous.accessToken)
            _ = try checkedAccount(id, epoch: epoch, revision: account.revision)
            guard identity.accountId == id else { throw NativeCloudSessionError.disconnected }
            try Task.checkCancellation()
            return previous
        }
        if let refresh = refreshes[id], refresh.revision == account.revision {
            let value = try await refresh.task.value
            _ = try checkedAccount(id, epoch: epoch, revision: account.revision)
            try Task.checkCancellation()
            return value
        }
        let refreshID = UUID()
        let task = Task { @MainActor () throws -> NativeCloudCredential in
            let issued = try await self.exchange(["grant_type": "refresh_token", "refresh_token": previous.refreshToken])
            do {
                let identity = try await self.verifiedIdentity(issued.accessToken)
                guard identity.accountId == id,
                      let index = self.registry.accounts.firstIndex(where: { $0.credential.accountID == id }),
                      self.registry.accounts[index].revision == account.revision,
                      self.registry.accounts[index].credential.refreshToken == previous.refreshToken else { throw NativeCloudSessionError.disconnected }
                var value = issued; value.accountID = id
                var next = self.registry; next.accounts[index].credential = value
                // Rotation belongs to this account even after a switch/lock. It never publishes an identity.
                try self.persist(next)
                return value
            } catch {
                try? await self.revoke(issued.refreshToken)
                throw error
            }
        }
        refreshes[id] = Refresh(id: refreshID, revision: account.revision, task: task)
        defer { if refreshes[id]?.id == refreshID { refreshes.removeValue(forKey: id) } }
        let value = try await task.value
        _ = try checkedAccount(id, epoch: epoch, revision: account.revision)
        try Task.checkCancellation()
        return value
    }
    func disconnect() async throws {
        if let id = selectedAccountID { try await removeAccount(id) }
        else { lock() }
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
        return .init(accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: now().addingTimeInterval(Double(value.expires_in)), accountID: "")
    }
    private struct Identity: Decodable {
        let accountId: String
        let displayName: String?
        let name: String?
        let email: String?
    }
    private func verifiedIdentity(_ token: String) async throws -> Identity {
        var request = URLRequest(url: URL(string: "https://app.multivibe.cloud/native/v1/auth/session")!)
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        let value = try JSONDecoder().decode(Identity.self, from: await send(request))
        guard !value.accountId.isEmpty, value.accountId.utf8.count <= 256 else { throw NativeCloudSessionError.invalidResponse }
        return value
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
