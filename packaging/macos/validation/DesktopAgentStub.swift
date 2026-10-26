import Foundation

struct ComputerUseModelReply {
    let message: [String: Any]
    let text: String
    let calls: [(id: String, name: String, arguments: String)]
}
struct ComputerUseCommand: Decodable { let action: String }
@MainActor final class ChromiumBrowser { func close() {} }
@MainActor final class ComputerUseController {
    var running = false
    var conversationID: UUID?
    var onStop: (() -> Void)?
    let browser = ChromiumBrowser()
    func stop() { onStop?() }
    func releaseExternal(conversation: UUID) {}
    func executeExternal(conversation: UUID, command: ComputerUseCommand) async throws -> [[String: String]] { [["type": "text", "text": "fixture"]] }
    func run(conversation: UUID, messages: [[String: String]], model: String,
             turn: @MainActor ([[String: Any]], String) async throws -> ComputerUseModelReply,
             update: @MainActor (String) -> Void) async throws {
        running = true; conversationID = conversation; defer { running = false }
        let reply = try await turn(messages.map { $0 as [String: Any] }, model)
        try Task.checkCancellation()
        update(reply.text)
    }
}
