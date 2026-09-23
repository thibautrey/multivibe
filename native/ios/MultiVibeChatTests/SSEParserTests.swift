import XCTest
import AVFoundation
import AuthenticationServices
@testable import MultiVibeChat

@MainActor final class ModelMarketplaceTests: XCTestCase {
    func testCatalogMetadataOwnsProviderIdentity() {
        XCTAssertEqual(ModelOption(id: "gpt-lookalike", author: "anthropic").presentation.provider, .anthropic)
        XCTAssertEqual(ModelOption(id: "openai/gpt-5.3").presentation.provider, .other)
        XCTAssertEqual(ModelOption(id: "opaque-id", author: "openai").presentation.provider, .openAI)
    }
    func testAccessSelectionSurvivesHistoryAndLegacyConversationDecoding() throws {
        let access = SelectedModelAccess(id: "account-1", modelId: "openai/luna", label: "My account", method: "device_code")
        XCTAssertEqual(SelectedModelAccess.fromHistory(access.historyValue), access)
        XCTAssertNil(SelectedModelAccess.fromHistory(nil))
        let conversation = Conversation(model: access.modelId, modelAccess: access)
        let decoded = try JSONDecoder().decode(Conversation.self, from: JSONEncoder().encode(conversation))
        XCTAssertEqual(decoded.modelAccess, access)
    }

    func testChangingAccountClearsProviderSelection() {
        let manager = ConversationManager(services: isolatedServices())
        manager.selectedModel = "openai/luna"
        manager.selectedAccess = .init(id: "old-private-account", modelId: "openai/luna", label: "Private", method: "device_code")
        manager.requestedAccessModel = .init(id: "openai/luna")
        manager.session = .init(accessToken: "fixture", refreshToken: "fixture", expiresAt: .distantFuture, accountId: UUID().uuidString)
        XCTAssertNil(manager.selectedAccess)
        XCTAssertNil(manager.requestedAccessModel)
    }

    func testLocalModelIsFreePrivateAndOffline() {
        let presentation = ModelOption(id: LocalModel.id, name: "Apple Foundation Local").presentation
        XCTAssertEqual(presentation.provider, .apple)
        XCTAssertFalse(presentation.usesCloudCredit)
        XCTAssertTrue(presentation.useCases.contains(.local))
        XCTAssertTrue(presentation.badges.contains("Hors ligne"))
    }

