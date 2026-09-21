import AuthenticationServices
import Foundation

struct ChatMessage: Codable, Identifiable, Equatable, Sendable {
    var id: UUID = UUID()
    var role: String
    var content: String
    enum Completion: String, Codable, Sendable { case streaming, completed, stopped, failed }
    // Optional for compatibility with conversations saved before completion tracking.
    var localEvents: [LocalAgentEvent]?
    var memoryReferences: [MemoryReference]?
    /// Rich, device-owned presentation data. Cloud history deliberately serializes only `content`.
    var nativeContent: NativeContentPayload?
    var completion: Completion?
    var canRetry: Bool { role == "assistant" && (completion == .stopped || completion == .failed) }
}

struct NativeContentPayload: Codable, Equatable, Sendable {
    static let currentVersion = 1
    var version = currentVersion
    var blocks: [NativeContentBlock]
    init(blocks: [NativeContentBlock]) { self.blocks = Array(blocks.prefix(50)) }
}

enum NativeContentBlock: Codable, Equatable, Sendable, Identifiable {
    struct CalendarEvent: Codable, Equatable, Sendable, Identifiable {
        let id: String
        let title: String
        let start: Date
        let end: Date
        let calendar: String
        let location: String?
        let isAllDay: Bool
    }
    struct Reminder: Codable, Equatable, Sendable, Identifiable {
        let id: String
        let title: String
        let due: Date?
        var isCompleted: Bool
        let list: String
    }
    struct Contact: Codable, Equatable, Sendable, Identifiable {
        let id: String
        let name: String
        let phones: [String]
        let emails: [String]
    }
    struct Location: Codable, Equatable, Sendable {
        let latitude: Double
        let longitude: Double
        let accuracy: Double
        let measuredAt: Date
    }
    struct WebSource: Codable, Equatable, Sendable {
        let url: URL
        let status: Int
        let contentType: String
        let excerpt: String
    }
    struct Document: Codable, Equatable, Sendable {
        let id: UUID
        let name: String
        let excerpt: String
    }

    case agenda(title: String, events: [CalendarEvent])
    case reminders(title: String, items: [Reminder])
    case contacts(title: String, items: [Contact])
    case location(Location)
    case web(WebSource)
    case document(Document)

    var id: String {
        switch self {
        case .agenda(let title, let events): "agenda:\(title):\(events.first?.id ?? "empty")"
        case .reminders(let title, let items): "reminders:\(title):\(items.first?.id ?? "empty")"
        case .contacts(let title, let items): "contacts:\(title):\(items.first?.id ?? "empty")"
        case .location(let value): "location:\(value.latitude):\(value.longitude)"
        case .web(let value): "web:\(value.url.absoluteString)"
        case .document(let value): "document:\(value.id.uuidString)"
        }
    }
}

struct LocalToolResult: Sendable {
    let modelText: String
    let blocks: [NativeContentBlock]
    init(_ modelText: String, blocks: [NativeContentBlock] = []) {
        self.modelText = modelText
        self.blocks = blocks
    }
}
struct Conversation: Codable, Identifiable, Equatable, Sendable {
    var id: UUID = UUID()
    var title = "Nouvelle conversation"
    var internetPermission: ConversationInternetPermission?
    var memorySourceID: UUID?
    var memoryScope: String?
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
    var passkeyOptions: NativePasskeyOptions?
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
        case .server(503, "memory_sync_not_supported"):
            "Le serveur ne prend pas encore en charge la mémoire. Vos souvenirs restent sur cet appareil."
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
    var memory: [AgentMemory]?

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
            let events = try message["multivibeLocalEvents"].map {
                try JSONDecoder().decode([LocalAgentEvent].self, from: JSONEncoder().encode($0))
            }
            let references = try message["multivibeMemoryReferences"].map {
                try JSONDecoder().decode([MemoryReference].self, from: JSONEncoder().encode($0))
            }
            messages.append(ChatMessage(id: localID, role: role, content: text, localEvents: events, memoryReferences: references, completion: completion))
            if node["parentId"] == .null { cursor = nil }
            else if let parent = node["parentId"]?.string { cursor = parent }
            else { throw APIError.invalidResponse }
        }
        return Conversation(id: id, title: title, memorySourceID: item["multivibeSourceID"]?.string.flatMap(UUID.init(uuidString:)), memoryScope: item["multivibeMemoryScope"]?.string, model: item["model"]?.string ?? "", messages: messages.reversed(), updatedAt: Date(timeIntervalSince1970: timestamp / 1000))
    }
}

