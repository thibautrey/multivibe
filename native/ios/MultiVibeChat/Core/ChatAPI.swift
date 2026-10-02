import CryptoKit
import MultiVibeSDK
import Foundation

actor ChatAPI {
    static let shared = ChatAPI()
    private let base = URL(string: "https://app.multivibe.cloud")!
    private let session: URLSession
    private let decoder: JSONDecoder
    init(session suppliedSession: URLSession? = nil) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 300
        session = suppliedSession ?? URLSession(configuration: configuration, delegate: NativeTransportDelegate(), delegateQueue: nil)
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
    func hermesRequest<T: Decodable & Sendable>(_ path: String, body: Data? = nil, token: String) async throws -> T {
        try Task.checkCancellation()
        guard path.rangeOfCharacter(from:.whitespacesAndNewlines) == nil else { throw APIError.invalidResponse }
        guard path == "capabilities" || path == "consent" || path == "mutations" || path == "runs"
            || path.range(of:"^changes\\?after=(0|[1-9][0-9]{0,15})$",options:.regularExpression) != nil
            || path.range(of: "^artifacts(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(/(complete|chunks/(0|[1-9][0-9]{0,2})))?)?$", options: .regularExpression) != nil
            || path.range(of: "^runs/[0-9a-f-]{36}(/cancel)?$", options: .regularExpression) != nil else { throw APIError.invalidResponse }
        var components = URLComponents(url:base,resolvingAgainstBaseURL:false)!
        let parts = path.split(separator:"?",maxSplits:1)
        components.path = "/native/v2/agent/" + String(parts[0])
        if parts.count == 2 { components.percentEncodedQuery = String(parts[1]) }
        guard let url = components.url else { throw APIError.invalidResponse }
        var request = URLRequest(url:url)
        request.httpMethod = body == nil ? "GET" : "POST"; request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard (body?.count ?? 0) <= 1_048_576 else { throw APIError.invalidResponse }
        let (data,response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard data.count <= 2_097_152, let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let code = (object?["error"] as? [String: Any])?["code"] as? String ?? "hermes_request_failed"
            throw APIError.server(http.statusCode, code)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func hermesArtifactBegin(accountId: String, artifact: CloudArtifactIdentity, token: String) async throws -> CloudArtifactManifest {
        try artifact.validate()
        struct Body: Encodable { let accountId: String; let artifact: CloudArtifactIdentity }
        let reply: CloudArtifactReply = try await hermesRequest("artifacts", body: JSONEncoder().encode(Body(accountId: accountId, artifact: artifact)), token: token)
        return try reply.checked(accountId: accountId, expected: artifact)
    }
    func hermesArtifactRead(accountId: String, artifact: CloudArtifactIdentity, token: String) async throws -> CloudArtifactManifest {
        try artifact.validate()
        let reply: CloudArtifactReply = try await hermesRequest("artifacts/" + artifact.artifactId, token: token)
        return try reply.checked(accountId: accountId, expected: artifact)
    }
    func hermesArtifactComplete(accountId: String, artifact: CloudArtifactIdentity, token: String) async throws -> CloudArtifactManifest {
        try artifact.validate()
        let reply: CloudArtifactReply = try await hermesRequest("artifacts/" + artifact.artifactId + "/complete", body: JSONEncoder().encode(["accountId": accountId]), token: token)
        let result = try reply.checked(accountId: accountId, expected: artifact)
        guard result.state == "complete" else { throw APIError.invalidResponse }
        return result
    }
    func hermesArtifactPutChunk(accountId: String, artifact: CloudArtifactIdentity, index: Int, data: Data, token: String) async throws -> CloudArtifactManifest {
        try artifact.validate()
        guard data.count == (try artifact.chunkLength(index)) else { throw APIError.invalidResponse }
        let reply: CloudArtifactReply = try await hermesRequest("artifacts/" + artifact.artifactId + "/chunks/" + String(index),
            body: JSONEncoder().encode(["accountId": accountId, "data": data.base64EncodedString()]), token: token)
        let result = try reply.checked(accountId: accountId, expected: artifact)
        guard result.received.contains(index) else { throw APIError.invalidResponse }
        return result
    }
    func hermesArtifactReadChunk(accountId: String, artifact: CloudArtifactIdentity, index: Int, token: String) async throws -> Data {
        try artifact.validate()
        _ = try artifact.chunkLength(index)
        let reply: CloudArtifactChunkReply = try await hermesRequest("artifacts/" + artifact.artifactId + "/chunks/" + String(index), token: token)
        return try reply.checked(accountId: accountId, expected: artifact, index: index)
    }
    func hermesChanges(after:Int64,token:String) async throws -> CloudAgentPage {
        guard after >= 0, after < 9_007_199_254_740_991 else { throw APIError.invalidResponse }
        return try await hermesRequest("changes?after=\(after)",token:token)
    }
    func hermesMutations(accountId:String,operations:[CloudAgentMutation],token:String) async throws -> CloudAgentReceipts {
        guard !operations.isEmpty, operations.count <= 100 else { throw APIError.invalidResponse }
        for operation in operations { try CloudAgentState.validate(operation) }
        struct Body:Encodable { let accountId:String;let operations:[CloudAgentMutation] }
        return try await hermesRequest("mutations",body:JSONEncoder().encode(Body(accountId:accountId,operations:operations)),token:token)
    }
    func hermesConsent(token: String) async throws -> CloudHermesConsent { try await hermesRequest("consent", token: token) }
    func hermesSetConsent(accountId: String, revision: Int, enabled: Bool, token: String, exportSources: [String] = []) async throws -> CloudHermesConsent {
        let body = try JSONSerialization.data(withJSONObject: ["accountId":accountId,"revision":revision,"cloudEnabled":enabled,"exportSources":exportSources] as [String:Any])
        return try await hermesRequest("consent", body: body, token: token)
    }
    func hermesPrepare(accountId: String, binding: CloudHermesBinding, token: String) async throws {
        struct Capabilities: Decodable, Sendable { let runtime: Bool }
        let capabilities: Capabilities = try await hermesRequest("capabilities", token: token)
        guard capabilities.runtime else { throw APIError.server(503,"agent_runtime_unavailable") }
        let consent = try await hermesConsent(token: token)
        guard consent.accountId == accountId, consent.cloudEnabled else { throw APIError.server(403,"agent_cloud_consent_required") }
        let mutation: [String:Any] = ["operationId":binding.operationId,"objectId":binding.sessionId,"versionId":binding.versionId,
            "deviceId":binding.deviceId,"kind":"session","parents":[],"deleted":false,
            "value":["type":"hermes_chat","conversationId":binding.conversationId,"branchId":binding.branchId,"title":"Hermes chat"]]
        struct Receipt: Decodable, Sendable { let accountId: String }
        let receipt: Receipt = try await hermesRequest("mutations", body: JSONSerialization.data(withJSONObject:["accountId":accountId,"operations":[mutation]]), token: token)
        guard receipt.accountId == accountId else { throw APIError.invalidResponse }
    }
    func hermesRun(accountId: String, run: CloudHermesRunInput, token: String) async throws -> CloudHermesRun {
        struct Body: Encodable { let accountId: String; let run: CloudHermesRunInput }
        let reply: CloudHermesRunReply = try await hermesRequest("runs", body: JSONEncoder().encode(Body(accountId:accountId,run:run)), token: token)
        return try reply.checked(accountId: accountId, runId: run.runId)
    }
    func hermesRead(accountId: String, runId: String, token: String, cancel: Bool = false) async throws -> CloudHermesRun {
        let body = cancel ? try JSONSerialization.data(withJSONObject:["accountId":accountId]) : nil
        let reply: CloudHermesRunReply = try await hermesRequest("runs/" + runId + (cancel ? "/cancel" : ""), body: body, token: token)
        return try reply.checked(accountId: accountId, runId: runId)
    }
    func automationCompletion(model: String, access: SelectedModelAccess?, messages: String, tools: String, token: String) async throws -> String {
        guard let access, access.modelId == model else { throw APIError.server(409, "model_access_unavailable") }
        let body = try JSONSerialization.data(withJSONObject: ["model": model, "accessId": access.id, "stream": false, "max_tokens": 1024,
            "messages": JSONSerialization.jsonObject(with: Data(messages.utf8)), "tools": JSONSerialization.jsonObject(with: Data(tools.utf8))])
        let (data, response) = try await session.data(for: request("access-completions", body: body, token: token))
        try validate(response, data: data)
        guard data.count <= 128_000, let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = value["choices"] as? [[String: Any]], let message = choices.first?["message"] as? [String: Any] else { throw APIError.invalidResponse }
        return String(decoding: try JSONSerialization.data(withJSONObject: message), as: UTF8.self)
    }
    func automations(_ body: Data, token: String) async throws -> Data {
        let (data, response) = try await session.data(for: request("automations", body: body, token: token))
        try validate(response, data: data)
        guard data.count <= 2_000_000 else { throw APIError.invalidResponse }; return data
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
        guard conversation.modelAccess?.method == "cloud", conversation.modelAccess?.modelId == model else {
            throw APIError.server(409, "voice_requires_explicit_cloud_access")
        }
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

struct CloudHermesConsent: Codable, Sendable { let accountId: String; let cloudEnabled: Bool; let revision: Int; var exportSources: [String]? = nil }
struct CloudHermesModel: Codable, Equatable, Sendable {
    let id: String; let source: String; let accessId: String?
    static func selected(_ model: String, access: SelectedModelAccess?) throws -> Self {
        if model.hasPrefix("relay/") { return .init(id:model,source:"relay",accessId:nil) }
        guard let access, access.modelId == model else { throw APIError.server(409,"model_access_unavailable") }
        if access.method == "cloud" { return .init(id:model.hasPrefix("multivibe/cloud/") ? model : "multivibe/cloud/" + model,source:"cloud",accessId:nil) }
        guard UUID(uuidString:access.id) != nil else { throw APIError.invalidResponse }
        return .init(id:model,source:"relay",accessId:access.id.lowercased())
    }
}
struct CloudHermesRunInput: Codable, Equatable, Sendable {
    let operationId: String; let runId: String; let sessionId: String; let branchId: String
    let model: CloudHermesModel; let message: String; let history: [HistoryJSON]
    var workspaceProjectId: String? = nil
    var projectId: String? = nil
}
struct CloudHermesRun: Codable, Sendable {
    struct Result: Codable, Sendable { let response: String; let history: [HistoryJSON] }
    let runId: String; let sessionId: String; let branchId: String; let state: String; let generation: Int; let result: Result?
}
struct CloudHermesRunReply: Decodable, Sendable {
    let accountId: String; let run: CloudHermesRun
    func checked(accountId expected: String, runId: String) throws -> CloudHermesRun {
        guard accountId == expected, run.runId == runId, UUID(uuidString:run.sessionId) != nil, UUID(uuidString:run.branchId) != nil,
            run.generation >= 0, ["queued","running","waiting_device","awaiting_resolution","completed","cancelled"].contains(run.state) else { throw APIError.invalidResponse }
        return run
    }
}
struct CloudHermesBinding: Codable, Sendable {
    let accountId: String; let conversationId: String; let sessionId: String; let branchId: String
    let operationId: String; let versionId: String; let deviceId: String
    var cloudAuthorized: Bool? = nil
    var localExportSources: [String]? = nil
    var contextMemoryIDs: [String]? = nil
    var contextSkillIDs: [String]? = nil
    var contextFileIDs: [String]? = nil
    var contextProjectID: String? = nil
    var localTurns: [CloudHermesLocalTurn]? = nil
    var importApproved: Bool; var history: [HistoryJSON] = []; var pending: CloudHermesRunInput?; var turnId: UUID?
}

/// A local inference intent is journaled before inference, including when export is not authorized.
struct CloudHermesLocalTurn: Codable, Sendable {
    let turnId: UUID
    let modelId: String
    let source: String
    let parents: [String]
    let operationId: String
    let versionId: String
    let sessionOperationId: String
    let sessionVersionId: String
    var published = false
    var parentValue: HistoryJSON? = nil
}
extension CloudHermesBinding {
    static let mobileEngine = "hermes-mobile/6d49922875f60af5bc31e2bfbae78a81d2fa91fc"
    static let localSources = ["downloaded-local", "apple-foundation-local"]
    func permitsLocalOperation(_ operation: CloudAgentMutation) -> Bool {
        guard cloudAuthorized != false, let source=operation.value?.object?["localSource"]?.string,
            (localExportSources ?? []).contains(source) else { return false }
        return operation.objectId == sessionId || operation.value?.object?["sessionId"]?.string == sessionId
    }
    mutating func recordLocalIntent(turnId: UUID, modelId: String, source: String, parents: [String], parentValue: HistoryJSON? = nil) {
        guard !(localTurns ?? []).contains(where: { $0.turnId == turnId }) else { return }
        let id = { UUID().uuidString.lowercased() }
        var turns = localTurns ?? []
        var snapshot = parentValue
        if let last = turns.last, !last.published {
            snapshot = nil
            if var value = last.parentValue?.object {
                value["type"] = .string("hermes_session"); value["localSource"] = .string(last.source)
                value["localTurnId"] = .string(last.turnId.uuidString.lowercased())
                snapshot = .object(value)
            }
        }
        // Brand-new sessions have an exact deterministic initial value, even before first upload.
        let effectiveParents = turns.last.flatMap { $0.published ? nil : [$0.sessionVersionId] } ?? parents
        if snapshot == nil && effectiveParents == [versionId] {
            snapshot = .object(["type":.string("hermes_session"),"conversationId":.string(conversationId),"branchId":.string(branchId),"title":.string("Hermes chat")])
        }
        turns.append(.init(turnId:turnId,modelId:modelId,source:source,
            parents:effectiveParents,
            operationId:id(),versionId:id(),sessionOperationId:id(),sessionVersionId:id(),parentValue:snapshot))
        localTurns = turns
    }
    mutating func localPublication(index: Int, checkpoint: [HistoryJSON]) throws -> [CloudAgentMutation] {
        guard var turns = localTurns, turns.indices.contains(index), !turns[index].published,
            (localExportSources ?? []).contains(turns[index].source), cloudAuthorized != false,
            let start = checkpoint.lastIndex(where: { $0.object?["role"]?.string == "user" }) else { throw APIError.server(403,"hermes_local_export_consent_required") }
        let turn = turns[index]
        guard turn.parents.count == 1 else { throw APIError.server(409,"hermes_session_conflict_requires_resolution") }
        let continuation = history.isEmpty ? checkpoint : history + Array(checkpoint[start...])
        let value: HistoryJSON = .object(["type":.string("hermes_local_turn"),"sessionId":.string(sessionId),"branchId":.string(branchId),
            "turnId":.string(turn.turnId.uuidString.lowercased()),"localSource":.string(turn.source),"source":.string(turn.source),"modelId":.string(turn.modelId),
            "engine":.string(Self.mobileEngine),"sequence":.number(Double(index)),"messages":.array(checkpoint),"history":.array(continuation)])
        let message = CloudAgentMutation(operationId:turn.operationId,objectId:turn.turnId.uuidString.lowercased(),versionId:turn.versionId,deviceId:deviceId,
            kind:"message",parents:[],deleted:false,value:value)
        guard var sessionValue = turn.parentValue?.object, sessionValue["branchId"]?.string == branchId else { throw APIError.server(409,"hermes_original_session_snapshot_required") }
        sessionValue["type"] = .string("hermes_session")
        sessionValue["localSource"] = .string(turn.source)
        sessionValue["localTurnId"] = .string(turn.turnId.uuidString.lowercased())
        let session = CloudAgentMutation(operationId:turn.sessionOperationId,objectId:sessionId,versionId:turn.sessionVersionId,deviceId:deviceId,
            kind:"session",parents:turn.parents,deleted:false,value:.object(sessionValue))
        try CloudAgentState.validate(message); try CloudAgentState.validate(session)
        // Preserve previous Cloud tool history, then the complete current local turn including its tool observations.
        history = continuation
        turns[index].published = true; localTurns = turns
        return [message,session]
    }
}

/// Separate from device/legacy history: ordered durable intents for synchronized Cloud sessions.
struct RemoteHermesSession: Codable, Sendable {
    struct Request: Codable, Sendable {
        let input: CloudHermesRunInput
        let baseCursor: Int64
        let sessionHeads: [String]
    }
    let accountId: String
    let sessionId: String
    let branchId: String
    var requests: [Request] = []
    var results: [String: CloudHermesRun] = [:]
    var cancellations: Set<String> = []
    static func validateHistory(_ history: [HistoryJSON]) throws {
        guard history.count <= 1000, try JSONEncoder().encode(history).count <= 512 * 1024 else { throw APIError.invalidResponse }
        var open = Set<String>()
        for message in history {
            guard let value = message.object, let role = value["role"]?.string, ["system","user","assistant","tool"].contains(role) else { throw APIError.invalidResponse }
            if role == "tool" {
                guard let id = value["tool_call_id"]?.string, open.remove(id) != nil, value["content"]?.string != nil else { throw APIError.invalidResponse }
            } else {
                guard open.isEmpty else { throw APIError.invalidResponse }
                let calls = value["tool_calls"]?.array ?? []
                guard value["content"]?.string != nil || (role == "assistant" && !calls.isEmpty && value["content"] == .null) else { throw APIError.invalidResponse }
                if !calls.isEmpty {
                    guard role == "assistant" else { throw APIError.invalidResponse }
                    for call in calls {
                        guard let call = call.object, let id = call["id"]?.string, !id.isEmpty,
                            open.insert(id).inserted, let function = call["function"]?.object,
                            function["name"]?.string?.isEmpty == false, let arguments = function["arguments"]?.string,
                            (try? JSONSerialization.jsonObject(with:Data(arguments.utf8))) is [String:Any] else { throw APIError.invalidResponse }
                    }
                }
            }
        }
        guard open.isEmpty else { throw APIError.server(409,"hermes_history_has_unknown_effects") }
    }
}

struct CloudArtifactIdentity: Codable, Sendable, Equatable {
    static let chunkBytes = 262_144
    static let maxFileBytes = 67_108_864
    let artifactId: String
    let projectId: String
    let fileId: String
    let byteLength: Int
    let sha256: String
    var chunkCount: Int { (byteLength + Self.chunkBytes - 1) / Self.chunkBytes }
    func validate() throws {
        guard [artifactId, projectId, fileId].allSatisfy({ UUID(uuidString: $0)?.uuidString.lowercased() == $0 }),
              (0...Self.maxFileBytes).contains(byteLength),
              sha256.count == 64, sha256.allSatisfy({ "0123456789abcdef".contains($0) }) else { throw APIError.invalidResponse }
    }
    func chunkLength(_ index: Int) throws -> Int {
        try validate()
        guard index >= 0, index < chunkCount else { throw APIError.invalidResponse }
        return min(Self.chunkBytes, byteLength - index * Self.chunkBytes)
    }
}
struct CloudArtifactManifest: Codable, Sendable, Equatable {
    let artifactId: String
    let projectId: String
    let fileId: String
    let byteLength: Int
    let sha256: String
    let chunkBytes: Int
    let state: String
    let received: [Int]
    var identity: CloudArtifactIdentity { .init(artifactId: artifactId, projectId: projectId, fileId: fileId, byteLength: byteLength, sha256: sha256) }
    func checked(expected: CloudArtifactIdentity) throws -> Self {
        try expected.validate()
        guard identity == expected, chunkBytes == CloudArtifactIdentity.chunkBytes,
              ["uploading", "complete"].contains(state), Set(received).count == received.count,
              received.allSatisfy({ $0 >= 0 && $0 < expected.chunkCount }),
              state != "complete" || received.count == expected.chunkCount else { throw APIError.invalidResponse }
        return self
    }
}
struct CloudArtifactReply: Decodable, Sendable {
    let accountId: String
    let artifact: CloudArtifactManifest
    func checked(accountId expectedAccount: String, expected: CloudArtifactIdentity) throws -> CloudArtifactManifest {
        guard accountId == expectedAccount else { throw APIError.invalidResponse }
        return try artifact.checked(expected: expected)
    }
}
struct CloudArtifactChunkReply: Decodable, Sendable {
    struct Chunk: Decodable, Sendable { let index: Int; let data: String; let sha256: String }
    let accountId: String
    let chunk: Chunk
    func checked(accountId expectedAccount: String, expected: CloudArtifactIdentity, index: Int) throws -> Data {
        let size = try expected.chunkLength(index)
        guard accountId == expectedAccount, chunk.index == index,
              chunk.data.utf8.count == ((size + 2) / 3) * 4,
              let bytes = Data(base64Encoded: chunk.data), bytes.count == size,
              bytes.base64EncodedString() == chunk.data,
              SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == chunk.sha256 else { throw APIError.invalidResponse }
        return bytes
    }
}
