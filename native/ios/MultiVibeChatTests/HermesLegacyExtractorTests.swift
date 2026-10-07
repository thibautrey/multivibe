import XCTest
@testable import MultiVibeChat

final class HermesLegacyExtractorTests: XCTestCase {
    private func extract(_ text: String) throws -> HermesLegacyExtraction { try HermesLegacyExtractor.extract(Data(text.utf8)) }

    func testNativeArrayPreservesUnknownRichBytesAndOriginalIDs() throws {
        let text = #" [ {"id":"conversation-original", "future":{"number":9007199254740993123},"messages":[ {"id":"message-original","completion":"failed","future":{"tool":"unchanged"}} ]} ] "#
        let result = try extract(text)
        XCTAssertEqual(result.original, Data(text.utf8)); XCTAssertTrue(result.diagnostics.isEmpty)
        XCTAssertEqual(result.records.map(\.id), ["conversation-original", "message-original"])
        XCTAssertEqual(result.records.map(\.source), [.nativeConversation, .nativeMessage])
        XCTAssertEqual(result.records[1].container, "conversation-original")
        for record in result.records { XCTAssertEqual(record.payload, result.original.subdata(in: record.range)) }
        XCTAssertTrue(String(decoding: result.records[1].payload, as: UTF8.self).contains("failed"))
    }

    func testMemoryCollectionsPreserveRevisionsAndClearedTombstoneScope() throws {
        let live = #"{"id":"memory","version":"live","state":"confirmed","scope":"project","evidence":{"future":true}}"#
        let dead = #"{"id":"memory","version":"dead","state":"deleted","scope":"","text":""}"#
        let text = "{\"memory\":[" + live + "],\"memoryBaseline\":[" + live + "],\"snapshot\":{\"memory\":[" + dead + "]},\"pending\":{\"memory\":[" + live + "],\"snapshot\":{\"memory\":[" + dead + "]}}}"
        let result = try extract(text)
        XCTAssertEqual(result.records.count, 5)
        XCTAssertEqual(Set(result.records.map(\.container)), ["native-memory"])
        XCTAssertEqual(result.records.map(\.tombstone), [false, false, true, false, true])
        XCTAssertEqual(result.records.map(\.scope), ["project", "project", "", "project", ""])
        guard case .original(let revision) = result.records[2].revision else { return XCTFail("Expected original revision") }
        XCTAssertEqual(revision, "dead"); XCTAssertEqual(result.records[2].payload, Data(dead.utf8))
    }

    func testAllNativeConversationCollectionsRetainProvenance() throws {
        let text = #"{"conversations":[{"id":"a"}],"baseline":[{"id":"b"}],"pending":{"local":[{"id":"c"}]}}"#
        let result = try extract(text)
        XCTAssertEqual(result.records.map(\.path), ["$.conversations[0]", "$.baseline[0]", "$.pending.local[0]"])
        XCTAssertEqual(result.records.map(\.id), ["a", "b", "c"])
    }

    func testContentIdentityStableWithoutChronologyOrNewIDs() throws {
        let text = #"[{"id":"original","messages":[{"id":"original-message","content":"exact"}]}]"#
        let first = try extract(text), second = try extract(text)
        for (left, right) in zip(first.records, second.records) {
            guard case .contentIdentity(let a) = left.revision, case .contentIdentity(let b) = right.revision else { return XCTFail("Expected tagged content identity") }
            XCTAssertEqual(a, b); XCTAssertTrue(a.hasPrefix("sha256:"))
        }
    }

    func testGuestObjectAndAlternatingArrayPreserveOrigin() throws {
        for text in [#"{"importedGuestSnapshots":{"guest-original":{"id":"conversation","messages":[{"id":"message"}]}}}"#,
                     #"{"importedGuestSnapshots":["guest-original",{"id":"conversation","messages":[{"id":"message"}]}]}"#] {
            let result = try extract(text)
            XCTAssertEqual(result.records.count, 2)
            XCTAssertEqual(result.records.map(\.guestOrigin), ["guest-original", "guest-original"])
            XCTAssertEqual(result.records.map(\.id), ["conversation", "message"])
            XCTAssertTrue(result.diagnostics.isEmpty)
        }
    }

