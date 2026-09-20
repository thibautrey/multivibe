import Foundation
struct ModelOption: Sendable { let id: String; var name: String? }
struct ChatMessage: Sendable { var role: String; var content: String }
struct Conversation: Sendable { var title: String; var messages: [ChatMessage] }
struct LocalDeviceSnapshot: Sendable { var calendar = "Not authorized"; var reminders = "Not authorized" }
enum APIError: Error { case invalidResponse }
actor Recorder {
    var approvals = 0
    var fetches = 0
    var answer = ""
    var tools: [String] = []
    func approve(_ url: URL) -> Bool { approvals += 1; return true }
    func fetch(_ url: URL, _ method: String) -> LocalWebResponse {
        fetches += 1
        return LocalWebResponse(url: url, status: 200, contentType: "text/plain", text: "The observatory visitor code is ORION-4729. This information was read from the page.")
    }
    func record(_ event: LocalAgentEvent) { tools.append(event.tool); print("TOOL: \(event.tool) \(event.detail)") }
    func output(_ text: String) { answer = text }
}
@main struct Harness {
    static func main() async {
      do {
        if let reason = LocalModel.unavailableReason { print("MODEL_UNAVAILABLE: \(reason)"); exit(2) }
        let recorder = Recorder()
        let workspace = LocalAgentWorkspace(conversations: [], documents: [], event: { await recorder.record($0) }, saveDocument: { _ in },
            authorizeInternet: { await recorder.approve($0) }, webFetch: { await recorder.fetch($0, $1) })
        try await LocalAgent.respond(messages: [ChatMessage(role: "user", content: "Lis https://example.com avec ton outil fetch_website et indique le code visiteur de l’observatoire présent sur cette page.")], workspace: workspace, onText: { await recorder.output($0) })
        let count = await recorder.fetches
        let approvals = await recorder.approvals
        let answer = await recorder.answer
        print("APPROVALS=\(approvals) FETCHES=\(count) ANSWER=\(answer)")
        guard count >= 1, approvals >= 1, answer.contains("ORION-4729") else { exit(1) }
        let deviceRecorder = Recorder()
        let deviceWorkspace = LocalAgentWorkspace(conversations: [], documents: [],
            event: { await deviceRecorder.record($0) }, saveDocument: { _ in },
            readDevice: { action, _ in
                action == "current_location" ? "GPS observation: latitude 48.8566, longitude 2.3522, accuracy 100 m." : "Access denied."
            })
        try await LocalAgent.respond(messages: [ChatMessage(role: "user", content: "Where are we? Give me our current GPS coordinates.")],
            workspace: deviceWorkspace, onText: { await deviceRecorder.output($0) })
        let deviceTools = await deviceRecorder.tools
        let deviceAnswer = await deviceRecorder.answer
        print("DEVICE_TOOLS=\(deviceTools) ANSWER=\(deviceAnswer)")
        guard deviceTools.contains("current_location"), deviceAnswer.contains("48.8566") else { exit(1) }
        let live = try await LocalWebFetch.fetch(url: URL(string: "https://example.com")!, method: "GET")
        guard live.status == 200, live.text.contains("Example Domain") else { exit(1) }
        print("LIVE_HTTPS_GET=200 HTML_EXTRACTION=PASS")
      } catch { print("MODEL_ERROR: \(error)"); exit(1) }
    }
}
