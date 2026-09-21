import AppKit
import Foundation

struct HostAssistantModel: Codable, Identifiable, Hashable {
    let id: String
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

    func models() async throws -> [HostAssistantModel] {
        struct Catalog: Decodable { let data: [HostAssistantModel] }
        let data = try await request("v1/models")
        return Array(Set(try JSONDecoder().decode(Catalog.self, from: data).data)).sorted { $0.id < $1.id }
    }

    func ask(_ prompt: String, model: String? = nil) async throws -> String {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 32_000 else { throw HostAssistantError.invalidInput }
        let selected = model ?? defaultModel
        guard !selected.isEmpty, try await models().contains(where: { $0.id == selected }) else { throw HostAssistantError.missingModel }
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
