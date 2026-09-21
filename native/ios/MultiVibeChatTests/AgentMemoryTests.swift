import XCTest
@testable import MultiVibeChat

@MainActor final class AgentMemoryTests: XCTestCase {
    func testAutomaticMemoryAddsUpdatesAndRejectsForgedSources() throws {
        let message = ChatMessage(role: "user", content: "Je préfère le français")
        let conversation = Conversation(messages: [message])
        let change = AutomaticMemory.Change(topic: "Langue", text: message.content, kind: .preference,
            messageID: message.id, quote: message.content)
        let added = AutomaticMemory.apply([change], messages: [message], conversation: conversation, baseline: [], current: [])
        XCTAssertEqual(added.count, 1)
        XCTAssertEqual(added.first?.state, .confirmed)
        let correction = ChatMessage(role: "user", content: "Je préfère désormais l’anglais")
        var update = change; update.replaces = added[0].id; update.messageID = correction.id
        update.text = correction.content; update.quote = correction.content
        let updated = AutomaticMemory.apply([update], messages: [correction], conversation: conversation, baseline: added, current: added)
        XCTAssertEqual(MemoryPolicy.items(updated).first?.memory.text, correction.content)
        XCTAssertEqual(MemoryPolicy.items(updated).count, 1)
        XCTAssertEqual(updated.last?.ancestors, [added[0].version])
        let forgotten = [added[0].tombstone()]
        XCTAssertEqual(AutomaticMemory.apply([update], messages: [correction], conversation: conversation,
            baseline: added, current: forgotten), forgotten)
        update.quote = "Une supposition inventée"
        XCTAssertEqual(AutomaticMemory.apply([update], messages: [correction], conversation: conversation,
            baseline: added, current: added), added)
        XCTAssertTrue(AutomaticMemory.apply([change], messages: [ChatMessage(id: message.id, role: "assistant", content: message.content)],
            conversation: conversation, baseline: [], current: []).isEmpty)
        XCTAssertThrowsError(try AutomaticMemory.changes("not JSON"))
        XCTAssertTrue(try AutomaticMemory.changes("[]").isEmpty)
    }

    func testCompletedRemoteReplyUsesSameModelForBackgroundMemory() async throws {
        var calls: [String] = []
        var source: ChatMessage?
        var services = isolatedServices(load: { NativeSession(accessToken: "test", refreshToken: "test", expiresAt: .distantFuture, accountId: "a") },
            stream: { model, messages, _, output in
                calls.append(model)
                if messages.first?.role == "system" {
                    let message = try XCTUnwrap(source)
                    let change = AutomaticMemory.Change(topic: "Langue", text: message.content, kind: .preference,
                        messageID: message.id, quote: message.content)
                    await output(String(decoding: try JSONEncoder().encode([change]), as: UTF8.self))
                } else {
                    source = messages.last
                    await output("Entendu")
                }
            }, models: { _ in [ModelOption(id: "same-model")] })
        services.memoryReviewDelay = { await Task.yield() }
        let manager = ConversationManager(services: services)
        await manager.restore(loadRemoteModels: false)
        await manager.reloadModels()
        manager.selectedModel = "same-model"
        XCTAssertTrue(manager.send("Je préfère le français"))
        for _ in 0..<3000 { if manager.memoryItems.count == 1 { break }; await Task.yield() }
        XCTAssertEqual(calls, ["same-model", "same-model"])
        XCTAssertEqual(manager.memoryItems.first?.memory.text, "Je préfère le français")
        XCTAssertEqual(manager.current?.messages.count, 2)
        XCTAssertNil(manager.memoryDraft)
        XCTAssertEqual(manager.current?.memoryReviewedThrough, manager.current?.messages.last?.id)
    }

