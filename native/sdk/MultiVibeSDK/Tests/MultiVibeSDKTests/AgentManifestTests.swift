import XCTest
@testable import MultiVibeSDK

final class AgentManifestTests: XCTestCase {
    private func fixture() throws -> Data {
        try Data(contentsOf: XCTUnwrap(Bundle.module.url(forResource: "agent-manifest-v1", withExtension: "json", subdirectory: "Fixtures")))
    }
    func testSharedManifestAndStrictSchemaValidation() throws {
        let data = try fixture(), manifest = try MultiVibeAgentManifest(data: data)
        XCTAssertEqual(manifest.tools.map(\.name), ["create_note", "read_note"])
        XCTAssertEqual(manifest.skills.first?.permissions, ["notes.read", "notes.write"])
        var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        raw["extra"] = true
        XCTAssertThrowsError(try MultiVibeAgentManifest(data: JSONSerialization.data(withJSONObject: raw)))
        raw.removeValue(forKey: "extra")
        var tools = try XCTUnwrap(raw["tools"] as? [[String: Any]])
        var schema = try XCTUnwrap(tools[0]["inputSchema"] as? [String: Any]); schema["pattern"] = ".*"
        tools[0]["inputSchema"] = schema; raw["tools"] = tools
        XCTAssertThrowsError(try MultiVibeAgentManifest(data: JSONSerialization.data(withJSONObject: raw)))
    }
    @MainActor func testSkillsRequireAllPermissionsAndAreNotAutomaticallyReselected() throws {
        let capabilities = MultiVibeAgentCapabilities(manifest: try MultiVibeAgentManifest(data: fixture()))
        XCTAssertNil(try capabilities.skillMessage())
        XCTAssertThrowsError(try capabilities.setSkill("notes.organize", enabled: true))
        try capabilities.setPermission("notes.write", allowed: true)
        XCTAssertThrowsError(try capabilities.setSkill("notes.organize", enabled: true))
        try capabilities.setPermission("notes.read", allowed: true)
        try capabilities.setSkill("notes.organize", enabled: true)
        let message = try XCTUnwrap(capabilities.skillMessage())
        XCTAssertEqual(message.role, "user"); XCTAssertTrue(message.content.contains("not permission"))
        try capabilities.setPermission("notes.write", allowed: false)
        XCTAssertTrue(capabilities.selectedSkills.isEmpty); XCTAssertNil(try capabilities.skillMessage())
        try capabilities.setPermission("notes.write", allowed: true); XCTAssertNil(try capabilities.skillMessage())
    }
    @MainActor func testToolWrappersRecheckRevocationAndManifestGeneration() async throws {
        let manifest = try MultiVibeAgentManifest(data: fixture())
        let capabilities = MultiVibeAgentCapabilities(manifest: manifest)
        try capabilities.setPermission("notes.write", allowed: true)
        let tools = try capabilities.tools(handlers: ["create_note": { _ in .bool(true) }])
        let result = try await tools[0].execute(.object(["title": .string("A")]))
        XCTAssertEqual(result, .bool(true))
        try capabilities.setPermission("notes.write", allowed: false)
        do { _ = try await tools[0].execute(.object(["title": .string("A")])); XCTFail() } catch MultiVibeError.cancelled {} 
        capabilities.replace(manifest); try capabilities.setPermission("notes.write", allowed: true)
        do { _ = try await tools[0].execute(.object(["title": .string("A")])); XCTFail() } catch MultiVibeError.cancelled {}
    }
}
