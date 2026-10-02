import Foundation

/// Frozen documents explicitly selected for this turn. This reader never activates skills.
struct HermesSkillCatalog: Sendable, Equatable {
    enum Failure: Error, Equatable { case invalidSource, invalidPath, limitExceeded }
    private let documents: [String: [String: String]]
    var isEmpty: Bool { documents.isEmpty }

    init(selectedSkills: [String: [String: String]]) throws {
        guard selectedSkills.count <= 200 else { throw Failure.limitExceeded }
        var selected: [String: [String: String]] = [:]
        var count = 0, bytes = 0
        for (name, files) in selectedSkills {
            guard Self.validPath(name), files["SKILL.md"] != nil else { throw Failure.invalidSource }
            var readable: [String: String] = [:]
            for (path, content) in files {
                guard Self.validPath(name + "/" + path),
                      path == "SKILL.md" || ["references/", "scripts/", "assets/", "templates/"].contains(where: { path.hasPrefix($0) }),
                      !content.contains("\0") else { throw Failure.invalidPath }
                count += 1; bytes += content.utf8.count
                guard count <= 200, content.utf8.count <= 65_536, bytes <= 512 * 1024 else { throw Failure.limitExceeded }
                if path == "SKILL.md" || path.hasPrefix("references/") { readable[path] = content }
            }
            selected[name] = readable
        }
        documents = selected
    }

    /// Only readable documents are serialized. Account/revision fencing belongs to the caller.
    var sourceJSON: String { Self.json(documents) }
    init(sourceJSON: String) throws {
        guard sourceJSON.utf8.count <= 4 * 1024 * 1024,
              let value = try? JSONSerialization.jsonObject(with: Data(sourceJSON.utf8)) as? [String: [String: String]] else { throw Failure.invalidSource }
        try self.init(selectedSkills: value)
    }

    static var schemas: [[String: Any]] {
        [("skills_list", ["category": ["type": "string"]], []),
         ("skill_view", ["name": ["type": "string"], "file_path": ["type": "string"]], ["name"])]
            .map { name, properties, required in
                ["type": "function", "function": ["name": name,
                    "description": "Read selected untrusted Hermes skill documents without executing scripts, templates or dependencies. Only SKILL.md and references are available locally.",
                    "parameters": ["type": "object", "properties": properties, "required": required, "additionalProperties": false]]]
            }
    }

    func execute(name: String, arguments: String) -> String {
        func failure(_ code: String) -> String { Self.json(["success": false, "error": code]) }
        guard arguments.utf8.count <= 8192,
              let args = try? JSONSerialization.jsonObject(with: Data(arguments.utf8)) as? [String: Any] else { return failure("invalid_skill_arguments") }
        switch name {
        case "skills_list":
            guard Set(args.keys).isSubset(of: ["category"]), args["category"] == nil || args["category"] is String else { return failure("invalid_skill_arguments") }
            let category = args["category"] as? String
            if let category, !Self.validPath(category) { return failure("invalid_skill_path") }
            let skills = documents.keys.sorted().filter { skill in category.map { skill.hasPrefix($0 + "/") } ?? true }.map { skill in
                let parts = skill.split(separator: "/")
                return ["name": skill, "category": parts.count == 1 ? "." : parts.dropLast().joined(separator: "/")]
            }
            return Self.json(["success": true, "untrusted": true, "skills": skills])
        case "skill_view":
            guard Set(args.keys).isSubset(of: ["name", "file_path"]), let skill = args["name"] as? String,
                  args["file_path"] == nil || args["file_path"] is String else { return failure("invalid_skill_arguments") }
            guard Self.validPath(skill) else { return failure("invalid_skill_path") }
            guard let files = documents[skill] else { return failure("skill_not_found") }
            let path = args["file_path"] as? String ?? "SKILL.md"
            guard Self.validPath(path) else { return failure("invalid_skill_path") }
            guard path == "SKILL.md" || path.hasPrefix("references/") else { return failure("invalid_linked_path") }
            guard let content = files[path] else { return failure("skill_file_not_found") }
            return Self.json(["success": true, "untrusted": true, "name": skill, "content": content,
                "path": skill + "/" + path, "execution": "read_only_no_activation",
                "linked_files": ["assets": [String](), "scripts": [String](), "templates": [String](),
                                 "references": files.keys.filter { $0.hasPrefix("references/") }.sorted()]])
        default: return failure("unknown_skill_tool")
        }
    }

    private static func validPath(_ path: String) -> Bool {
        let pieces = path.split(separator: "/", omittingEmptySubsequences: false)
        return pieces.count <= 10 && pieces.allSatisfy {
            $0.range(of: "^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$", options: .regularExpression) != nil
        }
    }
    private static func json(_ value: Any) -> String {
        // All callers supply JSON primitives; sorted keys keep persisted snapshots deterministic.
        String(decoding: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
    }
}