extension AccountHistorySnapshot {
    /// Replace the selected branch projection, retaining all original graph nodes
    /// and metadata. Changed native nodes receive new IDs, so alternate web
    /// branches that reference the originals remain untouched.
    mutating func store(_ conversation: Conversation, serverID: String,
                        messageIDs: inout [String: UUID]) throws {
        let index = conversations.firstIndex { $0.object?["id"]?.string == serverID }
        var item = index.flatMap { conversations[$0].object } ?? [:]
        var repository = item["repository"]?.object ?? [:]
        var entries = repository["messages"]?.array ?? []
        var nodes: [String: HistoryJSON] = [:]
        for entry in entries {
            guard let id = entry.object?["message"]?.object?["id"]?.string,
                  nodes.updateValue(entry, forKey: id) == nil else { throw APIError.invalidResponse }
        }
        var parent: HistoryJSON = .null
        for message in conversation.messages {
            let candidates = messageIDs.filter { $0.value == message.id }.map(\.key).sorted()
            let matching = candidates.first { id in
                guard let entry = nodes[id]?.object, entry["parentId"] == parent,
                      let original = entry["message"]?.object, original["role"]?.string == message.role,
                      let parts = original["content"]?.array else { return false }
                if message.role == "assistant" {
                    let expected = message.completion == .completed ? "complete" : "incomplete"
                    guard original["status"]?.object?["type"]?.string == expected else { return false }
                }
                return parts.compactMap { $0.object?["text"]?.string }.joined(separator: "\n") == message.content
            }
            if let matching { parent = .string(matching); continue }
            let id = UUID().uuidString
            var node: [String: HistoryJSON] = [
                "id": .string(id), "role": .string(message.role),
                "createdAt": .string(ISO8601DateFormatter().string(from: conversation.updatedAt)),
                "content": .array([.object(["type": .string("text"), "text": .string(message.content)])])
            ]
            if let events = message.localEvents {
                node["multivibeLocalEvents"] = try JSONDecoder().decode(HistoryJSON.self, from: JSONEncoder().encode(events))
            }
            if let references = message.memoryReferences {
                node["multivibeMemoryReferences"] = try JSONDecoder().decode(HistoryJSON.self, from: JSONEncoder().encode(references))
            }
            if message.role == "assistant" {
                let complete = message.completion == .completed
                node["status"] = .object(["type": .string(complete ? "complete" : "incomplete"),
                                          "reason": .string(complete ? "stop" : "cancelled")])
            }
            let entry = HistoryJSON.object(["parentId": parent, "message": .object(node)])
            entries.append(entry); nodes[id] = entry; messageIDs[id] = message.id
            parent = .string(id)
        }
        repository["messages"] = .array(entries); repository["headId"] = parent
        item["multivibeSourceID"] = .string((conversation.memorySourceID ?? conversation.id).uuidString)
        item["id"] = .string(serverID); item["title"] = .string(conversation.title)
        item["updatedAt"] = .number(conversation.updatedAt.timeIntervalSince1970 * 1000)
        item["model"] = .string(conversation.model)
        if let scope = conversation.memoryScope { item["multivibeMemoryScope"] = .string(scope) }
        if item["renamed"] == nil { item["renamed"] = .bool(false) }
        if item["draft"] == nil { item["draft"] = .string("") }
        item["repository"] = .object(repository)
        if let index { conversations[index] = .object(item) }
        else { conversations.append(.object(item)) }
    }
}

/// Same pre-normalization UTF-8 limits as the Cloud email/password identity service.
/// Never trim or normalize the submitted secret in the native client.
enum NativePasswordPolicy {
    static func accepts(_ password: String) -> Bool {
        let length = password.utf8.count
        return (12...256).contains(length) && password.unicodeScalars.contains { scalar in
            // ECMAScript WhiteSpace + LineTerminator, matching the server's \S.
            switch scalar.value {
            case 0x0009...0x000D, 0x0020, 0x00A0, 0x1680, 0x2000...0x200A,
                 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: false
            default: true
            }
        }
    }
}

/// A deliberately small block subset; unsupported Markdown remains readable text.
/// Fences are recognized even before their closing delimiter arrives in a stream.
enum MessageBlock: Equatable {
    case prose(String)
    case heading(String, Int)
    case bullet(String)
    case checklist(String, Bool)
    case quote(String)
    case table([[String]])
    case code(String, String)

