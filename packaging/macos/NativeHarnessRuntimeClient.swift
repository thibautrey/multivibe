import AppKit
import Foundation

enum DesktopHarnessError: LocalizedError {
    case rejected(String), invalidResponse
    var errorDescription: String? { switch self { case .rejected(let message): return message; case .invalidResponse: return "Réponse invalide du runtime de harness." } }
}
@MainActor final class DesktopHarnessClient: DesktopHarnessServing {
    static let shared = DesktopHarnessClient()
    private func request(_ route: String, method: String, target: String) async throws -> URLRequest {
        guard let app = NSApplication.shared.delegate as? MultiVibeMenuBarApp else { throw DesktopHarnessError.rejected("Le Host n’est pas disponible.") }
        if !app.operational { _ = try await HostAssistantClient.shared.connection() }
        guard var request = app.authorizedRequest(path: "/admin/host-harness-runtime/v1" + route, method: method),
              let url = request.url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw DesktopHarnessError.invalidResponse }
        var items = components.queryItems ?? []; items.append(URLQueryItem(name: "targetId", value: target)); components.queryItems = items
        request.url = components.url; request.timeoutInterval = 90
        return request
    }
    private func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral; config.httpShouldSetCookies = false
        config.timeoutIntervalForResource = 86_400
        return URLSession(configuration: config, delegate: DesktopHarnessRedirectPolicy(), delegateQueue: nil)
    }
    func call(_ route: String, method: String = "GET", target: String = "local", body: HarnessJSON? = nil) async throws -> HarnessJSON {
        var request = try await request(route, method: method, target: target)
        if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "content-type") }
        let session = session(); defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard data.count <= 32 * 1024 * 1024, let http = response as? HTTPURLResponse else { throw DesktopHarnessError.invalidResponse }
        let value = try JSONDecoder().decode(HarnessJSON.self, from: data)
        guard (200..<300).contains(http.statusCode) else { throw DesktopHarnessError.rejected(value["error"].string ?? "Le Host a refusé la demande (\(http.statusCode)).") }
        return value
    }
    func events(sessionID: String, target: String, after: Int, update: @MainActor @escaping (DesktopHarnessEvent) -> Void) async throws {
        var request = try await request("/sessions/\(sessionID)/events", method: "GET", target: target)
        var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "after", value: String(after))]
        request.url = components.url; request.setValue("text/event-stream", forHTTPHeaderField: "accept")
        let session = session(); defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw DesktopHarnessError.rejected("La session est inaccessible. Vérifiez le Host et la connexion à la machine.") }
        for try await line in bytes.lines {
            try Task.checkCancellation()
            guard line.utf8.count <= 2 * 1024 * 1024 else { throw DesktopHarnessError.invalidResponse }
            if line.hasPrefix("data:") {
                let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                update(try JSONDecoder().decode(DesktopHarnessEvent.self, from: Data(payload.utf8)))
            }
        }
        throw DesktopHarnessError.rejected("Connexion interrompue ; reconnexion à la session en cours.")
    }
}
private final class DesktopHarnessRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
