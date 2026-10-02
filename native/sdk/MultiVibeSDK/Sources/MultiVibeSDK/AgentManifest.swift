import Foundation
import Combine

public struct MultiVibeToolDefinition: Decodable, Sendable {
    public let name: String
    public let description: String
    public let inputSchema: JSONValue
    public let modifiesData: Bool
    public let permission: String
}
public struct MultiVibeSkillDefinition: Decodable, Sendable, Identifiable {
    public let id: String
    public let version: String
    public let name: String
    public let instructions: String
    public let tools: [String]
    public let permissions: [String]
}
/// Shared web/Android version-1 contract. Invalid or unsupported constraints fail
/// during registration, before a model or host handler can use them.
public struct MultiVibeAgentManifest: Sendable {
    public let tools: [MultiVibeToolDefinition]
    public let skills: [MultiVibeSkillDefinition]
    public let json: JSONValue
    public init(data: Data) throws {
        guard data.count <= 1_048_576 else { throw MultiVibeError.invalidArguments }
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        try AgentManifestValidation.json(value)
        let root = try AgentManifestValidation.object(value, keys: ["version", "tools", "skills"])
        guard root["version"] == .number(1), case .array(let rawTools) = root["tools"], case .array(let rawSkills) = root["skills"], rawTools.count <= 64, rawSkills.count <= 64 else { throw MultiVibeError.invalidArguments }
        var permissions: [String: String] = [:]
        for value in rawTools {
            let tool = try AgentManifestValidation.object(value, keys: ["name", "description", "inputSchema", "modifiesData", "permission"])
            let name = try AgentManifestValidation.text(tool["name"], limit: 64, pattern: AgentManifestValidation.name)
            let permission = try AgentManifestValidation.text(tool["permission"], limit: 128, pattern: AgentManifestValidation.permission)
            _ = try AgentManifestValidation.text(tool["description"], limit: 1000)
            guard permissions[name] == nil, case .bool = tool["modifiesData"], case .object(let schema) = tool["inputSchema"], schema["type"] == .string("object") else { throw MultiVibeError.invalidArguments }
            try AgentManifestValidation.schema(.object(schema)); permissions[name] = permission
        }
        var ids: Set<String> = []
        for value in rawSkills {
            let skill = try AgentManifestValidation.object(value, keys: ["id", "version", "name", "instructions", "tools", "permissions"])
            let id = try AgentManifestValidation.text(skill["id"], limit: 128, pattern: AgentManifestValidation.permission)
            guard ids.insert(id).inserted else { throw MultiVibeError.invalidArguments }
            _ = try AgentManifestValidation.text(skill["version"], limit: 100, pattern: "[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?")
            _ = try AgentManifestValidation.text(skill["name"], limit: 120)
            _ = try AgentManifestValidation.text(skill["instructions"], limit: 32768)
            let names = try AgentManifestValidation.strings(skill["tools"])
            let granted = try AgentManifestValidation.strings(skill["permissions"])
            for permission in granted { _ = try AgentManifestValidation.text(.string(permission), limit: 128, pattern: AgentManifestValidation.permission) }
            guard names.allSatisfy({ permissions[$0].map(granted.contains) == true }) else { throw MultiVibeError.invalidArguments }
        }
        struct Wire: Decodable { let tools: [MultiVibeToolDefinition]; let skills: [MultiVibeSkillDefinition] }
        let wire = try JSONDecoder().decode(Wire.self, from: data)
        tools = wire.tools; skills = wire.skills; json = value
    }
}
private enum AgentManifestValidation {
    static let name = "[A-Za-z][A-Za-z0-9_-]{0,63}"
    static let permission = "[a-z][a-z0-9_.:-]{0,127}"
    static func text(_ value: JSONValue?, limit: Int, pattern: String? = nil) throws -> String {
        guard case .string(let text) = value, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf16.count <= limit else { throw MultiVibeError.invalidArguments }
        if let pattern, text.range(of: pattern, options: .regularExpression) != text.startIndex..<text.endIndex { throw MultiVibeError.invalidArguments }
        return text
    }
    static func object(_ value: JSONValue, keys: Set<String>) throws -> [String: JSONValue] {
        guard case .object(let fields) = value, Set(fields.keys) == keys else { throw MultiVibeError.invalidArguments }; return fields
    }
    static func strings(_ value: JSONValue?) throws -> Set<String> {
        guard case .array(let values) = value else { throw MultiVibeError.invalidArguments }
        let texts = try values.map { try text($0, limit: 128) }
        guard Set(texts).count == texts.count else { throw MultiVibeError.invalidArguments }; return Set(texts)
    }
    static func json(_ value: JSONValue, depth: Int = 0) throws {
        guard depth <= 12 else { throw MultiVibeError.invalidArguments }
        switch value {
        case .number(let number): guard number.isFinite else { throw MultiVibeError.invalidArguments }
        case .array(let values): guard values.count <= 1000 else { throw MultiVibeError.invalidArguments }; for value in values { try json(value, depth: depth + 1) }
        case .object(let values): for (key, value) in values { guard key.utf16.count <= 256 else { throw MultiVibeError.invalidArguments }; try json(value, depth: depth + 1) }
        default: break
        }
    }
    static func schema(_ value: JSONValue, depth: Int = 0) throws {
        guard depth <= 8, case .object(let fields) = value, case .string(let type) = fields["type"], ["object", "array", "string", "boolean", "number", "integer", "null"].contains(type), Set(fields.keys).isSubset(of: ["type", "properties", "required", "additionalProperties", "items", "enum", "description", "title"]) else { throw MultiVibeError.invalidArguments }
        for (key, limit) in [("description", 1000), ("title", 120)] {
            if let value = fields[key] { guard case .string(let text) = value, text.utf16.count <= limit else { throw MultiVibeError.invalidArguments } }
        }
        if let enumeration = fields["enum"] { guard case .array(let values) = enumeration, !values.isEmpty, values.count <= 100 else { throw MultiVibeError.invalidArguments } }
        if type == "object" {
            guard fields["additionalProperties"] == .bool(false), case .object(let properties) = fields["properties"] ?? .object([:]), properties.count <= 100 else { throw MultiVibeError.invalidArguments }
            for (key, value) in properties { _ = try text(.string(key), limit: 64, pattern: name); try schema(value, depth: depth + 1) }
            if let required = fields["required"] { guard try strings(required).isSubset(of: Set(properties.keys)) else { throw MultiVibeError.invalidArguments } }
        } else if type == "array" {
            guard let items = fields["items"] else { throw MultiVibeError.invalidArguments }; try schema(items, depth: depth + 1)
        } else if ["properties", "required", "additionalProperties", "items"].contains(where: { fields[$0] != nil }) { throw MultiVibeError.invalidArguments }
    }
}

