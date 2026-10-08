import XCTest
@testable import MultiVibeChat

final class NativeApplicationIdentityTests: XCTestCase {
    func testProductionIdentifiersRetainExistingStorageAndBackgroundWork() {
        XCTAssertEqual(NativeApplicationIdentity.identifier("session", bundleIdentifier: "cloud.multivibe.chat"), "cloud.multivibe.chat.session")
        XCTAssertEqual(NativeApplicationIdentity.identifier("model-downloads.v1", bundleIdentifier: "cloud.multivibe.chat"), "cloud.multivibe.chat.model-downloads.v1")
        XCTAssertEqual(NativeApplicationIdentity.identifier("automations", bundleIdentifier: "cloud.multivibe.chat"), "cloud.multivibe.chat.automations")
    }

    func testQAHasNoProductionCredentialOrBackgroundIdentifier() {
        let suffixes = ["session", "model-downloads.v1", "automations"]
        let production = Set(suffixes.map { NativeApplicationIdentity.identifier($0, bundleIdentifier: "cloud.multivibe.chat") })
        let qa = Set(suffixes.map { NativeApplicationIdentity.identifier($0, bundleIdentifier: "cloud.multivibe.chat.qa") })
        XCTAssertEqual(qa.count, suffixes.count)
        XCTAssertTrue(production.isDisjoint(with: qa))
    }

    func testMissingApplicationIdentityCannotReadProductionCredentials() {
        XCTAssertEqual(NativeApplicationIdentity.identifier("session", bundleIdentifier: nil), "cloud.multivibe.chat.unidentified.session")
        XCTAssertNotEqual(NativeApplicationIdentity.identifier("session", bundleIdentifier: nil), "cloud.multivibe.chat.session")
    }
}
