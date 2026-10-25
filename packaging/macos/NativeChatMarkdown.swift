import SwiftUI

enum ChatMarkdownBlock: Equatable {
    case paragraph(String)
    case heading(Int, String)
    case bullet(String)
    case numbered(String, String)
    case quote(String)
    case code(String, String?)
    case divider
}

enum ChatMarkdownParser {
    static func parse(_ source: String) -> [ChatMarkdownBlock] {
        var result: [ChatMarkdownBlock] = []
        var paragraph: [String] = []
        var code: [String] = []
        var fence: String?
        var language: String?
        func flushParagraph() {
            let value = paragraph.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { result.append(.paragraph(value)) }
            paragraph = []
        }
        for line in source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let current = fence {
                if trimmed.hasPrefix(current) {
                    result.append(.code(code.joined(separator: "\n"), language))
                    fence = nil; language = nil; code = []
                } else { code.append(line) }
                continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushParagraph()
                let marker = trimmed.first!, count = trimmed.prefix { $0 == marker }.count
                fence = String(repeating: String(marker), count: count)
                let suffix = trimmed.dropFirst(count).trimmingCharacters(in: .whitespaces)
                language = suffix.isEmpty ? nil : suffix
            } else if trimmed.isEmpty { flushParagraph() }
            else if let heading = heading(trimmed) { flushParagraph(); result.append(.heading(heading.level, heading.text)) }
            else if ["---", "***", "___"].contains(trimmed) { flushParagraph(); result.append(.divider) }
            else if let bullet = ["- ", "* ", "+ "].first(where: { trimmed.hasPrefix($0) }) {
                flushParagraph(); result.append(.bullet(String(trimmed.dropFirst(bullet.count))))
            } else if let numbered = numbered(trimmed) {
                flushParagraph(); result.append(.numbered(numbered.number, numbered.text))
            } else if trimmed.hasPrefix("> ") {
                flushParagraph(); result.append(.quote(String(trimmed.dropFirst(2))))
            } else { paragraph.append(trimmed) }
        }
        if fence != nil { result.append(.code(code.joined(separator: "\n"), language)) }
        flushParagraph()
        return result
    }
    private static func heading(_ line: String) -> (level: Int, text: String)? {
        let count = line.prefix { $0 == "#" }.count
        guard (1...6).contains(count), line.dropFirst(count).first == " " else { return nil }
        return (count, line.dropFirst(count + 1).trimmingCharacters(in: .whitespaces))
    }
    private static func numbered(_ line: String) -> (number: String, text: String)? {
        guard let separator = line.firstIndex(of: "."), line.index(after: separator) < line.endIndex,
              line[line.index(after: separator)] == " ", !line[..<separator].isEmpty,
              line[..<separator].allSatisfy(\.isNumber) else { return nil }
        return (String(line[...separator]), String(line[line.index(separator, offsetBy: 2)...]))
    }
}

struct ChatMarkdownView: View {
    let content: String
    private var blocks: [ChatMarkdownBlock] { ChatMarkdownParser.parse(content) }
    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                switch block {
                case .paragraph(let text): inline(text).font(.system(size: 15)).lineSpacing(5)
                case .heading(let level, let text):
                    inline(text).font(.system(size: level == 1 ? 23 : level == 2 ? 19 : 16, weight: .semibold, design: .rounded))
                        .tracking(level <= 2 ? -0.25 : 0).padding(.top, index == 0 ? 0 : 4)
                case .bullet(let text):
                    HStack(alignment: .firstTextBaseline, spacing: 10) { Text("•").foregroundStyle(ChatPalette.accent); inline(text).font(.system(size: 15)).lineSpacing(4) }
                        .padding(.leading, 4)
                case .numbered(let number, let text):
                    HStack(alignment: .firstTextBaseline, spacing: 10) { Text(number).font(.system(size: 14, weight: .semibold)).foregroundStyle(.secondary).frame(minWidth: 20, alignment: .trailing); inline(text).font(.system(size: 15)).lineSpacing(4) }
                case .quote(let text):
                    HStack(spacing: 12) { RoundedRectangle(cornerRadius: 2).fill(ChatPalette.accent.opacity(0.55)).frame(width: 3); inline(text).font(.system(size: 15)).foregroundStyle(.secondary).lineSpacing(4) }
                case .code(let text, let language):
                    VStack(alignment: .leading, spacing: 8) {
                        if let language { Text(language.uppercased()).font(.system(size: 9, weight: .semibold)).tracking(0.6).foregroundStyle(.secondary) }
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(text).font(.system(size: 12.5, design: .monospaced)).fixedSize(horizontal: true, vertical: false)
                        }
                    }.padding(13).frame(maxWidth: .infinity, alignment: .leading).background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 10))
                case .divider: Divider().padding(.vertical, 2)
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
    }
    private func inline(_ text: String) -> Text {
        Text((try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text))
    }
}
