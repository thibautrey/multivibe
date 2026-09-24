import Foundation

@MainActor enum RemoteAutomationAgent {
    static func respond(model: String, access: SelectedModelAccess?, messages: [ChatMessage], token: String,
                        execute: @escaping @Sendable (String) async throws -> String,
                        output: @escaping @Sendable (String) async -> Void) async throws {
        actor Budget { var turns = 0; func take() throws { turns += 1; if turns > 4 { throw LocalAgentError.budget } } }
        let budget = Budget()
        let harness = try PiAgentHarness()
        var history = messages.suffix(8).map { ["role": $0.role, "content": String($0.content.prefix(4000))] }
        history.insert(["role": "system", "content": "You can manage requested automations with automation_manage. Local execution requires an explicitly selected local model; Cloud requires explicit user choice. Never claim a schedule is active before the tool confirms it. Check capabilities and list before modifying IDs. Respect returned limitations and ask for missing required details. Answer in the user's language."], at: 0)
        let schema = String(decoding: try JSONSerialization.data(withJSONObject: [AutomationTools.schema]), as: UTF8.self)
        try await harness.run(messages: AutomationCodec.string(history), tools: schema, generate: { transcript, tools, emit in
            try await budget.take()
            let reply = try await ChatAPI.shared.automationCompletion(model: model, access: access, messages: transcript, tools: tools, token: token)
            if let data = reply.data(using: .utf8), let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               (value["tool_calls"] as? [[String: Any]])?.isEmpty != false, let content = value["content"] as? String { await emit(content) }
            return reply
        }, execute: { name, json in
            guard name == "automation_manage" else { throw LocalAgentError.invalidInput }
            do { return PiToolResult(content: try await execute(json)) }
            catch { return PiToolResult(content: error.localizedDescription, isError: true) }
        }, onText: output)
    }
}
