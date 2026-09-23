import MultiVibeSDK
import Foundation

actor ChatAPI {
    static let shared = ChatAPI()
    private let base = URL(string: "https://app.multivibe.cloud")!
    private let session: URLSession
    private let decoder: JSONDecoder
    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 300
        session = URLSession(configuration: configuration, delegate: NativeTransportDelegate(), delegateQueue: nil)
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            let format = ISO8601DateFormatter()
            format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = format.date(from: raw) { return date }
            format.formatOptions = [.withInternetDateTime]
            guard let date = format.date(from: raw) else { throw APIError.invalidResponse }
            return date
        }
    }
    private func request(_ path: String, body: Data? = nil, token: String? = nil) -> URLRequest {
        var request = URLRequest(url: base.appending(path: "/native/v1/" + path))
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }
    private func validate(_ response: URLResponse, data: Data = Data()) throws {
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let code = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String ?? "request_failed"
            throw APIError.server(http.statusCode, code)
        }
    }
    func history(token: String) async throws -> AccountHistorySnapshot {
        let (data, response) = try await session.data(for: request("history", token: token))
        try validate(response, data: data)
        guard data.count <= 2_097_152 else { throw APIError.invalidResponse }
        let snapshot = try JSONDecoder().decode(AccountHistorySnapshot.self, from: data)
        guard snapshot.revision >= 0, snapshot.conversations.count <= 500,
              (snapshot.folders?.count ?? 0) <= 100 else { throw APIError.invalidResponse }
        return snapshot
    }
    func saveHistory(_ snapshot: AccountHistorySnapshot, token: String) async throws -> AccountHistorySnapshot {
        let body = try JSONEncoder().encode(snapshot)
        guard body.count <= 1_048_576 else { throw APIError.server(413, "history_too_large") }
        let (data, response) = try await session.data(for: request("history", body: body, token: token))
        try validate(response, data: data)
        let saved = try JSONDecoder().decode(AccountHistorySnapshot.self, from: data)
        guard saved.accountId == snapshot.accountId, saved.revision == snapshot.revision + 1,
              snapshot.memory == nil || saved.memory == snapshot.memory else { throw APIError.invalidResponse }
        return saved
    }
    func authenticationConfiguration() async throws -> NativeAuthConfiguration {
        let (data, response) = try await session.data(for: request("auth/config"))
        try validate(response, data: data)
        let configuration = try decoder.decode(NativeAuthConfiguration.self, from: data)
        guard !configuration.signupEnabled || configuration.hasValidDocuments else { throw APIError.invalidResponse }
        return configuration
    }
    func authenticate(mode: String, fields: [String: String]) async throws -> AuthReply {
        let body = try JSONSerialization.data(withJSONObject: fields)
        let (data, response) = try await session.data(for: request("auth/\(mode)", body: body))
        try validate(response, data: data)
        return try decoder.decode(AuthReply.self, from: data)
    }
    func requestPasswordReset(email: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["email": email])
        let (data, response) = try await session.data(for: request("auth/reset", body: body))
        try validate(response, data: data)
        struct Reply: Decodable { let accepted: Bool; let duplicate: Bool }
        guard try decoder.decode(Reply.self, from: data).accepted else { throw APIError.invalidResponse }
    }
    func completePasswordReset(link: String, password: String) async throws {
        guard let token = PasswordResetLink.token(from: link) else { throw APIError.invalidResponse }
        let body = try JSONSerialization.data(withJSONObject: ["token": token, "password": password])
        let (data, response) = try await session.data(for: request("auth/reset/complete", body: body))
        try validate(response, data: data)
        struct Reply: Decodable { let changed: Bool }
        guard try decoder.decode(Reply.self, from: data).changed else { throw APIError.invalidResponse }
    }
    func billingSession(token: String) async throws -> CloudBillingSession {
        let (data, response) = try await session.data(for: request("billing/browser-session", body: Data("{}".utf8), token: token))
        try validate(response, data: data)
        return try decoder.decode(CloudBillingSession.self, from: data)
    }
    func accountProfile(token: String) async throws -> NativeAccountProfile {
        let (data, response) = try await session.data(for: request("account", token: token))
        try validate(response, data: data)
        return try decoder.decode(NativeAccountProfile.self, from: data)
    }
    func creditBalance(token: String) async throws -> CloudCreditBalance {
        let (data, response) = try await session.data(for: request("credits", token: token))
        try validate(response, data: data)
        return try decoder.decode(CloudCreditBalance.self, from: data)
    }
    func providerRequest<T: Decodable & Sendable>(_ path: String, fields: [String: String]? = nil, token: String) async throws -> T {
        let body = try fields.map { try JSONSerialization.data(withJSONObject: $0) }
        let (data, response) = try await session.data(for: request(path, body: body, token: token))
        try validate(response, data: data)
        return try decoder.decode(T.self, from: data)
    }
    func catalog(search: String = "", cursor: String = "", token: String) async throws -> CatalogPage {
        try await providerRequest("catalog", fields: ["search": search, "cursor": cursor], token: token)
    }
    func models(token: String) async throws -> [ModelOption] {
        try await catalog(token: token).data.map(\.option)
    }
    func modelAccess(model: String, token: String) async throws -> ModelAccessReply {
        try await providerRequest("model-access", fields: ["model": model], token: token)
    }
    func saveModelAccess(_ access: SelectedModelAccess, token: String) async throws {
        let _: [String: Bool] = try await providerRequest("model-preference", fields: ["model": access.modelId, "accessId": access.id], token: token)
    }
    func voiceCapabilities(token: String) async throws -> VoiceCapabilities {
        let (data, response) = try await session.data(for: request("voice/capabilities", token: token))
        try validate(response, data: data)
        return try decoder.decode(VoiceCapabilities.self, from: data)
    }
    func createVoiceSession(conversation: Conversation, model: String, voice: String, language: String,
                            token: String) async throws -> VoiceSession {
        let messages = Array(conversation.messages.filter { ["user", "assistant"].contains($0.role) && ($0.completion == nil || $0.completion == .completed) }.suffix(20)).map { ["role": $0.role, "content": $0.content] }
        let body = try JSONSerialization.data(withJSONObject: ["conversationId": conversation.id.uuidString.lowercased(),
            "model": model, "voice": voice, "language": language, "messages": messages])
        let (data, response) = try await session.data(for: request("voice/sessions", body: body, token: token))
        try validate(response, data: data)
        return try decoder.decode(VoiceSession.self, from: data)
    }
    func reconcileVoiceTurn(session: VoiceSession, turnID: String, token: String) async throws -> Bool {
        let body = try JSONSerialization.data(withJSONObject: ["turnId": turnID])
        var request = request("voice/sessions/\(session.id)/turns", body: body, token: token)
        request.setValue(session.sessionToken, forHTTPHeaderField: "X-MultiVibe-Voice-Token")
        let (data, response) = try await self.session.data(for: request)
        try validate(response, data: data)
        struct Reply: Decodable { let accepted: Bool; let duplicate: Bool }
        let reply = try decoder.decode(Reply.self, from: data)
        return reply.accepted || reply.duplicate
    }
    func closeVoiceSession(_ voice: VoiceSession, token: String) async {
        var request = request("voice/sessions/\(voice.id)/close", body: Data("{}".utf8), token: token)
        request.setValue(voice.sessionToken, forHTTPHeaderField: "X-MultiVibe-Voice-Token")
        _ = try? await session.data(for: request)
    }
    func refresh(_ previous: NativeSession) async throws -> NativeSession {
        var request = URLRequest(url: URL(string: "https://auth.multivibe.cloud/oauth/token")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = [URLQueryItem(name: "client_id", value: "multivibe-ios"),
            URLQueryItem(name: "grant_type", value: "refresh_token"),
            URLQueryItem(name: "refresh_token", value: previous.refreshToken)]
        request.httpBody = form.percentEncodedQuery?.data(using: .utf8)
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        struct Reply: Decodable {
            let access_token: String
            let refresh_token: String
            let expires_in: Int
        }
        let reply = try decoder.decode(Reply.self, from: data)
        guard !reply.access_token.isEmpty, !reply.refresh_token.isEmpty, reply.expires_in > 0 else {
            throw APIError.invalidResponse
        }
        return NativeSession(accessToken: reply.access_token, refreshToken: reply.refresh_token,
            expiresAt: Date().addingTimeInterval(TimeInterval(reply.expires_in)), accountId: previous.accountId)
    }
    func revoke(token: String) async throws {
        var request = URLRequest(url: URL(string: "https://auth.multivibe.cloud/oauth/revoke")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = [URLQueryItem(name: "client_id", value: "multivibe-ios"), URLQueryItem(name: "token", value: token), URLQueryItem(name: "token_type_hint", value: "refresh_token")]
        request.httpBody = form.percentEncodedQuery?.data(using: .utf8)
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
    }
    func stream(model: String, access: SelectedModelAccess? = nil, messages: [ChatMessage], token: String,
                onDelta: @Sendable (String) async -> Void) async throws {
        guard let access, access.modelId == model else { throw APIError.server(409, "model_access_unavailable") }
        let body = try JSONSerialization.data(withJSONObject: ["model": model, "accessId": access.id, "stream": true,
            "messages": messages.map { ["role": $0.role, "content": $0.content] }] as [String: Any])
        let (bytes, response) = try await session.bytes(for: request("access-completions", body: body, token: token))
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            var data = Data()
            for try await byte in bytes { data.append(byte); if data.count >= 8192 { break } }
            try validate(response, data: data)
        }
        guard (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "content-type")?.hasPrefix("text/event-stream") == true else {
            throw APIError.invalidResponse
        }
        var parser = SSEByteParser()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard let event = try parser.consume(byte) else { continue }
            if event == "[DONE]" { return }
            guard let delta = try? decoder.decode(CompletionDelta.self, from: Data(event.utf8)) else {
                throw APIError.invalidResponse
            }
            if let content = delta.choices.first?.delta.content { await onDelta(content) }
        }
        throw APIError.invalidResponse // Do not silently accept a truncated stream.
    }
}

