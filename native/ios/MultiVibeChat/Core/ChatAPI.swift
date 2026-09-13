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
        struct Reply: Decodable { let accepted: Bool }
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
    func models(token: String) async throws -> [ModelOption] {
        let (data, response) = try await session.data(for: request("models", token: token))
        try validate(response, data: data)
        return try decoder.decode(ModelList.self, from: data).data
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
    func stream(model: String, messages: [ChatMessage], token: String,
                onDelta: @Sendable (String) async -> Void) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["model": model, "stream": true,
            "messages": messages.map { ["role": $0.role, "content": $0.content] }] as [String: Any])
        let (bytes, response) = try await session.bytes(for: request("completions", body: body, token: token))
        try validate(response)
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
    let signupEnabled: Bool
    let termsVersion: String?
    let termsUrl: URL?
    let privacyUrl: URL?
    var hasValidDocuments: Bool {
        guard let termsVersion, !termsVersion.isEmpty, let termsUrl, let privacyUrl else { return false }
        return Self.isSecureDocument(termsUrl) && Self.isSecureDocument(privacyUrl)
    }
    private static func isSecureDocument(_ url: URL) -> Bool {
        guard url.scheme == "https", url.host != nil else { return false }
        return url.user == nil && url.password == nil
    }
}