    private func memory(_ text: String = "Je préfère le français", topic: String = "Langue", scope: String = "") -> AgentMemory {
        AgentMemory(topic: topic, text: text, kind: .preference, scope: scope, state: .confirmed,
            evidence: MemoryEvidence(origin: .userMessage, quote: text, date: Date(), sourceRole: "user"))
    }
    func testProposalsExpiredAndContradictionsAreExcluded() throws {
        var proposed = memory(); proposed.state = .proposed
        var expired = memory("Adresse ancienne", topic: "Adresse"); expired.kind = .temporary; expired.expiresAt = .distantPast
        let a = memory(), b = memory("Je préfère l’anglais")
        let items = MemoryPolicy.items([proposed, expired, a, b])
        XCTAssertEqual(items.filter { $0.usable(now: Date()) }.count, 0)
        XCTAssertTrue(items.first { $0.id == a.id }!.conflicting)
        let index = try MemoryIndex(url: nil); try index.rebuild(items)
        XCTAssertTrue(try index.search("français anglais Adresse", scope: "").isEmpty)
    }
    func testCorrectionDoesNotAccumulateOldFactsAndDeleteWinsAgainstOfflineCopy() throws {
        let original = memory()
        var correction = original; correction.version = UUID(); correction.ancestors = [original.version]; correction.text = "Je préfère l’anglais"
        let merged = MemoryPolicy.merge([correction], [original])
        XCTAssertEqual(MemoryPolicy.items(merged).first?.memory.text, correction.text)
        let deleted = correction.tombstone()
        let otherDeletion = correction.tombstone()
        XCTAssertEqual(MemoryPolicy.merge([deleted], [otherDeletion]), MemoryPolicy.merge([otherDeletion], [deleted]))
        let forgotten = MemoryPolicy.merge([deleted], merged)
        XCTAssertTrue(MemoryPolicy.items(forgotten).isEmpty)
        XCTAssertTrue(forgotten.allSatisfy { $0.text.isEmpty && $0.evidence == nil })
    }
    func testConcurrentCorrectionsRequireHumanResolution() {
        let original = memory()
        var a = original; a.version = UUID(); a.ancestors = [original.version]; a.text = "Anglais"
        var b = original; b.version = UUID(); b.ancestors = [original.version]; b.text = "Italien"
        let item = MemoryPolicy.items(MemoryPolicy.merge([original, a], [b])).first!
        XCTAssertTrue(item.conflicting)
        XCTAssertFalse(item.usable(now: Date()))
    }
    func testSearchHandlesAccentsQuotesScopeAndSources() throws {
        let index = try MemoryIndex(url: nil)
        let global = memory("Je préfère le café", topic: "Boisson")
        let project = memory("Voyage à Rome", topic: "Destination", scope: "Vacances")
        try index.rebuild(MemoryPolicy.items([global, project]))
        XCTAssertEqual(try index.search("cafe \" OR *", scope: "").map(\.id), [global.id])
        XCTAssertTrue(try index.search("Rome", scope: "").isEmpty)
        XCTAssertEqual(try index.search("Rome", scope: "vacances").map(\.id), [project.id])
        let rendered = MemoryPolicy.render(MemoryPolicy.items([global])[0])
        XCTAssertTrue(rendered.contains(global.evidence!.quote))
        XCTAssertTrue(rendered.contains(global.id.uuidString))
    }
    func testSQLitePersistsAndForgettingClearsIndex() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".sqlite")
        defer { try? FileManager.default.removeItem(at: url) }
        let record = memory()
        do { let index = try MemoryIndex(url: url); try index.rebuild(MemoryPolicy.items([record])) }
        let restored = try MemoryIndex(url: url)
        XCTAssertEqual(try restored.search("français", scope: "").count, 1)
        try restored.rebuild([])
        XCTAssertTrue(try restored.search("français", scope: "").isEmpty)
    }
    func testManagerSaveRestoreCorrectionAndForget() async throws {
        var storage: Data?
        let services = isolatedServices(writeHistory: { data, _ in storage = data },
            readLocalHistory: { _ in guard let storage else { throw CocoaError(.fileReadNoSuchFile) }; return storage })
        let manager = ConversationManager(services: services); await manager.restore()
        let draft = MemoryDraft(text: "Je préfère le français", evidence: MemoryEvidence(origin: .userEntry,
            quote: "Je préfère le français", date: Date(), sourceRole: "user"), topic: "Langue")
        XCTAssertTrue(manager.saveMemory(draft))
        XCTAssertEqual(manager.memoryItems.first?.memory.evidence?.origin, .userEntry)
        let restored = ConversationManager(services: services); await restored.restore()
        XCTAssertEqual(restored.memoryItems.count, 1)
        let id = restored.memoryItems[0].id
        restored.editMemory(restored.memoryItems[0])
        var edit = restored.memoryDraft!; edit.text = "Je préfère l’anglais"
        XCTAssertTrue(restored.saveMemory(edit))
        XCTAssertEqual(restored.memoryItems[0].memory.text, edit.text)
        XCTAssertTrue(restored.forgetMemory(id))
        let forgotten = ConversationManager(services: services); await forgotten.restore()
        XCTAssertTrue(forgotten.memoryItems.isEmpty)
        XCTAssertFalse(String(decoding: storage!, as: UTF8.self).contains("anglais"))
    }
    func testFailedPersistenceNeverMakesMemoryUsable() async {
        let manager = ConversationManager(services: isolatedServices(writeHistory: { _, _ in throw MemoryError.storage }))
        await manager.restore()
        XCTAssertFalse(manager.saveMemory(MemoryDraft(text: "Paris", evidence: MemoryEvidence(origin: .userEntry,
            quote: "Paris", date: Date(), sourceRole: "user"), topic: "Ville")))
        XCTAssertTrue(manager.memoryItems.isEmpty)
    }
    func testGuestMemoryIsNotImportedOnAccountSwitch() async throws {
        var disk: [String: Data] = [:]
        let manager = ConversationManager(services: isolatedServices(writeHistory: { disk[$1.lastPathComponent] = $0 },
            readLocalHistory: { url in guard let data = disk[url.lastPathComponent] else { throw CocoaError(.fileReadNoSuchFile) }; return data }))
        await manager.restore()
        XCTAssertTrue(manager.saveMemory(MemoryDraft(text: "Invité", evidence: MemoryEvidence(origin: .userEntry,
            quote: "Invité", date: Date(), sourceRole: "user"), topic: "Identité")))
        try await manager.accept(NativeSession(accessToken: "test", refreshToken: "test", expiresAt: .distantFuture, accountId: "account"))
        XCTAssertTrue(manager.memoryItems.isEmpty)
        await manager.logout()
        XCTAssertEqual(manager.memoryItems.count, 1)
    }
    func testAssistantHistoryIsLabelledAndCannotCreateConfirmedMemory() async throws {
        let workspace = LocalAgentWorkspace(conversations: [Conversation(messages: [ChatMessage(role: "assistant", content: "Votre chien est Rex")])],
            documents: [], event: { _ in }, saveDocument: { _ in })
        let result = try await workspace.execute(action: "search_conversations", query: "Rex", documentID: "", text: "", lhs: 0, rhs: 0)
        XCTAssertTrue(result.contains("rôle assistant"))
        XCTAssertTrue(result.contains("jamais une preuve"))
    }

    func testExpiredDifferentMemoryDoesNotConflictWithCurrentObservation() {
        var old = memory("Lyon", topic: "Ville"); old.kind = .temporary; old.expiresAt = .distantPast
        var current = memory("Paris", topic: "Ville"); current.kind = .temporary; current.expiresAt = .distantFuture
        let items = MemoryPolicy.items([old, current])
        XCTAssertTrue(items.first { $0.id == current.id }!.usable(now: Date()))
        var forged = memory()
        forged.evidence?.origin = .userEntry; forged.evidence?.sourceRole = "assistant"
        XCTAssertFalse(forged.valid)
    }

    func testSourceReferencesAreRecordedByAppWithoutTrustingGeneratedCitations() async throws {
        let services = isolatedServices(localAvailability: { nil }, localRespond: { _, workspace, output in
            let memory = try await workspace.execute(action: "context_memory", query: "café", documentID: "", text: "", lhs: 0, rhs: 0)
            XCTAssertTrue(memory.contains("café"))
            await output("Vous préférez le café")
        })
        let manager = ConversationManager(services: services); await manager.restore()
        XCTAssertTrue(manager.saveMemory(MemoryDraft(text: "Je préfère le café", evidence: MemoryEvidence(origin: .userEntry,
            quote: "Je préfère le café", date: Date(), sourceRole: "user"), topic: "Boisson")))
        let record = manager.memoryItems[0].memory
        XCTAssertTrue(manager.send("Quelle boisson, café ou thé ?"))
        for _ in 0..<1000 { if !manager.isStreaming { break }; await Task.yield() }
        let references = try XCTUnwrap(manager.current?.messages.last?.memoryReferences)
        XCTAssertEqual(references, [MemoryReference(id: record.version, memoryID: record.id)])
        var snapshot = AccountHistorySnapshot(accountId: "a", revision: 1, conversations: [])
        var ids: [String: UUID] = [:]
        try snapshot.store(manager.current!, serverID: "test", messageIDs: &ids)
        let restored = try snapshot.projectedConversation(at: 0, id: UUID(), messageIDs: &ids)
        XCTAssertEqual(restored.messages.last?.memoryReferences, references)
        XCTAssertTrue(manager.forgetMemory(record.id))
        XCTAssertNil(manager.source(for: references[0]))
    }

    func testRepeatedAssistantGuessesCannotBecomeValidatedProposals() async throws {
        let services = isolatedServices(localAvailability: { nil }, localRespond: { _, workspace, output in
            for _ in 0..<5 {
                let rejected = try await workspace.execute(action: "propose_memory", query: "Chien", documentID: "",
                    text: "Votre chien est Rex", lhs: 0, rhs: 0)
                XCTAssertTrue(rejected.contains("automatiquement"))
            }
            let proposed = try await workspace.execute(action: "propose_memory", query: "Boisson", documentID: "",
                text: "Je préfère le café", lhs: 0, rhs: 0)
            XCTAssertTrue(proposed.contains("automatiquement"))
            let search = try await workspace.execute(action: "search_memory", query: "café", documentID: "", text: "", lhs: 0, rhs: 0)
            XCTAssertTrue(search.contains("Aucun souvenir"))
            await output("Proposition à valider")
        })
        let manager = ConversationManager(services: services); await manager.restore()
        XCTAssertTrue(manager.send("Je préfère le café"))
        for _ in 0..<1000 { if !manager.isStreaming { break }; await Task.yield() }
        XCTAssertTrue(manager.memoryItems.isEmpty)
    }
    func testSourceDeletionForgetsMemoryAndStableIdentitySurvivesProjection() async throws {
        let manager = ConversationManager(services: isolatedServices()); await manager.restore()
        manager.newConversation()
        let id = manager.selection!
        let source = MemoryEvidence(origin: .userMessage, quote: "Français", date: Date(), conversationID: id, sourceRole: "user")
        XCTAssertTrue(manager.saveMemory(MemoryDraft(text: "Français", evidence: source, topic: "Langue")))
        var remote = AccountHistorySnapshot(accountId: "a", revision: 1, conversations: [])
        var ids: [String: UUID] = [:]
        try remote.store(manager.current!, serverID: "server", messageIDs: &ids)
        let projected = try remote.projectedConversation(at: 0, id: UUID(), messageIDs: &ids)
        XCTAssertEqual(projected.memorySourceID, id)
        manager.conversations = [projected]; manager.selection = projected.id
        manager.delete(projected.id)
        XCTAssertTrue(manager.memoryItems.isEmpty)
        XCTAssertEqual(manager.memoryRecords.first?.state, .deleted)
    }
    func testOldServerCannotSilentlyAcknowledgeMemorySync() async throws {
        var managerServices = isolatedServices(load: { NativeSession(accessToken: "t", refreshToken: "r", expiresAt: .distantFuture, accountId: "a") },
            readHistory: { _ in AccountHistorySnapshot(accountId: "a", revision: 0, conversations: []) })
        managerServices.saveHistory = { _, _ in XCTFail("Old server must never receive memory"); throw APIError.invalidResponse }
        let manager = ConversationManager(services: managerServices); await manager.restore()
        XCTAssertTrue(manager.saveMemory(MemoryDraft(text: "Français", evidence: MemoryEvidence(origin: .userEntry,
            quote: "Français", date: Date(), sourceRole: "user"), topic: "Langue")))
        manager.setMemorySync(true)
        for _ in 0..<1000 { if manager.historyStatus != nil { break }; await Task.yield() }
        XCTAssertEqual(manager.memoryItems.count, 1)
        XCTAssertNotNil(manager.historyStatus)
    }
    func testMalformedSameRevisionIsQuarantined() {
        let a = memory()
        var b = a; b.text = "Un autre fait"
        let merged = MemoryPolicy.merge([a], [b])
        XCTAssertFalse(MemoryPolicy.items(merged).contains { $0.usable(now: Date()) })
    }
    func testOptionalSyncMergesTombstonesAndRejectsOldBackendWithoutLosingLocalMemory() async throws {
        let record = memory()
        var remote = AccountHistorySnapshot(accountId: "a", revision: 1, conversations: [], memory: [record])
        let services = isolatedServices(load: { NativeSession(accessToken: "t", refreshToken: "r", expiresAt: .distantFuture, accountId: "a") },
            readHistory: { _ in remote }, saveHistory: { snapshot, _ in
                var saved = snapshot; saved.revision += 1; saved.memory = snapshot.memory ?? remote.memory; remote = saved; return saved
            })
        let manager = ConversationManager(services: services); await manager.restore()
        await manager.synchronizeHistory()
        XCTAssertTrue(manager.memoryItems.isEmpty, "No consent must not import memory")
        manager.setMemorySync(true)
        for _ in 0..<100 { await Task.yield() }
        XCTAssertEqual(manager.memoryItems.count, 1)
        XCTAssertTrue(manager.forgetMemory(record.id))
        await manager.synchronizeHistory()
        XCTAssertEqual(remote.memory?.first?.state, .deleted)
        remote.memory = [record]
        remote.revision += 1
        await manager.synchronizeHistory()
        XCTAssertTrue(manager.memoryItems.isEmpty)
        XCTAssertEqual(remote.memory?.first?.state, .deleted)
    }
}