/// OAuth transport remains on fixed first-party hosts; account identity is
/// resolved by the backend rather than trusting a locally decoded ID token.
extension ChatAPI {
    func exchangeAuthorizationCode(_ code: String, verifier: String) async throws -> NativeSession {
        var request = URLRequest(url: URL(string: "https://auth.multivibe.cloud/oauth/token")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = [URLQueryItem(name: "client_id", value: "multivibe-ios"),
            URLQueryItem(name: "grant_type", value: "authorization_code"),
            URLQueryItem(name: "redirect_uri", value: "https://auth.multivibe.cloud/oauth/callback/ios"),
            URLQueryItem(name: "code", value: code), URLQueryItem(name: "code_verifier", value: verifier)]
        request.httpBody = form.percentEncodedQuery?.data(using: .utf8)
        let (data, response) = try await session.data(for: request)
        try validate(response, data: data)
        struct Tokens: Decodable { let access_token: String; let refresh_token: String; let expires_in: Int }
        let tokens = try decoder.decode(Tokens.self, from: data)
        guard !tokens.access_token.isEmpty, !tokens.refresh_token.isEmpty, tokens.expires_in > 0 else { throw APIError.invalidResponse }
        do {
            let (accountData, accountResponse) = try await session.data(for: self.request("auth/session", token: tokens.access_token))
            try validate(accountResponse, data: accountData)
            struct Account: Decodable { let accountId: String }
            let account = try decoder.decode(Account.self, from: accountData)
            guard !account.accountId.isEmpty else { throw APIError.invalidResponse }
            return NativeSession(accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
                expiresAt: Date().addingTimeInterval(TimeInterval(tokens.expires_in)), accountId: account.accountId)
        } catch {
            try? await revoke(token: tokens.refresh_token)
            throw error
        }
    }
}

/// API routes are exact endpoints, not navigation. Never forward passwords,
/// refresh tokens, authorization codes or chat bodies through an HTTP redirect.
final class NativeTransportDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct NativeAuthConfiguration: Decodable {
    var nativeProviderSelection: Bool? = nil
    var nativeAppleProviderSelection: Bool? = nil
    let signupEnabled: Bool
    let termsVersion: String?
    let termsUrl: URL?
    let privacyUrl: URL?
    /// Missing capabilities mean an older server: use its existing provider chooser.
    /// Explicit false remains authoritative and must not be bypassed.
    func providerCapability(_ provider: String) -> Bool? {
        provider == "apple" ? nativeAppleProviderSelection : nativeProviderSelection
    }
    func canStartSSO(provider: String, acceptedTerms: Bool) -> Bool {
        guard ["google", "github", "apple"].contains(provider),
              providerCapability(provider) != false else { return false }
        return !signupEnabled || (hasValidDocuments && acceptedTerms)
    }
    func directSSOProvider(_ provider: String) -> String? {
        providerCapability(provider) == true ? provider : nil
    }
    var usesLegacyProviderChooser: Bool {
        nativeProviderSelection == nil || nativeAppleProviderSelection == nil
    }
    var hasValidDocuments: Bool {
        guard let termsVersion, !termsVersion.isEmpty, let termsUrl, let privacyUrl else { return false }
        return Self.isSecureDocument(termsUrl) && Self.isSecureDocument(privacyUrl)
    }
    private static func isSecureDocument(_ url: URL) -> Bool {
        guard url.scheme == "https", url.host != nil else { return false }
        return url.user == nil && url.password == nil
    }
}
