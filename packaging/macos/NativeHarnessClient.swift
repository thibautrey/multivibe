import AppKit
import Foundation

struct NativeConversationHarness: Codable, Identifiable, Hashable {
    struct Capabilities: Codable, Hashable {
        let sessions: Bool
        let streaming: Bool
        let tools: Bool
        let longTermMemory: Bool
    }
    let id: String
    let name: String
    let available: Bool
    let configured: Bool
    let description: String
    let capabilities: Capabilities
    let unavailableReason: String?

    static let computerUse = NativeConversationHarness(
        id: "computer-use", name: "Computer use", available: true, configured: true,
        description: "Piloter le navigateur intégré et les applications macOS autorisées. Modèle avec vision et outils requis.",
        capabilities: .init(sessions: true, streaming: false, tools: true, longTermMemory: false), unavailableReason: nil
    )

    static let native = NativeConversationHarness(
        id: "native", name: "MultiVibe natif", available: true, configured: true,
        description: "Conversation directe avec le modèle sélectionné.",
        capabilities: .init(sessions: true, streaming: true, tools: false, longTermMemory: false), unavailableReason: nil
    )
}

enum NativeHarnessError: LocalizedError {
    case unavailable, invalidResponse, rejected(String), emptyReply
    var errorDescription: String? {
        switch self {
        case .unavailable: return "Le harness sélectionné n’est pas disponible. Vérifiez sa connexion dans le Host."
        case .invalidResponse: return "Le harness a retourné une réponse invalide."
        case .rejected(let message): return message
        case .emptyReply: return "Le harness n’a retourné aucune réponse textuelle."
        }
    }
}

@MainActor final class NativeHarnessClient {
    static let shared = NativeHarnessClient()

    private func request(path: String, method: String = "GET") throws -> URLRequest {
        guard let app = NSApplication.shared.delegate as? MultiVibeMenuBarApp,
              var request = app.authorizedRequest(path: path, method: method) else { throw NativeHarnessError.unavailable }
        request.timeoutInterval = method == "GET" ? 15 : 330
        return request
    }

    func harnesses() async throws -> [NativeConversationHarness] {
        struct Response: Decodable { let harnesses: [NativeConversationHarness] }
        let request = try request(path: "/admin/host-conversation-harnesses")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration, delegate: NativeHarnessNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              let decoded = try? JSONDecoder().decode(Response.self, from: data) else { throw NativeHarnessError.invalidResponse }
        return decoded.harnesses
    }

    func stream(harnessID: String, conversationID: UUID, prompt: String, model: String, sessionID: String?,
                update: @MainActor @escaping (String) -> Void) async throws -> String? {
        var request = try request(path: "/admin/host-conversation-harnesses/\(harnessID)/run", method: "POST")
        var body: [String: Any] = [
            "conversationId": conversationID.uuidString.lowercased(), "prompt": prompt, "model": model,
        ]
        if let sessionID, !sessionID.isEmpty { body["sessionId"] = sessionID }
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("text/event-stream", forHTTPHeaderField: "accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForResource = 330
        let session = URLSession(configuration: configuration, delegate: NativeHarnessNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw NativeHarnessError.unavailable }
        var result = "", returnedSession: String?, line = Data(), total = 0, finished = false
        for try await byte in bytes {
            try Task.checkCancellation()
            total += 1
            guard total <= 16 * 1024 * 1024, line.count <= 1024 * 1024 else { throw NativeHarnessError.invalidResponse }
            if byte != 10 { line.append(byte); continue }
            let value = String(decoding: line, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            line.removeAll(keepingCapacity: true)
            guard value.hasPrefix("data:") else { continue }
            let payload = String(value.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            guard let data = payload.data(using: .utf8),
                  let event = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = event["type"] as? String else { throw NativeHarnessError.invalidResponse }
            if type == "text", let text = event["text"] as? String {
                result = text; update(text)
            } else if type == "result" {
                returnedSession = event["sessionId"] as? String
                if let text = event["text"] as? String, !text.isEmpty, text != result { result = text; update(text) }
                finished = true
            } else if type == "error" {
                throw NativeHarnessError.rejected((event["error"] as? String) ?? "Le harness a interrompu la conversation.")
            }
        }
        try Task.checkCancellation()
        guard finished else { throw NativeHarnessError.invalidResponse }
        guard !result.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw NativeHarnessError.emptyReply }
        return returnedSession
    }
}

private final class NativeHarnessNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
