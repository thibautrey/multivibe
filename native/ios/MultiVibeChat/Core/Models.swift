import Foundation

struct ChatMessage: Codable, Identifiable, Equatable, Sendable {
    var id: UUID = UUID()
    var role: String
    var content: String
    enum Completion: String, Codable, Sendable { case streaming, completed, stopped, failed }
    // Optional for compatibility with conversations saved before completion tracking.
    var completion: Completion?
    var canRetry: Bool { role == "assistant" && (completion == .stopped || completion == .failed) }
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

/// Parse only the exact first-party recovery URL. Never navigate to a pasted
/// URL or send its fragment to a destination chosen by the clipboard content.
enum PasswordResetLink {
    static func token(from raw: String) -> String? {
        guard raw.utf8.count <= 512,
              let url = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "https", url.host == "auth.multivibe.cloud",
              url.user == nil, url.password == nil, url.port == nil,
              url.path == "/password/reset", url.query == nil,
              let fragment = url.percentEncodedFragment,
              fragment.hasPrefix("token=") else { return nil }
        let token = String(fragment.dropFirst(6))
        guard token.utf8.count == 43, token.utf8.allSatisfy({
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }) else { return nil }
        return token
    }
}

struct PasswordRecoveryRequest: Identifiable {
    let id = UUID()
    let link: String
    let email: String
    init(email: String) { self.email = email; link = "" }
    init?(url: URL) {
        guard PasswordResetLink.token(from: url.absoluteString) != nil else { return nil }
        link = url.absoluteString
        email = ""
    }
}

/// Retain unknown web fields and off-screen branches instead of flattening the
/// server snapshot on the next native save.
indirect enum HistoryJSON: Codable, Equatable, Sendable {
    case object([String: HistoryJSON]), array([HistoryJSON]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let bool = try? value.decode(Bool.self) { self = .bool(bool) }
        else if let number = try? value.decode(Double.self) { self = .number(number) }
        else if let string = try? value.decode(String.self) { self = .string(string) }
        else if let array = try? value.decode([HistoryJSON].self) { self = .array(array) }
        else { self = .object(try value.decode([String: HistoryJSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let object): try value.encode(object)
        case .array(let array): try value.encode(array)
        case .string(let string): try value.encode(string)
        case .number(let number): try value.encode(number)
        case .bool(let bool): try value.encode(bool)
        case .null: try value.encodeNil()
        }
    }
    var object: [String: HistoryJSON]? { if case .object(let value) = self { value } else { nil } }
    var array: [HistoryJSON]? { if case .array(let value) = self { value } else { nil } }
    var string: String? { if case .string(let value) = self { value } else { nil } }
    var number: Double? { if case .number(let value) = self { value } else { nil } }
}

struct AccountHistorySnapshot: Codable, Sendable {
    var accountId: String
    var revision: Int
    var conversations: [HistoryJSON]
    var folders: [HistoryJSON]?

    /// Display only the selected branch. Keep the raw snapshot alongside this
    /// projection: web identifiers need not be UUIDs and must never be rewritten.
    func projectedConversation(at index: Int, id: UUID, messageIDs: inout [String: UUID]) throws -> Conversation {
        guard conversations.indices.contains(index), let item = conversations[index].object,
              let title = item["title"]?.string, let timestamp = item["updatedAt"]?.number,
              let repository = item["repository"]?.object, let entries = repository["messages"]?.array else {
            throw APIError.invalidResponse
        }
        var nodes: [String: [String: HistoryJSON]] = [:]
        for entry in entries {
            guard let node = entry.object, let message = node["message"]?.object,
                  let key = message["id"]?.string, nodes[key] == nil else { throw APIError.invalidResponse }
            nodes[key] = node
        }
        var cursor = repository["headId"]?.string
        var visited = Set<String>(), messages: [ChatMessage] = []
        while let key = cursor {
            guard visited.insert(key).inserted, let node = nodes[key],
                  let message = node["message"]?.object, let role = message["role"]?.string,
                  ["user", "assistant", "system"].contains(role), let parts = message["content"]?.array else { throw APIError.invalidResponse }
            let text = try parts.map { part -> String in
                guard let object = part.object, object["type"]?.string == "text", let text = object["text"]?.string else { throw APIError.invalidResponse }
                return text
            }.joined(separator: "\n")
            let localID = messageIDs[key] ?? UUID()
            messageIDs[key] = localID
            let status = message["status"]?.object?["type"]?.string
            let completion: ChatMessage.Completion? = role != "assistant" ? nil : status == "complete" ? .completed : status == "incomplete" ? .stopped : nil
            messages.append(ChatMessage(id: localID, role: role, content: text, completion: completion))
            if node["parentId"] == .null { cursor = nil }
            else if let parent = node["parentId"]?.string { cursor = parent }
            else { throw APIError.invalidResponse }
        }
        return Conversation(id: id, title: title, model: item["model"]?.string ?? "", messages: messages.reversed(), updatedAt: Date(timeIntervalSince1970: timestamp / 1000))
    }
}
