import XCTest
@testable import MultiVibeChat

final class RemoteInstanceTests: XCTestCase {
    func testPairingAcceptsOnlyExactFirstPartyShapeAndNeverAnEndpoint() {
        let machine = UUID().uuidString.lowercased()
        XCTAssertNotNil(RemotePairing.parse(URL(string: "multivibe-chat://instance/pair?machine=\(machine)&handoff=SYNTHETIC123")!))
        for value in [
            "https://evil.invalid/instance/pair?machine=\(machine)&handoff=SYNTHETIC123",
            "multivibe-chat://instance/pair?machine=\(machine)&handoff=SYNTHETIC123&endpoint=https://evil.invalid",
            "multivibe-chat://instance/pair?machine=\(machine)&handoff=SYNTHETIC123&handoff=SYNTHETIC123",
            "multivibe-chat://instance/pair?machine=\(machine)&handoff=SYNTHETIC123#fragment",
            "multivibe-chat://instance/pair?machine=bad&handoff=SYNTHETIC123"
        ] { XCTAssertNil(RemotePairing.parse(URL(string: value)!), value) }
    }
    func testRelayRequestsCannotChooseAnotherOriginOrInjectAPath() async throws {
        let api = RemoteInstanceAPI()
        let request = try await api.request("machines", token: "synthetic-native-session")
        XCTAssertEqual(request.url?.absoluteString, "https://app.multivibe.cloud/relay/v1/machines")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-native-session")
        do { _ = try await api.request("https://evil.invalid", token: "synthetic-native-session"); XCTFail("Arbitrary origin accepted") } catch { }
        do { _ = try await api.request("machines/../completions", token: "synthetic-native-session"); XCTFail("Traversal accepted") } catch { }
    }
    func testDeviceAuthorizationIsAccountAndMachineScoped() throws {
        let account = UUID().uuidString, machine = UUID().uuidString
        defer { RemoteAuthorizationStore.clear(account, machine) }
        let value = RemoteDeviceAuthorization(deviceId: UUID().uuidString, deviceToken: "SYNTHETIC_DEVICE_CREDENTIAL_FOR_TEST_ONLY", expiresAt: Date().addingTimeInterval(60).timeIntervalSince1970 * 1000)
        try RemoteAuthorizationStore.save(value, account, machine)
        XCTAssertEqual(try RemoteAuthorizationStore.load(account, machine)?.deviceId, value.deviceId)
        XCTAssertNil(try RemoteAuthorizationStore.load(UUID().uuidString, machine))
        XCTAssertNil(try RemoteAuthorizationStore.load(account, UUID().uuidString))
        RemoteAuthorizationStore.clear(account, machine); XCTAssertNil(try RemoteAuthorizationStore.load(account, machine))
        try RemoteAuthorizationStore.save(value, account, machine)
        RemoteAuthorizationStore.clearAccount(account)
        XCTAssertNil(try RemoteAuthorizationStore.load(account, machine))
    }
}
