import XCTest
@testable import MultiVibeChat

@MainActor final class NativeIntentTests: XCTestCase {
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
}
