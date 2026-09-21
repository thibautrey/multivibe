import AppKit
import Foundation

struct HostAssistantModel: Codable, Identifiable, Hashable {
    let id: String
    var name: String?
    var local: Bool?
    init(id: String, name: String? = nil, local: Bool? = nil) {
        self.id = id; self.name = name; self.local = local
    }
    var displayName: String { name ?? id }
}

enum HostAssistantError: LocalizedError {
    case unavailable, missingModel, invalidInput, rejected(Int), emptyReply
    var errorDescription: String? {
        switch self {
        case .unavailable: return "MultiVibe Host n’est pas disponible. Ouvrez le Host et vérifiez sa connexion."
        case .missingModel: return "Choisissez un modèle MultiVibe disponible."
        case .invalidInput: return "Saisissez un texte de 1 à 32 000 caractères."
        case .rejected(let status): return "MultiVibe a refusé la demande (HTTP \(status)). Vérifiez le modèle et sa connexion dans le Host."
        case .emptyReply: return "Le modèle n’a retourné aucune réponse textuelle."
        }
    }
}

/// Credentials stay in the Host process. Shortcuts receive only model IDs and results.
@MainActor
final class HostAssistantClient {
    static let shared = HostAssistantClient()
    static let defaultModelKey = "assistantDefaultModel"
    private let localModel: any AppleFoundationServing
    init(localModel: any AppleFoundationServing = AppleFoundationModel()) {
        self.localModel = localModel
    }
    var defaultModel: String {
        get { UserDefaults.standard.string(forKey: Self.defaultModelKey) ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: Self.defaultModelKey) }
    }

    private func connection() async throws -> (URL, String) {
        guard let app = NSApplication.shared.delegate as? MultiVibeMenuBarApp else { throw HostAssistantError.unavailable }
        // Explicit invocation can start the service even when launch-at-login is off.
        if !app.operational {
            if app.startAtLoginEnabled { app.ensureServiceIsRunning() }
            else { app.launchService() }
        }
        for _ in 0..<60 {
            try Task.checkCancellation()
            if let credentials = app.readCredentials(), let key = credentials.proxyAPIKey, !key.isEmpty {
                if app.operational { return (app.dashboardURL, key) }
            }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        throw HostAssistantError.unavailable
    }

    private func request(_ path: String, body: Data? = nil) async throws -> Data {
        let (base, key) = try await connection()
        guard base.scheme == "http", base.host == "127.0.0.1" else { throw HostAssistantError.unavailable }
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.timeoutInterval = body == nil ? 15 : 180
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // No cookies, caches or redirects carrying credentials to another destination.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration, delegate: HostAssistantNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw HostAssistantError.unavailable }
        guard (200..<300).contains(http.statusCode) else { throw HostAssistantError.rejected(http.statusCode) }
        return data
    }

    /// SSE completion with the complete conversation, bounded output and no credential redirects.
    func stream(_ messages: [[String: String]], model: String, update: @MainActor @escaping (String) -> Void) async throws {
        guard !messages.isEmpty, messages.count <= 500,
              messages.allSatisfy({ ["user", "assistant"].contains($0["role"] ?? "") }),
              messages.reduce(0, { $0 + ($1["content"]?.utf8.count ?? 0) }) <= 1_000_000 else { throw HostAssistantError.invalidInput }
        if model == AppleFoundationModel.id {
            guard await localModel.model != nil else { throw HostAssistantError.missingModel }
            try await localModel.respond(messages: messages, update: update)
            return
        }
        guard try await remoteModels().contains(where: { $0.id == model }) else { throw HostAssistantError.missingModel }
        let (base, key) = try await connection()
        guard base.scheme == "http", base.host == "127.0.0.1" else { throw HostAssistantError.unavailable }
        var request = URLRequest(url: base.appendingPathComponent("v1/chat/completions"))
        request.httpMethod = "POST"
        request.timeoutInterval = 180
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["model": model, "stream": true, "messages": messages])
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.timeoutIntervalForResource = 300
        let session = URLSession(configuration: config, delegate: HostAssistantNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw HostAssistantError.unavailable }
        guard (200..<300).contains(http.statusCode) else { throw HostAssistantError.rejected(http.statusCode) }
        struct Chunk: Decodable {
            struct Choice: Decodable {
                struct Delta: Decodable { let content: String? }
                let delta: Delta
                let finish_reason: String?
            }
            let choices: [Choice]
        }
        var result = "", line = Data(), total = 0, finished = false
        for try await byte in bytes {
            try Task.checkCancellation()
            total += 1
            guard total <= 8_000_000, line.count <= 1_000_000 else { throw HostAssistantError.invalidInput }
            if byte != 10 { line.append(byte); continue }
            let value = String(decoding: line, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            line.removeAll(keepingCapacity: true)
            guard value.hasPrefix("data:") else { continue }
            let payload = String(value.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            if payload == "[DONE]" { finished = true; break }
            let chunk = try JSONDecoder().decode(Chunk.self, from: Data(payload.utf8))
            if let choice = chunk.choices.first {
                if let text = choice.delta.content { result += text; update(result) }
                if choice.finish_reason != nil { finished = true }
            }
        }
        try Task.checkCancellation()
        guard finished else { throw HostAssistantError.unavailable }
        guard !result.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw HostAssistantError.emptyReply }
    }

    private func remoteModels() async throws -> [HostAssistantModel] {
        struct Catalog: Decodable { let data: [HostAssistantModel] }
        let data = try await request("v1/models")
        return Array(Set(try JSONDecoder().decode(Catalog.self, from: data).data)).sorted { $0.id < $1.id }
    }

    func models() async throws -> [HostAssistantModel] {
        let local = await localModel.model
        // A local-only chat must remain immediately usable while the Host is stopped.
        if let local, (NSApplication.shared.delegate as? MultiVibeMenuBarApp)?.operational != true {
            return [local]
        }
        do {
            var catalog = try await remoteModels()
            if let local { catalog.removeAll { $0.id == local.id }; catalog.insert(local, at: 0) }
            return catalog
        } catch {
            if let local { return [local] }
            throw error
        }
    }

    func ask(_ prompt: String, model: String? = nil) async throws -> String {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 32_000 else { throw HostAssistantError.invalidInput }
        let selected = model ?? defaultModel
        guard !selected.isEmpty else { throw HostAssistantError.missingModel }
        if selected == AppleFoundationModel.id {
            var reply = ""
            try await stream([["role": "user", "content": text]], model: selected) { reply = $0 }
            guard !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw HostAssistantError.emptyReply }
            return reply
        }
        guard try await remoteModels().contains(where: { $0.id == selected }) else { throw HostAssistantError.missingModel }
        let body = try JSONSerialization.data(withJSONObject: ["model": selected, "stream": false, "messages": [["role": "user", "content": text]]])
        struct Reply: Decodable {
            struct Choice: Decodable { struct Message: Decodable { let content: String? }; let message: Message }
            let choices: [Choice]
        }
        let data = try await request("v1/chat/completions", body: body)
        guard let reply = try JSONDecoder().decode(Reply.self, from: data).choices.first?.message.content,
              !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw HostAssistantError.emptyReply }
        return reply
    }
}

private final class HostAssistantNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
