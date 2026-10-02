import Foundation

/// JSON shared by the agent journal and wire protocol; never carries host credentials.
indirect enum NativeAgentJSON: Codable, Equatable, Sendable {
    case null, bool(Bool), number(Double), string(String), array([Self]), object([String: Self])
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([Self].self) { self = .array(v) }
        else { self = .object(try c.decode([String: Self].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
}

struct NativeAgentCatalogModel: Decodable, Identifiable, Sendable {
    let id: String
    let name: String?
    let source: String?
    let owned_by: String
    let available: Bool?
    let machineName: String?
    var supportsCloudAgent: Bool { source != "personal" && !id.hasPrefix("personal/") }
}

struct NativeAgentConsent: Codable, Sendable {
    let accountId: String
    let cloudEnabled: Bool
    let exportSources: [String]
    let revision: Int64
}
struct NativeAgentCapabilities: Decodable, Sendable {
    let version: Int
    let stateSync: Bool
    let runtime: Bool
    let encryption: String
    let requiresCloudConsent: Bool
    let maxOperations: Int
    let maxValueBytes: Int
}
struct NativeAgentMutation: Codable, Sendable {
    enum Kind: String, Codable, Sendable { case session, message, memory, skill, project, file, environment, task }
    let operationId: String
    let objectId: String
    let versionId: String
    let deviceId: String
    let kind: Kind
    let parents: [String]
    let deleted: Bool
    let value: NativeAgentJSON?
}
struct NativeAgentChange: Codable, Sendable {
    let operationId: String
    let objectId: String
    let versionId: String
    let deviceId: String
    let kind: NativeAgentMutation.Kind
    let parents: [String]
    let deleted: Bool
    let value: NativeAgentJSON?
    let cursor: Int64
    let erased: Bool
}
struct NativeAgentChanges: Decodable, Sendable {
    let accountId: String
    let changes: [NativeAgentChange]
    let cursor: Int64
    let hasMore: Bool
}
struct NativeAgentReceipt: Decodable, Sendable {
    let operationId: String
    let versionId: String
    let cursor: Int64
    let heads: [String]
    let deleted: Bool
}
struct NativeAgentRunInput: Codable, Sendable {
    struct Model: Codable, Sendable {
        enum Source: String, Codable, Sendable { case cloud, relay, device }
        let id: String
        let accessId: String?
        let source: Source
        let deviceId: String?
    }
    let operationId: String
    let runId: String
    let sessionId: String
    let branchId: String
    let projectId: String?
    var workspaceProjectId: String? = nil
    let model: Model
    let message: String
    let history: [NativeAgentJSON]?
}
struct NativeAgentRun: Codable, Sendable {
    enum State: String, Codable, Sendable { case queued, running, waiting_device, awaiting_resolution, completed, cancelled }
    let runId: String
    let sessionId: String
    let branchId: String
    let state: State
    let generation: Int
    let result: NativeAgentJSON?
}
enum NativeAgentClientError: Error { case accountMismatch, invalidRequest, invalidResponse, tooLarge, http(Int) }

private final class NativeAgentRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Transport only. Consent, durable IDs and retry/reconciliation policy belong to the caller.
@MainActor final class NativeAgentClient {
    typealias Transport = @MainActor (URLRequest) async throws -> (Data, URLResponse)
    private let token: @MainActor () async throws -> String
    private let account: @MainActor () -> String?
    private let transport: Transport
    private let encoder: JSONEncoder
    static let responseLimit = 16 * 1024 * 1024
    private static let origin = "https://app.multivibe.cloud/native/v2/agent/"

    convenience init(session: NativeCloudSession) {
        self.init(token: { try await session.token() }, account: { session.accountID })
    }
    // Internal injection supports deterministic fixtures without exposing arbitrary production endpoints.
    init(token: @escaping @MainActor () async throws -> String,
         account: @escaping @MainActor () -> String?, transport: Transport? = nil) {
        self.token = token; self.account = account
        encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        if let transport { self.transport = transport }
        else {
            let config = URLSessionConfiguration.ephemeral
            config.httpCookieStorage = nil; config.httpShouldSetCookies = false
            config.urlCredentialStorage = nil; config.urlCache = nil
            let session = URLSession(configuration: config, delegate: NativeAgentRedirectPolicy(), delegateQueue: nil)
            self.transport = { request in
                let (bytes, response) = try await session.bytes(for: request)
                guard response.expectedContentLength <= Int64(Self.responseLimit) else { throw NativeAgentClientError.tooLarge }
                var data = Data()
                for try await byte in bytes {
                    guard data.count < Self.responseLimit else { throw NativeAgentClientError.tooLarge }
                    data.append(byte)
                }
                return (data, response)
            }
        }
    }
    private func encoded<T: Encodable>(_ value: T) throws -> Data { try encoder.encode(value) }
    private func request<T: Decodable>(_ path: String, accountID: String, method: String = "GET", body: Data? = nil, catalog: String? = nil) async throws -> T {
        try Task.checkCancellation()
        guard !accountID.isEmpty, account() == nil || account() == accountID else { throw NativeAgentClientError.accountMismatch }
        guard (body?.count ?? 0) <= 1024 * 1024 else { throw NativeAgentClientError.tooLarge }
        let bearer = try await token()
        guard account() == accountID else { throw NativeAgentClientError.accountMismatch }
        try Task.checkCancellation()
        guard !bearer.isEmpty, !bearer.contains("\r"), !bearer.contains("\n") else { throw NativeAgentClientError.invalidRequest }
        var req = URLRequest(url: URL(string: catalog == "relay" ? "https://app.multivibe.cloud/relay/v1/models" : catalog == "cloud" ? "https://app.multivibe.cloud/native/v1/models" : Self.origin + path)!)
        req.httpMethod = method; req.httpBody = body; req.timeoutInterval = 60
        req.httpShouldHandleCookies = false
        req.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await transport(req)
        try Task.checkCancellation()
        guard account() == accountID else { throw NativeAgentClientError.accountMismatch }
        guard let http = response as? HTTPURLResponse, http.url == req.url else { throw NativeAgentClientError.invalidResponse }
        guard data.count <= Self.responseLimit else { throw NativeAgentClientError.tooLarge }
        guard (200..<300).contains(http.statusCode) else { throw NativeAgentClientError.http(http.statusCode) }
        guard http.mimeType?.lowercased() == "application/json" else { throw NativeAgentClientError.invalidResponse }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw NativeAgentClientError.invalidResponse }
    }
    private func matches(_ actual: String, _ expected: String) throws {
        guard actual == expected else { throw NativeAgentClientError.accountMismatch }
    }
    private func uuid(_ value: String) throws {
        guard value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil else { throw NativeAgentClientError.invalidRequest }
    }
    func models(accountID: String) async throws -> [NativeAgentCatalogModel] {
        struct Catalog: Decodable { let object: String; let data: [NativeAgentCatalogModel] }
        let result: Catalog = try await request("", accountID: accountID, catalog: "cloud")
        guard result.object == "list", result.data.count <= 10_000,
              Set(result.data.map(\.id)).count == result.data.count else { throw NativeAgentClientError.invalidResponse }
        return result.data.filter { $0.supportsCloudAgent }
    }
    func relayModels(accountID: String) async throws -> [NativeAgentCatalogModel] {
        struct Catalog: Decodable { let data: [NativeAgentCatalogModel] }
        let result: Catalog = try await request("", accountID: accountID, catalog: "relay")
        guard result.data.count <= 10_000, Set(result.data.map(\.id)).count == result.data.count,
              result.data.allSatisfy({ $0.source == "relay" && $0.id.hasPrefix("relay/") }) else { throw NativeAgentClientError.invalidResponse }
        return result.data
    }
    func capabilities(accountID: String) async throws -> NativeAgentCapabilities { try await request("capabilities", accountID: accountID) }
    func consent(accountID: String) async throws -> NativeAgentConsent {
        let result: NativeAgentConsent = try await request("consent", accountID: accountID)
        try matches(result.accountId, accountID); return result
    }
    func setConsent(_ consent: NativeAgentConsent) async throws -> NativeAgentConsent {
        guard consent.revision >= 0, consent.revision < 9_007_199_254_740_991,
              consent.exportSources.count <= 50, Set(consent.exportSources).count == consent.exportSources.count,
              consent.exportSources.allSatisfy({ $0.range(of: "^[a-z][a-z0-9_.-]{0,63}$", options: .regularExpression) != nil }) else { throw NativeAgentClientError.invalidRequest }
        let result: NativeAgentConsent = try await request("consent", accountID: consent.accountId, method: "POST", body: encoded(consent))
        try matches(result.accountId, consent.accountId); return result
    }
    func changes(accountID: String, after: Int64) async throws -> NativeAgentChanges {
        guard after >= 0, after < 9_007_199_254_740_991 else { throw NativeAgentClientError.invalidRequest }
        let result: NativeAgentChanges = try await request("changes?after=\(after)", accountID: accountID)
        try matches(result.accountId, accountID)
        guard result.changes.count <= 100, result.cursor >= after, result.cursor < 9_007_199_254_740_991 else { throw NativeAgentClientError.invalidResponse }
        var previous = after
        for change in result.changes {
            guard change.cursor > previous, change.cursor <= result.cursor else { throw NativeAgentClientError.invalidResponse }
            previous = change.cursor
        }
        guard result.cursor == previous, !result.hasMore || !result.changes.isEmpty else { throw NativeAgentClientError.invalidResponse }
        return result
    }
    func mutate(accountID: String, operations: [NativeAgentMutation]) async throws -> [NativeAgentReceipt] {
        guard !operations.isEmpty, operations.count <= 100,
              Set(operations.map(\.operationId)).count == operations.count,
              Set(operations.map(\.versionId)).count == operations.count else { throw NativeAgentClientError.invalidRequest }
        for op in operations {
            for id in [op.operationId, op.objectId, op.versionId, op.deviceId] + op.parents { try uuid(id) }
            guard op.parents.count <= 100, Set(op.parents).count == op.parents.count, !op.parents.contains(op.versionId),
                  op.deleted ? op.value == nil : op.value != nil else { throw NativeAgentClientError.invalidRequest }
            if let value = op.value, try encoded(value).count > 131_072 { throw NativeAgentClientError.tooLarge }
        }
        struct Body: Encodable { let accountId: String; let operations: [NativeAgentMutation] }
        struct Reply: Decodable { let accountId: String; let receipts: [NativeAgentReceipt] }
        let result: Reply = try await request("mutations", accountID: accountID, method: "POST", body: encoded(Body(accountId: accountID, operations: operations)))
        try matches(result.accountId, accountID)
        guard result.receipts.count == operations.count else { throw NativeAgentClientError.invalidResponse }
        for (receipt, op) in zip(result.receipts, operations) {
            guard receipt.operationId == op.operationId, receipt.versionId == op.versionId else { throw NativeAgentClientError.invalidResponse }
        }
        return result.receipts
    }
    private struct RunReply: Decodable { let accountId: String; let run: NativeAgentRun }
    private func runRequest(_ path: String, accountID: String, runID: String, method: String = "GET", body: Data? = nil) async throws -> NativeAgentRun {
        let reply: RunReply = try await request(path, accountID: accountID, method: method, body: body)
        try matches(reply.accountId, accountID)
        guard reply.run.runId == runID else { throw NativeAgentClientError.invalidResponse }
        return reply.run
    }
    func createRun(accountID: String, run: NativeAgentRunInput) async throws -> NativeAgentRun {
        for id in [run.operationId, run.runId, run.sessionId, run.branchId] + [run.projectId, run.workspaceProjectId, run.model.accessId, run.model.deviceId].compactMap({ $0 }) { try uuid(id) }
        guard !run.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !run.model.id.isEmpty, run.model.id.count <= 555,
              run.model.id.rangeOfCharacter(from: .controlCharacters) == nil,
              run.model.source != .device || run.model.deviceId != nil,
              (run.history?.count ?? 0) <= 1000 else { throw NativeAgentClientError.invalidRequest }
        guard try encoded(run).count <= 512 * 1024 else { throw NativeAgentClientError.tooLarge }
        struct Body: Encodable { let accountId: String; let run: NativeAgentRunInput }
        let result = try await runRequest("runs", accountID: accountID, runID: run.runId, method: "POST", body: encoded(Body(accountId: accountID, run: run)))
        guard result.sessionId == run.sessionId, result.branchId == run.branchId else { throw NativeAgentClientError.invalidResponse }
        return result
    }
    func readRun(accountID: String, runID: String) async throws -> NativeAgentRun {
        try uuid(runID); return try await runRequest("runs/" + runID, accountID: accountID, runID: runID)
    }
    func cancelRun(accountID: String, runID: String) async throws -> NativeAgentRun {
        try uuid(runID)
        return try await runRequest("runs/" + runID + "/cancel", accountID: accountID, runID: runID, method: "POST", body: encoded(["accountId": accountID]))
    }
}
