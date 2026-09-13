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
    func testAssistantActivationWaitsForAuthenticatedVoicePresentation() {
        let manager = ConversationManager()
        manager.session = nil
        manager.prepareShortcut(.assistantVoiceConversation)
        XCTAssertTrue(manager.wantsVoiceConversation)
        XCTAssertTrue(manager.wantsImmediateVoiceCapture)
        XCTAssertFalse(manager.voice.recording)
        XCTAssertFalse(manager.isStreaming)
        XCTAssertTrue(manager.conversations.isEmpty)
        manager.prepareShortcut(.draft("Replacement"))
        XCTAssertFalse(manager.wantsVoiceConversation)
        XCTAssertFalse(manager.wantsImmediateVoiceCapture)
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

    func testRejectedSignInPersistenceRevokesNewSessionAndPreservesCurrentAccount() async {
        let current = session("current"), incoming = session("incoming", account: "other")
        var revoked: [String] = []
        let services = SessionServices(load: { current }, save: { _ in throw APIError.invalidResponse },
            clear: { XCTFail("Existing session must not be erased") },
            refresh: { _ in XCTFail("No refresh expected"); return current },
            revoke: { revoked.append($0) }, models: { _ in XCTFail("No model request expected"); return [] })
        let manager = ConversationManager(services: services)
        do { try await manager.accept(incoming); XCTFail("Failed persistence must reject sign-in") }
        catch {}
        XCTAssertEqual(manager.session?.refreshToken, "current")
        XCTAssertEqual(revoked, ["incoming"])
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


final class PasswordResetLinkTests: XCTestCase {
    func testAcceptsOnlyExactRecoveryOriginAndSingleOpaqueToken() {
        let token = String(repeating: "a", count: 43)
        let link = "https://auth.multivibe.cloud/password/reset#token=\(token)"
        XCTAssertEqual(PasswordResetLink.token(from: link), token)
        XCTAssertEqual(PasswordRecoveryRequest(url: URL(string: link)!)?.link, link)
        XCTAssertNil(PasswordRecoveryRequest(url: URL(string: "https://auth.multivibe.cloud/oauth/callback/ios?code=fixture")!))
        for invalid in [link.replacingOccurrences(of: "https:", with: "http:"),
                        link.replacingOccurrences(of: "auth.multivibe.cloud", with: "evil.example"),
                        link.replacingOccurrences(of: "auth.multivibe.cloud", with: "user@auth.multivibe.cloud"),
                        link.replacingOccurrences(of: "auth.multivibe.cloud", with: "auth.multivibe.cloud:443"),
                        link.replacingOccurrences(of: "#", with: "?x=1#"),
                        link + "&token=other", link + "a", link + "%00", String(repeating: "x", count: 513)] {
            XCTAssertNil(PasswordResetLink.token(from: invalid))
        }
    }
}

@MainActor final class ReplyRetryTests: XCTestCase {
    func testFailedTailRetryDoesNotDuplicatePrompt() async throws {
        let session = NativeSession(accessToken: "fixture", refreshToken: "fixture", expiresAt: .distantFuture, accountId: "retry-fixture")
        var inputs: [[ChatMessage]] = []
        let services = SessionServices(writeHistory: { _, _ in }, load: { session }, stream: { _, messages, _, delta in
            inputs.append(messages)
            await delta(inputs.count == 1 ? "partial" : "complete")
            if inputs.count == 1 { throw APIError.invalidResponse }
        })
        let manager = ConversationManager(services: services)
        manager.models = [ModelOption(id: "fixture")]; manager.selectedModel = "fixture"
        XCTAssertTrue(manager.send("hello"))
        for _ in 0..<1000 { if !manager.isStreaming { break }; await Task.yield() }
        XCTAssertFalse(manager.isStreaming)
        let conversation = try XCTUnwrap(manager.current)
        let failed = try XCTUnwrap(conversation.messages.last)
        XCTAssertEqual(failed.completion, .failed)
        XCTAssertEqual(failed.content, "partial")
        XCTAssertTrue(manager.retry(conversation: conversation.id, message: failed.id))
        XCTAssertFalse(manager.retry(conversation: conversation.id, message: failed.id))
        for _ in 0..<1000 { if !manager.isStreaming { break }; await Task.yield() }
        XCTAssertFalse(manager.isStreaming)
        XCTAssertEqual(inputs.count, 2)
        XCTAssertEqual(inputs.first, inputs.last)
        XCTAssertEqual(manager.current?.messages.count, 2)
        XCTAssertEqual(manager.current?.messages.last?.completion, .completed)
        XCTAssertEqual(manager.current?.messages.last?.content, "complete")
        XCTAssertFalse(manager.retry(conversation: conversation.id, message: failed.id))
    }
    func testStopRejectsLateDeltasAndMarksOriginalConversation() async throws {
        let session = NativeSession(accessToken: "fixture", refreshToken: "fixture", expiresAt: .distantFuture, accountId: "stop-fixture")
        var resume: CheckedContinuation<Void, Never>?
        let services = SessionServices(writeHistory: { _, _ in }, load: { session }, stream: { _, _, _, delta in
            await delta("partial")
            await withCheckedContinuation { resume = $0 }
            await delta("must not appear")
        })
        let manager = ConversationManager(services: services)
        manager.models = [ModelOption(id: "fixture")]; manager.selectedModel = "fixture"
        XCTAssertTrue(manager.send("hello"))
        for _ in 0..<1000 { if resume != nil { break }; await Task.yield() }
        let continuation = try XCTUnwrap(resume)
        let original = try XCTUnwrap(manager.selection)
        manager.newConversation()
        continuation.resume()
        for _ in 0..<20 { await Task.yield() }
        let message = manager.conversations.first { $0.id == original }?.messages.last
        XCTAssertEqual(message?.completion, .stopped)
        XCTAssertEqual(message?.content, "partial")
        XCTAssertNil(manager.completedReply)
        XCTAssertFalse(manager.isStreaming)
        XCTAssertFalse(manager.retry(conversation: original, message: try XCTUnwrap(message?.id)))
    }
    func testLegacyMessageDecodesWithoutInventingCompletion() throws {
        let id = UUID()
        let data = Data("{\"id\":\"\(id)\",\"role\":\"assistant\",\"content\":\"old\"}".utf8)
        let message = try JSONDecoder().decode(ChatMessage.self, from: data)
        XCTAssertNil(message.completion)
        XCTAssertFalse(message.canRetry)
    }
}

final class SharedHistoryProjectionTests: XCTestCase {
    func testUnknownFieldsAndAlternativeBranchesSurviveRoundtrip() throws {
        let fixture = #"{"accountId":"account","revision":4,"folders":[{"id":"folder","title":"Folder","future":true}],"conversations":[{"id":"web-id-not-uuid","title":"Branch","updatedAt":1000,"model":"model","draft":"unsent","future":{"retain":true},"repository":{"headId":"selected","messages":[{"parentId":null,"message":{"id":"user","role":"user","content":[{"type":"text","text":"hello"}]}},{"parentId":"user","message":{"id":"other","role":"assistant","content":[{"type":"text","text":"alternative"}]}},{"parentId":"user","message":{"id":"selected","role":"assistant","status":{"type":"complete"},"content":[{"type":"text","text":"answer"}]}}]}}]}"#
        let data = Data(fixture.utf8)
        let snapshot = try JSONDecoder().decode(AccountHistorySnapshot.self, from: data)
        XCTAssertEqual(try JSONDecoder().decode(HistoryJSON.self, from: JSONEncoder().encode(snapshot)),
                       try JSONDecoder().decode(HistoryJSON.self, from: data))
        var ids: [String: UUID] = [:]
        let id = UUID()
        let chat = try snapshot.projectedConversation(at: 0, id: id, messageIDs: &ids)
        XCTAssertEqual(chat.messages.map(\.content), ["hello", "answer"])
        XCTAssertEqual(chat.messages.last?.completion, .completed)
        XCTAssertEqual(chat.updatedAt, Date(timeIntervalSince1970: 1))
        XCTAssertEqual(chat, try snapshot.projectedConversation(at: 0, id: id, messageIDs: &ids))
        let invalid = fixture.replacingOccurrences(of: "\"headId\":\"selected\"", with: "\"headId\":\"missing\"")
        let bad = try JSONDecoder().decode(AccountHistorySnapshot.self, from: Data(invalid.utf8))
        XCTAssertThrowsError(try bad.projectedConversation(at: 0, id: id, messageIDs: &ids))
    }
}

final class SharedHistoryStatusTests: XCTestCase {
    func testCompletionChangeRetainsOldBranchInsteadOfReusingWrongStatus() throws {
        var snapshot = AccountHistorySnapshot(accountId: "fixture", revision: 0, conversations: [])
        var ids: [String: UUID] = [:]
        var conversation = Conversation(model: "fixture")
        conversation.messages = [ChatMessage(role: "assistant", content: "same text", completion: .stopped)]
        try snapshot.store(conversation, serverID: "chat", messageIDs: &ids)
        let oldHead = snapshot.conversations[0].object?["repository"]?.object?["headId"]
        conversation.messages[0].completion = .completed
        try snapshot.store(conversation, serverID: "chat", messageIDs: &ids)
        let repository = try XCTUnwrap(snapshot.conversations[0].object?["repository"]?.object)
        XCTAssertNotEqual(repository["headId"], oldHead)
        XCTAssertEqual(repository["messages"]?.array?.count, 2)
        let projected = try snapshot.projectedConversation(at: 0, id: conversation.id, messageIDs: &ids)
        XCTAssertEqual(projected.messages.last?.completion, .completed)
        try snapshot.store(conversation, serverID: "chat", messageIDs: &ids)
        XCTAssertEqual(snapshot.conversations[0].object?["repository"]?.object?["messages"]?.array?.count, 2)
    }
}

@MainActor final class SharedHistorySynchronizationTests: XCTestCase {
    func testCommittedSaveRebasesEditsMadeDuringRequest() async throws {
        let session = NativeSession(accessToken: "fixture", refreshToken: "fixture", expiresAt: .distantFuture, accountId: UUID().uuidString)
        var remote = AccountHistorySnapshot(accountId: session.accountId, revision: 0, conversations: [])
        var resume: CheckedContinuation<Void, Never>?
        var writes = 0
        let services = SessionServices(writeHistory: { _, _ in }, load: { session },
            readHistory: { _ in remote }, saveHistory: { snapshot, _ in
                writes += 1
                if writes == 1 { await withCheckedContinuation { resume = $0 } }
                remote = snapshot; remote.revision += 1
                return remote
            }, models: { _ in [ModelOption(id: "fixture")] })
        let manager = ConversationManager(services: services)
        await manager.restore()
        manager.newConversation()
        let original = try XCTUnwrap(manager.current)
        let operation = Task { await manager.synchronizeHistory() }
        for _ in 0..<1000 { if resume != nil { break }; await Task.yield() }
        guard let continuation = resume else { operation.cancel(); XCTFail("Save did not begin"); return }
        // Both a deletion and a newly created chat must survive the saved snapshot.
        manager.delete(original.id)
        manager.newConversation()
        let replacement = try XCTUnwrap(manager.current)
        continuation.resume()
        await operation.value
        XCTAssertEqual(manager.conversations.map(\.id), [replacement.id])
        XCTAssertEqual(remote.conversations.count, 1)
        await manager.synchronizeHistory()
        XCTAssertEqual(writes, 2, "Confirmed first save must become the next revision baseline")
        XCTAssertEqual(remote.conversations.count, 1)
        XCTAssertEqual(remote.conversations.first?.object?["id"]?.string, replacement.id.uuidString)
        XCTAssertEqual(manager.historyStatus, "Historique synchronisé avec votre compte.")
    }

    func testConflictRequiresConsentAndPreservesRemoteVersion() async throws {
        let session = NativeSession(accessToken: "fixture", refreshToken: "fixture", expiresAt: .distantFuture, accountId: UUID().uuidString)
        var remote = AccountHistorySnapshot(accountId: session.accountId, revision: 0, conversations: [])
        var writes = 0
        let services = SessionServices(writeHistory: { _, _ in }, load: { session },
            readHistory: { _ in remote }, saveHistory: { snapshot, _ in
                writes += 1; remote = snapshot; remote.revision += 1; return remote
            }, models: { _ in [ModelOption(id: "fixture")] })
        let manager = ConversationManager(services: services)
        await manager.restore()
        manager.newConversation()
        await manager.synchronizeHistory()
        manager.conversations[0].title = "Local edit"
        var item = try XCTUnwrap(remote.conversations[0].object)
        item["title"] = .string("Remote edit")
        remote.conversations[0] = .object(item); remote.revision += 1
        await manager.synchronizeHistory()
        XCTAssertTrue(manager.hasHistoryConflict)
        XCTAssertEqual(writes, 1)
        XCTAssertEqual(manager.conversations.first?.title, "Local edit")
        await manager.synchronizeHistory(keepingBothVersions: true)
        XCTAssertFalse(manager.hasHistoryConflict)
        XCTAssertEqual(writes, 2)
        XCTAssertEqual(Set(manager.conversations.map(\.title)), ["Remote edit", "Local edit — copie locale"])
        XCTAssertEqual(Set(manager.conversations.map(\.id)).count, 2)
        await manager.synchronizeHistory()
        XCTAssertEqual(writes, 2, "A resolved conflict must not duplicate copies on the next sync")
    }

    func testLostSaveResponseReconcilesExactPayloadWithoutDuplicateImport() async {
        let session = NativeSession(accessToken: "fixture", refreshToken: "fixture", expiresAt: .distantFuture, accountId: UUID().uuidString)
        var remote = AccountHistorySnapshot(accountId: session.accountId, revision: 0, conversations: [])
        var writes = 0
        let services = SessionServices(writeHistory: { _, _ in }, load: { session },
            readHistory: { _ in remote }, saveHistory: { snapshot, _ in
                writes += 1; remote = snapshot; remote.revision += 1
                throw APIError.invalidResponse
            }, models: { _ in [] })
        let manager = ConversationManager(services: services)
        await manager.restore()
        manager.newConversation()
        let original = manager.conversations
        await manager.synchronizeHistory()
        XCTAssertEqual(writes, 1)
        XCTAssertEqual(manager.conversations, original)
        await manager.synchronizeHistory()
        XCTAssertEqual(writes, 1)
        XCTAssertEqual(manager.conversations.count, 1)
        XCTAssertEqual(manager.conversations.first?.id, original.first?.id)
        XCTAssertFalse(manager.hasHistoryConflict)
        XCTAssertEqual(manager.historyStatus, "Historique synchronisé avec votre compte.")
    }

    func testLocalPersistenceFailurePreventsRemoteWrite() async {
        let session = NativeSession(accessToken: "fixture", refreshToken: "fixture", expiresAt: .distantFuture, accountId: UUID().uuidString)
        var writes = 0
        let services = SessionServices(writeHistory: { _, _ in throw APIError.invalidResponse }, load: { session },
            readHistory: { _ in AccountHistorySnapshot(accountId: session.accountId, revision: 0, conversations: []) },
            saveHistory: { snapshot, _ in writes += 1; return snapshot }, models: { _ in [] })
        let manager = ConversationManager(services: services)
        await manager.restore()
        manager.newConversation()
        let before = manager.conversations
        await manager.synchronizeHistory()
        XCTAssertEqual(writes, 0)
        XCTAssertEqual(manager.conversations, before)
        XCTAssertNotNil(manager.error)
        XCTAssertTrue(manager.historyStatus?.contains("non terminée") == true)
    }

    func testInvalidRemoteProjectionNeverTriggersSave() async {
        let session = NativeSession(accessToken: "fixture", refreshToken: "fixture", expiresAt: .distantFuture, accountId: UUID().uuidString)
        var writes = 0
        let services = SessionServices(writeHistory: { _, _ in }, load: { session },
            readHistory: { _ in AccountHistorySnapshot(accountId: session.accountId, revision: 0,
                conversations: [.object(["id": .string("malformed")])]) },
            saveHistory: { snapshot, _ in writes += 1; return snapshot }, models: { _ in [] })
        let manager = ConversationManager(services: services)
        await manager.restore()
        manager.newConversation()
        let before = manager.conversations
        await manager.synchronizeHistory()
        XCTAssertEqual(writes, 0)
        XCTAssertEqual(manager.conversations, before)
        XCTAssertTrue(manager.historyStatus?.contains("conservées") == true)
    }
}

final class VoiceAudioSessionOwnershipTests: XCTestCase {
    func testIdleStopDoesNotDeactivatePlayback() throws {
        var ownership = VoiceAudioSessionOwnership()
        var deactivations = 0
        try ownership.release(.recording) { deactivations += 1 }
        ownership.acquired(.playback)
        try ownership.release(.recording) { deactivations += 1 }
        XCTAssertEqual(deactivations, 0)
        XCTAssertEqual(ownership.use, .playback)
        try ownership.release(.playback) { deactivations += 1 }
        try ownership.release(.playback) { deactivations += 1 }
        XCTAssertEqual(deactivations, 1)
        XCTAssertNil(ownership.use)
    }
    func testOldPlaybackCompletionDoesNotReleaseRecording() throws {
        var ownership = VoiceAudioSessionOwnership()
        ownership.acquired(.playback)
        ownership.acquired(.recording)
        try ownership.release(.playback) { XCTFail("Must preserve the recorder") }
        XCTAssertEqual(ownership.use, .recording)
        try ownership.release(.recording) {}
        XCTAssertNil(ownership.use)
    }
    func testFailedDeactivationRemainsRetryable() throws {
        enum Failure: Error { case busy }
        var ownership = VoiceAudioSessionOwnership()
        ownership.acquired(.recording)
        XCTAssertThrowsError(try ownership.release(.recording) { throw Failure.busy })
        XCTAssertEqual(ownership.use, .recording)
        try ownership.release(.recording) {}
        XCTAssertNil(ownership.use)
    }
}

final class NativePasswordPolicyTests: XCTestCase {
    func testUTF8BoundariesMatchBackend() {
        XCTAssertFalse(NativePasswordPolicy.accepts(String(repeating: "a", count: 11)))
        XCTAssertTrue(NativePasswordPolicy.accepts(String(repeating: "a", count: 12)))
        XCTAssertTrue(NativePasswordPolicy.accepts(String(repeating: "a", count: 256)))
        XCTAssertFalse(NativePasswordPolicy.accepts(String(repeating: "a", count: 257)))
        XCTAssertTrue(NativePasswordPolicy.accepts(String(repeating: "é", count: 6)))
        XCTAssertTrue(NativePasswordPolicy.accepts(String(repeating: "🌌", count: 64)))
        XCTAssertFalse(NativePasswordPolicy.accepts(String(repeating: "🌌", count: 65)))
    }
    func testWhitespaceIsNotAcceptedAndSecretIsNotTrimmed() {
        XCTAssertFalse(NativePasswordPolicy.accepts(String(repeating: " ", count: 12)))
        XCTAssertFalse(NativePasswordPolicy.accepts(String(repeating: "\u{FEFF}", count: 4)))
        XCTAssertTrue(NativePasswordPolicy.accepts("           a"))
        XCTAssertTrue(NativePasswordPolicy.accepts(String(repeating: "\u{0085}", count: 6)))
    }
}
