import Foundation
public enum MultiVibeError: Error, LocalizedError, Sendable {
    case authenticationRequired, invalidResponse, invalidCallback, conflict, unsupportedTools, unknownToolOutcome, invalidArguments, toolLimit, cancelled
    case server(Int, String)
    public var errorDescription: String? {
        switch self {
        case .authenticationRequired: "Connectez votre compte MultiVibe."
        case .invalidResponse: "Réponse MultiVibe invalide ou interrompue."
        case .invalidCallback: "Retour de connexion invalide ou expiré."
        case .conflict: "Cette conversation a changé. Rechargez-la avant de continuer."
        case .unsupportedTools: "Ce modèle ne prend pas en charge les outils."
        case .unknownToolOutcome: "Une action a été interrompue. Vérifiez son résultat dans l’application avant de recommencer."
        case .invalidArguments: "Paramètres de l’outil invalides."
        case .toolLimit: "Limite d’exécution des outils atteinte."
        case .cancelled: "Action annulée."
        case .server(let status, let code): "MultiVibe (\(status)) : \(code)"
        }
    }
}
public enum JSONValue: Codable, Sendable, Equatable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([String: JSONValue].self) { self = .object(v) }
        else { self = .array(try c.decode([JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .string(let v): try c.encode(v); case .number(let v): try c.encode(v); case .bool(let v): try c.encode(v); case .object(let v): try c.encode(v); case .array(let v): try c.encode(v); case .null: try c.encodeNil() }
    }
}
public struct MultiVibeToolCall: Codable, Identifiable, Sendable, Equatable {
    public var id: String; public var name: String; public var arguments: String
    public init(id: String, name: String, arguments: String) { self.id = id; self.name = name; self.arguments = arguments }
}
public struct MultiVibeMessage: Codable, Identifiable, Sendable, Equatable {
    public var id: String; public var role: String; public var content: String
    public var toolCallId: String?; public var toolCalls: [MultiVibeToolCall]?; public var status: String?
    public init(id: String = UUID().uuidString, role: String, content: String, toolCallId: String? = nil, toolCalls: [MultiVibeToolCall]? = nil, status: String? = nil) {
        self.id = id; self.role = role; self.content = content; self.toolCallId = toolCallId; self.toolCalls = toolCalls; self.status = status
    }
}
public struct MultiVibeConversation: Codable, Identifiable, Sendable, Equatable {
    public var id: String; public var appId: String; public var appName: String; public var appURL: String?
    public var revision: Int; public var title: String; public var model: String; public var messages: [MultiVibeMessage]; public var context: String; public var updatedAt: String
    public init(id: String = UUID().uuidString, appId: String, title: String = "Nouvelle conversation", model: String = "") {
        self.id = id.lowercased(); self.appId = appId.lowercased(); appName = ""; revision = 0; self.title = title; self.model = model; messages = []; context = ""; updatedAt = ""
    }
}
public struct MultiVibeModel: Codable, Identifiable, Sendable { public let id: String; public let supportsTools: Bool? }
public struct MultiVibeConfiguration: Sendable {
    public let clientID: String; public let redirectURI: URL; public let baseURL: URL
    public init(clientID: String, redirectURI: URL, baseURL: URL = URL(string: "https://app.multivibe.cloud")!) { self.clientID = clientID.lowercased(); self.redirectURI = redirectURI; self.baseURL = baseURL }
}
public protocol MultiVibeContextProvider: Sendable { func context() async throws -> String }
public struct MultiVibeTool: Sendable {
    public let name: String; public let description: String; public let parameters: JSONValue; public let modifiesData: Bool
    public let execute: @Sendable (JSONValue) async throws -> JSONValue
    public init(name: String, description: String, parameters: JSONValue, modifiesData: Bool, execute: @escaping @Sendable (JSONValue) async throws -> JSONValue) {
        self.name = name; self.description = description; self.parameters = parameters; self.modifiesData = modifiesData; self.execute = execute
    }
}