    func testCloudRepositoriesPreserveOffHeadNodesAndUnknownWrappers() throws {
        let text = #"{"snapshot":{"accountId":"a","revision":99999999999999999999,"conversations":[{"id":"cloud-original","repository":{"headId":"head","messages":[{"parentId":null,"future":42,"message":{"id":"head","content":[]}},{"parentId":"other","message":{"id":"off-head","content":[]}}]}}]},"pending":{"snapshot":{"conversations":[{"id":"pending-cloud","repository":{"messages":[]}}]}}}"#
        let result = try extract(text)
        XCTAssertEqual(result.records.map(\.source), [.cloudConversation, .cloudRepositoryNode, .cloudRepositoryNode, .cloudConversation])
        XCTAssertEqual(result.records.map(\.id), ["cloud-original", "head", "off-head", "pending-cloud"])
        XCTAssertTrue(String(decoding: result.records[1].payload, as: UTF8.self).contains("\"future\":42"))
        XCTAssertTrue(String(decoding: result.records[2].payload, as: UTF8.self).contains("\"parentId\":\"other\""))
    }

    func testMissingIdentityAndUnknownStateRemainArchivedWithDiagnostics() throws {
        let text = #"{"unknownTop":{"future":true},"conversations":[{"messages":[]}],"memory":[{"id":"missing-version"},{"id":"known","version":"v","state":"future-state","unknown":true}]}"#
        let result = try extract(text)
        XCTAssertEqual(result.original, Data(text.utf8))
        XCTAssertEqual(result.diagnostics.map(\.reason), ["missing_conversation_identity", "missing_memory_identity_or_revision", "unknown_memory_state"])
        XCTAssertEqual(result.records.count, 1); XCTAssertNil(result.records[0].tombstone)
    }

