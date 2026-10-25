import Foundation

enum DesktopHarnessError: LocalizedError {
    case rejected(String), invalidResponse
    var errorDescription: String? { switch self { case .rejected(let message): return message; case .invalidResponse: return "Réponse invalide du runtime de harness." } }
}

indirect enum HarnessJSON: Codable, Equatable, Sendable {
    case object([String: HarnessJSON]), array([HarnessJSON]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let v = try? value.decode(Bool.self) { self = .bool(v) }
        else if let v = try? value.decode(String.self) { self = .string(v) }
        else if let v = try? value.decode(Double.self) { self = .number(v) }
        else if let v = try? value.decode([HarnessJSON].self) { self = .array(v) }
        else { self = .object(try value.decode([String: HarnessJSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .null: try value.encodeNil()
        case .bool(let v): try value.encode(v)
        case .string(let v): try value.encode(v)
        case .number(let v): try value.encode(v)
        case .array(let v): try value.encode(v)
        case .object(let v): try value.encode(v)
        }
    }
    subscript(_ key: String) -> HarnessJSON { if case .object(let value) = self { return value[key] ?? .null }; return .null }
    var string: String? { if case .string(let value) = self { return value }; return nil }
    var array: [HarnessJSON] { if case .array(let value) = self { return value }; return [] }
    var object: [String: HarnessJSON] { if case .object(let value) = self { return value }; return [:] }
    var display: String { if let string { return string }; return (try? String(data: JSONEncoder.pretty.encode(self), encoding: .utf8)) ?? "" }
    func decode<T: Decodable>(_ type: T.Type) throws -> T { try JSONDecoder().decode(type, from: JSONEncoder().encode(self)) }
    static func encode<T: Encodable>(_ value: T) throws -> HarnessJSON { try JSONDecoder().decode(HarnessJSON.self, from: JSONEncoder().encode(value)) }
}
private extension JSONEncoder {
    static var pretty: JSONEncoder { let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]; return encoder }
}
struct DesktopHarnessCapability: Codable, Equatable, Sendable {
    var support: String; var available: Bool; var reason: String?; var constraints: HarnessJSON?
}
struct DesktopHarnessDescriptor: Codable, Identifiable, Sendable {
    let id: String; let name: String; let protocolName: String; let version: String?
    let detected: Bool; let configured: Bool; let available: Bool; let reason: String?
    let authentication: String; let capabilities: [String: DesktopHarnessCapability]
    enum CodingKeys: String, CodingKey { case id, name, version, detected, configured, available, reason, authentication, capabilities; case protocolName = "protocol" }
}
struct DesktopHarnessTarget: Codable, Identifiable, Equatable, Sendable {
    var id: String; var name: String; var kind: String; var sshHost: String?; var bridgePath: String?; var container: String?
    static let local = DesktopHarnessTarget(id: "local", name: "Ce Mac", kind: "local")
}
struct DesktopHarnessSession: Codable, Sendable {
    var id: String; var harnessId: String; var targetId: String; var workspace: String; var nativeSessionId: String?
    var title: String; var model: String?; var authMode: String; var state: String; var queuePaused: Bool
    var revision: Int; var activeTurnId: String?; var archived: Bool; var pinned: Bool
    var createdAt: Double; var updatedAt: Double; var capabilities: [String: DesktopHarnessCapability]
    var configuration: HarnessJSON?
    var harnessVersion: String?; var protocolVersion: String?
    var running: Bool { ["starting", "running", "waiting_user", "compacting"].contains(state) }
}
struct DesktopMessagePart: Codable, Equatable, Sendable {
    var type: String; var text: String?; var attachmentId: String?; var uri: String?; var mimeType: String?
    static func text(_ value: String) -> DesktopMessagePart { .init(type: "text", text: value) }
}
struct DesktopHarnessAttachment: Codable, Identifiable, Equatable, Sendable {
    let id: String; let name: String; let mimeType: String; let size: Int; let sha256: String
}
struct DesktopDraftAttachment: Codable, Identifiable, Equatable {
    let id: UUID; let name: String; let mimeType: String; let localPath: String; let size: Int; let sha256: String
}
struct DesktopHarnessReceipt: Codable, Identifiable, Sendable {
    let id: String; let sessionId: String; let command: HarnessJSON; let state: String; let createdAt: Double; let ordinal: Double; let result: HarnessJSON?; let error: String?
    var text: String { command["displayText"].string ?? command["parts"].array.compactMap { $0["text"].string }.joined(separator: "\n") }
}
struct DesktopHarnessInteraction: Codable, Identifiable, Sendable {
    let id: String; let sessionId: String; let kind: String; let title: String; let detail: HarnessJSON
    let status: String; let createdAt: Double; let expiresAt: Double
}
enum DesktopHarnessForm {
    static func content(schema: HarnessJSON, values: [String: String]) throws -> HarnessJSON {
        let required = Set(schema["required"].array.compactMap(\.string))
        var content: [String: HarnessJSON] = [:]
        for (key, field) in schema["properties"].object {
            let raw = values[key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if raw.isEmpty {
                if let value = field.object["default"] { content[key] = value; continue }
                if field["type"].string == "boolean" { content[key] = .bool(false); continue }
                if required.contains(key) { throw DesktopHarnessError.rejected("Le champ \(field["title"].string ?? key) est requis.") }
                continue
            }
            let value: HarnessJSON
            switch field["type"].string {
            case "boolean":
                guard ["true", "false"].contains(raw) else { throw DesktopHarnessError.rejected("\(key) attend true ou false.") }
                value = .bool(raw == "true")
            case "number", "integer":
                guard let number = Double(raw), number.isFinite, field["type"].string != "integer" || number.rounded() == number else { throw DesktopHarnessError.rejected("\(key) attend un nombre valide.") }
                if case .number(let minimum) = field["minimum"], number < minimum { throw DesktopHarnessError.rejected("\(key) doit être supérieur ou égal à \(minimum).") }
                if case .number(let maximum) = field["maximum"], number > maximum { throw DesktopHarnessError.rejected("\(key) doit être inférieur ou égal à \(maximum).") }
                value = .number(number)
            case "object", "array":
                guard let parsed = try? JSONDecoder().decode(HarnessJSON.self, from: Data(raw.utf8)) else { throw DesktopHarnessError.rejected("\(key) attend du JSON valide.") }
                let matches: Bool
                switch parsed { case .array: matches = field["type"].string == "array"; case .object: matches = field["type"].string == "object"; default: matches = false }
                guard matches else { throw DesktopHarnessError.rejected("\(key) attend du JSON de type \(field["type"].string ?? "object").") }
                value = parsed
            default: value = .string(values[key] ?? raw)
            }
            if !field["enum"].array.isEmpty, !field["enum"].array.contains(value) { throw DesktopHarnessError.rejected("Sélectionnez une valeur proposée pour \(key).") }
            content[key] = value
        }
        return .object(content)
    }
}
struct DesktopHarnessEvent: Codable, Identifiable, Equatable, Sendable {
    let seq: Int; let sessionId: String; let type: String; let turnId: String?; let itemId: String?; let payload: HarnessJSON; let createdAt: Double
    var id: Int { seq }
}
struct DesktopPendingSubmission: Codable, Identifiable {
    let id: UUID; let text: String; let attachments: [DesktopDraftAttachment]
    var intent: String?; var turnID: String?
    var displayText: String?
}
struct DesktopNativeSessionSource: Codable, Identifiable, Sendable {
    let sourceId: String; let harnessId: String; let nativeSessionId: String; let title: String; let workspace: String?
    let updatedAt: Double; let canContinue: Bool; let strategy: String; let reason: String?
    var id: String { sourceId }
}
@MainActor protocol DesktopHarnessServing {
    func call(_ route: String, method: String, target: String, body: HarnessJSON?) async throws -> HarnessJSON
    func events(sessionID: String, target: String, after: Int, update: @MainActor @escaping (DesktopHarnessEvent) -> Void) async throws
}