    func testFavoritesRoundTripInDedicatedDefaultsSuite() {
        let suite = "ModelFavoriteStoreTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        ModelFavoriteStore.save(["model-b", "model-a"], to: defaults)
        XCTAssertEqual(ModelFavoriteStore.load(from: defaults), ["model-a", "model-b"])
    }
}

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
        let manager = ConversationManager(services: isolatedServices())
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
    func testUnloadedModelKeepsIdentityWithoutInventingAnAccess() {
        let manager = ConversationManager(services: isolatedServices())
        manager.session = nil
        let conversation = Conversation(model: "removed")
        manager.models = [ModelOption(id: "available")]
        manager.selectedModel = "available"
        manager.conversations = [conversation]
        manager.selection = conversation.id
        XCTAssertEqual(manager.selectedModel, "removed")
        XCTAssertNil(manager.selectedAccess)
    }
    func testReselectingSameConversationDoesNotStopGeneration() {
        let manager = ConversationManager(services: isolatedServices())
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
        let manager = ConversationManager(services: isolatedServices())
        manager.session = nil
        manager.prepareShortcut(.newConversation)
        XCTAssertTrue(manager.wantsNewConversation)
        XCTAssertTrue(manager.conversations.isEmpty)
        XCTAssertNil(manager.selection)
        XCTAssertFalse(manager.isStreaming)
    }
    func testLatestShortcutReplacesEarlierPendingActions() {
        let manager = ConversationManager(services: isolatedServices())
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
        let manager = ConversationManager(services: isolatedServices())
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
        let manager = ConversationManager(services: isolatedServices())
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
        let services = isolatedServices(load: { old }, save: { _ in throw APIError.invalidResponse },
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
        let services = isolatedServices(load: { current }, save: { _ in throw APIError.invalidResponse },
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
        let services = isolatedServices(load: { old }, save: { _ in saves += 1 }, clear: {},
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
        let services = isolatedServices(load: { old }, save: { saved.append($0.refreshToken) }, clear: {},
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
        let services = isolatedServices(writeHistory: { _, _ in }, load: { session }, stream: { _, messages, _, delta in
            inputs.append(messages)
            await delta(inputs.count == 1 ? "partial" : "complete")
            if inputs.count == 1 { throw APIError.invalidResponse }
        })
        let manager = ConversationManager(services: services)
        await manager.restore(loadRemoteModels: false)
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
        let services = isolatedServices(writeHistory: { _, _ in }, load: { session }, stream: { _, _, _, delta in
            await delta("partial")
            await withCheckedContinuation { resume = $0 }
            await delta("must not appear")
        })
        let manager = ConversationManager(services: services)
        await manager.restore(loadRemoteModels: false)
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
        let services = isolatedServices(writeHistory: { _, _ in }, load: { session },
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
        let services = isolatedServices(writeHistory: { _, _ in }, load: { session },
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
        let services = isolatedServices(writeHistory: { _, _ in }, load: { session },
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
        let services = isolatedServices(writeHistory: { _, _ in throw APIError.invalidResponse }, load: { session },
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
        let services = isolatedServices(writeHistory: { _, _ in }, load: { session },
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

@MainActor final class NativeCredentialFlowTests: XCTestCase {
    private func reply(_ token: String) -> AuthReply {
        AuthReply(accessToken: token, refreshToken: token, expiresAt: .distantFuture, accountId: "fixture")
    }
    func testLateReplyRevokedWithoutAffectingNewAttempt() async {
        var pending: [CheckedContinuation<AuthReply, Never>] = []
        var revoked: [String] = [], accepted: [String] = []
        let flow = NativeCredentialFlow(services: .init(issue: { _, _ in
            await withCheckedContinuation { pending.append($0) }
        }, revoke: { revoked.append($0) }))
        func submit() {
            flow.submit(mode: "login", fields: [:], accept: { accepted.append($0.refreshToken) },
                        challenge: { _ in XCTFail("Unexpected challenge") }, failure: { _, _ in XCTFail("Unexpected error") })
        }
        submit()
        while pending.count < 1 { await Task.yield() }
        flow.cancel(); submit()
        while pending.count < 2 { await Task.yield() }
        pending[0].resume(returning: reply("old"))
        while revoked.isEmpty { await Task.yield() }
        XCTAssertTrue(flow.busy); XCTAssertTrue(accepted.isEmpty)
        pending[1].resume(returning: reply("new"))
        while flow.busy { await Task.yield() }
        XCTAssertEqual(revoked, ["old"]); XCTAssertEqual(accepted, ["new"])
    }
    func testMalformedLateReplyStillRevoked() async {
        var pending: CheckedContinuation<AuthReply, Never>?
        var revoked: [String] = []
        let flow = NativeCredentialFlow(services: .init(issue: { _, _ in
            await withCheckedContinuation { pending = $0 }
        }, revoke: { revoked.append($0) }))
        flow.submit(mode: "login", fields: [:], accept: { _ in XCTFail() },
                    challenge: { _ in XCTFail() }, failure: { _, _ in XCTFail() })
        while pending == nil { await Task.yield() }
        flow.cancel(); pending?.resume(returning: AuthReply(refreshToken: "orphan"))
        while revoked.isEmpty { await Task.yield() }
        XCTAssertEqual(revoked, ["orphan"]); XCTAssertFalse(flow.busy)
    }
    func testMFAAndInconsistentEnvelope() async {
        var response = AuthReply(challenge: "challenge", status: "mfa_required")
        var challenges: [String] = [], revoked: [String] = [], errors = 0
        let flow = NativeCredentialFlow(services: .init(issue: { _, _ in response }, revoke: { revoked.append($0) }))
        func submit() {
            flow.submit(mode: "login", fields: [:], accept: { _ in XCTFail("MFA must not accept session") },
                        challenge: { challenges.append($0) }, failure: { _, _ in errors += 1 })
        }
        submit(); while flow.busy { await Task.yield() }
        XCTAssertEqual(challenges, ["challenge"]); XCTAssertEqual(errors, 0)
        response = reply("inconsistent"); response.status = "mfa_required"
        submit(); while flow.busy { await Task.yield() }
        XCTAssertEqual(errors, 1); XCTAssertEqual(revoked, ["inconsistent"])
    }
    func testInvalidatedFailureCannotUpdateUI() async {
        var pending: CheckedContinuation<Void, Never>?
        let flow = NativeCredentialFlow(services: .init(issue: { _, _ in
            await withCheckedContinuation { pending = $0 }
            throw APIError.invalidResponse
        }, revoke: { _ in XCTFail() }))
        flow.submit(mode: "login", fields: [:], accept: { _ in XCTFail() },
                    challenge: { _ in XCTFail() }, failure: { _, _ in XCTFail() })
        while pending == nil { await Task.yield() }
        flow.cancel(); pending?.resume()
        for _ in 0..<20 { await Task.yield() }
        XCTAssertFalse(flow.busy)
    }
}

final class VoiceSystemEventTests: XCTestCase {
    func testMediaServiceNotificationsDecodeWithoutPayload() {
        XCTAssertEqual(VoiceSystemEvent.decode(Notification(name: AVAudioSession.mediaServicesWereLostNotification)), .servicesLost)
        XCTAssertEqual(VoiceSystemEvent.decode(Notification(name: AVAudioSession.mediaServicesWereResetNotification)), .servicesReset)
    }
    @MainActor func testResetPreservesTranscriptAndNeverRestartsActiveAudio() {
        let voice = VoiceController()
        voice.transcript = "Brouillon conservé"
        voice.recording = true
        voice.handleSystemEvent(.servicesReset)
        XCTAssertEqual(voice.transcript, "Brouillon conservé")
        XCTAssertFalse(voice.recording); XCTAssertFalse(voice.speaking)
        XCTAssertNotNil(voice.error)
        voice.silence()
    }
    @MainActor func testLostServiceBlocksNewPlaybackAndIdleResetIsQuiet() {
        let voice = VoiceController()
        voice.transcript = "Brouillon"
        voice.handleSystemEvent(.servicesLost)
        XCTAssertNil(voice.error)
        voice.speak("Ne pas lire")
        XCTAssertFalse(voice.speaking)
        XCTAssertNotNil(voice.error)
        voice.silence()
        voice.error = nil
        voice.handleSystemEvent(.servicesReset)
        XCTAssertNil(voice.error)
        XCTAssertEqual(voice.transcript, "Brouillon")
        XCTAssertFalse(voice.recording); XCTAssertFalse(voice.speaking)
    }

    func testOnlyInterruptionStartStopsAudio() {
        XCTAssertEqual(VoiceSystemEvent.decode(Notification(name: AVAudioSession.interruptionNotification,
            userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue])), .interruptionBegan)
        XCTAssertNil(VoiceSystemEvent.decode(Notification(name: AVAudioSession.interruptionNotification,
            userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue])))
        XCTAssertNil(VoiceSystemEvent.decode(Notification(name: AVAudioSession.interruptionNotification)))
    }
    func testRouteLossButNotOwnCategoryChangeStopsAudio() {
        for reason in [AVAudioSession.RouteChangeReason.oldDeviceUnavailable, .noSuitableRouteForCategory] {
            XCTAssertEqual(VoiceSystemEvent.decode(Notification(name: AVAudioSession.routeChangeNotification,
                userInfo: [AVAudioSessionRouteChangeReasonKey: reason.rawValue])), .routeLost)
        }
        for reason in [AVAudioSession.RouteChangeReason.categoryChange, .newDeviceAvailable, .override] {
            XCTAssertNil(VoiceSystemEvent.decode(Notification(name: AVAudioSession.routeChangeNotification,
                userInfo: [AVAudioSessionRouteChangeReasonKey: reason.rawValue])))
        }
    }
    @MainActor func testIdleEventDoesNotEraseTranscriptOrCreateError() {
        let voice = VoiceController()
        voice.transcript = "Texte conservé"
        voice.handleSystemEvent(.routeLost)
        XCTAssertEqual(voice.transcript, "Texte conservé")
        XCTAssertNil(voice.error)
        XCTAssertFalse(voice.recording)
        XCTAssertFalse(voice.speaking)
    }
}

final class MessageMarkdownTests: XCTestCase {
    func testExplicitRichStructuresAreParsedWithoutGuessingEntities() {
        XCTAssertEqual(MessageBlock.parse("- [x] Fait\n- [ ] À faire\n> Citation"), [.checklist("Fait", true), .checklist("À faire", false), .quote("Citation")])
        XCTAssertEqual(MessageBlock.parse("Jour | Heure\n--- | ---\nLundi | 10h"), [.table([["Jour", "Heure"], ["Lundi", "10h"]])])
        XCTAssertEqual(MessageBlock.parse("Rendez-vous demain à Toulouse"), [.prose("Rendez-vous demain à Toulouse")])
    }

    func testNativePayloadRoundTripsLocally() throws {
        let block = NativeContentBlock.document(.init(id: UUID(), name: "Note", excerpt: "Texte"))
        let message = ChatMessage(role: "assistant", content: "Résumé", nativeContent: .init(blocks: [block]), completion: .completed)
        XCTAssertEqual(try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(message)), message)
    }
    func testNativePayloadIsExcludedFromCloudHistory() throws {
        let messageID = UUID()
        let message = ChatMessage(id: messageID, role: "assistant", content: "Résumé synchronisable",
            nativeContent: .init(blocks: [.location(.init(latitude: 43.6, longitude: 1.44, accuracy: 10, measuredAt: Date()))]), completion: .completed)
        let conversation = Conversation(title: "Test", model: "local", messages: [message])
        var snapshot = AccountHistorySnapshot(accountId: "account", revision: 0, conversations: [])
        var ids: [String: UUID] = [:]
        try snapshot.store(conversation, serverID: "conversation", messageIDs: &ids)
        let encoded = String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self)
        XCTAssertTrue(encoded.contains("Résumé synchronisable"))
        XCTAssertFalse(encoded.contains("nativeContent"))
        XCTAssertFalse(encoded.contains("43.6"))
    }
    func testNativeBlocks() {
        XCTAssertEqual(MessageBlock.parse("# Titre\nBonjour **vous**\n\n- Premier\n+ Second"),
                       [.heading("Titre", 1), .prose("Bonjour **vous**"), .bullet("Premier"), .bullet("Second")])
    }
    func testStreamingCodePreservesWhitespace() {
        XCTAssertEqual(MessageBlock.parse("```swift\n  let n = 1\n"), [.code("  let n = 1\n", "swift")])
        XCTAssertEqual(MessageBlock.parse("```swift\n  let n = 1\n```\nSuite"),
                       [.code("  let n = 1", "swift"), .prose("Suite")])
    }
    func testFenceLengthAndDelimiter() {
        XCTAssertEqual(MessageBlock.parse("````\n```\n~~~~\n````"), [.code("```\n~~~~", "")])
        XCTAssertEqual(MessageBlock.parse("~~~txt\n# literal\n~~~"), [.code("# literal", "txt")])
    }
    func testUnsupportedAndIndentedSyntaxIsNotDiscarded() {
        XCTAssertEqual(MessageBlock.parse("    ```\n####### sept\n#sans espace"),
                       [.prose("    ```\n####### sept\n#sans espace")])
    }
    func testUntrustedSchemesCannotBecomeActionLinks() {
        for destination in ["multivibe-chat://new", "javascript:alert(1)", "file:///tmp/test", "https://user:pass@example.com"] {
            XCTAssertTrue(MessageBlock.inline("[Lien](\(destination))").runs.allSatisfy { $0.link == nil })
        }
        XCTAssertEqual(MessageBlock.inline("[Site](https://example.com)").runs.first?.link?.host, "example.com")
    }
}

@MainActor final class HomeSuggestionTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let value = UserDefaults(suiteName: "HomeSuggestionTests-\(UUID().uuidString)")!
        value.removePersistentDomain(forName: value.volatileDomainNames.first ?? "")
        return value
    }
    func testDefaultsAndRoundTrip() {
        let storage = defaults()
        XCTAssertEqual(HomeSuggestionStore.load(from: storage), HomeSuggestion.defaults)
        let custom = HomeSuggestion(id: UUID(), title: "Corriger", systemImage: "text.badge.checkmark", instruction: "Corrige les fautes et tournures de phrases", inputSource: .clipboard, behavior: .send)
        HomeSuggestionStore.save([custom], to: storage)
        XCTAssertEqual(HomeSuggestionStore.load(from: storage), [custom])
    }
    func testInvalidAndEmptyDataFallBackAndSaveIsBounded() {
        let storage = defaults()
        storage.set(Data("invalide".utf8), forKey: HomeSuggestionStore.key)
        XCTAssertEqual(HomeSuggestionStore.load(from: storage), HomeSuggestion.defaults)
        let values = (0..<20).map { HomeSuggestion(id: UUID(), title: "\($0)", systemImage: "sparkles", instruction: "Instruction", inputSource: .none, behavior: .prepare) }
        HomeSuggestionStore.save(values, to: storage)
        XCTAssertEqual(HomeSuggestionStore.load(from: storage).count, 12)
    }
}

@MainActor final class ModelRecoveryTests: XCTestCase {
    private func session(_ name: String = "models-fixture") -> NativeSession {
        NativeSession(accessToken: name, refreshToken: name, expiresAt: .distantFuture, accountId: name)
    }
    func testRetryAfterOfflinePreservesConversation() async {
        let credentials = session()
        var calls = 0
        let manager = ConversationManager(services: isolatedServices(load: { credentials }, models: { _ in
            calls += 1
            if calls == 1 { throw APIError.invalidResponse }
            return [ModelOption(id: "chosen")]
        }))
        let conversation = Conversation(model: "chosen", messages: [ChatMessage(role: "user", content: "Keep me")])
        manager.conversations = [conversation]; manager.selection = conversation.id
        await manager.reloadModels()
        XCTAssertNotNil(manager.modelsError)
        XCTAssertFalse(manager.isLoadingModels)
        await manager.reloadModels()
        XCTAssertNil(manager.modelsError)
        XCTAssertEqual(manager.selectedModel, "chosen")
        XCTAssertEqual(manager.conversations, [conversation])
    }
    func testRemovedModelRequiresUserSelection() async {
        let credentials = session()
        let manager = ConversationManager(services: isolatedServices(load: { credentials }, models: { _ in [ModelOption(id: "new")] }))
        let conversation = Conversation(model: "old")
        manager.conversations = [conversation]; manager.selection = conversation.id
        manager.selectedModel = "old"
        await manager.reloadModels()
        XCTAssertEqual(manager.selectedModel, "")
        XCTAssertEqual(manager.current?.model, "old")
    }
    func testEmptyRemoteCatalogStillOffersLocalModel() async {
        let credentials = session()
        let manager = ConversationManager(services: isolatedServices(load: { credentials }, models: { _ in [] }))
        await manager.reloadModels()
        XCTAssertNil(manager.modelsError)
        XCTAssertEqual(manager.models.map(\.id), [LocalModel.id])
    }
    func testLateCatalogCannotRestoreLoggedOutAccount() async throws {
        let credentials = session()
        var pending: CheckedContinuation<[ModelOption], Never>?
        var calls = 0
        let manager = ConversationManager(services: isolatedServices(load: { credentials }, clear: {}, revoke: { _ in }, models: { _ in
            calls += 1
            return await withCheckedContinuation { pending = $0 }
        }))
        let task = Task { await manager.reloadModels() }
        for _ in 0..<1000 { if pending != nil { break }; await Task.yield() }
        let continuation = try XCTUnwrap(pending)
        await manager.reloadModels()
        XCTAssertEqual(calls, 1)
        await manager.logout()
        continuation.resume(returning: [ModelOption(id: "stale")])
        await task.value
        XCTAssertNil(manager.session)
        XCTAssertEqual(manager.models.map(\.id), [LocalModel.id])
        XCTAssertNil(manager.modelsError)
        XCTAssertFalse(manager.isLoadingModels)
    }
}

@MainActor final class NativePasskeyOptionsTests: XCTestCase {
    func testPasskeyChallengeAndAllowList() throws {
        let options = NativePasskeyOptions(challenge: "YWJj", rpId: "app.multivibe.cloud",
            allowCredentials: [.init(id: "ZGVm", type: "public-key")])
        let request = try options.request()
        XCTAssertEqual(request.challenge, Data("abc".utf8))
        XCTAssertEqual(request.allowedCredentials.first?.credentialID, Data("def".utf8))
    }
    func testPasskeyRejectsOtherRPAndInvalidOptions() {
        for options in [
            NativePasskeyOptions(challenge: "YWJj", rpId: "evil.example", allowCredentials: [.init(id: "ZGVm", type: "public-key")]),
            NativePasskeyOptions(challenge: "!", rpId: "app.multivibe.cloud", allowCredentials: [.init(id: "ZGVm", type: "public-key")]),
            NativePasskeyOptions(challenge: "YWJj", rpId: "app.multivibe.cloud", allowCredentials: []),
            NativePasskeyOptions(challenge: "YWJj", rpId: "app.multivibe.cloud", allowCredentials: [.init(id: "ZGVm", type: "password")])
        ] { XCTAssertThrowsError(try options.request()) }
    }
    func testLegacyReplyStillSupportsOTP() throws {
        let reply = try JSONDecoder().decode(AuthReply.self, from: Data(#"{"status":"mfa_required","challenge":"opaque"}"#.utf8))
        XCTAssertNil(reply.passkeyOptions)
        XCTAssertEqual(reply.challenge, "opaque")
    }
}

final class NativeSSOAvailabilityTests: XCTestCase {
    private func configuration(_ capabilities: String = "") throws -> NativeAuthConfiguration {
        try JSONDecoder().decode(NativeAuthConfiguration.self, from: Data(("""
        {"signupEnabled":true,"termsVersion":"2026-09-03","termsUrl":"https://multivibe.cloud/terms/","privacyUrl":"https://multivibe.cloud/privacy/"
        """ + capabilities + "}").utf8))
    }
    func testLegacyServerUnlocksChooserOnlyAfterConsent() throws {
        let config = try configuration()
        for provider in ["google", "github", "apple"] {
            XCTAssertFalse(config.canStartSSO(provider: provider, acceptedTerms: false))
            XCTAssertTrue(config.canStartSSO(provider: provider, acceptedTerms: true))
            XCTAssertNil(config.directSSOProvider(provider))
        }
        XCTAssertTrue(config.usesLegacyProviderChooser)
    }
    func testExplicitUnavailableProvidersStayDisabled() throws {
        let config = try configuration(",\"nativeProviderSelection\":false,\"nativeAppleProviderSelection\":false")
        for provider in ["google", "github", "apple"] {
            XCTAssertFalse(config.canStartSSO(provider: provider, acceptedTerms: true))
        }
    }
    func testModernServerPreservesDirectProviderSelection() throws {
        let config = try configuration(",\"nativeProviderSelection\":true,\"nativeAppleProviderSelection\":true")
        for provider in ["google", "github", "apple"] {
            XCTAssertTrue(config.canStartSSO(provider: provider, acceptedTerms: true))
            XCTAssertEqual(config.directSSOProvider(provider), provider)
        }
        XCTAssertFalse(config.canStartSSO(provider: "unknown", acceptedTerms: true))
        XCTAssertFalse(config.usesLegacyProviderChooser)
    }
}

final class NativeSSOFailureTests: XCTestCase {
    func testMissingAssociationIsNotSilentlyTreatedAsUserCancellation() {
        let error = NSError(domain: ASWebAuthenticationSessionError.errorDomain,
                            code: ASWebAuthenticationSessionError.canceledLogin.rawValue,
                            userInfo: [NSLocalizedFailureReasonErrorKey:
                                "Application with identifier cloud.multivibe.chat is not associated with domain auth.multivibe.cloud."])
        XCTAssertEqual(NativeSSOFailure.message(for: error), NativeSSOFailure.associationMessage)
    }

    func testCancellationWithoutAssociationReasonStillOffersRetry() {
        let error = NSError(domain: ASWebAuthenticationSessionError.errorDomain,
                            code: ASWebAuthenticationSessionError.canceledLogin.rawValue)
        XCTAssertTrue(NativeSSOFailure.message(for: error).contains("réessayer"))
        XCTAssertNotEqual(NativeSSOFailure.message(for: error), NativeSSOFailure.associationMessage)
    }

    func testOtherFailuresPreserveTheirDescription() {
        let error = NSError(domain: "test", code: 1,
                            userInfo: [NSLocalizedDescriptionKey: "Presentation failed"])
        XCTAssertEqual(NativeSSOFailure.message(for: error), "Presentation failed")
    }
}

@MainActor final class NativeSSOCallbackTests: XCTestCase {
    private let state = "expected-state-123456"
    private let code = String(repeating: "a", count: 43)
    private func callback(_ query: String) -> URL {
        URL(string: "https://auth.multivibe.cloud/oauth/callback/ios?" + query)!
    }
    func testValidCodeCanBeExchanged() throws {
        XCTAssertEqual(try NativeSSOController.authorizationCode(from: callback("state=\(state)&code=\(code)"), expectedState: state), code)
    }
    func testServerRejectionHasAnActionableMessage() {
        for (value, expected) in [("access_denied", NativeSSOFailure.accessDenied),
                                  ("invalid_request", .authorizationRejected),
                                  ("server_error", .serverUnavailable),
                                  ("temporarily_unavailable", .serverUnavailable),
                                  ("secret-untrusted-message", .authorizationRejected)] {
            XCTAssertThrowsError(try NativeSSOController.authorizationCode(from: callback("state=\(state)&error=\(value)"), expectedState: state)) {
                XCTAssertEqual($0.localizedDescription, expected.localizedDescription)
            }
        }
    }
    func testStateIsValidatedBeforeErrors() {
        XCTAssertThrowsError(try NativeSSOController.authorizationCode(from: callback("state=wrong&error=access_denied"), expectedState: state)) {
            XCTAssertEqual($0.localizedDescription, NativeSSOFailure.callbackStateMismatch.localizedDescription)
        }
    }
    func testAmbiguousAndMalformedCallbacksRemainRejected() {
        for query in ["state=\(state)&state=\(state)&code=\(code)",
                      "state=\(state)&code=\(code)&code=\(code)",
                      "state=\(state)&code=\(code)&error=access_denied",
                      "state=\(state)&error=access_denied&error=server_error",
                      "state=\(state)&error=", "state=\(state)&code=short"] {
            XCTAssertThrowsError(try NativeSSOController.authorizationCode(from: callback(query), expectedState: state))
        }
        for base in ["http://auth.multivibe.cloud/oauth/callback/ios",
                     "https://evil.example/oauth/callback/ios",
                     "https://auth.multivibe.cloud:443/oauth/callback/ios",
                     "https://auth.multivibe.cloud/oauth/callback/other"] {
            XCTAssertThrowsError(try NativeSSOController.authorizationCode(from: URL(string: "\(base)?state=\(state)&code=\(code)")!, expectedState: state))
        }
    }
}


final class CloudCreditBalanceTests: XCTestCase {
    func testExactDecimalBalancesIncludingZeroAndSmallRemainders() throws {
        for raw in ["0", "11.75", "0.000001"] {
            let data = Data("{\"currency\":\"USD\",\"totalAvailableUsd\":\"\(raw)\"}".utf8)
            let balance = try JSONDecoder().decode(CloudCreditBalance.self, from: data)
            XCTAssertEqual(balance.available, Decimal(string: raw))
            XCTAssertFalse(balance.formatted.isEmpty)
        }
    }
    func testInvalidBalanceNeverBecomesZero() {
        for json in [#"{"currency":"EUR","totalAvailableUsd":"10"}"#,
                     #"{"currency":"USD","totalAvailableUsd":"invalid"}"#,
                     #"{"currency":"USD","totalAvailableUsd":"12oops"}"#,
                     #"{"currency":"USD","totalAvailableUsd":"-1"}"#,
                     #"{"currency":"USD","totalAvailableUsd":10}"#,
                     #"{"currency":"USD"}"#] {
            XCTAssertThrowsError(try JSONDecoder().decode(CloudCreditBalance.self, from: Data(json.utf8)))
        }
    }
}


final class CloudBillingSessionTests: XCTestCase {
    func testZeroBalanceUsesCredits() throws {
        let balance = try JSONDecoder().decode(CloudCreditBalance.self, from: Data(#"{"currency":"USD","totalAvailableUsd":"0"}"#.utf8))
        XCTAssertEqual(balance.formatted, "0 crédits")
    }
    func testBrowserCookieIsSecureHTTPOnlyAndBoundToCloud() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let data = Data("{\"sessionToken\":\"\(String(repeating: "a", count: 43))\",\"expiresAt\":\"2030-01-01T00:00:00Z\"}".utf8)
        let session = try decoder.decode(CloudBillingSession.self, from: data)
        let cookie = try session.cookie(now: Date(timeIntervalSince1970: 0))
        XCTAssertTrue(cookie.isSecure)
        XCTAssertTrue(cookie.isHTTPOnly)
        XCTAssertEqual(cookie.name, "__Host-mv_dashboard_session")
        XCTAssertEqual(cookie.domain, "app.multivibe.cloud")
        XCTAssertEqual(cookie.path, "/")
        XCTAssertEqual(CloudBillingSession.pageURL.absoluteString, "https://app.multivibe.cloud/billing")
        XCTAssertThrowsError(try session.cookie(now: .distantFuture))
    }
    func testInvalidBrowserTokenIsRejected() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let session = try decoder.decode(CloudBillingSession.self, from: Data(#"{"sessionToken":"invalid","expiresAt":"2030-01-01T00:00:00Z"}"#.utf8))
        XCTAssertThrowsError(try session.cookie(now: Date(timeIntervalSince1970: 0)))
    }
}


final class NativeAccountProfileTests: XCTestCase {
    func testAccountWithAndWithoutTeams() throws {
        let profile = try JSONDecoder().decode(NativeAccountProfile.self, from: Data(#"{"accountId":"account","email":"member@example.com","teams":[{"id":"team","name":"My Team"}]}"#.utf8))
        XCTAssertEqual(profile.email, "member@example.com")
        XCTAssertEqual(profile.teams.first?.name, "My Team")
        let personal = try JSONDecoder().decode(NativeAccountProfile.self, from: Data(#"{"accountId":"account","email":null,"teams":[]}"#.utf8))
        XCTAssertNil(personal.email)
        XCTAssertTrue(personal.teams.isEmpty)
    }
}

private final class ProviderTestProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, String))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, body) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
@MainActor final class NativeProviderAPITests: XCTestCase {
    private func api(_ handler: @escaping @Sendable (URLRequest) throws -> (Int, String)) -> ChatAPI {
        ProviderTestProtocol.handler = handler
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProviderTestProtocol.self]
        return ChatAPI(session: URLSession(configuration: configuration))
    }
    func testProviderConnectionUsesNativeBearerBoundary() async throws {
        let api = api { request in
            XCTAssertEqual(request.url?.path, "/native/v1/providers")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer native-fixture")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            return (201, #"{"id":"connection-1","provider":"openai","displayName":"My API","state":"connected","models":["luna"],"authenticationMethod":"api_key"}"#)
        }
        let reply: ProviderConnection = try await api.providerRequest("providers", fields: ["provider": "openai", "displayName": "My API", "apiKey": "fixture-only"], token: "native-fixture")
        XCTAssertEqual(reply.id, "connection-1")
        XCTAssertEqual(reply.authenticationMethod, "api_key")
    }
    func testProviderErrorsDoNotExposeUpstreamDiagnostics() async {
        let api = api { _ in (503, #"{"error":"personal_provider_unavailable","message":"secret-diagnostic-fixture"}"#) }
        do {
            let _: ProviderConnection = try await api.providerRequest("providers", fields: [:], token: "fixture")
            XCTFail("Expected failure")
        } catch { XCTAssertFalse(error.localizedDescription.contains("secret-diagnostic-fixture")) }
    }
    func testLegacySelectionCannotSilentlyUseCloud() async {
        let api = api { _ in XCTFail("Missing access must fail before networking"); return (500, "{}") }
        do { try await api.stream(model: "openai/luna", messages: [], token: "fixture") { _ in }; XCTFail("Expected explicit choice") }
        catch { if case APIError.server(409, "model_access_unavailable") = error {} else { XCTFail("Unexpected error: \(error)") } }
    }
    func testDeviceChallengeDecodesExpiryAndOpaqueFlow() throws {
        let challenge = try JSONDecoder().decode(ProviderChallenge.self, from: Data(#"{"provider":"openai","userCode":"TEST-CODE","verificationUrl":"https://auth.openai.com/codex/device","intervalSeconds":5,"expiresAt":2000000000000,"flowToken":"opaque-fixture"}"#.utf8))
        XCTAssertEqual(challenge.expiry.timeIntervalSince1970, 2000000000)
        XCTAssertEqual(challenge.intervalSeconds, 5)
        XCTAssertEqual(challenge.flowToken, "opaque-fixture")
    }
}