    func testConflictingRevisionsArePreservedWithoutChoosingWinnerAndMalformedFailsClosed() throws {
        let result = try extract(#"{"memory":[{"id":"m","version":"v","state":"confirmed","text":"one"}],"memoryBaseline":[{"id":"m","version":"v","state":"deleted","text":""}]}"#)
        XCTAssertEqual(result.records.count, 2)
        XCTAssertNotEqual(result.records[0].payload, result.records[1].payload)
        for text in ["[", #"{"memory":[],"memory":[]}"#, "[] trailing"] { XCTAssertThrowsError(try extract(text)) }
        XCTAssertThrowsError(try HermesLegacyExtractor.extract(Data(repeating: 32, count: HermesLegacyLedger.maximumBytes + 1)))
        let malformedDictionary = try extract(#"{"importedGuestSnapshots":["key"]}"#)
        XCTAssertTrue(malformedDictionary.records.isEmpty)
        XCTAssertEqual(malformedDictionary.diagnostics.first?.reason, "invalid_dictionary_array")
    }
    func testAdapterHistoricalV1RecordDecodesWithoutChangingIdentityOrBindings() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let oldJSON = #"{"kind":"memory","id":"old","revision":"old-v","container":"scope","payload":"e30=","deleted":false,"inferenceUsable":false}"#
        let record = try JSONDecoder().decode(HermesLegacyRecord.self, from: Data(oldJSON.utf8))
        XCTAssertNil(record.provenance)
        let first = try await HermesLegacyLedger(root: root).convert([record], accountID: "a")
        XCTAssertNotNil(first.bindings["memory:scope"])
        let restored = try await HermesLegacyLedger(root: root).convert([record], accountID: "a")
        XCTAssertEqual(first, restored)
    }

    func testAdapterSeparatesNativeCloudAndGuestOriginalIdentities() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let extraction = try extract(#"{"conversations":[{"id":"same"}],"snapshot":{"conversations":[{"id":"same","repository":{"messages":[]}}]},"importedGuestSnapshots":["guest-one",{"id":"same"},"guest-two",{"id":"same"}]}"#)
        let result = try await HermesLegacyLedger(root: root).convertExtraction(extraction, accountID: "a")
        XCTAssertEqual(result.conversions.count, 4); XCTAssertTrue(result.quarantine.isEmpty)
        XCTAssertEqual(result.conversions.map { $0.record.id }, ["same", "same", "same", "same"])
        XCTAssertEqual(result.bindings.count, 4)
        XCTAssertEqual(result.conversions.map { $0.record.provenance?.guestOrigin }, [nil, nil, "guest-one", "guest-two"])
    }

    func testAdapterPreservesAllMemoryPayloadsIncludingConflictsAndTombstones() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let extraction = try extract(#"{"memory":[{"id":"m","version":"dead","state":"deleted","scope":""}],"memoryBaseline":[{"id":"m","version":"live","state":"confirmed","scope":"project","future":true}],"snapshot":{"memory":[{"id":"m","version":"live","state":"confirmed","scope":"project","future":false}]},"pending":{"memory":[{"id":"m","version":"older","state":"proposed","scope":"project"}],"snapshot":{"memory":[{"id":"other","version":"v","state":"future"}]}}}"#)
        let result = try await HermesLegacyLedger(root: root).convertExtraction(extraction, accountID: "a")
        XCTAssertEqual(result.conversions.count, 4); XCTAssertEqual(result.quarantine.count, 1)
        let preserved = result.conversions.map { $0.record.payload } + result.quarantine.map { $0.record.payload }
        for record in extraction.records { XCTAssertTrue(preserved.contains(record.payload)) }
        XCTAssertEqual(result.conversions.last?.record.revision, "dead")
        XCTAssertTrue(result.conversions.last?.record.deleted == true)
        XCTAssertEqual(Set(result.conversions.map { $0.record.container }), ["native-memory"])
        XCTAssertTrue(result.inferenceCandidates.isEmpty)
        XCTAssertTrue(result.conversions.allSatisfy { !$0.record.inferenceUsable && $0.publication == .converted })
    }

    func testAdapterRepeatsAreIdempotentAndMetadataCollisionQuarantined() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let extraction = try extract(#"{"memory":[{"id":"m","version":"v","state":"confirmed"}],"memoryBaseline":[{"id":"m","version":"v","state":"confirmed"}]}"#)
        let ledger = HermesLegacyLedger(root: root)
        let first = try await ledger.convertExtraction(extraction, accountID: "a")
        let repeated = try await HermesLegacyLedger(root: root).convertExtraction(extraction, accountID: "a")
        XCTAssertEqual(first, repeated)
        XCTAssertEqual(first.conversions.count, 1); XCTAssertEqual(first.quarantine.count, 1)
        XCTAssertNotEqual(first.conversions[0].record.provenance?.sourcePath, first.quarantine[0].record.provenance?.sourcePath)
        XCTAssertEqual(first.conversions[0].record.payload, first.quarantine[0].record.payload)
        XCTAssertEqual(first.conversions[0].record.provenance?.rawRange, extraction.records[0].range)
        XCTAssertEqual(first.conversions[0].record.provenance?.archiveDigest.count, 64)
    }

    func testAdapterParentMessageBindingsShareSourceFamilyAndSeparateGuest() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let extraction = try extract(#"{"conversations":[{"id":"parent","messages":[{"id":"message"}]}],"snapshot":{"conversations":[{"id":"parent","repository":{"messages":[{"message":{"id":"message"}}]}}]},"importedGuestSnapshots":["guest",{"id":"parent","messages":[{"id":"message"}]}]}"#)
        let result = try await HermesLegacyLedger(root: root).convertExtraction(extraction, accountID: "a")
        XCTAssertEqual(result.conversions.count, 6); XCTAssertTrue(result.quarantine.isEmpty)
        XCTAssertEqual(result.bindings.count, 3)
        XCTAssertEqual(result.bindings.keys.filter { $0.contains("native-history") }.count, 2)
        XCTAssertEqual(result.bindings.keys.filter { $0.contains("cloud-history") }.count, 1)
        XCTAssertEqual(result.conversions.map { $0.record.provenance?.source },
            ["nativeConversation", "nativeMessage", "cloudConversation", "cloudRepositoryNode", "nativeConversation", "nativeMessage"])
        let restored = try await HermesLegacyLedger(root: root).convertExtraction(extraction, accountID: "a")
        XCTAssertEqual(restored, result)
    }

}
