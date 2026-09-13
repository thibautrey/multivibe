import XCTest
@testable import MultiVibeChat

final class SSEParserTests: XCTestCase {
    func testEventBoundariesAndComments() {
        var parser = SSEParser()
        XCTAssertNil(parser.consume(": keepalive"))
        XCTAssertNil(parser.consume(""))
        XCTAssertNil(parser.consume("data: hello"))
        XCTAssertNil(parser.consume("data: world"))
        XCTAssertEqual(parser.consume(""), "hello\nworld")
        XCTAssertNil(parser.consume(""))
        XCTAssertNil(parser.consume("data: [DONE]"))
        XCTAssertEqual(parser.consume(""), "[DONE]")
    }
    func testDataWhitespaceIsPreserved() {
        var parser = SSEParser()
        XCTAssertNil(parser.consume("data:  indented"))
        XCTAssertEqual(parser.consume(""), " indented")
    }
    func testByteFramingPreservesBlankLinesAndUnicode() throws {
        for ending in ["\n", "\r", "\r\n"] {
            var parser = SSEByteParser()
            let wire = "\u{FEFF}: heartbeat" + ending + ending
                + "data: Bonjour 🌌" + ending + "data: été" + ending + ending
                + "data: [DONE]" + ending + ending
            let events = try Array(wire.utf8).compactMap { try parser.consume($0) }
            XCTAssertEqual(events, ["Bonjour 🌌\nété", "[DONE]"])
        }
    }
    func testUnterminatedEventIsNotDispatched() throws {
        var parser = SSEByteParser()
        XCTAssertEqual(try Array("data: incomplete\n".utf8).compactMap { try parser.consume($0) }, [])
    }
    func testBoundedUnterminatedInputAndMultilineEvent() throws {
        for wire in [String(repeating: "x", count: 25), "data: a\ndata: b\ndata: c\ndata: d\n"] {
            var parser = SSEByteParser(maximumBytes: 24)
            XCTAssertThrowsError(try Array(wire.utf8).forEach { _ = try parser.consume($0) })
        }
    }
    func testEventLimitResetsAndBareDataIsEmptyEvent() throws {
        var parser = SSEByteParser(maximumBytes: 8)
        XCTAssertEqual(try Array("data\n\ndata\n\n".utf8).compactMap { try parser.consume($0) }, ["", ""])
    }
    func testInvalidUTF8FailsClosed() throws {
        var parser = SSEByteParser()
        XCTAssertThrowsError(try [UInt8(0xff), 10].forEach { _ = try parser.consume($0) })
    }
}

final class NativeTransportTests: XCTestCase {
    func testRedirectsAreRejectedForEveryRedirectStatusAndDestination() {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let original = URL(string: "https://auth.multivibe.cloud/oauth/token")!
        let task = session.dataTask(with: original)
        for status in [301, 302, 303, 307, 308] {
            for destination in ["https://auth.multivibe.cloud/other", "https://example.invalid/token", "http://auth.multivibe.cloud/oauth/token"] {
                let response = HTTPURLResponse(url: original, statusCode: status, httpVersion: nil, headerFields: ["Location": destination])!
                let completed = expectation(description: "redirect rejected")
                NativeTransportDelegate().urlSession(session, task: task,
                    willPerformHTTPRedirection: response, newRequest: URLRequest(url: URL(string: destination)!)) { redirected in
                        XCTAssertNil(redirected)
                        completed.fulfill()
                    }
                wait(for: [completed], timeout: 1)
            }
        }
    }
}

@MainActor final class ConversationSelectionTests: XCTestCase {
    func testSelectionRestoresModelAndStopsGeneration() {
        let manager = ConversationManager()
        manager.session = nil // Never persist to a real account in this test.
        let first = Conversation(model: "first")
        let second = Conversation(model: "second")
        manager.models = [ModelOption(id: "first"), ModelOption(id: "second")]
        manager.conversations = [first, second]
        manager.selection = first.id
        XCTAssertEqual(manager.selectedModel, "first")
        manager.isStreaming = true
        manager.selection = second.id
        XCTAssertFalse(manager.isStreaming)
        XCTAssertEqual(manager.selectedModel, "second")
    }
    func testUnavailableModelRequiresExplicitReplacement() {
        let manager = ConversationManager()
        manager.session = nil
        let conversation = Conversation(model: "removed")
        manager.models = [ModelOption(id: "available")]
        manager.selectedModel = "available"
        manager.conversations = [conversation]
        manager.selection = conversation.id
        XCTAssertEqual(manager.selectedModel, "")
    }
    func testReselectingSameConversationDoesNotStopGeneration() {
        let manager = ConversationManager()
        manager.session = nil
        let conversation = Conversation(model: "first")
        manager.conversations = [conversation]
        manager.selection = conversation.id
        manager.isStreaming = true
        manager.selection = conversation.id
        XCTAssertTrue(manager.isStreaming)
    }
}

