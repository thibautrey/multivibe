import XCTest
@testable import MultiVibeChat

final class HermesSkillCatalogTests: XCTestCase {
    func result(_ catalog: HermesSkillCatalog, _ name: String = "skill_view", _ arguments: String = "{\"name\":\"example\"}") throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(catalog.execute(name: name, arguments: arguments).utf8)) as? [String: Any])
    }
    func testLiteralDocumentsAndExcludedFiles() throws {
        let literal = "---\ndeps: [never-install]\n---\n!`never execute`\n${ENV_SECRET}\n"
        let catalog = try HermesSkillCatalog(selectedSkills: ["example": ["SKILL.md": literal, "references/a.md": "reference", "scripts/private.sh": "SECRET", "assets/private.txt": "SECRET", "templates/private.txt": "SECRET"]])
        let value = try result(catalog)
        XCTAssertEqual(value["content"] as? String, literal)
        XCTAssertEqual(value["untrusted"] as? Bool, true)
        XCTAssertEqual(value["execution"] as? String, "read_only_no_activation")
        XCTAssertFalse(catalog.sourceJSON.contains("SECRET")); XCTAssertFalse(catalog.sourceJSON.contains("private"))
        XCTAssertEqual(try HermesSkillCatalog(sourceJSON: catalog.sourceJSON), catalog)
        XCTAssertEqual(try result(catalog, "skill_view", "{\"name\":\"example\",\"file_path\":\"scripts/private.sh\"}")["error"] as? String, "invalid_linked_path")
        let linked = try XCTUnwrap(value["linked_files"] as? [String: [String]])
        XCTAssertEqual(linked, ["assets": [], "scripts": [], "templates": [], "references": ["references/a.md"]])
    }
    func testCatalogCategoryAndStableOrder() throws {
        let catalog = try HermesSkillCatalog(selectedSkills: ["z": ["SKILL.md": "z"], "cat/b": ["SKILL.md": "b"], "cat/a": ["SKILL.md": "a"]])
        let all = try XCTUnwrap(result(catalog, "skills_list", "{}")["skills"] as? [[String: String]])
        XCTAssertEqual(all.map { $0["name"]! }, ["cat/a", "cat/b", "z"])
        XCTAssertEqual(all.last?["category"], ".")
        let filtered = try XCTUnwrap(result(catalog, "skills_list", "{\"category\":\"cat\"}")["skills"] as? [[String: String]])
        XCTAssertEqual(filtered.count, 2)
        XCTAssertEqual(catalog.sourceJSON, try HermesSkillCatalog(sourceJSON: catalog.sourceJSON).sourceJSON)
    }
    func testTraversalMissingAndInvalidArguments() throws {
        let catalog = try HermesSkillCatalog(selectedSkills: ["example": ["SKILL.md": "safe"]])
        for path in ["../secret", "/secret", "references/../secret", "references//secret", "references/secret\\file"] {
            let args = String(decoding: try JSONSerialization.data(withJSONObject: ["name": "example", "file_path": path]), as: UTF8.self)
            XCTAssertEqual(try result(catalog, "skill_view", args)["error"] as? String, "invalid_skill_path")
        }
        XCTAssertEqual(try result(catalog, "skill_view", "{\"name\":\"other\"}")["error"] as? String, "skill_not_found")
        XCTAssertEqual(try result(catalog, "skill_view", "{\"name\":\"example\",\"file_path\":\"references/missing.md\"}")["error"] as? String, "skill_file_not_found")
        for args in ["null", "[]", "{}", "{\"name\":1}", "{\"name\":\"example\",\"file_path\":null}", "{\"name\":\"example\",\"extra\":true}"] {
            XCTAssertEqual(try result(catalog, "skill_view", args)["error"] as? String, "invalid_skill_arguments")
        }
    }
    func testSourceBoundsValidateEvenExcludedFiles() throws {
        XCTAssertThrowsError(try HermesSkillCatalog(selectedSkills: ["example": [:]]))
        XCTAssertThrowsError(try HermesSkillCatalog(selectedSkills: ["example": ["SKILL.md": "safe", "scripts/../bad": "x"]]))
        XCTAssertThrowsError(try HermesSkillCatalog(selectedSkills: ["example": ["SKILL.md": "safe", "assets/large": String(repeating: "é", count: 32_769)]]))
        var files = ["SKILL.md": "safe"]
        for index in 0..<200 { files["references/f\(index)"] = "x" }
        XCTAssertThrowsError(try HermesSkillCatalog(selectedSkills: ["example": files]))
        let largeFiles = Dictionary(uniqueKeysWithValues: (0..<9).map { ("references/f\($0)", String(repeating: "x", count: 65_536)) })
        XCTAssertThrowsError(try HermesSkillCatalog(selectedSkills: ["example": largeFiles.merging(["SKILL.md": "safe"], uniquingKeysWith: { a, _ in a })]))
        XCTAssertThrowsError(try HermesSkillCatalog(sourceJSON: "[]"))
        XCTAssertTrue(try HermesSkillCatalog(selectedSkills: [:]).isEmpty)
    }
}
