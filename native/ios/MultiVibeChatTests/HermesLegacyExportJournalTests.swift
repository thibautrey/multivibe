import XCTest
import CryptoKit
@testable import MultiVibeChat

final class HermesLegacyExportJournalTests: XCTestCase {
    private let account = "11111111-1111-4111-8111-111111111111"
    private let device = "22222222-2222-4222-8222-222222222222"
    private func conversion(guest: String? = nil, deleted: Bool = false, payload: Data = Data(#"{"n":9007199254740993123456789}"#.utf8)) -> HermesLegacyConversion {
        let record = HermesLegacyRecord(kind: .memory, id: "original", revision: "v1", container: "native-memory", payload: payload,
            deleted: deleted, inferenceUsable: false, provenance: .init(source: "nativeMemory", guestOrigin: guest,
                sourcePath: "$.memory[0]", rawRange: 0..<payload.count, archiveDigest: String(repeating: "a", count: 64)))
        return .init(record: record, digest: SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined(), operationID: UUID(), versionID: UUID())
    }
    private func consent(guest: Bool = false, enabled: Bool = true) -> CloudHermesConsent {
        .init(accountId: account, cloudEnabled: enabled, revision: 3, exportSources: ["legacy-native-memory"] + (guest ? ["legacy-guest"] : []))
    }
    private func root() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }
    func testRestartRetainsExactOperationParentsAndRawTombstone() async throws {
        let root = root(); defer { try? FileManager.default.removeItem(at: root) }
        let journal = HermesLegacyExportJournal(root: root), conversion = conversion(deleted: true)
        let parent = UUID().uuidString.lowercased()
        let intent = try await journal.prepare(conversion, accountID: account, deviceID: device, parents: [parent], consent: consent())
        let restarted = HermesLegacyExportJournal(root: root)
        let retry = try await restarted.prepare(conversion, accountID: account, deviceID: device, parents: [], consent: consent())
        XCTAssertEqual(intent, retry); XCTAssertEqual(retry.mutation.parents, [parent]); XCTAssertFalse(retry.mutation.deleted)
        let decoded = try HermesLegacyEnvelopeCodec.decode(JSONEncoder().encode(XCTUnwrap(retry.mutation.value)))
        XCTAssertEqual(decoded.payload, conversion.record.payload); XCTAssertTrue(decoded.envelope.deleted)
    }
    func testGuestRequiresSeparateConsentAndAccountIsolation() async throws {
        let root = root(); defer { try? FileManager.default.removeItem(at: root) }
        let journal = HermesLegacyExportJournal(root: root), guest = conversion(guest: "guest:1")
        do { _ = try await journal.prepare(guest, accountID: account, deviceID: device, parents: [], consent: consent()); XCTFail() } catch {}
        let intent = try await journal.prepare(guest, accountID: account, deviceID: device, parents: [], consent: consent(guest: true))
        XCTAssertEqual(intent.requiredSources, ["legacy-guest", "legacy-native-memory"])
        let other = try await journal.snapshot(accountID: "33333333-3333-4333-8333-333333333333")
        XCTAssertTrue(other.intents.isEmpty)
        do { _ = try await journal.queue(accountID: account, operationID: intent.mutation.operationId, consent: consent(enabled: false)); XCTFail() } catch {}
    }
    func testFailedPersistenceNeverPublishesPreparedIntent() async throws {
        let root = root(); defer { try? FileManager.default.removeItem(at: root) }
        let journal = HermesLegacyExportJournal(root: root, writeFile: { _, _ in throw NSError(domain: "write", code: 1) })
        do { _ = try await journal.prepare(conversion(), accountID: account, deviceID: device, parents: [], consent: consent()); XCTFail() } catch {}
        let state = try await journal.snapshot(accountID: account)
        XCTAssertTrue(state.intents.isEmpty); XCTAssertTrue(state.mappings.isEmpty)
    }
    func testExactAppliedOperationSettlesButReusedVersionBlocks() async throws {
        let root = root(); defer { try? FileManager.default.removeItem(at: root) }
        let journal = HermesLegacyExportJournal(root: root)
        let intent = try await journal.prepare(conversion(), accountID: account, deviceID: device, parents: [], consent: consent())
        let op = intent.mutation
        func change(operation: String, erased: Bool = false) -> CloudAgentChange {
            .init(operationId: operation, objectId: op.objectId, versionId: op.versionId, deviceId: op.deviceId,
                  kind: op.kind, parents: op.parents, deleted: false, value: op.value, cursor: 1, erased: erased)
        }
        let recovered = try await journal.reconcile(accountID: account, changes: [change(operation: op.operationId)])
        XCTAssertEqual(recovered.intents[op.operationId]?.phase, .receiptConfirmed)
        let conflict = try await journal.reconcile(accountID: account, changes: [change(operation: UUID().uuidString.lowercased())])
        XCTAssertEqual(conflict.intents[op.operationId]?.phase, .blocked)
    }
    func testReceiptValidationAndConsentRevocationRetainPendingBytes() async throws {
        let root = root(); defer { try? FileManager.default.removeItem(at: root) }
        let journal = HermesLegacyExportJournal(root: root)
        let prepared = try await journal.prepare(conversion(), accountID: account, deviceID: device, parents: [], consent: consent())
        let queued = try await journal.queue(accountID: account, operationID: prepared.mutation.operationId, consent: consent())
        let op = queued.mutation
        let bad = CloudAgentReceipts(accountId: account, receipts: [.init(operationId: op.operationId, versionId: UUID().uuidString.lowercased(), cursor: 1, heads: [op.versionId], deleted: false)])
        do { _ = try await journal.acknowledge(accountID: account, submitted: [op], reply: bad); XCTFail() } catch {}
        let stillQueued = try await journal.snapshot(accountID: account)
        XCTAssertEqual(stillQueued.intents[op.operationId]?.phase, .queued)
        let good = CloudAgentReceipts(accountId: account, receipts: [.init(operationId: op.operationId, versionId: op.versionId, cursor: 1, heads: [op.versionId], deleted: false)])
        let settled = try await journal.acknowledge(accountID: account, submitted: [op], reply: good)
        XCTAssertEqual(settled.intents[op.operationId]?.phase, .receiptConfirmed)
        XCTAssertEqual(settled.intents[op.operationId]?.mutation, op)
    }
    func testOversizedPayloadLeavesNoIntent() async throws {
        let root = root(); defer { try? FileManager.default.removeItem(at: root) }
        let journal = HermesLegacyExportJournal(root: root)
        do { _ = try await journal.prepare(conversion(payload: Data(repeating: 32, count: 65537)), accountID: account, deviceID: device, parents: [], consent: consent()); XCTFail() } catch {}
        let state = try await journal.snapshot(accountID: account); XCTAssertTrue(state.intents.isEmpty)
    }
    func testSourceGuestMappingsAndReusedOperationAreDistinct() async throws {
        let root = root(); defer { try? FileManager.default.removeItem(at: root) }
        let journal = HermesLegacyExportJournal(root: root)
        let original = conversion()
        let native = try await journal.prepare(original, accountID: account, deviceID: device, parents: [], consent: consent())
        let guest = try await journal.prepare(conversion(guest: "nil:"), accountID: account, deviceID: device, parents: [], consent: consent(guest: true))
        XCTAssertNotEqual(native.mutation.objectId, guest.mutation.objectId)
        let replacement = conversion(payload: Data("{}".utf8))
        let reused = HermesLegacyConversion(record: replacement.record, digest: replacement.digest,
            operationID: original.operationID, versionID: original.versionID)
        do { _ = try await journal.prepare(reused, accountID: account, deviceID: device, parents: [], consent: consent()); XCTFail() } catch {}
        let saved = try await journal.snapshot(accountID: account)
        XCTAssertEqual(saved.intents[native.mutation.operationId]?.mutation, native.mutation)
    }

}