@MainActor final class ShortcutPreparationTests: XCTestCase {
    func testNewConversationWaitsForForegroundConsumption() {
        let manager = ConversationManager()
        manager.session = nil
        manager.prepareShortcut(.newConversation)
        XCTAssertTrue(manager.wantsNewConversation)
        XCTAssertTrue(manager.conversations.isEmpty)
        XCTAssertNil(manager.selection)
        XCTAssertFalse(manager.isStreaming)
    }
    func testLatestShortcutReplacesEarlierPendingActions() {
        let manager = ConversationManager()
        manager.session = nil
        manager.prepareShortcut(.dictation)
        manager.prepareShortcut(.voiceConversation)
        XCTAssertFalse(manager.wantsVoice)
        XCTAssertTrue(manager.wantsVoiceConversation)
        manager.prepareShortcut(.draft("Bonjour"))
        XCTAssertFalse(manager.wantsVoiceConversation)
        XCTAssertEqual(manager.pendingDraft, "Bonjour")
        manager.prepareShortcut(.newConversation)
        XCTAssertNil(manager.pendingDraft)
        XCTAssertTrue(manager.wantsNewConversation)
    }
    func testShortcutDraftIsBoundedAndNeverSentAutomatically() {
        let manager = ConversationManager()
        manager.session = nil
        manager.prepareShortcut(.draft(String(repeating: "é", count: 40_000)))
        XCTAssertEqual(manager.pendingDraft?.count, 32_000)
        XCTAssertTrue(manager.conversations.isEmpty)
        XCTAssertFalse(manager.isStreaming)
    }
}

@MainActor final class SessionRotationTests: XCTestCase {
    private func session(_ token: String, account: String = "rotation-test", expired: Bool = false) -> NativeSession {
        NativeSession(accessToken: "access-" + token, refreshToken: token,
                      expiresAt: Date().addingTimeInterval(expired ? -60 : 3600), accountId: account)
    }

    func testPersistenceFailureClosesSessionAndRevokesRotatedToken() async {
        let old = session("old", expired: true), renewed = session("renewed")
        var cleared = false
        var revoked: [String] = []
        let services = SessionServices(load: { old }, save: { _ in throw APIError.invalidResponse },
            clear: { cleared = true }, refresh: { _ in renewed }, revoke: { revoked.append($0) }, models: { _ in [] })
        let manager = ConversationManager(services: services)
        manager.prepareShortcut(.draft("must not survive"))
        do { _ = try await manager.validSession(); XCTFail("Persistence failure must require login") }
        catch {}
        XCTAssertNil(manager.session)
        XCTAssertNil(manager.pendingDraft)
        XCTAssertTrue(cleared)
        XCTAssertEqual(revoked, ["renewed"])
        XCTAssertNotNil(manager.error)
    }

    func testConcurrentRefreshPersistsOnlyOnce() async throws {
        let old = session("old", expired: true), renewed = session("renewed")
        var saves = 0, refreshes = 0
        let services = SessionServices(load: { old }, save: { _ in saves += 1 }, clear: {},
            refresh: { _ in refreshes += 1; await Task.yield(); return renewed }, revoke: { _ in }, models: { _ in [] })
        let manager = ConversationManager(services: services)
        let first = Task { try await manager.validSession() }
        let second = Task { try await manager.validSession() }
        let a = try await first.value, b = try await second.value
        XCTAssertEqual(a.refreshToken, "renewed")
        XCTAssertEqual(b.refreshToken, "renewed")
        XCTAssertEqual(saves, 1)
        XCTAssertEqual(refreshes, 1)
    }

    func testAccountSwitchRevokesOldRotationWithoutReplacingNewAccount() async throws {
        let old = session("old", expired: true), renewed = session("renewed")
        let newAccount = session("new-account", account: "different-test-account")
        var continuation: CheckedContinuation<NativeSession, Never>?
        var saved: [String] = [], revoked: [String] = []
        let services = SessionServices(load: { old }, save: { saved.append($0.refreshToken) }, clear: {},
            refresh: { _ in await withCheckedContinuation { continuation = $0 } },
            revoke: { revoked.append($0) }, models: { _ in [] })
        let manager = ConversationManager(services: services)
        let refresh = Task { try await manager.validSession() }
        while continuation == nil { await Task.yield() }
        try await manager.accept(newAccount)
        continuation?.resume(returning: renewed)
        do { _ = try await refresh.value; XCTFail("Old account caller must be cancelled") }
        catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
        XCTAssertEqual(manager.session?.accountId, newAccount.accountId)
        XCTAssertEqual(saved, ["new-account"])
        XCTAssertEqual(revoked, ["renewed"])
    }
}
