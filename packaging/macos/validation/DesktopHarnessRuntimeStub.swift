import Foundation

@MainActor final class DesktopHarnessClient: DesktopHarnessServing {
    static let shared = DesktopHarnessClient()
    private var sessions: [String: HarnessJSON] = [:]
    private var journal: [String: [DesktopHarnessEvent]] = [:]
    private var sequence = 0
    var lastCreatedWorkspace: String?
    func call(_ route: String, method: String, target: String, body: HarnessJSON?) async throws -> HarnessJSON {
        let body = body ?? .null
        if route == "/models" {
            precondition(body["harnessId"].string == "pi")
            return .object(["models": .array([.object(["id": .string("native-picked"), "name": .string("Native model"), "provider": .string("native-provider")])]), "currentModelId": .string("native-default")])
        }
        if route == "/sessions", method == "POST" {
            let id = body["id"].string!
            let workspace = body["workspace"].string ?? "/tmp"; lastCreatedWorkspace = workspace
            let session: HarnessJSON = .object(["id": .string(id), "harnessId": body["harnessId"], "targetId": .string(target), "workspace": .string(workspace), "nativeSessionId": .string("session-fixture"), "title": body["title"], "authMode": body["authMode"], "state": .string("idle"), "queuePaused": .bool(false), "revision": .number(1), "archived": .bool(false), "pinned": .bool(false), "createdAt": .number(1), "updatedAt": .number(1), "capabilities": .object([:])])
            if body["model"].string == "native-picked" { precondition(body["nativeProvider"].string == "native-provider"); precondition(body["authMode"].string == "native") }
            sessions[id] = session; return .object(["session": session])
        }
        let components = route.split(separator: "/"); let id = String(components[1])
        if route.hasSuffix("/commands") {
            let commandID = body["id"].string!
            let harness = sessions[id]!["harnessId"].string!
            NativeHarnessClient.shared.receivedHarnessID = harness
            if let text = body["parts"].array.first?["text"].string { precondition(text == NativeInteractiveDocument.prompt("Brouillon à conserver")) }
            var session = sessions[id]!.object; session["state"] = .string("running"); sessions[id] = .object(session)
            func event(_ type: String, _ payload: HarnessJSON) {
                sequence += 1
                journal[id, default: []].append(.init(seq: sequence, sessionId: id, type: type, turnId: commandID, itemId: nil, payload: payload, createdAt: 1))
            }
            event("message.user", .object(["parts": body["parts"], "displayText": body["displayText"]]))
            event("message.delta", .object(["text": .string("Réponse du harness")]))
            event("turn.completed", .object([:]))
            session["state"] = .string("idle"); event("session.updated", .object(session))
            return .object(["receipt": .object(["id": .string(commandID), "sessionId": .string(id), "command": body, "state": .string("accepted"), "createdAt": .number(1), "ordinal": .number(1)])])
        }
        return .object(["session": sessions[id]!, "queue": .array([]), "interactions": .array([])])
    }
    func events(sessionID: String, target: String, after: Int, update: @MainActor @escaping (DesktopHarnessEvent) -> Void) async throws {
        var cursor = after
        while !Task.isCancelled {
            for event in journal[sessionID] ?? [] where event.seq > cursor {
                update(event); cursor = event.seq
                if event.type == "session.updated" { sessions[sessionID] = event.payload }
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }
}