    static func parse(_ source: String) -> [MessageBlock] {
        var result: [MessageBlock] = []
        var prose: [String] = []
        var code: [String] = []
        var fence: Character?
        var fenceLength = 0
        var language = ""
        func flushProse() {
            if !prose.isEmpty { result.append(.prose(prose.joined(separator: "\n"))); prose = [] }
        }
        let sourceLines = source.components(separatedBy: "\n")
        var lineIndex = 0
        while lineIndex < sourceLines.count {
            let line = sourceLines[lineIndex]
            let leading = line.prefix(while: { $0 == " " }).count
            let candidate = line.dropFirst(min(leading, 3))
            let delimiter = candidate.first
            let length = candidate.prefix(while: { $0 == delimiter }).count
            if let open = fence {
                if leading <= 3, delimiter == open, length >= fenceLength,
                   candidate.dropFirst(length).trimmingCharacters(in: .whitespaces).isEmpty {
                    result.append(.code(code.joined(separator: "\n"), language))
                    code = []; fence = nil
                } else { code.append(line) }
                lineIndex += 1; continue
            }
            if leading <= 3, let delimiter, delimiter == "`" || delimiter == "~", length >= 3 {
                let info = String(candidate.dropFirst(length)).trimmingCharacters(in: .whitespaces)
                if delimiter != "`" || !info.contains("`") {
                    flushProse(); fence = delimiter; fenceLength = length; language = String(info.prefix(80))
                    lineIndex += 1; continue
                }
            }
            if line.contains("|"), lineIndex + 1 < sourceLines.count,
               sourceLines[lineIndex + 1].range(of: #"^\s*\|?\s*:?-{3,}"#, options: .regularExpression) != nil {
                flushProse()
                var rows: [[String]] = [tableCells(line)]
                lineIndex += 2
                while lineIndex < sourceLines.count, sourceLines[lineIndex].contains("|") {
                    rows.append(tableCells(sourceLines[lineIndex])); lineIndex += 1
                }
                result.append(.table(rows)); continue
            }
            let hashes = candidate.prefix(while: { $0 == "#" }).count
            if leading <= 3, (1...6).contains(hashes), candidate.dropFirst(hashes).first == " " {
                flushProse(); result.append(.heading(String(candidate.dropFirst(hashes + 1)), hashes))
            } else if leading <= 3, candidate.range(of: #"^[-*+] \[[ xX]\] "#, options: .regularExpression) != nil {
                flushProse(); result.append(.checklist(String(candidate.dropFirst(6)), candidate.dropFirst(3).first?.lowercased() == "x"))
            } else if leading <= 3, candidate.hasPrefix("> ") {
                flushProse(); result.append(.quote(String(candidate.dropFirst(2))))
            } else if leading <= 3, ["- ", "* ", "+ "].contains(where: { candidate.hasPrefix($0) }) {
                flushProse(); result.append(.bullet(String(candidate.dropFirst(2))))
            } else if line.isEmpty {
                flushProse()
            } else { prose.append(line) }
            lineIndex += 1
        }
        if fence != nil { result.append(.code(code.joined(separator: "\n"), language)) }
        flushProse()
        return result
    }

    private static func tableCells(_ line: String) -> [String] {
        line.trimmingCharacters(in: CharacterSet(charactersIn: " |")).split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// Model text may propose links, but must not launch app/deep-link schemes.
    static func inline(_ text: String) -> AttributedString {
        var value = (try? AttributedString(markdown: text, options: .init(
            interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
        let unsafeRanges = value.runs.compactMap { run -> Range<AttributedString.Index>? in
            guard let link = run.link else { return nil }
            guard ["https", "http"].contains(link.scheme?.lowercased() ?? ""),
                  link.host != nil, link.user == nil, link.password == nil else { return run.range }
            return nil
        }
        for range in unsafeRanges { value[range].link = nil }
        return value
    }
}

struct NativePasskeyOptions: Decodable, Sendable {
    struct Credential: Decodable, Sendable { let id: String; let type: String }
    let challenge: String
    let rpId: String
    let allowCredentials: [Credential]
    func request() throws -> ASAuthorizationPlatformPublicKeyCredentialAssertionRequest {
        guard rpId == "app.multivibe.cloud", let bytes = Self.decode(challenge), !bytes.isEmpty,
              !allowCredentials.isEmpty, allowCredentials.count <= 100 else { throw APIError.invalidResponse }
        let request = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
            .createCredentialAssertionRequest(challenge: bytes)
        request.userVerificationPreference = .required
        request.allowedCredentials = try allowCredentials.map {
            guard $0.type == "public-key", let id = Self.decode($0.id), !id.isEmpty else { throw APIError.invalidResponse }
            return ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: id)
        }
        return request
    }
    static func decode(_ value: String) -> Data? {
        guard !value.isEmpty, value.count <= 4096, value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { return nil }
        let encoded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return Data(base64Encoded: encoded + String(repeating: "=", count: (4 - encoded.count % 4) % 4))
    }
}
