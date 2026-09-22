import Foundation
/// SSE events can span multiple data lines and arbitrary network chunk boundaries.
public struct SSEParser {
    public init() {}
    private var dataLines: [String] = []
    public mutating func consume(_ line: String) -> String? {
        if line.isEmpty {
            defer { dataLines.removeAll(keepingCapacity: true) }
            return dataLines.isEmpty ? nil : dataLines.joined(separator: "\n")
        }
        if line == "data" { dataLines.append("") }
        else if line.hasPrefix("data:") {
            var value = String(line.dropFirst(5))
            if value.first == " " { value.removeFirst() }
            dataLines.append(value)
        }
        return nil
    }
}
/// Byte-level framing preserves empty lines and CR/LF/CRLF event boundaries.
/// Limits cover comments/unknown fields too, so an untrusted stream cannot grow
/// an unterminated line or event without bound.
public struct SSEByteParser {
    private var line: [UInt8] = []
    private var parser = SSEParser()
    private var afterCR = false
    private var firstLine = true
    private var eventBytes = 0
    let maximumBytes: Int
    public init(maximumBytes: Int = 1_048_576) { self.maximumBytes = maximumBytes }

    public mutating func consume(_ byte: UInt8) throws -> String? {
        if afterCR {
            afterCR = false
            if byte == 10 { return nil }
        }
        guard eventBytes < maximumBytes else { throw MultiVibeError.invalidResponse }
        eventBytes += 1
        if byte == 13 || byte == 10 {
            afterCR = byte == 13
            guard var text = String(bytes: line, encoding: .utf8) else { throw MultiVibeError.invalidResponse }
            line.removeAll(keepingCapacity: true)
            if firstLine {
                firstLine = false
                if text.first == "\u{FEFF}" { text.removeFirst() }
            }
            if text.isEmpty { eventBytes = 0 }
            return parser.consume(text)
        }
        line.append(byte)
        return nil
    }
}
