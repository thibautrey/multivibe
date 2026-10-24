import Foundation

/// Native transport for OpenIntelligentUI's ordered generateSandboxedUi fields.
/// Documents are immutable chat snapshots; local control state stays in the sandbox.
struct NativeInteractiveDocument: Decodable, Equatable {
    let title: String
    let initialHeight: Double?
    let placeholderMessages: [String]?
    let css: String?
    let html: String
    let jsFunctions: String?
    let jsExpressions: String?

    static let maximumBytes = 200_000
    var height: Double { min(800, max(200, initialHeight ?? 420)) }
    var valid: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && title.count <= 160 &&
        !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        [css ?? "", html, jsFunctions ?? "", jsExpressions ?? ""].reduce(0, { $0 + $1.utf8.count }) <= Self.maximumBytes &&
        (initialHeight?.isFinite ?? true)
    }
    enum Segment: Equatable {
        case text(String), document(NativeInteractiveDocument), pending
    }
    /// Parse only complete, explicitly typed fences. Ordinary code stays literal.
    static func segments(_ content: String) -> [Segment] {
        var result: [Segment] = [], text = "", block = ""
        var fence: String?, interactive = false
        func flush() { if !text.isEmpty { result.append(.text(text)); text = "" } }
        for line in content.split(separator: "\n", omittingEmptySubsequences: false) {
            let row = String(line), trimmed = row.trimmingCharacters(in: .whitespaces)
            if let current = fence {
                if trimmed == current {
                    if interactive {
                        let data = Data(block.utf8)
                        if data.count <= maximumBytes, let document = try? JSONDecoder().decode(Self.self, from: data), document.valid {
                            flush(); result.append(.document(document))
                        } else { text += "```intelligent-ui\n" + block + row + "\n" }
                    } else { text += row + "\n" }
                    fence = nil; interactive = false; block = ""
                } else if interactive { block += row + "\n" }
                else { text += row + "\n" }
            } else if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                let marker = trimmed.first!, count = trimmed.prefix(while: { $0 == marker }).count
                fence = String(repeating: String(marker), count: count)
                interactive = trimmed == "```intelligent-ui"
                if interactive { flush() } else { text += row + "\n" }
            } else { text += row + "\n" }
        }
        if interactive { flush(); result.append(.pending) }
        flush()
        return result
    }

    static let instructions = """
    Desktop presentation capability (OpenIntelligentUI): use plain text for direct answers.
    When a visualization, comparison, calculator or simulation would help, explain briefly and emit a
    complete ```intelligent-ui JSON code fence with title, initialHeight (200-800), placeholderMessages,
    css, html, jsFunctions, jsExpressions in that order. html is a self-contained body fragment;
    css and JavaScript are strings. Prefer semantic HTML. The default theme provides card, panel,
    grid, stack, actions, eyebrow, metric, muted and badge classes plus polished forms and tables.
    Use inline SVG, canvas and standard browser APIs. No external
    libraries, network, storage, native APIs, forms to external URLs, or top-level await.
    Build working local controls with accessible labels. Clearly label illustrative data and assumptions.
    window.sendPrompt(text) proposes a follow-up draft including selected values for user review;
    window.openLink(httpsURL) proposes a link for user review. Nothing sends automatically.
    Prior documents are independent snapshots; output a new document for revisions. Never wrap
    ordinary source code in intelligent-ui. Keep JSON valid and under 200000 UTF-8 bytes.
    """
    static func prompt(_ text: String) -> String { instructions + "\n\nUser request:\n" + text }
    static func messages(_ messages: [[String: String]]) -> [[String: String]] {
        var result = messages
        if let index = result.lastIndex(where: { $0["role"] == "user" }) {
            result[index]["content"] = prompt(result[index]["content"] ?? "")
        }
        return result
    }
}

/// Only a proposal reaches native UI; the native button requires a separate user action.
enum NativeInteractiveProposal: Equatable {
    case prompt(String), link(URL)
    static func parse(_ body: Any) -> Self? {
        guard let object = body as? [String: Any], let type = object["type"] as? String else { return nil }
        if type == "send-prompt", let text = object["text"] as? String,
           !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf8.count <= 8_000 { return .prompt(text) }
        if type == "open-link", let raw = object["url"] as? String, raw.utf8.count <= 2_048,
           let url = URL(string: raw), url.scheme?.lowercased() == "https", url.host != nil,
           url.user == nil, url.password == nil { return .link(url) }
        return nil
    }
}
