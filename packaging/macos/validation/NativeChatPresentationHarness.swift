import Foundation

enum NativeChatPresentationHarness {
    static func validate() throws {
        func event(_ seq: Int, _ type: String, _ payload: HarnessJSON, item: String? = nil, turn: String = "turn", session: String = "session") -> DesktopHarnessEvent {
            .init(seq: seq, sessionId: session, type: type, turnId: turn, itemId: item, payload: payload, createdAt: 1)
        }
        let start = event(1, "tool", .object(["toolName": .string("Lire les notes"), "type": .string("tool_execution_start")]), item: "call")
        let end = event(2, "tool", .object(["type": .string("tool_execution_end")]), item: "call")
        let rows = HarnessPresentation.activities([start, end])
        precondition(rows.count == 1 && rows[0].title == "Lire les notes" && rows[0].status == .completed)
        let reused = event(3, "tool", .object([:]), item: "call", turn: "next-turn")
        let otherSession = event(4, "tool", .object([:]), item: "call", session: "other")
        precondition(HarnessPresentation.activities([start, end, reused, otherSession]).count == 3)
        precondition(HarnessPresentation.activities([start])[0].status == .active)
        precondition(HarnessPresentation.activities([reused])[0].status == .neutral)
        let failure = event(5, "tool", .object(["isError": .bool(true), "type": .string("tool_execution_end")]), item: "call")
        precondition(HarnessPresentation.activities([start, failure])[0].status == .failed)
        let nested = event(6, "tool", .object(["tool": .string("bash"), "state": .object(["status": .string("running")])]), item: "bash")
        precondition(HarnessPresentation.activities([nested])[0].status == .active)
        let file = DesktopHarnessAttachment(id: "file", name: "notes.md", mimeType: "text/plain", size: 42, sha256: "fixture")
        let withFile = event(7, "tool", .object(["artifacts": try .encode([file])]), item: "call")
        precondition(HarnessPresentation.activities([start, withFile, end])[0].attachments == [file])
        let reasoning = [event(8, "reasoning", .object(["text": .string("Première ")])), event(9, "reasoning", .object(["text": .string("étape")]))]
        precondition(HarnessPresentation.activities(reasoning)[0].readable == "Première étape")
        let usage = event(10, "usage", .object(["usage": .object(["input_tokens": .number(200), "cache_read_input_tokens": .number(100), "output_tokens": .number(20)])]))
        let readable = HarnessPresentation.activities([usage])[0].readable!
        precondition(readable.contains("200") && readable.contains("100") && !readable.contains("320"))
        let terminal = [event(11, "terminal.output", .object(["output": .string("hello")] ), item: "terminal"), event(12, "terminal.output", .object(["output": .string("hello world")]), item: "terminal")]
        precondition(HarnessPresentation.activities(terminal)[0].readable == "hello world")
        precondition(HarnessPresentation.origin("unknown") == "À confirmer")
        print("PASS activity grouping, native status, artifact retention and measured usage")

        let traceback = "2026-10-25 [ERROR] Streaming failed before delivery: Connection error.\nTraceback (most recent call last):\n  internal.py"
        let presented = ChatPresentedError(traceback)
        precondition(presented.summary == "La connexion au modèle a été interrompue. Réessayez si aucune réponse n’apparaît.")
        precondition(presented.details == traceback)
        precondition(ChatPresentedError("Harness failed").details == nil)
        let bounded = ChatPresentedError(String(repeating: "x", count: 300)).summary
        precondition(bounded.count <= 240 && bounded.hasSuffix("…"))
        print("PASS concise errors with folded technical diagnostics")

        let markdown = ChatMarkdownParser.parse("## Titre\n\n1. Première étape\n- Un point\n\n```swift\nlet value = 1\n```\n> Une note")
        precondition(markdown == [.heading(2, "Titre"), .numbered("1.", "Première étape"), .bullet("Un point"), .code("let value = 1", "swift"), .quote("Une note")])
        precondition(ChatMarkdownParser.parse("Du texte\nsur deux lignes") == [.paragraph("Du texte sur deux lignes")])
        print("PASS native Markdown block presentation")

        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var pinned = NativeChatConversation(); pinned.pinned = true; pinned.updatedAt = now.addingTimeInterval(-20 * 86_400)
        var today = NativeChatConversation(); today.updatedAt = now
        var week = NativeChatConversation(); week.updatedAt = now.addingTimeInterval(-2 * 86_400)
        var old = NativeChatConversation(); old.updatedAt = now.addingTimeInterval(-12 * 86_400)
        let sections = ChatConversationSection.sections([old, week, pinned, today], now: now, calendar: calendar)
        precondition(sections.map(\.id) == ["pinned", "today", "week", "older"])
        precondition(Set(sections.flatMap(\.conversations).map(\.id)).count == 4)
        print("PASS conversation date sections and pinned uniqueness")
    }
}
