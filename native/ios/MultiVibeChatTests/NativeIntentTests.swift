import XCTest
@testable import MultiVibeChat

@MainActor final class NativeIntentTests: XCTestCase {
    func testRepeatedNewConversationReusesUnusedConversation() async throws {
        let manager = ConversationManager(services: isolatedServices())
        await manager.restore(loadRemoteModels: false)
        manager.newConversation()
        let id = try XCTUnwrap(manager.selection)
        manager.newConversation()
        manager.newConversation()
        XCTAssertEqual(manager.selection, id)
        XCTAssertEqual(manager.conversations.count, 1)
        XCTAssertTrue(manager.historyConversations.isEmpty)
    }

    func testNewConversationReusesDraftAfterOpeningUsedConversation() async throws {
        let manager = ConversationManager(services: isolatedServices())
        await manager.restore(loadRemoteModels: false)
        manager.newConversation()
        let usedID = try XCTUnwrap(manager.selection)
        manager.conversations[0].messages.append(ChatMessage(role: "user", content: "Bonjour"))
        XCTAssertEqual(manager.historyConversations.map(\.id), [usedID])
        manager.newConversation()
        let draftID = try XCTUnwrap(manager.selection)
        XCTAssertNotEqual(draftID, usedID)
        manager.selection = usedID
        manager.newConversation()
        XCTAssertEqual(manager.selection, draftID)
        XCTAssertEqual(manager.conversations.count, 2)
        XCTAssertEqual(manager.historyConversations.map(\.id), [usedID])
    }

    func testFirstSendMakesDraftVisibleInHistory() async throws {
        let manager = ConversationManager(services: isolatedServices(localAvailability: { nil },
            localRespond: { _, _, output in await output("Réponse") }))
        await manager.restore(loadRemoteModels: false)
        manager.selectedModel = LocalModel.id
        manager.newConversation()
        let id = try XCTUnwrap(manager.selection)
        XCTAssertFalse(manager.send("   "))
        XCTAssertTrue(manager.historyConversations.isEmpty)
        XCTAssertTrue(manager.send("Bonjour"))
        XCTAssertEqual(manager.historyConversations.map(\.id), [id])
        XCTAssertEqual(manager.current?.messages.first?.content, "Bonjour")
        manager.stop()
    }

