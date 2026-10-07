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
        XCTAssertFalse(first.conversions[0].record.usableForInference)
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

}
