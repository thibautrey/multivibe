import Foundation

struct ChatMessage: Codable, Identifiable, Equatable, Sendable {
    var id: UUID = UUID()
    var role: String
    var content: String
}
struct Conversation: Codable, Identifiable, Equatable, Sendable {
    var id: UUID = UUID()
    var title = "Nouvelle conversation"
    var model: String = ""
    var messages: [ChatMessage] = []
    var updatedAt = Date()
}
struct ModelOption: Codable, Identifiable, Sendable {
    let id: String
    var name: String?
    var displayName: String { name ?? id }
}
struct ModelList: Decodable { let data: [ModelOption] }
struct NativeSession: Codable, Sendable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: Date
    let accountId: String
}
struct AuthReply: Decodable, Sendable {
    var accessToken: String?
    var refreshToken: String?
    var expiresAt: Date?
    var accountId: String?
    var challenge: String?
    var status: String?
    func session() throws -> NativeSession {
        guard let accessToken, let refreshToken, let expiresAt, let accountId else { throw APIError.invalidResponse }
        return NativeSession(accessToken: accessToken, refreshToken: refreshToken, expiresAt: expiresAt, accountId: accountId)
    }
}
enum APIError: LocalizedError {
    case authenticationRequired, invalidResponse, server(Int, String), noModel
    var errorDescription: String? {
        switch self {
        case .authenticationRequired: "Connectez-vous à MultiVibe pour continuer."
        case .invalidResponse: "La réponse du serveur est invalide. Réessayez."
        case .server(let status, let code):
            switch status {
            case 401: "Connexion refusée ou expirée. Vérifiez vos identifiants."
            case 402: "Votre compte ne dispose pas de crédits suffisants."
            case 429: "Trop de demandes. Patientez avant de réessayer."
            case 503: "Ce service est temporairement indisponible."
            default: "La demande a échoué (\(status), \(code))."
            }
        case .noModel: "Choisissez un modèle disponible sur votre compte."
        }
    }
}
/// SSE events can span multiple data lines and arbitrary network chunk boundaries.
struct SSEParser {
    private var dataLines: [String] = []
    mutating func consume(_ line: String) -> String? {
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
struct SSEByteParser {
    private var line: [UInt8] = []
    private var parser = SSEParser()
    private var afterCR = false
    private var firstLine = true
    private var eventBytes = 0
    let maximumBytes: Int
    init(maximumBytes: Int = 1_048_576) { self.maximumBytes = maximumBytes }

    mutating func consume(_ byte: UInt8) throws -> String? {
        if afterCR {
            afterCR = false
            if byte == 10 { return nil }
        }
        guard eventBytes < maximumBytes else { throw APIError.invalidResponse }
        eventBytes += 1
        if byte == 13 || byte == 10 {
            afterCR = byte == 13
            guard var text = String(bytes: line, encoding: .utf8) else { throw APIError.invalidResponse }
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
struct CompletionDelta: Decodable {
    struct Choice: Decodable {
        struct Delta: Decodable { var content: String? }
        var delta: Delta
    }
    var choices: [Choice]
}
