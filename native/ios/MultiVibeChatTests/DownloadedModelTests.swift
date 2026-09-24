import XCTest
@testable import MultiVibeChat

@MainActor final class DownloadedModelTests: XCTestCase {
    private func model() -> DownloadableModel {
        DownloadableModel(repository: "example/model", revision: String(repeating: "a", count: 40), filename: "model-Q4_K_M.gguf",
            name: "Test model", publisher: "Example", bytes: 500_000_000, sha256: String(repeating: "b", count: 64),
            license: "apache-2.0", architecture: "qwen3", layers: 28, kvHeads: 8, headSize: 128)
    }
    func testModelIdentityCannotBecomeRemoteAfterDeletingFiles() {
        XCTAssertEqual(ModelExecution(model().id), .downloaded)
        XCTAssertEqual(ModelExecution(LocalModel.id), .apple)
        XCTAssertEqual(ModelExecution("openai/gpt-4"), .remote)
        XCTAssertFalse(model().option.presentation.usesCloudCredit)
    }
    func testRuntimeMemoryIncludesKVAndScratchInsteadOfFileSizeOnly() {
        let m = model()
        XCTAssertGreaterThan(m.estimatedMemory, UInt64(m.bytes))
        XCTAssertNotNil(LocalDeviceBudget(memory: UInt64(m.bytes), disk: 10_000_000_000).problem(m, downloading: true))
        XCTAssertNotNil(LocalDeviceBudget(memory: 10_000_000_000, disk: m.bytes).problem(m, downloading: true))
        XCTAssertNil(LocalDeviceBudget(memory: 10_000_000_000, disk: 10_000_000_000).problem(m, downloading: true))
    }
    func testRangeRecoveryRejectsWrongOffsetTruncationAndChangedTotal() throws {
        XCTAssertFalse(try DownloadSegment.validate(status: 206, range: "bytes 32-63/100", offset: 32, received: 32, total: 100))
        XCTAssertTrue(try DownloadSegment.validate(status: 200, range: nil, offset: 32, received: 100, total: 100))
        for range in ["bytes 0-31/100", "bytes 32-63/101", "bytes 32-62/100"] {
            XCTAssertThrowsError(try DownloadSegment.validate(status: 206, range: range, offset: 32, received: 32, total: 100))
        }
        XCTAssertThrowsError(try DownloadSegment.validate(status: 200, range: nil, offset: 32, received: 32, total: 100))
        XCTAssertThrowsError(try DownloadSegment.validate(status: 416, range: nil, offset: 100, received: 0, total: 100))
    }
    func testMeterNeverShowsNegativeRemainingTime() {
        let start = Date(timeIntervalSince1970: 0)
        var meter = DownloadMeter(lastTime: start)
        XCTAssertTrue(meter.label(total: 1000).contains("Estimation"))
        meter.update(500, now: start.addingTimeInterval(1))
        XCTAssertTrue(meter.label(total: 1000).contains("50 %"))
        meter.update(1500, now: start.addingTimeInterval(2))
        XCTAssertTrue(meter.label(total: 1000).hasPrefix("100 %"))
    }
    func testUntrustedToolCallsMustMatchKnownSchema() throws {
        let sum = try LocalDownloadedTools.arguments(#"{"action":"add","lhs":2,"rhs":3}"#)
        XCTAssertEqual(sum.lhs + sum.rhs, 5)
        for value in [#"{"action":"delete_all"}"#, #"{"action":"add","lhs":true}"#, #"{"action":"read_calendar","admin":true}"#, #"{"action":"read_document","documentID":3}"#] {
            XCTAssertThrowsError(try LocalDownloadedTools.arguments(value))
        }
    }
    func testMalformedGGUFDoesNotClaimCompatibility() {
        XCTAssertThrowsError(try GGUFHeader.read(Data()))
        XCTAssertThrowsError(try GGUFHeader.read(Data(repeating: 255, count: 1024)))
    }
    func testDownloadRegistryRestoresWithoutNetworkAndPreservesCorruption() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let entry = ModelInstallation(model: model(), state: .paused, completed: 32)
        let registry = root.appendingPathComponent("installations.json")
        try JSONEncoder().encode([entry]).write(to: registry)
        try Data(repeating: 0, count: 32).write(to: root.appendingPathComponent(model().key + ".partial"))
        let restored = LocalModelLibrary(root: root)
        XCTAssertEqual(restored.installation(model().id)?.state, .paused)
        XCTAssertEqual(restored.installation(model().id)?.completed, 32)
        try Data("corrupt".utf8).write(to: registry)
        let damaged = LocalModelLibrary(root: root)
        XCTAssertNotNil(damaged.storageError)
        damaged.requestDownload(model())
        XCTAssertEqual(try String(contentsOf: registry, encoding: .utf8), "corrupt")
    }
    func testDownloadedGuestChatNeverAuthenticatesOrCallsCloud() async throws {
        let local = model()
        var services = SessionServices()
        services.load = { nil }; services.writeHistory = { _, _ in }
        services.readLocalHistory = { _ in throw CocoaError(.fileReadNoSuchFile) }
        services.memoryIndex = { _ in try MemoryIndex(url: nil) }; services.monitorConnectivity = false
        services.downloadedModels = { [local.option] }; services.downloadedAvailability = { _ in nil }
        services.downloadedRespond = { id, _, workspace, output in
            XCTAssertEqual(id, local.id)
            XCTAssertNotNil(workspace)
            await output("LOCAL-ONLY")
        }
        services.refresh = { _ in XCTFail("No authentication for local chat"); throw APIError.invalidResponse }
        services.stream = { _, _, _, _ in XCTFail("No cloud fallback") }
        services.memoryReviewDelay = { try await Task.sleep(for: .seconds(3600)) }
        let manager = ConversationManager(services: services)
        await manager.restore(loadRemoteModels: false)
        await manager.chooseModel(local.option)
        XCTAssertTrue(manager.send("Bonjour"))
        for _ in 0..<1000 { if !manager.isStreaming { break }; await Task.yield() }
        XCTAssertEqual(manager.current?.messages.last?.content, "LOCAL-ONLY")
        XCTAssertNil(manager.session)
    }
}
