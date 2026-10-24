import AppKit
import SwiftUI
import WebKit

struct NativeInteractiveAnswerView: View {
    let content: String
    var streaming = false
    var proposePrompt: (String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(NativeInteractiveDocument.segments(content).enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .text(let text):
                    Text((try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text))
                        .textSelection(.enabled).font(.system(size: 15)).lineSpacing(5)
                case .document(let document):
                    NativeInteractiveCard(document: document, proposePrompt: proposePrompt)
                case .pending:
                    Label(streaming ? "Création de la réponse interactive…" : "Réponse interactive incomplète", systemImage: "slider.horizontal.3")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct NativeInteractiveCard: View {
    let document: NativeInteractiveDocument
    let proposePrompt: (String) -> Void
    @State private var proposal: NativeInteractiveProposal?
    @State private var error: String?
    @State private var reload = UUID()
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(document.title, systemImage: "slider.horizontal.3").font(.headline)
                Spacer()
                Button { proposal = nil; error = nil; reload = UUID() } label: { Image(systemName: "arrow.counterclockwise") }
                    .help("Réinitialiser les contrôles")
            }
            NativeInteractiveWebView(document: document, proposal: $proposal, error: $error)
                .id(reload).frame(height: document.height)
                .accessibilityLabel(document.title)
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            if let proposal {
                VStack(alignment: .leading, spacing: 6) {
                    switch proposal {
                    case .prompt(let text):
                        Text(text).font(.callout).lineLimit(5).textSelection(.enabled)
                        Button("Utiliser comme brouillon") { proposePrompt(text); self.proposal = nil }
                    case .link(let url):
                        Text(url.absoluteString).font(.caption).lineLimit(3).textSelection(.enabled)
                        Button("Ouvrir le lien dans le navigateur") { NSWorkspace.shared.open(url); self.proposal = nil }
                    }
                    Button("Ignorer") { self.proposal = nil }.buttonStyle(.link)
                }.padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            }
            DisclosureGroup("Code de la réponse") {
                ScrollView { Text(document.html + "\n" + (document.css ?? "") + "\n" + (document.jsFunctions ?? "") + "\n" + (document.jsExpressions ?? ""))
                    .font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    .frame(maxHeight: 180)
            }.font(.caption).foregroundStyle(.secondary)
        }.padding(14).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
    }
}

/// Adapted from OpenIntelligentUI's document assembly/bridge, pinned in docs/desktop-interactive-answers.md.
/// Only trusted wrapper JavaScript owns the native handler. Generated content has an opaque origin.
enum NativeInteractiveSandbox {
    static let hostWorld = WKContentWorld.world(name: "MultiVibeInteractiveHost")
    static let hostBridge = """
        let lastProposal = 0;
        window.addEventListener('message', function(event) {
          const frame = document.querySelector('iframe');
          if (!frame || event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object') return;
          const message = event.data;
          if (Date.now() - lastProposal < 500) return;
          if (message.type === 'send-prompt' && typeof message.text === 'string' && message.text.trim() && message.text.length <= 8000) {
            lastProposal = Date.now(); window.webkit.messageHandlers.interactive.postMessage({type:'send-prompt',text:message.text});
          } else if (message.type === 'open-link' && typeof message.url === 'string' && message.url.length <= 2048) {
            try { const url = new URL(message.url); if(url.protocol !== 'https:' || url.username || url.password) return;
              lastProposal = Date.now(); window.webkit.messageHandlers.interactive.postMessage({type:'open-link',url:url.href}); } catch {}
          }
        });
    """
    static func page(_ document: NativeInteractiveDocument) -> String {
        let values: [String: String] = ["html": document.html, "css": document.css ?? "",
                                       "jsFunctions": document.jsFunctions ?? "", "jsExpressions": document.jsExpressions ?? ""]
        let data = try! JSONSerialization.data(withJSONObject: values)
        let payload = String(decoding: data, as: UTF8.self)
            .replacingOccurrences(of: "<", with: "\\u003c")
            .replacingOccurrences(of: ">", with: "\\u003e")
            .replacingOccurrences(of: "&", with: "\\u0026")
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        return """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src about:; base-uri 'none'; form-action 'none'">
        <style>html,body{margin:0;height:100%;background:transparent}iframe{border:0;width:100%;height:100%;display:block}</style>
        </head><body><iframe sandbox="allow-scripts" title="Interactive answer"></iframe><script>
        const data = \(payload);
        const frame = document.querySelector('iframe');
        const bridge = "window.sendPrompt=function(text){parent.postMessage({type:'send-prompt',text:text},'*')};window.openLink=function(url){parent.postMessage({type:'open-link',url:url},'*')};document.addEventListener('click',function(e){const a=e.target.closest('a[href]');if(a){e.preventDefault();window.openLink(a.href)}});";
        const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
        const theme = "html{color-scheme:light dark;font:15px system-ui}body{margin:0;padding:16px;box-sizing:border-box;color:CanvasText;background:Canvas}*{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer}input,select,button{padding:8px;border-radius:6px}svg,canvas{max-width:100%}:focus-visible{outline:2px solid #21895c;outline-offset:2px}";
        const script = code => '<script>' + code + '<' + '/script>';
        frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="' + policy + '"><style>' + theme + data.css + '</style></head><body>' + script(bridge) + data.html + script(data.jsFunctions) + script(data.jsExpressions) + '</body></html>';
        </script></body></html>
        """
    }
}

struct NativeInteractiveWebView: NSViewRepresentable {
    let document: NativeInteractiveDocument
    @Binding var proposal: NativeInteractiveProposal?
    @Binding var error: String?
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> WKWebView { makeWebView(coordinator: context.coordinator) }
    func makeWebView(coordinator: Coordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(coordinator, contentWorld: NativeInteractiveSandbox.hostWorld, name: "interactive")
        configuration.userContentController.addUserScript(WKUserScript(source: NativeInteractiveSandbox.hostBridge,
            injectionTime: .atDocumentStart, forMainFrameOnly: true, in: NativeInteractiveSandbox.hostWorld))
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = coordinator
        coordinator.view = view
        view.loadHTMLString(NativeInteractiveSandbox.page(document), baseURL: nil)
        return view
    }
    func updateNSView(_ view: WKWebView, context: Context) { context.coordinator.parent = self }
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading(); view.configuration.userContentController.removeScriptMessageHandler(forName: "interactive", contentWorld: NativeInteractiveSandbox.hostWorld)
        view.navigationDelegate = nil; coordinator.view = nil
    }
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: NativeInteractiveWebView
        weak var view: WKWebView?
        init(_ parent: NativeInteractiveWebView) { self.parent = parent }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "interactive", message.webView === view, message.frameInfo.isMainFrame,
                  let proposal = NativeInteractiveProposal.parse(message.body) else { return }
            parent.proposal = proposal
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // Only WebKit's initial blank/srcdoc loads. No navigation, downloads or custom schemes.
            let url = action.request.url?.absoluteString ?? ""
            decisionHandler(action.navigationType == .other && (url == "about:blank" || url == "about:srcdoc") ? .allow : .cancel)
        }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { parent.error = "La réponse interactive a été arrêtée. Réinitialisez-la pour réessayer." }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { parent.error = "Impossible d’afficher cette réponse interactive." }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { parent.error = "Impossible d’afficher cette réponse interactive." }
    }
}
