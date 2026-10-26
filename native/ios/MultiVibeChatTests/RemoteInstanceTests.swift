import XCTest
import SwiftUI
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
    func testExistingRemoteConversationAndPreferenceDecodeWithoutDesktopControls() throws {
        let chat = RemoteChat(machine: UUID().uuidString, harness: "pi", model: "model")
        var chatObject = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(chat)) as? [String: Any])
        for key in ["effort", "projectId", "projectName"] { chatObject.removeValue(forKey: key) }
        let restored = try JSONDecoder().decode(RemoteChat.self, from: JSONSerialization.data(withJSONObject: chatObject))
        XCTAssertNil(restored.effort); XCTAssertNil(restored.projectId); XCTAssertNil(restored.projectName)

        let oldPreference = Data(#"{"harness":"pi","model":"model"}"#.utf8)
        let preference = try JSONDecoder().decode(RemoteModelPreference.self, from: oldPreference)
        XCTAssertNil(preference.effort); XCTAssertNil(preference.projectId)
    }
    func testPendingConfigurationKeepsItsOperationIdentityAcrossRestore() throws {
        var chat = RemoteChat(machine: UUID().uuidString, harness: "hermes-agent", model: "old")
        chat.pendingConfiguration = .init(model: "openai-api:gpt-6.1-sol", provider: "openai-api")
        let restored = try JSONDecoder().decode(RemoteChat.self, from: JSONEncoder().encode(chat))
        XCTAssertEqual(restored.pendingConfiguration?.id, chat.pendingConfiguration?.id)
        XCTAssertEqual(restored.pendingConfiguration?.fields["model"]?.string, "openai-api:gpt-6.1-sol")
        XCTAssertNil(restored.pendingConfiguration?.fields["projectId"])
        XCTAssertEqual(RemoteConfiguration(effort: nil).fields["effort"], .null)
    }
    @MainActor func testDesktopStyleEffortScaleRendersTheSelectedHarnessEffort() {
        let effort = ModelPickerEffort(options: [
            .init(value: "low", label: "Low"), .init(value: "medium", label: "Medium"), .init(value: "high", label: "High")
        ], selected: "high", defaultValue: "medium", disabled: false, select: { _ in })
        XCTAssertEqual(effort.selectedLabel, "High")
        let renderer = ImageRenderer(content: ModelEffortScale(effort: effort, disabled: false, select: { _ in }).frame(width: 320))
        renderer.scale = 1
        XCTAssertNotNil(renderer.uiImage)
    }
}
