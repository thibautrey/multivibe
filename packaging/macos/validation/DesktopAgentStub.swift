import Foundation

struct ComputerUseModelReply {
    let message: [String: Any]
    let text: String
    let calls: [(id: String, name: String, arguments: String)]
}
@MainActor final class ChromiumBrowser { func close() {} }
@MainActor final class ComputerUseController {
    var running = false
    var onStop: (() -> Void)?
    let browser = ChromiumBrowser()
    func stop() { onStop?() }
    func run(conversation: UUID, messages: [[String: String]], model: String,
             turn: @MainActor ([[String: Any]], String) async throws -> ComputerUseModelReply,
             update: @MainActor (String) -> Void) async throws {
        running = true; defer { running = false }
        let reply = try await turn(messages.map { $0 as [String: Any] }, model)
        try Task.checkCancellation()
        update(reply.text)
    }
}
