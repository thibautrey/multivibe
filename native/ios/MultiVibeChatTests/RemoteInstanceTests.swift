import XCTest
import SwiftUI
@testable import MultiVibeChat

final class RemoteInstanceTests: XCTestCase {
    func testRemoteFollowHasNoTransportDeadlineAndRetriesWithoutAttemptLimit() {
        let configuration = RemoteInstanceAPI.sessionConfiguration()
        XCTAssertEqual(RemoteInstanceAPI.lanControlTimeout, 20)
        XCTAssertEqual(configuration.timeoutIntervalForRequest, .greatestFiniteMagnitude)
        XCTAssertEqual(configuration.timeoutIntervalForResource, .greatestFiniteMagnitude)
        XCTAssertEqual(RemoteFollowRetryPolicy.delayNanoseconds(afterFailure: 0), 1_000_000_000)
        XCTAssertEqual(RemoteFollowRetryPolicy.delayNanoseconds(afterFailure: 4), 16_000_000_000)
        XCTAssertEqual(RemoteFollowRetryPolicy.delayNanoseconds(afterFailure: 5), 30_000_000_000)
        XCTAssertEqual(RemoteFollowRetryPolicy.delayNanoseconds(afterFailure: 10_000), 30_000_000_000)
    }
    func testVoiceTransportKeepsThePairedMachineOnTheFirstPartyOrigin() throws {
        let machine = UUID().uuidString.lowercased()
        let url = try RemoteInstanceAPI.voiceEndpoint(machine, operation: "realtime", voice: "kokoro:ff_siwis")
        XCTAssertEqual(url.scheme, "wss")
        XCTAssertEqual(url.host, "app.multivibe.cloud")
        XCTAssertEqual(url.path, "/relay/voice/v1/machines/\(machine)/realtime")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems, [.init(name: "voice", value: "kokoro:ff_siwis")])
        XCTAssertThrowsError(try RemoteInstanceAPI.voiceEndpoint("../completions", operation: "realtime"))
        XCTAssertThrowsError(try RemoteInstanceAPI.voiceEndpoint(machine, operation: "https://evil.invalid"))
    }
    func testVoiceCapabilitiesDecodeLegacyAndExplicitAudioModels() throws {
        let legacy = try JSONDecoder().decode(RemoteVoiceCapabilities.self, from: Data(#"{"enabled":true,"voices":[{"id":"kokoro:ff_siwis","name":"Kokoro"}],"llmModel":"gpt","transcriptionModel":"whisper","backgroundAudio":false}"#.utf8))
        XCTAssertNil(legacy.transcriptionModels)
        XCTAssertNil(legacy.synthesisModels)
        XCTAssertNil(legacy.voices[0].model)

        let current = try JSONDecoder().decode(RemoteVoiceCapabilities.self, from: Data(#"{"enabled":true,"voices":[{"id":"qwen:serena","name":"Serena","model":"qwen-tts","voice":"serena"}],"llmModel":"gpt","transcriptionModel":"whisper","transcriptionModels":[{"id":"whisper","name":"Whisper"}],"synthesisModels":[{"id":"qwen-tts","name":"Qwen TTS"}],"backgroundAudio":false}"#.utf8))
        XCTAssertEqual(current.transcriptionModels?.map(\.id), ["whisper"])
        XCTAssertEqual(current.synthesisModels?.map(\.id), ["qwen-tts"])
        XCTAssertEqual(current.voices[0].model, "qwen-tts")
        XCTAssertEqual(current.voices[0].voice, "serena")
    }
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
        for key in ["effort", "projectId", "projectName", "updatedAt"] { chatObject.removeValue(forKey: key) }
        let restored = try JSONDecoder().decode(RemoteChat.self, from: JSONSerialization.data(withJSONObject: chatObject))
        XCTAssertNil(restored.effort); XCTAssertNil(restored.projectId); XCTAssertNil(restored.projectName)
        XCTAssertNil(restored.updatedAt)

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

extension RemoteInstanceTests {
    @MainActor func testDiscoveryKeepsMachineAndEnvironmentIdentityAndCachedMessages() throws {
        let source = RemoteConversationSource(targetId: "local", kind: "native", id: "same-native-id", harnessId: "pi")
        let summary = RemoteConversationSummary(source: source, title: "External", updatedAt: 123000, model: nil, canContinue: true)
        var chats: [RemoteChat] = []
        RemoteInstances.merge([summary], into: &chats, machine: "mac-one", environment: "Mac")
        let id = chats[0].id
        chats[0].messages = [.init(role: "user", content: "Cached transcript")]
        RemoteInstances.merge([summary], into: &chats, machine: "mac-one", environment: "Mac")
        RemoteInstances.merge([summary], into: &chats, machine: "mac-two", environment: "Other Mac")
        var other = summary; other.source.targetId = "ssh-host"
        RemoteInstances.merge([other], into: &chats, machine: "mac-one", environment: "SSH")
        XCTAssertEqual(chats.count, 3); XCTAssertEqual(chats[0].id, id)
        XCTAssertEqual(chats[0].messages.first?.content, "Cached transcript")
        RemoteInstances.merge([], into: &chats, machine: "mac-one", environment: "Mac")
        XCTAssertEqual(chats.count, 3)
        let restored = try JSONDecoder().decode([RemoteChat].self, from: JSONEncoder().encode(chats))
        XCTAssertEqual(restored[0].source, source)
    }
    @MainActor func testDiscoveryDeduplicatesMobileRowsForksAndServerAliasesAndHonorsDismissal() {
        var chat = RemoteChat(machine: "mac", harness: "pi", model: "old")
        chat.messages = [.init(role: "user", content: "Preserved")]
        var chats = [chat]
        let native = RemoteConversationSource(targetId: "local", kind: "native", id: "native", harnessId: "pi")
        var summary = RemoteConversationSummary(source: .init(targetId: "local", kind: "session", id: "mobile-session", harnessId: "pi"), title: "Discovered", updatedAt: 123000, model: "model", canContinue: true, conversationId: chat.id.uuidString.lowercased(), nativeSourceId: "native")
        RemoteInstances.merge([summary], into: &chats, machine: "mac", environment: "Mac")
        XCTAssertEqual(chats.count, 1); XCTAssertEqual(chats[0].id, chat.id)
        XCTAssertEqual(chats[0].messages.first?.content, "Preserved")
        let alias = RemoteConversationSummary(source: native, title: "Native", updatedAt: 123000, model: nil, canContinue: true)
        RemoteInstances.merge([alias], into: &chats, machine: "mac", environment: "Mac")
        XCTAssertEqual(chats.count, 1); XCTAssertEqual(chats[0].source?.kind, "session")
        var hidden: [RemoteChat] = []
        RemoteInstances.merge([summary, alias], into: &hidden, machine: "mac", environment: "Mac", hidden: ["mac:" + native.key])
        XCTAssertTrue(hidden.isEmpty)
        summary.source.harnessId = "librechat"; summary.source.id = "server-session"; summary.conversationId = nil
        summary.nativeSessionId = "server-id"; summary.connectionId = "account-one"; summary.nativeSourceId = nil
        let server = RemoteConversationSummary(source: .init(targetId: "local", kind: "server", id: "server-id", harnessId: "librechat", connectionId: "account-one"), title: "Server", updatedAt: 123000, model: nil, canContinue: true)
        chats = []; RemoteInstances.merge([summary, server], into: &chats, machine: "mac", environment: "Mac")
        XCTAssertEqual(chats.count, 1)
        var otherAccount = server; otherAccount.source.connectionId = "account-two"
        RemoteInstances.merge([otherAccount], into: &chats, machine: "mac", environment: "Mac")
        XCTAssertEqual(chats.count, 2)
    }
}


extension RemoteInstanceTests {
    func testEveryHarnessActivityKindUpdatesIdempotentlyAndSurvivesArchive() throws {
        var chat = RemoteChat(machine: "mac", harness: "openai-codex", model: "model")
        chat.messages = [.init(role: "user", content: "Inspecte"), .init(role: "assistant", content: "", completion: .streaming)]
        let progress = RemoteHarnessActivity(id: "progress", kind: "message", text: "Je consulte ", append: true)
        chat.receiveActivity(progress, sequence: 1)
        chat.receiveActivity(progress, sequence: 1)
        chat.receiveActivity(.init(id: "progress", kind: "message", text: "la source.", append: true), sequence: 2)
        chat.receiveActivity(.init(id: "web", kind: "tool", title: "Lecture web", status: "running", input: "https://example.com"), sequence: 3)
        chat.receiveActivity(.init(id: "agent", kind: "agent", title: "Sous-agent recherche", status: "running", text: "Analyse", append: true), sequence: 4)
        chat.receiveActivity(.init(id: "plan", kind: "plan", title: "Plan", status: "running", text: "1. Lire"), sequence: 5)
        chat.receiveActivity(.init(id: "compact", kind: "status", title: "Compression du contexte", status: "running"), sequence: 6)
        chat.receiveActivity(.init(id: "terminal", kind: "tool", title: "Sortie de commande", status: "running", output: "A", append: true), sequence: 7)
        chat.receiveActivity(.init(id: "terminal", kind: "tool", output: "B", append: true), sequence: 8)
        chat.receiveActivity(.init(id: "web", kind: "tool", status: "success", output: "HTTP 200"), sequence: 9)
        chat.finishActivities(state: "completed")
        let restored = try JSONDecoder().decode(RemoteChat.self, from: JSONEncoder().encode(chat))
        let events = try XCTUnwrap(restored.messages.last?.localEvents)
        XCTAssertEqual(events.map(\.kind), ["message", "tool", "agent", "plan", "status", "tool"])
        XCTAssertEqual(events[0].detail, "Je consulte la source.")
        XCTAssertEqual(events[1].tool, "Lecture web"); XCTAssertEqual(events[1].status, "success"); XCTAssertEqual(events[1].output, "HTTP 200")
        XCTAssertEqual(events[2].status, "success"); XCTAssertEqual(events[3].status, "success"); XCTAssertEqual(events[4].status, "success")
        XCTAssertEqual(events[5].output, "AB"); XCTAssertEqual(events[5].status, "success"); XCTAssertEqual(restored.cursor, 9)
    }
    @MainActor func testEveryHarnessActivityKindRendersDuringRunAndAfterInterruption() {
        let events = [LocalAgentEvent(kind: "message", tool: "Message intermédiaire", detail: "Je vérifie les données.", status: "info"),
                      LocalAgentEvent(kind: "tool", tool: "Lecture web", detail: "", status: "running"),
                      LocalAgentEvent(kind: "agent", tool: "Sous-agent", detail: "Recherche", status: "running"),
                      LocalAgentEvent(kind: "plan", tool: "Plan", detail: "Inspecter puis vérifier", status: "success"),
                      LocalAgentEvent(kind: "status", tool: "Compression du contexte", detail: "", status: "success")]
        for completion in [ChatMessage.Completion.streaming, .stopped, .failed, .completed] {
            let renderer = ImageRenderer(content: AgentActivityView(events: events, completion: completion).frame(width: 350))
            XCTAssertNotNil(renderer.uiImage)
        }
    }
}

extension RemoteInstanceTests {
    func testDurableAndPendingCredentialsSurviveKeychainRestoreWithoutPlaintextArchive() throws {
        let account = UUID().uuidString, machine = UUID().uuidString
        defer { RemoteAuthorizationStore.clear(account, machine) }
        var pending = RemoteDeviceAuthorization(deviceId: UUID().uuidString, deviceToken: try RemoteDeviceAuthorization.secret(), expiresAt: 0,
            trustToken: try RemoteDeviceAuthorization.secret(), pendingUntil: Date().addingTimeInterval(300).timeIntervalSince1970 * 1000, deviceName: "Fixture iPhone")
        XCTAssertEqual(pending.deviceToken.count, 43)
        XCTAssertEqual(pending.trustToken?.count, 43)
        XCTAssertNotEqual(pending.deviceToken, pending.trustToken)
        try RemoteAuthorizationStore.save(pending, account, machine)
        XCTAssertEqual(try RemoteAuthorizationStore.load(account, machine)?.trustToken, pending.trustToken)
        pending.pendingCancelled = true
        try RemoteAuthorizationStore.save(pending, account, machine)
        XCTAssertEqual(try RemoteAuthorizationStore.load(account, machine)?.pendingCancelled, true)
        let legacy = Data(#"{"deviceId":"fixture","deviceToken":"fixture","expiresAt":1}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(RemoteDeviceAuthorization.self, from: legacy).trustToken)
    }
    @MainActor func testConnectionErrorsDistinguishRevocationFromTemporaryTransportLoss() {
        XCTAssertTrue(RemoteInstances.connectionError(APIError.server(401, "instance_device_revoked")).contains("révoqué"))
        XCTAssertTrue(RemoteInstances.connectionError(APIError.server(401, "instance_session_expired")).contains("compte"))
        XCTAssertTrue(RemoteInstances.connectionError(URLError(.notConnectedToInternet)).contains("hors ligne"))
        XCTAssertTrue(RemoteInstances.connectionError(APIError.server(409, "instance_update_required")).contains("jour"))
    }
    func testLANEndpointIsPinnedToLocalDNSAndFixedPath() throws {
        var machine = RemoteMachine(id: UUID().uuidString, name: "Mac", online: true, models: [])
        machine.lanPublicKey = String(repeating: "A", count: 43); machine.lanHost = "macbook-pro.local"; machine.lanPort = 42424
        XCTAssertEqual(try RemoteInstanceAPI.lanURL(machine).absoluteString, "https://macbook-pro.local:42424/v1")
        for host in ["example.com", "mac.local.evil.test", "../mac.local", ""] {
            machine.lanHost = host; XCTAssertThrowsError(try RemoteInstanceAPI.lanURL(machine))
        }
        machine.lanHost = "mac.local"; machine.lanPort = 0; XCTAssertThrowsError(try RemoteInstanceAPI.lanURL(machine))
        machine.lanPort = 65536; XCTAssertThrowsError(try RemoteInstanceAPI.lanURL(machine))

        var advertised = RemoteMachine(id: UUID().uuidString, name: "Mac", online: true,
            models: [.init(id: "multivibe/instance-lan-v1", name: String(repeating: "A", count: 43) + " 42424 macbook-pro.local")])
        XCTAssertEqual(try RemoteInstanceAPI.lanURL(advertised).absoluteString, "https://macbook-pro.local:42424/v1")
        advertised = RemoteMachine(id: UUID().uuidString, name: "Mac", online: true, models: [.init(id: "multivibe/instance-lan-v1", name: "malformed")])
        XCTAssertThrowsError(try RemoteInstanceAPI.lanURL(advertised))
    }

    func testOnlineDirectoryRefreshRetainsTheLastPinnedLANEndpoint() {
        let id = UUID().uuidString
        var previous = RemoteMachine(id: id, name: "Mac", online: true, models: [])
        previous.lanPublicKey = String(repeating: "A", count: 43); previous.lanHost = "old.local"; previous.lanPort = 42424
        let legacy = RemoteMachine(id: id, name: "Mac", online: true, models: [.init(id: RemoteInstanceAPI.model)])
        XCTAssertEqual(RemoteInstances.preservingLANEndpoints([legacy], previous: [previous])[0].localEndpoint?.port, 42424)
        var current = legacy; current.lanPublicKey = String(repeating: "B", count: 43); current.lanHost = "new.local"; current.lanPort = 43434
        XCTAssertEqual(RemoteInstances.preservingLANEndpoints([current], previous: [previous])[0].localEndpoint?.port, 43434)
        let offline = RemoteMachine(id: id, name: "Mac", online: false, models: [.init(id: RemoteInstanceAPI.model)])
        XCTAssertNil(RemoteInstances.preservingLANEndpoints([offline], previous: [previous])[0].localEndpoint)
    }

}
