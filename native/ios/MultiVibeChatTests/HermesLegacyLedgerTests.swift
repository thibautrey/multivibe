import XCTest
@testable import MultiVibeChat

final class HermesLegacyLedgerTests: XCTestCase {
    private func record(_ revision: String = "r1", payload: String = "{\"unknown\":{\"evidence\":[1,2]}}", deleted: Bool = false, container: String = "conversation-original") -> HermesLegacyRecord {
        .init(kind: .memory, id: "memory-original", revision: revision, container: container,
              payload: Data(payload.utf8), deleted: deleted, inferenceUsable: false)
    }
    private func directory() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }

    func testLosslessRestartStableIdentityAndNoPublication() async throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        let ledger = HermesLegacyLedger(root: root)
        let original = record()
        let first = try await ledger.convert([original], accountID: "a")
        let restored = try await HermesLegacyLedger(root: root).convert([original], accountID: "a")
        XCTAssertEqual(first, restored)
        XCTAssertEqual(first.conversions.first?.record.payload, original.payload)
        XCTAssertEqual(first.conversions.first?.record.id, "memory-original")
        XCTAssertEqual(first.conversions.first?.publication, .converted)
        XCTAssertTrue(first.inferenceCandidates.isEmpty)
        let noWrite = HermesLegacyLedger(root: root, writeFile: { _, _ in throw CocoaError(.fileWriteOutOfSpace) })
        let repeated = try await noWrite.convert([original], accountID: "a")
        XCTAssertEqual(repeated, first)
    }

    func testCollisionsAndTombstonesPreserveAcceptedRevisions() async throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        let ledger = HermesLegacyLedger(root: root)
        let first = try await ledger.convert([record()], accountID: "a")
        let result = try await ledger.convert([
            record(payload: "different bytes"), record("r2", container: "different scope"),
            record("r3", deleted: true), record("r4")
        ], accountID: "a")
        XCTAssertEqual(result.conversions.count, 2)
        XCTAssertEqual(result.conversions[0], first.conversions[0])
        XCTAssertEqual(result.quarantine.map(\.reason), ["revision_or_payload_collision", "identity_container_collision", "tombstone_resurrection"])
        let restarted = try await HermesLegacyLedger(root: root).convert([record("r4")], accountID: "a")
        XCTAssertEqual(restarted, result)
    }

    func testGuestAccountIsolationAndIndependentMemoryRevisions() async throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        let ledger = HermesLegacyLedger(root: root)
        let guest = try await ledger.convert([record()], accountID: nil)
        let a = try await ledger.convert([record(), record("r2", payload: "second revision")], accountID: "a")
        let b = try await ledger.convert([record()], accountID: "b")
        XCTAssertNotEqual(guest.scope, a.scope); XCTAssertNotEqual(a.scope, b.scope)
        XCTAssertNotEqual(a.deviceID, b.deviceID)
        XCTAssertEqual(a.conversions.count, 2)
        XCTAssertEqual(a.conversions.map { $0.record.revision }, ["r1", "r2"])
        XCTAssertEqual(a.bindings.count, 1)
    }

    func testDiskFailureLeavesPreviousDurableState() async throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        let first = try await HermesLegacyLedger(root: root).convert([record()], accountID: "a")
        let failing = HermesLegacyLedger(root: root, writeFile: { _, _ in throw CocoaError(.fileWriteOutOfSpace) })
        do {
            _ = try await failing.convert([record("r2")], accountID: "a")
            XCTFail("Expected disk failure")
        } catch {}
        let restored = try await HermesLegacyLedger(root: root).snapshot(accountID: "a")
        XCTAssertEqual(restored, first)
    }
    func testUnreadableLedgerIsNeverReplaced() async throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        let ledger = HermesLegacyLedger(root: root)
        _ = try await ledger.convert([record()], accountID: "a")
        let url = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first)
        let corrupt = Data("unsupported or corrupt ledger".utf8)
        try corrupt.write(to: url, options: .atomic)
        do {
            _ = try await ledger.convert([record("r2")], accountID: "a")
            XCTFail("Expected corrupt ledger rejection")
        } catch {}
        XCTAssertEqual(try Data(contentsOf: url), corrupt)
    }

    func testValidJSONPayloadTamperingIsRejectedWithoutReplacement() async throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        let ledger = HermesLegacyLedger(root: root)
        _ = try await ledger.convert([record()], accountID: "a")
        let url = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var conversions = try XCTUnwrap(object["conversions"] as? [[String: Any]])
        var source = try XCTUnwrap(conversions[0]["record"] as? [String: Any])
        source["payload"] = Data("tampered".utf8).base64EncodedString()
        conversions[0]["record"] = source; object["conversions"] = conversions
        let tampered = try JSONSerialization.data(withJSONObject: object)
        try tampered.write(to: url, options: .atomic)
        do {
            _ = try await ledger.convert([record("r2")], accountID: "a")
            XCTFail("Expected digest validation failure")
        } catch {}
        XCTAssertEqual(try Data(contentsOf: url), tampered)
    }

    func testConcurrentActorsRetainEveryAcceptedRecord() async throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        let actors = (0..<20).map { _ in HermesLegacyLedger(root: root) }
        try await withThrowingTaskGroup(of: Void.self) { group in
            for (index, ledger) in actors.enumerated() {
                group.addTask {
                    let item = HermesLegacyRecord(kind: .memory, id: "memory-\(index)", revision: "r1",
                        container: "scope", payload: Data("payload-\(index)".utf8), deleted: false, inferenceUsable: true)
                    _ = try await ledger.convert([item], accountID: "a")
                }
            }
            try await group.waitForAll()
        }
        let snapshot = try await HermesLegacyLedger(root: root).snapshot(accountID: "a")
        XCTAssertEqual(snapshot?.conversions.count, 20)
        XCTAssertEqual(Set(snapshot?.conversions.map { $0.record.id } ?? []).count, 20)
    }

    func testTombstoneExcludesHistoricalUsableMemoryAndKeepsPayload() async throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        let ledger = HermesLegacyLedger(root: root)
        let live = HermesLegacyRecord(kind: .memory, id: "memory", revision: "z",
            container: "scope", payload: Data("original rich memory".utf8), deleted: false, inferenceUsable: true)
        let newer = HermesLegacyRecord(kind: .memory, id: "memory", revision: "a",
            container: "scope", payload: Data("locally accepted later".utf8), deleted: false, inferenceUsable: true)
        let before = try await ledger.convert([live, newer], accountID: "a")
        XCTAssertEqual(before.inferenceCandidates, [newer])
        let dead = HermesLegacyRecord(kind: .memory, id: "memory", revision: "deleted",
            container: "scope", payload: Data("original tombstone".utf8), deleted: true, inferenceUsable: false)
        let after = try await ledger.convert([dead], accountID: "a")
        XCTAssertTrue(after.inferenceCandidates.isEmpty)
        XCTAssertEqual(after.conversions[0].record, live)
        XCTAssertEqual(after.conversions[1].record, newer)
    }

    func testRawArchiveRestartPreservesUnknownFieldsAndFormatting() async throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        let original = Data(" { \"unknownTopLevel\": [1, {\"future\":true}], \"conversations\": [] }\n".utf8)
        let ledger = HermesLegacyLedger(root: root)
        let hash = try await ledger.archive(original, accountID: "account/a")
        let restarted = HermesLegacyLedger(root: root, writeFile: { _, _ in throw CocoaError(.fileWriteOutOfSpace) })
        let repeated = try await restarted.archive(original, accountID: "account/a")
        let restored = try await restarted.archivedBytes(digest: hash, accountID: "account/a")
        XCTAssertEqual(hash, repeated); XCTAssertEqual(restored, original)
        let snapshot = try await restarted.snapshot(accountID: "account/a")
        XCTAssertNil(snapshot) // Preservation does not create conversions or grant eligibility.
    }

    func testRawArchiveAccountGuestSeparation() async throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        let ledger = HermesLegacyLedger(root: root)
        let bytes = Data("[]".utf8)
        let hash = try await ledger.archive(bytes, accountID: "a")
        let absentGuest = try await ledger.archivedBytes(digest: hash, accountID: nil)
        let absentB = try await ledger.archivedBytes(digest: hash, accountID: "b")
        XCTAssertNil(absentGuest); XCTAssertNil(absentB)
        _ = try await ledger.archive(bytes, accountID: nil)
        let guest = try await ledger.archivedBytes(digest: hash, accountID: nil)
        XCTAssertEqual(guest, bytes)
    }

    func testCorruptRawArchiveFailsClosedWithoutReplacement() async throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        let ledger = HermesLegacyLedger(root: root)
        let bytes = Data("original".utf8)
        let hash = try await ledger.archive(bytes, accountID: "a")
        let entries = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.allObjects as? [URL])
        let url = try XCTUnwrap(entries.first { $0.lastPathComponent == hash + ".raw" })
        let corrupt = Data("corrupt".utf8); try corrupt.write(to: url, options: .atomic)
        do { _ = try await ledger.archive(bytes, accountID: "a"); XCTFail("Expected corrupt archive failure") } catch {}
        do { _ = try await ledger.archivedBytes(digest: hash, accountID: "a"); XCTFail("Expected read validation failure") } catch {}
        XCTAssertEqual(try Data(contentsOf: url), corrupt)
    }

    func testRawArchiveBoundsAndDiskFailurePreserveSourceAndPriorArchive() async throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        let ledger = HermesLegacyLedger(root: root)
        let source = root.appendingPathComponent("history-source.json")
        let original = Data("original history".utf8)
        let hash = try await ledger.archive(original, accountID: "a")
        try original.write(to: source, options: .atomic)
        let failing = HermesLegacyLedger(root: root, writeFile: { _, _ in throw CocoaError(.fileWriteOutOfSpace) })
        do { _ = try await failing.archive(Data("new bytes".utf8), accountID: "a"); XCTFail("Expected disk failure") } catch {}
        do {
            _ = try await ledger.archive(Data(repeating: 0, count: HermesLegacyLedger.maximumBytes + 1), accountID: "a")
            XCTFail("Expected archive size failure")
        } catch HermesLegacyLedgerError.tooLarge {} catch { XCTFail("Unexpected error: \(error)") }
        let restored = try await ledger.archivedBytes(digest: hash, accountID: "a")
        XCTAssertEqual(restored, original); XCTAssertEqual(try Data(contentsOf: source), original)
    }

    func testScannerExactUnknownPayloadAndOpaqueNumbers() throws {
        let text = " \n" + #"{"conversations":[],"future":{"huge":9007199254740993123456789,"exponent":-1.2300e+999},"memory":null}"# + "\r\n"
        let bytes = Data(text.utf8)
        let root = try HermesLegacyJSONScanner.scan(bytes)
        guard case .object(let members) = root.kind else { return XCTFail("Expected object") }
        XCTAssertEqual(members.map(\.key), ["conversations", "future", "memory"])
        guard case .object(let future) = members[1].value.kind else { return XCTFail("Expected future fields") }
        XCTAssertEqual(String(decoding: bytes.subdata(in: future[0].value.range), as: UTF8.self), "9007199254740993123456789")
        XCTAssertEqual(String(decoding: bytes.subdata(in: future[1].value.range), as: UTF8.self), "-1.2300e+999")
        XCTAssertEqual(bytes.subdata(in: root.range), Data(text.trimmingCharacters(in: .whitespacesAndNewlines).utf8))
    }

    func testScannerEscapesUnicodeAndBracketStrings() throws {
        let text = #"{"\u0069d":"quote\" slash\\ braces{}[]","emoji":"\uD83D\uDE00","utf8":"é東京"}"#
        let bytes = Data(text.utf8)
        let root = try HermesLegacyJSONScanner.scan(bytes)
        guard case .object(let members) = root.kind else { return XCTFail("Expected object") }
        XCTAssertEqual(members[0].key, "id")
        guard case .string(let emoji) = members[1].value.kind else { return XCTFail("Expected string") }
        XCTAssertEqual(emoji, "😀")
        XCTAssertEqual(String(decoding: bytes.subdata(in: members[1].value.range), as: UTF8.self), #""\uD83D\uDE00""#)
    }

    func testScannerLegacyArrayNullAndAlternatingDictionaryArray() throws {
        for text in ["[]", "{}", "null", #"[{"id":"original","messages":[]}]"#,
                     #"{"importedGuestSnapshots":["uuid",{"id":"original"}],"memory":null}"#] {
            let bytes = Data(text.utf8)
            let root = try HermesLegacyJSONScanner.scan(bytes)
            XCTAssertEqual(bytes.subdata(in: root.range), bytes)
        }
    }

    func testScannerRejectsMalformedGrammarAndUnicode() {
        for text in ["", "[", "{", "[1,]", #"{"id":}"#, "true false", "01", "-01", "1.", "1e", "+1", "NaN",
                     #""\x""#, #""\uD800""#, #""\uDC00""#, #""\uD800\u0041""#, #""\uZZZZ""#,
                     "\"raw\nnewline\"", #"{"a":1 "b":2}"#] {
            XCTAssertThrowsError(try HermesLegacyJSONScanner.scan(Data(text.utf8)), text)
        }
        XCTAssertThrowsError(try HermesLegacyJSONScanner.scan(Data([34, 0xFF, 34])))
        XCTAssertThrowsError(try HermesLegacyJSONScanner.scan(Data([34, 0xED, 0xA0, 0x80, 34])))
    }

    func testScannerRejectsDuplicateDecodedKeysAtEveryDepth() {
        for text in [#"{"id":1,"id":2}"#, #"{"id":1,"\u0069d":2}"#,
                     #"[{"unknown":{"state":null,"st\u0061te":"deleted"}}]"#] {
            XCTAssertThrowsError(try HermesLegacyJSONScanner.scan(Data(text.utf8)))
        }
    }

    func testScannerResourceLimitsBeforeRecursion() throws {
        XCTAssertNoThrow(try HermesLegacyJSONScanner.scan(Data("[]".utf8), maximumDepth: 0, maximumNodes: 1))
        XCTAssertThrowsError(try HermesLegacyJSONScanner.scan(Data("[0]".utf8), maximumDepth: 0))
        XCTAssertThrowsError(try HermesLegacyJSONScanner.scan(Data("[0,1]".utf8), maximumNodes: 2))
        XCTAssertNoThrow(try HermesLegacyJSONScanner.scan(Data("[0,1]".utf8), maximumNodes: 3))
        let deep = String(repeating: "[", count: 65) + "0" + String(repeating: "]", count: 65)
        XCTAssertThrowsError(try HermesLegacyJSONScanner.scan(Data(deep.utf8)))
        XCTAssertThrowsError(try HermesLegacyJSONScanner.scan(Data(repeating: 32, count: HermesLegacyLedger.maximumBytes + 1)))
    }

    func testScannerAcceptsDistinctCanonicallyEquivalentScalarKeys() throws {
        let bytes = Data(#"{"\u00e9":1,"e\u0301":2}"#.utf8)
        let root = try HermesLegacyJSONScanner.scan(bytes)
        guard case .object(let members) = root.kind else { return XCTFail("Expected object") }
        XCTAssertEqual(members.count, 2)
        XCTAssertNotEqual(Data(members[0].key.utf8), Data(members[1].key.utf8))
        XCTAssertEqual(bytes.subdata(in: members[0].value.range), Data("1".utf8))
        XCTAssertEqual(bytes.subdata(in: members[1].value.range), Data("2".utf8))
        XCTAssertThrowsError(try HermesLegacyJSONScanner.scan(Data(#"{"id":1,"\u0069d":2}"#.utf8)))
    }

    func testScannerRejectsCallerNodeLimitsAboveHardCeiling() {
        for limit in [0, -1, 100_001, Int.max] {
            XCTAssertThrowsError(try HermesLegacyJSONScanner.scan(Data("[]".utf8), maximumNodes: limit))
        }
        XCTAssertNoThrow(try HermesLegacyJSONScanner.scan(Data("[]".utf8), maximumNodes: 100_000))
    }

    @MainActor private func restorationBytes(title: String) throws -> Data {
        let conversation = Conversation(title: title, messages: [.init(role: "assistant", content: "partial", completion: .streaming)])
        let encoded = try JSONEncoder().encode([conversation])
        return Data(("{\"future\": {\"unknown\": [1,2]}, \"conversations\":" + String(decoding: encoded, as: UTF8.self) + ",\"baseline\":[],\"conversationIDs\":{},\"messageIDs\":{}}\n").utf8)
    }

    @MainActor func testRestorePreservesOriginalBytesBeforeStreamingMutation() async throws {
        let bytes = try restorationBytes(title: "original")
        var preserved: Data?, readURL: URL?, preservedURL: URL?, memoryURL: URL?
        var services = isolatedServices(readLocalHistory: { url in readURL = url; return bytes })
        services.preserveLegacyHistory = { data, url, account in
            preserved = data; preservedURL = url; XCTAssertNil(account)
            XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("streaming"))
        }
        services.memoryIndex = { url in memoryURL = url; return try MemoryIndex(url: nil) }
        let manager = ConversationManager(services: services)
        await manager.restore(loadRemoteModels: false)
        XCTAssertEqual(preserved, bytes); XCTAssertEqual(readURL, preservedURL)
        XCTAssertEqual(memoryURL, readURL?.deletingPathExtension().appendingPathExtension("memory.sqlite"))
        XCTAssertEqual(manager.conversations.first?.messages.first?.completion, .stopped)
        XCTAssertTrue(manager.nativeDataReady)
    }

    @MainActor func testRestorePreservationFailureBlocksWritesAndRecovery() async throws {
        let bytes = try restorationBytes(title: "unarchived")
        var writes = 0, remote = 0
        let auth = NativeSession(accessToken: "fixture", refreshToken: "fixture", expiresAt: .distantFuture, accountId: "a")
        var services = isolatedServices(writeHistory: { _, _ in writes += 1 }, load: { auth }, readLocalHistory: { _ in bytes })
        services.preserveLegacyHistory = { _, _, _ in throw CocoaError(.fileWriteOutOfSpace) }
        services.hermesChanges = { _, _ in remote += 1; throw CancellationError() }
        services.hermesConsent = { _ in remote += 1; throw CancellationError() }
        let manager = ConversationManager(services: services)
        await manager.restore(loadRemoteModels: false)
        for _ in 0..<5 { await Task.yield() }
        XCTAssertFalse(manager.nativeDataReady); XCTAssertFalse(manager.isRestoring)
        XCTAssertTrue(manager.conversations.isEmpty); XCTAssertNotNil(manager.error)
        XCTAssertEqual(writes, 0); XCTAssertEqual(remote, 0)
    }

    @MainActor func testRestoreAccountReplacementRejectsSuspendedFailureWithoutErrorLeak() async throws {
        let old = NativeSession(accessToken: "old", refreshToken: "old", expiresAt: .distantFuture, accountId: "old")
        let new = NativeSession(accessToken: "new", refreshToken: "new", expiresAt: .distantFuture, accountId: "new")
        let oldBytes = try restorationBytes(title: "old"), newBytes = try restorationBytes(title: "new")
        let entered = expectation(description: "old preservation entered")
        let gate = LegacyRestorationGate()
        var reads = 0, archivedAccounts: [String?] = []
        var services = isolatedServices(load: { old }, readLocalHistory: { _ in reads += 1; return reads == 1 ? oldBytes : newBytes })
        services.preserveLegacyHistory = { _, _, account in
            archivedAccounts.append(account)
            if account == "old" { entered.fulfill(); try await gate.wait() }
        }
        services.hermesChanges = { _, _ in throw CancellationError() }
        services.hermesConsent = { _ in throw CancellationError() }
        let manager = ConversationManager(services: services)
        let pending = Task { await manager.restore(loadRemoteModels: false) }
        await fulfillment(of: [entered], timeout: 2)
        manager.session = new
        await manager.restore(loadRemoteModels: false)
        gate.release(throwing: CocoaError(.fileWriteOutOfSpace))
        await pending.value
        XCTAssertEqual(archivedAccounts.compactMap { $0 }, ["old", "new"])
        XCTAssertEqual(manager.conversations.first?.title, "new")
        XCTAssertTrue(manager.nativeDataReady); XCTAssertFalse(manager.isRestoring)
        XCTAssertNil(manager.error)
    }

    @MainActor func testRepeatedRestoreTokenDiscardsSuspendedOlderResult() async throws {
        let firstBytes = try restorationBytes(title: "older"), secondBytes = try restorationBytes(title: "latest")
        let entered = expectation(description: "first preservation entered")
        let gate = LegacyRestorationGate()
        var reads = 0, preserves = 0
        var services = isolatedServices(readLocalHistory: { _ in reads += 1; return reads == 1 ? firstBytes : secondBytes })
        services.preserveLegacyHistory = { _, _, _ in
            preserves += 1
            if preserves == 1 { entered.fulfill(); try await gate.wait() }
        }
        let manager = ConversationManager(services: services)
        let pending = Task { await manager.restore(loadRemoteModels: false) }
        await fulfillment(of: [entered], timeout: 2)
        await manager.restore(loadRemoteModels: false)
        gate.release()
        await pending.value
        XCTAssertEqual(manager.conversations.first?.title, "latest")
        XCTAssertTrue(manager.nativeDataReady); XCTAssertFalse(manager.isRestoring)
        XCTAssertNil(manager.error)
    }

}

@MainActor private final class LegacyRestorationGate {
    private var continuation: CheckedContinuation<Void, Error>?
    func wait() async throws {
        try await withCheckedThrowingContinuation { continuation = $0 }
    }
    func release(throwing error: Error? = nil) {
        if let error { continuation?.resume(throwing: error) }
        else { continuation?.resume() }
        continuation = nil
    }
}
