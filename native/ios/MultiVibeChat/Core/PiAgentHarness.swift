import Foundation
import JavaScriptCore
import Security

struct PiToolResult: Codable, Sendable {
    var content: String
    var isError = false
    var terminal = false
}

/// JavaScriptCore hosts the unmodified npm Pi loop. Swift owns inference, I/O and
/// permission checks; the JS bundle has no network, filesystem or credentials.
@MainActor final class PiAgentHarness {
    private let context: JSContext
    private let bridge: JSValue

    init() throws {
        guard let context = JSContext(),
              let url = Bundle.main.url(forResource: "PiAgentCore", withExtension: "js") else {
            throw LocalAgentError.unavailable("Le moteur d’agent Pi est absent de cette version de l’app.")
        }
        let random: @convention(block) (Int) -> [UInt8] = { count in
            guard (0...65_536).contains(count) else { return [] }
            var bytes = [UInt8](repeating: 0, count: count)
            guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else { return [] }
            return bytes
        }
        context.setObject(random, forKeyedSubscript: "__randomBytes" as NSString)
        context.evaluateScript(try String(contentsOf: url, encoding: .utf8), withSourceURL: url)
        guard context.exception == nil, let bridge = context.objectForKeyedSubscript("PiNative"), !bridge.isUndefined else {
            throw LocalAgentError.unavailable("Le moteur d’agent Pi n’a pas pu démarrer : " + (context.exception?.toString() ?? "initialisation invalide"))
        }
        self.context = context; self.bridge = bridge
    }

    var version: String { bridge.objectForKeyedSubscript("version")?.toString() ?? "unknown" }

    private func invoke(_ method: String, _ arguments: [Any] = []) throws -> JSValue? {
        context.exception = nil
        let value = bridge.invokeMethod(method, withArguments: arguments)
        if let exception = context.exception {
            throw LocalAgentError.unavailable("Erreur du moteur d’agent Pi : " + (exception.toString() ?? method))
        }
        return value
    }

    func run(messages: String, tools: String, weather: Bool = false,
             generate: @escaping @Sendable (String, String, @escaping @Sendable (String) async -> Void) async throws -> String,
             execute: @escaping @Sendable (String, String) async throws -> PiToolResult,
             onText: @escaping @Sendable (String) async -> Void) async throws {
        let input = "{\"messages\":" + messages + ",\"tools\":" + tools + ",\"weather\":" + String(weather) + "}"
        _ = try invoke("start", [input])
        var idlePolls = 0
        do {
            while true {
                try Task.checkCancellation()
                guard let json = try invoke("poll")?.toString(), let data = json.data(using: .utf8),
                      let state = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    throw LocalAgentError.invalidInput
                }
                if let error = state["error"] as? String { throw LocalAgentError.unavailable(error) }
                if state["done"] as? Bool == true {
                    if let text = state["finalText"] as? String { await onText(text) }
                    return
                }
                let requests = state["requests"] as? [[String: Any]] ?? []
                if requests.isEmpty {
                    idlePolls += 1
                    guard idlePolls < 500 else { throw LocalAgentError.unavailable("Le moteur d’agent ne répond plus.") }
                    try await Task.sleep(for: .milliseconds(10))
                    continue
                }
                idlePolls = 0
                for request in requests {
                    try Task.checkCancellation()
                    guard let id = request["id"] as? String, let kind = request["kind"] as? String else {
                        throw LocalAgentError.invalidInput
                    }
                    do {
                        let response: String
                        if kind == "model", let messages = request["messages"] as? String, let tools = request["tools"] as? String {
                            response = try await generate(messages, tools, onText)
                        } else if kind == "tool", let name = request["name"] as? String, let arguments = request["arguments"] as? String {
                            response = String(decoding: try JSONEncoder().encode(await execute(name, arguments)), as: UTF8.self)
                        } else { throw LocalAgentError.invalidInput }
                        try Task.checkCancellation()
                        _ = try invoke("resolve", [id, response, false])
                    } catch is CancellationError { throw CancellationError() }
                    catch { _ = try invoke("resolve", [id, error.localizedDescription, true]) }
                }
            }
        } catch {
            _ = try? invoke("cancel")
            throw error
        }
    }
}
