import AppKit
import SwiftUI
import WebKit

@MainActor private final class Proposals {
    var value: NativeInteractiveProposal?
    var error: String?
}

@main struct NativeInteractiveAnswersHarness {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        Task { @MainActor in
            do { try await verify(); print("PASS parser, persistence, working calculator, opaque origin, network isolation, native bridge"); exit(0) }
            catch { fputs("FAIL \(error)\n", stderr); exit(1) }
        }
        app.run()
    }
    struct Failure: Error { let message: String }
    static func check(_ condition: Bool, _ message: String) throws { if !condition { throw Failure(message: message) } }
    @MainActor static func verify() async throws {
        let html = """
        <label>Total <input id="total" type="number" value="120"></label>
        <label>People <input id="people" type="number" min="1" value="3"></label>
        <output id="share"></output><button id="follow">Explain my split</button>
        """
        let functions = """
        function calculate(){share.textContent=(Number(total.value)/Math.max(1,Number(people.value))).toFixed(2)}
        total.oninput=people.oninput=calculate;
        follow.onclick=()=>sendPrompt('Share per person: '+share.textContent);
        """
        let report = """
        calculate();total.value='150';total.dispatchEvent(new Event('input'));
        let storageBlocked=false;try{localStorage.setItem('secret','value')}catch{storageBlocked=true}
        let nativeBlocked=!(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.interactive);
        let networkBlocked=false;try{await fetch('https://example.com/')}catch{networkBlocked=true}
        sendPrompt(JSON.stringify({share:share.textContent,storageBlocked,nativeBlocked,networkBlocked}));
        """
        let fixture: [String: Any] = ["title":"Bill splitter", "initialHeight":420, "html":html, "jsFunctions":functions,
                                     "jsExpressions":"(async()=>{\(report)})()"]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: fixture), as: UTF8.self)
        let message = "Here is your calculator.\n```intelligent-ui\n\(json)\n```\nTry changing the total."
        let persisted = try JSONEncoder().encode(message)
        let restored = try JSONDecoder().decode(String.self, from: persisted)
        let segments = NativeInteractiveDocument.segments(restored)
        try check(segments.count == 3, "mixed text and document")
        guard case .document(let document) = segments[1] else { throw Failure(message: "missing document") }
        try check(NativeInteractiveDocument.segments("```intelligent-ui\n{\"html\":") == [.pending], "partial document executes nothing")
        try check(NativeInteractiveDocument.segments("```json\n\(json)\n```").allSatisfy { if case .text = $0 { return true }; return false }, "ordinary code stays literal")
        try check(NativeInteractiveDocument.segments("````markdown\n```intelligent-ui\n\(json)\n```\n````").count == 1, "nested code stays literal")
        let malformed = NativeInteractiveDocument.segments("```intelligent-ui\n{bad}\n```")
        try check(malformed.count == 1 && { if case .text = malformed[0] { return true }; return false }(), "invalid JSON stays readable")
        try check(NativeInteractiveDocument.segments(message + "\n```intelligent-ui\n\(json)\n```").filter { if case .document = $0 { return true }; return false }.count == 2, "independent documents")
        let oversized = "```intelligent-ui\n" + String(repeating: "x", count: 200001) + "\n```"
        try check(NativeInteractiveDocument.segments(oversized).count == 1, "bounded document")
        let encoded = try JSONSerialization.data(withJSONObject: ["title":"x", "html":"<p>x</p>", "initialHeight":9000])
        let tall = try JSONDecoder().decode(NativeInteractiveDocument.self, from: encoded)
        try check(tall.height == 800, "height bounded")
        for body: [String: Any] in [["type":"send-prompt","text":""], ["type":"send-prompt","text":String(repeating:"x",count:8001)], ["type":"open-link","url":"file:///etc/passwd"], ["type":"open-link","url":"javascript:alert(1)"], ["type":"open-link","url":"https://user:password@example.com"], ["type":"run-tool","text":"execute"]] {
            try check(NativeInteractiveProposal.parse(body) == nil, "invalid native proposal")
        }
        try check(NativeInteractiveProposal.parse(["type":"open-link", "url":"https://example.com"]) != nil, "HTTPS proposal")
        let hostile = try JSONDecoder().decode(NativeInteractiveDocument.self, from: JSONSerialization.data(withJSONObject: ["title":"x", "html":"</script><script>evil()</script>"]))
        try check(!NativeInteractiveSandbox.page(hostile).contains("<script>evil()"), "wrapper script breakout escaped")
        let state = Proposals()
        let parent = NativeInteractiveWebView(document: document,
            proposal: Binding(get: { state.value }, set: { state.value = $0 }),
            error: Binding(get: { state.error }, set: { state.error = $0 }))
        let coordinator = parent.makeCoordinator()
        let webView = parent.makeWebView(coordinator: coordinator)
        webView.frame = NSRect(x: 0, y: 0, width: 720, height: 420)
        defer { NativeInteractiveWebView.dismantleNSView(webView, coordinator: coordinator) }
        try check(!webView.configuration.websiteDataStore.isPersistent, "ephemeral storage")
        let deadline = Date().addingTimeInterval(15)
        while state.value == nil && state.error == nil && Date() < deadline { try await Task.sleep(nanoseconds: 100_000_000) }
        guard case .prompt(let reportText) = state.value else { throw Failure(message: "sandbox report missing: \(state.error ?? "timeout")") }
        guard let result = try JSONSerialization.jsonObject(with: Data(reportText.utf8)) as? [String: Any] else { throw Failure(message: "invalid report") }
        try check(result["share"] as? String == "50.00", "calculator controls recalculate")
        try check(result["storageBlocked"] as? Bool == true, "storage inaccessible")
        try check(result["nativeBlocked"] as? Bool == true, "iframe has no native handler")
        try check(result["networkBlocked"] as? Bool == true, "network disabled")
        let isolated = try await webView.evaluateJavaScript("(()=>{try{document.querySelector('iframe').contentWindow.document.body;return false}catch{return true}})()")
        try check(isolated as? Bool == true, "opaque iframe origin")
        if let output = ProcessInfo.processInfo.environment["MULTIVIBE_INTERACTIVE_QA_PATH"] {
            let snapshot = try await webView.takeSnapshot(configuration: nil)
            if let tiff = snapshot.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
               let png = bitmap.representation(using: .png, properties: [:]) { try png.write(to: URL(fileURLWithPath: output)) }
        }
        state.value = nil
        _ = try await webView.evaluateJavaScript("window.postMessage({type:'send-prompt',text:'forged'},'*')")
        try await Task.sleep(nanoseconds: 700_000_000)
        try check(state.value == nil, "non-iframe message rejected")
        // Re-load a document whose local control invokes the upstream-compatible follow-up bridge.
        let followFixture = try JSONDecoder().decode(NativeInteractiveDocument.self, from: JSONSerialization.data(withJSONObject: ["title":"Follow-up", "html":html, "jsFunctions":functions, "jsExpressions":"calculate();follow.click();"]))
        webView.loadHTMLString(NativeInteractiveSandbox.page(followFixture), baseURL: nil)
        let followDeadline = Date().addingTimeInterval(10)
        while state.value == nil && Date() < followDeadline { try await Task.sleep(nanoseconds: 100_000_000) }
        try check(state.value == .prompt("Share per person: 40.00"), "follow-up includes values and remains a proposal")
    }
}
