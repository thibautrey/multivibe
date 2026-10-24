import AppKit

enum AppleFoundationModel { static let id = "apple-local" }
enum HostAssistantError: Error { case emptyReply }

@MainActor final class ChromiumBrowser {
    var onClose: (() -> Void)?
    var automating = false
    var allowedOrigins: Set<String> = []
    func allow(origin: String) { allowedOrigins.insert(origin) }
    func observe() async throws -> ComputerUseObservation { throw ComputerUseFailure("Browser fixture unavailable") }
    func perform(_ command: ComputerUseCommand) async throws { throw ComputerUseFailure("Browser fixture unavailable") }
    func reset() {}
    func stopLoading() {}
    func contains(event: NSEvent) -> Bool { false }
}