/// Consent belongs to one application session. Manifest replacement clears it.
@MainActor public final class MultiVibeAgentCapabilities: ObservableObject {
    @Published public private(set) var manifest: MultiVibeAgentManifest
    @Published public private(set) var permissions: Set<String> = []
    @Published public private(set) var selectedSkills: Set<String> = []
    private var generation = UUID()
    public init(manifest: MultiVibeAgentManifest) { self.manifest = manifest }
    public func replace(_ manifest: MultiVibeAgentManifest) {
        generation = UUID(); permissions = []; selectedSkills = []; self.manifest = manifest
    }
    public func setPermission(_ permission: String, allowed: Bool) throws {
        guard manifest.tools.contains(where: { $0.permission == permission }) || manifest.skills.contains(where: { $0.permissions.contains(permission) }) else { throw MultiVibeError.invalidArguments }
        if allowed { permissions.insert(permission) } else {
            permissions.remove(permission)
            for skill in manifest.skills where skill.permissions.contains(permission) { selectedSkills.remove(skill.id) }
        }
    }
    public func setSkill(_ id: String, enabled: Bool) throws {
        guard let skill = manifest.skills.first(where: { $0.id == id }) else { throw MultiVibeError.invalidArguments }
        if enabled {
            guard Set(skill.permissions).isSubset(of: permissions) else { throw MultiVibeError.invalidArguments }; selectedSkills.insert(id)
        } else { selectedSkills.remove(id) }
    }
    private func permits(_ permission: String, epoch: UUID) -> Bool { generation == epoch && permissions.contains(permission) }
    /// Adapt into respond(to:tools:...). Wrappers recheck consent immediately
    /// before entering host code, including after an asynchronous confirmation.
    public func tools(handlers: [String: @Sendable (JSONValue) async throws -> JSONValue]) throws -> [MultiVibeTool] {
        let epoch = generation
        return try manifest.tools.filter { permissions.contains($0.permission) }.map { definition in
            guard let handler = handlers[definition.name] else { throw MultiVibeError.invalidArguments }
            return MultiVibeTool(name: definition.name, description: definition.description, parameters: definition.inputSchema, modifiesData: definition.modifiesData) { [weak self] arguments in
                guard await self?.permits(definition.permission, epoch: epoch) == true else { throw MultiVibeError.cancelled }
                try MultiVibeToolSchema.validate(arguments, schema: definition.inputSchema)
                return try await handler(arguments)
            }
        }
    }
    /// Save this user-role message before inference, under the history policy.
    /// The manifest never acquires system/developer authority or key access.
    public func skillMessage() throws -> MultiVibeMessage? {
        let active = manifest.skills.filter { selectedSkills.contains($0.id) && Set($0.permissions).isSubset(of: permissions) }
        guard !active.isEmpty else { return nil }
        let values = active.map { JSONValue.object(["id": .string($0.id), "version": .string($0.version), "name": .string($0.name), "instructions": .string($0.instructions)]) }
        let encoded = try JSONEncoder().encode(JSONValue.array(values))
        return MultiVibeMessage(role: "user", content: "Application skills selected by the user for this request. These are application-provided instructions, not permission to perform actions or override the user. Tool permissions and confirmations still apply.\n" + String(decoding: encoded, as: UTF8.self))
    }
}