    func testDeferredLocalRequestAndNoImplicitSend() async throws {
        let manager = ConversationManager(services: isolatedServices(localAvailability: { nil }))
        manager.queueNativeShortcut(.init(localDraft: "Bonjour"))
        XCTAssertNil(try manager.applyNativeShortcut())
        await manager.restore(loadRemoteModels: false)
        XCTAssertNotNil(try manager.applyNativeShortcut())
        XCTAssertEqual(manager.selectedModel, LocalModel.id)
        XCTAssertEqual(manager.pendingDraft, "Bonjour")
        XCTAssertTrue(manager.current!.messages.isEmpty)
        XCTAssertNil(try manager.applyNativeShortcut())
    }
    func testAccountMismatchDoesNotOpenConversation() async throws {
        let manager = ConversationManager(services: isolatedServices())
        await manager.restore(loadRemoteModels: false)
        manager.newConversation()
        let id = manager.selection!
        manager.queueNativeShortcut(.init(conversationID: id, accountID: "another-account"))
        XCTAssertThrowsError(try manager.applyNativeShortcut())
        XCTAssertThrowsError(try manager.shortcutConversation(id, accountID: "another-account"))
        XCTAssertNil(manager.nativeShortcut)
    }
    func testUnavailableLocalModelDoesNotFallBack() async throws {
        let manager = ConversationManager(services: isolatedServices(localAvailability: { "Indisponible" }))
        await manager.restore(loadRemoteModels: false)
        manager.selectedModel = "remote"
        manager.queueNativeShortcut(.init(localDraft: "Bonjour"))
        XCTAssertThrowsError(try manager.applyNativeShortcut())
        XCTAssertEqual(manager.selectedModel, "remote")
        XCTAssertTrue(manager.conversations.isEmpty)
    }
    func testMemoryRequiresConfirmation() async throws {
        let manager = ConversationManager(services: isolatedServices())
        await manager.restore(loadRemoteModels: false)
        manager.queueNativeShortcut(.init(memoryText: "Je préfère le français"))
        _ = try manager.applyNativeShortcut()
        XCTAssertEqual(manager.memoryDraft?.text, "Je préfère le français")
        XCTAssertTrue(manager.memoryItems.isEmpty)
    }
    func testDeletedConversationIsNotSubstituted() async throws {
        let manager = ConversationManager(services: isolatedServices())
        await manager.restore(loadRemoteModels: false)
        manager.queueNativeShortcut(.init(conversationID: UUID()))
        XCTAssertThrowsError(try manager.applyNativeShortcut())
        XCTAssertTrue(manager.conversations.isEmpty)
    }
    func testBusyHandoffDoesNotInterruptGeneration() async throws {
        let manager = ConversationManager(services: isolatedServices())
        await manager.restore(loadRemoteModels: false)
        manager.isStreaming = true
        manager.queueNativeShortcut(.init(localDraft: "Autre demande"))
        XCTAssertThrowsError(try manager.applyNativeShortcut())
        XCTAssertTrue(manager.isStreaming)
    }
    func testDocumentImportUsesLocalStore() async throws {
        let manager = ConversationManager(services: isolatedServices())
        await manager.restore(loadRemoteModels: false)
        manager.queueNativeShortcut(.init(destination: .documents, documentName: "Notes", documentText: "Texte local"))
        _ = try manager.applyNativeShortcut()
        XCTAssertEqual(manager.localDocuments.first?.text, "Texte local")
        XCTAssertTrue(manager.conversations.isEmpty)
    }
    func testLocalInferenceReturnsCompletedReplyWithoutRemoteTransport() async throws {
        var services = isolatedServices(localAvailability: { nil }, localRespond: { _, _, output in
            await output("Réponse locale")
        })
        services.stream = { _, _, _, _ in XCTFail("No remote fallback") }
        let manager = ConversationManager(services: services)
        await manager.restore(loadRemoteModels: false)
        let reply = try await manager.askLocalFromShortcut("Bonjour")
        XCTAssertEqual(reply, "Réponse locale")
        XCTAssertEqual(manager.current?.model, LocalModel.id)
        XCTAssertEqual(manager.current?.messages.first?.content, "Bonjour")
    }
    func testCancelledShortcutStopsOnlyItsOwnRun() async throws {
        let services = isolatedServices(localAvailability: { nil }, localRespond: { _, _, _ in
            try await Task.sleep(for: .seconds(10))
        })
        let manager = ConversationManager(services: services)
        await manager.restore(loadRemoteModels: false)
        let task = Task { try await manager.askLocalFromShortcut("Bonjour") }
        while !manager.isStreaming { await Task.yield() }
        task.cancel()
        do { _ = try await task.value; XCTFail("Cancellation must throw") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertFalse(manager.isStreaming)
        XCTAssertEqual(manager.current?.messages.last?.completion, .stopped)
    }
    func testNativeColdStartLoadsOnlyOnce() async {
        var reads = 0
        let services = isolatedServices(readLocalHistory: { _ in reads += 1; throw CocoaError(.fileReadNoSuchFile) })
        let manager = ConversationManager(services: services)
        await manager.restoreForNativeEntry()
        manager.newConversation()
        let id = manager.selection
        await manager.restoreForNativeEntry()
        XCTAssertEqual(reads, 1)
        XCTAssertEqual(manager.selection, id)
    }

    func testCancelledOldShortcutDoesNotStopNewConversation() async throws {
        let manager = ConversationManager(services: isolatedServices(localAvailability: { nil }, localRespond: { _, _, _ in
            try await Task.sleep(for: .seconds(10))
        }))
        await manager.restore(loadRemoteModels: false)
        let oldTask = Task { try await manager.askLocalFromShortcut("Ancienne demande") }
        while !manager.isStreaming { await Task.yield() }
        manager.newConversation()
        XCTAssertTrue(manager.send("Nouvelle demande"))
        oldTask.cancel()
        _ = try? await oldTask.value
        XCTAssertTrue(manager.isStreaming)
        XCTAssertEqual(manager.current?.messages.first?.content, "Nouvelle demande")
        manager.stop()
    }
    func testUnavailableStorageCannotBeQueried() async {
        let manager = ConversationManager(services: isolatedServices(readLocalHistory: { _ in throw CocoaError(.fileReadNoPermission) }))
        await manager.restoreForNativeEntry()
        XCTAssertFalse(manager.nativeDataReady)
        XCTAssertThrowsError(try manager.shortcutConversation(UUID(), accountID: nil))
    }

}
