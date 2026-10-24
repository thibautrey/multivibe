import Foundation

extension HostAssistantClient {
    /// Assemble tool deltas by stream index, preserving the upstream call_id exactly once.
    /// Using the streaming contract also avoids duplicate item_id/call_id reconstruction in older Hosts.
    func computerTurn(_ messages: [[String: Any]], model: String) async throws -> ComputerUseModelReply {
        guard model != AppleFoundationModel.id, !messages.isEmpty, messages.count <= 220 else { throw HostAssistantError.invalidInput }
        let body = try JSONSerialization.data(withJSONObject: ["model": model, "stream": true, "messages": messages,
            "tools": [ComputerUseController.tool], "tool_choice": "auto", "parallel_tool_calls": false, "max_completion_tokens": 8192])
        guard body.count <= 12 * 1024 * 1024 else { throw ComputerUseFailure("Le contexte de contrôle visuel est trop volumineux. Lancez une nouvelle conversation.") }
        let (base, key) = try await connection()
        guard base.scheme == "http", base.host == "127.0.0.1" else { throw HostAssistantError.unavailable }
        var request = URLRequest(url: base.appendingPathComponent("v1/chat/completions"))
        request.httpMethod = "POST"; request.httpBody = body; request.timeoutInterval = 180
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false; configuration.timeoutIntervalForResource = 300
        let session = URLSession(configuration: configuration, delegate: ComputerUseNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw HostAssistantError.unavailable }
        guard http.statusCode == 200 else { throw HostAssistantError.rejected(http.statusCode) }
        guard http.value(forHTTPHeaderField: "content-type")?.lowercased().contains("text/event-stream") == true else { throw ComputerUseFailure("Le fournisseur ne propose pas le flux d’outils requis.") }
        var line = Data(), total = 0, text = "", finished = false, finishReason: String?
        struct Call { var id = ""; var name = ""; var arguments = "" }
        var calls: [Int: Call] = [:]
        for try await byte in bytes {
            try Task.checkCancellation()
            total += 1
            guard total <= 4 * 1024 * 1024, line.count <= 1024 * 1024 else { throw ComputerUseFailure("Réponse du modèle trop volumineuse.") }
            if byte != 10 { line.append(byte); continue }
            let value = String(decoding: line, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            line.removeAll(keepingCapacity: true)
            guard value.hasPrefix("data:") else { continue }
            let payload = String(value.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            if payload == "[DONE]" { finished = true; break }
            guard let event = try JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any], event["error"] == nil,
                  let choices = event["choices"] as? [[String: Any]] else { throw ComputerUseFailure("Flux d’outils invalide ou interrompu par le fournisseur.") }
            guard let choice = choices.first else { continue } // Usage-only terminal frames.
            if let reason = choice["finish_reason"] as? String { finishReason = reason }
            guard let delta = choice["delta"] as? [String: Any] else { throw ComputerUseFailure("Delta du modèle invalide.") }
            if let content = delta["content"] as? String { text += content }
            for raw in delta["tool_calls"] as? [[String: Any]] ?? [] {
                guard let index = raw["index"] as? Int, (0..<8).contains(index),
                      let function = raw["function"] as? [String: Any] else { throw ComputerUseFailure("Delta d’appel d’outil invalide.") }
                var call = calls[index] ?? Call()
                if let id = raw["id"] as? String {
                    guard call.id.isEmpty || call.id == id else { throw ComputerUseFailure("L’identité de l’appel d’outil a changé.") }; call.id = id
                }
                if let name = function["name"] as? String { call.name += name }
                if let arguments = function["arguments"] as? String { call.arguments += arguments }
                guard call.id.count <= 256, call.name.count <= 128, call.arguments.utf8.count <= 24_000 else { throw ComputerUseFailure("Appel d’outil trop volumineux.") }
                calls[index] = call
            }
        }
        try Task.checkCancellation()
        guard finished, let finishReason, ["stop", "tool_calls"].contains(finishReason) else { throw ComputerUseFailure("Le flux du modèle est tronqué ou incomplet. Aucune action exécutée.") }
        let ordered = calls.keys.sorted().compactMap { calls[$0] }
        guard ordered.count <= 1, ordered.allSatisfy({ !$0.id.isEmpty && !$0.name.isEmpty }), Set(ordered.map(\.id)).count == ordered.count,
              (ordered.isEmpty && finishReason == "stop") || (!ordered.isEmpty && finishReason == "tool_calls") else { throw ComputerUseFailure("Les appels d’outils sont incomplets.") }
        var message: [String: Any] = ["role": "assistant", "content": text]
        if !ordered.isEmpty {
            message["tool_calls"] = ordered.map { ["id": $0.id, "type": "function", "function": ["name": $0.name, "arguments": $0.arguments]] }
        }
        return .init(message: message, text: text, calls: ordered.map { (id: $0.id, name: $0.name, arguments: $0.arguments) })
    }
}
private final class ComputerUseNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
