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
                    ChatMarkdownView(content: text)
                case .document(let document):
                    NativeInteractiveCard(document: document, proposePrompt: proposePrompt)
                case .pending:
                    HStack(spacing: 10) {
                        if streaming { ProgressView().controlSize(.small) }
                        else { Image(systemName: "exclamationmark.circle") }
                        Text(streaming ? "Création de la réponse interactive…" : "Réponse interactive incomplète")
                    }
                    .font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(Color(nsColor: .controlBackgroundColor), in: Capsule())
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
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().opacity(0.55)
            NativeInteractiveWebView(document: document, proposal: $proposal, error: $error)
                .id(reload).frame(height: document.height)
                .accessibilityLabel(document.title)
                .background(Color(nsColor: .textBackgroundColor).opacity(0.55))
            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.red)
                    .padding(.horizontal, 16).padding(.vertical, 10)
            }
            if let proposal {
                Divider().opacity(0.55)
                proposalView(proposal)
            }
            Divider().opacity(0.55)
            sourceDisclosure
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(.quaternary, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
        .shadow(color: .black.opacity(0.055), radius: 14, y: 5)
    }

    private var header: some View {
        HStack(spacing: 11) {
            ZStack {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(.tint.opacity(0.12))
                Image(systemName: "sparkles.rectangle.stack")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(.tint)
            }.frame(width: 32, height: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(document.title).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                Text("RÉPONSE INTERACTIVE").font(.system(size: 9, weight: .bold)).tracking(0.7).foregroundStyle(.tertiary)
            }
            Spacer()
            Button { proposal = nil; error = nil; reload = UUID() } label: {
                Image(systemName: "arrow.counterclockwise").font(.system(size: 12, weight: .semibold))
                    .frame(width: 28, height: 28).background(.quaternary.opacity(0.65), in: Circle())
            }.buttonStyle(.plain).foregroundStyle(.secondary)
                .help("Réinitialiser les contrôles")
        }
        .padding(.horizontal, 16).padding(.vertical, 13)
    }

    private func proposalView(_ proposal: NativeInteractiveProposal) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: proposal.icon)
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(.tint)
                .frame(width: 28, height: 28).background(.tint.opacity(0.10), in: Circle())
            VStack(alignment: .leading, spacing: 5) {
                Text(proposal.label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                switch proposal {
                case .prompt(let text):
                    Text(text).font(.callout).lineLimit(4).textSelection(.enabled)
                    Button("Utiliser comme brouillon") { proposePrompt(text); self.proposal = nil }
                        .buttonStyle(.borderedProminent).controlSize(.small)
                case .link(let url):
                    Text(url.absoluteString).font(.caption).foregroundStyle(.secondary).lineLimit(2).textSelection(.enabled)
                    Button("Ouvrir dans le navigateur") { NSWorkspace.shared.open(url); self.proposal = nil }
                        .buttonStyle(.borderedProminent).controlSize(.small)
                }
            }
            Spacer(minLength: 8)
            Button { self.proposal = nil } label: { Image(systemName: "xmark") }
                .buttonStyle(.plain).foregroundStyle(.secondary).help("Ignorer")
        }
        .padding(.horizontal, 16).padding(.vertical, 13)
        .background(.tint.opacity(0.045))
    }

    private var sourceText: String {
        let sections: [String] = [document.html, document.css ?? "",
                                  document.jsFunctions ?? "", document.jsExpressions ?? ""]
        return sections.joined(separator: "\n")
    }

    private var sourceDisclosure: some View {
        DisclosureGroup {
            ScrollView {
                Text(sourceText)
                    .font(.system(size: 10.5, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
            }.frame(maxHeight: 180)
        } label: {
            Label("Afficher le code", systemImage: "chevron.left.forwardslash.chevron.right")
        }
        .font(.caption).foregroundStyle(.secondary)
        .padding(.horizontal, 16).padding(.vertical, 11)
    }
}

private extension NativeInteractiveProposal {
    var label: String {
        switch self { case .prompt: return "SUITE PROPOSÉE"; case .link: return "LIEN PROPOSÉ" }
    }
    var icon: String {
        switch self { case .prompt: return "arrow.turn.down.right"; case .link: return "link" }
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
        const theme = `
        :root{color-scheme:light dark;font:14px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;
          --mv-accent:#16875f;--mv-accent-strong:#0d6f4c;--mv-accent-soft:rgba(22,135,95,.10);
          --mv-bg:#fbfcfb;--mv-surface:#fff;--mv-surface-raised:#f4f7f5;--mv-text:#152019;
          --mv-muted:#68736c;--mv-border:rgba(28,45,35,.13);--mv-shadow:0 10px 30px rgba(18,39,27,.07)}
        @media(prefers-color-scheme:dark){:root{--mv-accent:#65d9a5;--mv-accent-strong:#83e7b8;--mv-accent-soft:rgba(101,217,165,.12);
          --mv-bg:#171a18;--mv-surface:#202421;--mv-surface-raised:#282d29;--mv-text:#eef5f0;
          --mv-muted:#9da9a1;--mv-border:rgba(224,244,231,.12);--mv-shadow:0 12px 34px rgba(0,0,0,.22)}}
        *{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--mv-bg);color:var(--mv-text)}
        body{padding:22px}h1,h2,h3{margin:0 0 12px;line-height:1.18;letter-spacing:-.025em}h1{font-size:24px}h2{font-size:19px}h3{font-size:15px}
        p{margin:0 0 14px;color:var(--mv-muted)}a{color:var(--mv-accent-strong);text-underline-offset:3px}
        form,.card,.panel,[data-card]{padding:18px;border:1px solid var(--mv-border);border-radius:14px;background:var(--mv-surface);box-shadow:var(--mv-shadow)}
        .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.stack{display:grid;gap:14px}.actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
        .eyebrow{margin:0 0 5px;color:var(--mv-accent-strong);font-size:10px;font-weight:750;letter-spacing:.09em;text-transform:uppercase}
        .metric{padding:14px;border-radius:11px;background:var(--mv-accent-soft)}.muted{color:var(--mv-muted)}
        .badge{display:inline-flex;padding:4px 8px;border-radius:999px;color:var(--mv-accent-strong);background:var(--mv-accent-soft);font-size:11px;font-weight:700}
        label{display:grid;gap:7px;color:var(--mv-muted);font-size:12px;font-weight:650;letter-spacing:.015em}
        input,select,textarea,button{font:inherit}input,select,textarea{width:100%;min-height:40px;padding:9px 11px;color:var(--mv-text);background:var(--mv-surface-raised);
          border:1px solid var(--mv-border);border-radius:9px;outline:none;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease}
        input:hover,select:hover,textarea:hover{border-color:var(--mv-accent)}
        input:focus,select:focus,textarea:focus{border-color:var(--mv-accent);box-shadow:0 0 0 3px var(--mv-accent-soft);background:var(--mv-surface)}
        input[type=range]{padding:0;accent-color:var(--mv-accent);background:transparent;border:0;box-shadow:none}
        input[type=checkbox],input[type=radio]{width:auto;min-height:auto;accent-color:var(--mv-accent)}
        button{min-height:38px;padding:8px 13px;border:0;border-radius:9px;color:#fff;background:var(--mv-accent-strong);font-weight:650;cursor:pointer;
          box-shadow:0 4px 12px rgba(13,111,76,.16);transition:transform .14s ease,filter .14s ease,box-shadow .14s ease}
        button:hover{filter:brightness(1.06);box-shadow:0 6px 16px rgba(13,111,76,.22)}button:active{transform:translateY(1px)}button:disabled{opacity:.48;cursor:default;box-shadow:none}
        output{display:block;font-size:26px;font-weight:720;letter-spacing:-.035em;color:var(--mv-text);font-variant-numeric:tabular-nums}
        table{width:100%;border-collapse:separate;border-spacing:0;border:1px solid var(--mv-border);border-radius:12px;overflow:hidden;background:var(--mv-surface)}
        th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--mv-border)}th{font-size:11px;letter-spacing:.055em;text-transform:uppercase;color:var(--mv-muted);background:var(--mv-surface-raised)}tr:last-child td{border-bottom:0}
        hr{border:0;border-top:1px solid var(--mv-border);margin:18px 0}svg,canvas,img{max-width:100%}
        code{padding:2px 5px;border-radius:5px;background:var(--mv-surface-raised);font:12px ui-monospace,SFMono-Regular,monospace}
        :focus-visible{outline:2px solid var(--mv-accent);outline-offset:3px}
        @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
        `;
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
