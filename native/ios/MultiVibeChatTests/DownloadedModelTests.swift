import XCTest
import CryptoKit
@testable import MultiVibeChat

@MainActor final class DownloadedModelTests: XCTestCase {
    func testPublisherIdentityAndBundledImages() throws {
        XCTAssertEqual(ModelPublisher.resolve(repository: "bartowski/Qwen", baseModels: ["Qwen/Qwen3-0.6B"]), "qwen")
        XCTAssertEqual(ModelPublisher.resolve(repository: "bartowski/Gemma", baseModels: ["google/gemma-3"]), "google")
        XCTAssertNil(ModelPublisher.resolve(repository: "unknown/Qwen-finetune"))
        XCTAssertNil(ModelPublisher.canonical("unknown"))
        XCTAssertEqual(ModelPublisher.canonical("Mistral AI"), "mistralai")
        for publisher in ModelPublisher.known {
            XCTAssertNotNil(UIImage(named: "Publisher-" + publisher), publisher)
        }
        for model in HuggingFaceCatalog.bundled {
            XCTAssertEqual(model.resolvedLogoPublisher, ModelPublisher.canonical(model.publisher))
            XCTAssertEqual(model.option.logoPublisher, model.resolvedLogoPublisher)
        }
        let old = try JSONEncoder().encode(model())
        XCTAssertNil(try JSONDecoder().decode(DownloadableModel.self, from: old).logoPublisher)
    }
    func testExpandedCatalogIntegrityAndMemoryGates() throws {
        let models = HuggingFaceCatalog.bundled
        XCTAssertEqual(models.count, 15)
        XCTAssertEqual(Set(models.map(\.id)).count, models.count)
        for model in models {
            XCTAssertNotNil(model.revision.range(of: "^[a-f0-9]{40}$", options: .regularExpression))
            XCTAssertNotNil(model.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression))
            XCTAssertNil(LocalDeviceBudget(memory: 64_000_000_000, disk: 100_000_000_000).problem(model, downloading: true), model.name)
            XCTAssertNotNil(LocalDeviceBudget(memory: 1, disk: 100_000_000_000).problem(model, downloading: false))
            if model.name != "Qwen3 1.7B" { XCTAssertFalse(model.supportsTools) }
        }
        var hybrid = try XCTUnwrap(models.first { $0.name == "Bonsai 27B" })
        XCTAssertGreaterThan(try XCTUnwrap(hybrid.recurrentStateBytes), 0)
        hybrid.recurrentStateBytes = nil
        XCTAssertNotNil(LocalDeviceBudget(memory: 64_000_000_000, disk: 100_000_000_000).problem(hybrid, downloading: false))
        let gemma = try XCTUnwrap(models.first { $0.name == "Gemma 4 E2B" })
        XCTAssertEqual(gemma.headSize, 512) // Global KV width, not the 256-wide sliding window.
    }
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
    func testMeterKeepsSmoothedSpeedAcrossDownloadSegments() {
        let start = Date(timeIntervalSince1970: 0)
        var meter = DownloadMeter(lastTime: start)
        meter.update(500, now: start.addingTimeInterval(1))
        let speed = meter.speed

        meter.continueFrom(500, now: start.addingTimeInterval(2))

        XCTAssertEqual(meter.speed, speed)
        XCTAssertFalse(meter.label(total: 1_000).contains("Estimation"))
        meter.update(600, now: start.addingTimeInterval(3))
        XCTAssertGreaterThan(meter.speed, 100)
        XCTAssertLessThan(meter.speed, speed)
    }
    func testUntrustedToolCallsMustMatchKnownSchema() throws {
        let sum = try LocalDownloadedTools.arguments(#"{"action":"add","lhs":2,"rhs":3}"#)
        XCTAssertEqual(sum.lhs + sum.rhs, 5)
        for value in [#"{"action":"delete_all"}"#, #"{"action":"add","lhs":true}"#, #"{"action":"read_calendar","admin":true}"#, #"{"action":"read_document","documentID":3}"#] {
            XCTAssertThrowsError(try LocalDownloadedTools.arguments(value))
        }
    }
    func testBareKnownToolCallIsRecoveredButProseIsNotExecuted() throws {
        let json = #"{"name":"fetch_website","arguments":{"url":"https://example.com","offset":142}}"#
        for content in [json, "```json\n" + json + "\n```"] {
            let reply = LocalDownloadedTools.normalizedReply(["role": "assistant", "content": content])
            let calls = try XCTUnwrap(reply["tool_calls"] as? [[String: Any]])
            XCTAssertEqual(calls.count, 1)
            let function = try XCTUnwrap(calls.first?["function"] as? [String: Any])
            let input = try LocalDownloadedTools.arguments(try XCTUnwrap(function["arguments"] as? String), name: "fetch_website")
            XCTAssertEqual(input.lhs, 142)
            XCTAssertEqual(reply["content"] as? String, "")
        }
        for content in ["Example: " + json, #"{"name":"delete_files","arguments":{}}"#, "{not json}"] {
            XCTAssertNil(LocalDownloadedTools.normalizedReply(["content": content])["tool_calls"])
        }
    }
    func testWebPaginationStopsAtEndOfContent() async throws {
        let workspace = LocalAgentWorkspace(conversations: [], documents: [], event: { _ in }, saveDocument: { _ in },
            authorizeInternet: { _ in true }, webFetch: { url, _ in
                LocalWebResponse(url: url, status: 200, contentType: "text/plain", text: String(repeating: "x", count: 2500))
            })
        let first = try await workspace.execute(action: "fetch_website", query: "https://example.com", documentID: "", text: "", lhs: 0, rhs: 0)
        XCTAssertTrue(first.contains("More content: use offset/lhs=2400"))
        let last = try await workspace.execute(action: "fetch_website", query: "https://example.com", documentID: "", text: "", lhs: 2400, rhs: 0)
        XCTAssertTrue(last.contains("End of page"))
        XCTAssertFalse(last.contains("More content"))
    }
    func testUpstreamPiDocumentEditInJavaScriptCore() async throws {
        actor State {
            var turns = 0
            var saved: LocalDocument?
            func next() -> Int { turns += 1; return turns }
            func save(_ document: LocalDocument) { saved = document }
        }
        let state = State()
        let document = LocalDocument(name: "Test", text: "Total: 42\r\n")
        let workspace = LocalAgentWorkspace(conversations: [], documents: [document], event: { _ in }, saveDocument: { await state.save($0) })
        let harness = try PiAgentHarness()
        try await harness.run(messages: #"[{"role":"user","content":"Modifie Total: 42 en Total: 43"}]"#,
            tools: LocalDownloadedTools.schema(deviceActions: []), generate: { messages, tools, _ in
                XCTAssertTrue(tools.contains("edit_document"))
                if await state.next() == 1 {
                    let args = String(decoding: try JSONSerialization.data(withJSONObject: ["path": document.id.uuidString, "edits": [["oldText": "Total: 42", "newText": "Total: 43"]]]), as: UTF8.self)
                    return String(decoding: try JSONSerialization.data(withJSONObject: ["role": "assistant", "content": "", "tool_calls": [["id": "edit", "type": "function", "function": ["name": "edit_document", "arguments": args]]]]), as: UTF8.self)
                }
                XCTAssertTrue(messages.contains("Successfully replaced"))
                return #"{"role":"assistant","content":"Modifié"}"#
            }, execute: { name, args in
                guard let result = try await workspace.executeHarnessTool(name: name, arguments: args) else { throw LocalAgentError.invalidInput }
                return result
            }, onText: { _ in })
        let saved = await state.saved
        XCTAssertEqual(saved?.id, document.id)
        XCTAssertEqual(saved?.text, "Total: 43\r\n")
    }
    func testNativeDocumentReplacementRejectsStaleSnapshotAndFailedSave() async throws {
        let document = LocalDocument(name: "Test", text: "Original")
        let workspace = LocalAgentWorkspace(conversations: [], documents: [document], event: { _ in }, saveDocument: { _ in throw CocoaError(.fileWriteOutOfSpace) })
        for expected in ["Stale", "Original"] {
            let json = String(decoding: try JSONSerialization.data(withJSONObject: ["documentID": document.id.uuidString, "content": "Changed", "expected": expected]), as: UTF8.self)
            do { _ = try await workspace.executeHarnessTool(name: "document_replace", arguments: json); XCTFail("Must reject stale or failed writes") }
            catch { }
        }
        let json = String(decoding: try JSONSerialization.data(withJSONObject: ["documentID": document.id.uuidString]), as: UTF8.self)
        let result = try await workspace.executeHarnessTool(name: "document_snapshot", arguments: json)
        XCTAssertEqual(result?.content, "Original")
    }
    func testPiJavaScriptCoreExecutesNativeToolAndPreservesPrompt() async throws {
        actor Calls {
            var count = 0
            func next() -> Int { count += 1; return count }
        }
        let calls = Calls()
        let harness = try PiAgentHarness()
        XCTAssertNotEqual(harness.version, "unknown")
        try await harness.run(messages: #"[{"role":"system","content":"PROMPT-KEPT"},{"role":"user","content":"Read the date"}]"#,
            tools: LocalDownloadedTools.schema(deviceActions: []), generate: { messages, _, output in
                XCTAssertTrue(messages.contains("PROMPT-KEPT"))
                if await calls.next() == 1 {
                    return #"{"role":"assistant","content":"","tool_calls":[{"id":"native-test","type":"function","function":{"name":"local_workspace","arguments":"{\"action\":\"current_date\"}"}}]}"#
                }
                XCTAssertTrue(messages.contains("DATE-EVIDENCE"))
                await output("Done")
                return #"{"role":"assistant","content":"Done"}"#
            }, execute: { name, _ in
                XCTAssertEqual(name, "local_workspace")
                return PiToolResult(content: "DATE-EVIDENCE")
            }, onText: { _ in })
        let count = await calls.count
        XCTAssertEqual(count, 2)
    }
    func testHTTPFailureIsRecordedAsErrorRatherThanSuccessfulEvidence() async throws {
        actor Events {
            var values: [LocalAgentEvent] = []
            func add(_ value: LocalAgentEvent) { values.append(value) }
        }
        let events = Events()
        let workspace = LocalAgentWorkspace(conversations: [], documents: [], event: { await events.add($0) }, saveDocument: { _ in },
            authorizeInternet: { _ in true }, webFetch: { url, _ in
                LocalWebResponse(url: url, status: 404, contentType: "text/html", text: "Not found")
            })
        do {
            _ = try await workspace.execute(action: "fetch_website", query: "https://example.com/missing", documentID: "", text: "", lhs: 0, rhs: 0)
            XCTFail("HTTP 404 must fail")
        } catch LocalWebError.httpStatus(404) { }
        let last = await events.values.last
        XCTAssertEqual(last?.status, "error")
        XCTAssertTrue(last?.output?.contains("404") == true)
    }
    func testWeatherToolRequiresUserProvidedCity() throws {
        let messages = [ChatMessage(role: "user", content: "Quel temps fera-t-il demain ?")]
        XCTAssertTrue(LocalDownloadedTools.isWeatherRequest(messages))
        XCTAssertFalse(LocalDownloadedTools.cityWasProvided("Hawthorne", messages: messages))
        XCTAssertTrue(LocalDownloadedTools.cityWasProvided("Toulouse", messages: messages + [ChatMessage(role: "user", content: "Toulouse")]))
        let schema = LocalDownloadedTools.schema(deviceActions: [], weather: true)
        XCTAssertTrue(schema.contains("weather_forecast"))
        XCTAssertFalse(schema.contains("fetch_website"))
    }
    func testToolCapabilityDoesNotDependOnPerformanceRecommendation() {
        var model = model()
        XCTAssertFalse(model.supportsTools)
        model.toolsValidated = true
        XCTAssertTrue(model.supportsTools)
        XCTAssertFalse(model.recommended)
        let qwen = HuggingFaceCatalog.bundled.first { $0.name == "Qwen3 1.7B" }
        XCTAssertEqual(qwen?.supportsTools, true)
    }
    func testWebsiteToolAndDeviceScope() throws {
        let schema = try XCTUnwrap(LocalDownloadedTools.schema(deviceActions: []).data(using: .utf8))
        let tools = try XCTUnwrap(JSONSerialization.jsonObject(with: schema) as? [[String: Any]])
        XCTAssertTrue(tools.contains { ($0["function"] as? [String: Any])?["name"] as? String == "fetch_website" })
        XCTAssertFalse(String(decoding: schema, as: UTF8.self).contains("read_contacts"))
        XCTAssertTrue(LocalDownloadedTools.schema(deviceActions: ["read_contacts"]).contains("read_contacts"))
        let input = try LocalDownloadedTools.arguments(#"{"url":"https://example.com","offset":20}"#, name: "fetch_website")
        XCTAssertEqual(input.action, "fetch_website")
        XCTAssertEqual(input.query, "https://example.com")
        XCTAssertEqual(input.lhs, 20)
        for json in [#"{"url":12}"#, #"{"url":"https://example.com","offset":true}"#, #"{"url":"https://example.com","offset":-1}"#, #"{"url":"https://example.com","admin":true}"#] {
            XCTAssertThrowsError(try LocalDownloadedTools.arguments(json, name: "fetch_website"))
        }
        XCTAssertThrowsError(try LocalDownloadedTools.arguments("{}", name: "unknown"))
    }
    func testQwenExplicitKeyWidthOverridesEmbeddingDividedByHeads() throws {
        var data = Data()
        func number(_ value: UInt64, count: Int) { for i in 0..<count { data.append(UInt8((value >> (8 * i)) & 255)) } }
        func string(_ value: String) { number(UInt64(value.utf8.count), count: 8); data.append(contentsOf: value.utf8) }
        number(0x46554747, count: 4); number(3, count: 4); number(0, count: 8); number(7, count: 8)
        string("general.architecture"); number(8, count: 4); string("qwen3")
        for (key, value) in [("block_count", 28), ("embedding_length", 1024), ("attention.head_count", 16),
                             ("attention.head_count_kv", 8), ("attention.key_length", 128), ("attention.value_length", 128)] {
            string("qwen3." + key); number(4, count: 4); number(UInt64(value), count: 4)
        }
        let info = try GGUFHeader.read(data)
        XCTAssertEqual(info.headSize, 128)
        XCTAssertEqual(info.kvHeads, 8)
    }
    func testHybridAndPerLayerKVMetadata() throws {
        func header(architecture: String, hybrid: Bool) -> Data {
            var data = Data()
            func number(_ value: UInt64, _ count: Int) { for i in 0..<count { data.append(UInt8((value >> (8 * i)) & 255)) } }
            func string(_ value: String) { number(UInt64(value.utf8.count), 8); data.append(contentsOf: value.utf8) }
            var fields = [("block_count", 32), ("embedding_length", 2560), ("attention.head_count", 16),
                          ("attention.key_length", 256), ("attention.value_length", 256)]
            if hybrid { fields += [("ssm.state_size", 128), ("ssm.inner_size", 4096), ("ssm.conv_kernel", 4), ("ssm.group_count", 16)] }
            number(0x46554747, 4); number(3, 4); number(0, 8); number(UInt64(fields.count + 2), 8)
            string("general.architecture"); number(8, 4); string(architecture)
            for (key, value) in fields { string(architecture + "." + key); number(4, 4); number(UInt64(value), 4) }
            string(architecture + ".attention.head_count_kv"); number(9, 4); number(4, 4); number(2, 8)
            number(8, 4); number(1, 4)
            return data
        }
        let hybrid = try GGUFHeader.read(header(architecture: "qwen35", hybrid: true))
        XCTAssertEqual(hybrid.recurrentStateBytes, 70_254_592)
        XCTAssertThrowsError(try GGUFHeader.read(header(architecture: "qwen35", hybrid: false)))
        let gemma = try GGUFHeader.read(header(architecture: "gemma4", hybrid: false))
        XCTAssertEqual(gemma.kvHeads, 8)
        XCTAssertNil(gemma.recurrentStateBytes)
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

/// Run explicitly on a physical device. Downloads real immutable model artifacts.
@MainActor final class DownloadedModelDeviceTests: XCTestCase {
    override func tearDown() async throws { await DownloadedModelRuntime.shared.unload() }
    func testInstalledQwenUsesUpstreamDocumentEdit() async throws {
        #if targetEnvironment(simulator)
        throw XCTSkip("Physical-device acceptance only")
        #else
        guard ProcessInfo.processInfo.environment["MULTIVIBE_LOCAL_DEVICE_TEST"] == "1" else { throw XCTSkip("Opt in to device inference") }
        let library = LocalModelLibrary.shared
        let model = try XCTUnwrap(HuggingFaceCatalog.bundled.first { $0.name == "Qwen3 1.7B" })
        var modelFile = library.file(model)
        var temporaryFile: URL?
        defer { if let temporaryFile { try? FileManager.default.removeItem(at: temporaryFile) } }
        if library.installation(model.id)?.state != .installed {
            guard ProcessInfo.processInfo.environment["MULTIVIBE_TEST_DOWNLOAD_FIXTURE"] == "1" else { throw XCTSkip("Install Qwen3 1.7B or opt in to an isolated Wi-Fi fixture") }
            executionTimeAllowance = 600
            let configuration = URLSessionConfiguration.ephemeral
            configuration.allowsCellularAccess = false
            configuration.timeoutIntervalForResource = 480
            let session = URLSession(configuration: configuration)
            defer { session.invalidateAndCancel() }
            let (file, response) = try await session.download(from: model.url)
            temporaryFile = file
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            var hash = SHA256(), size: Int64 = 0
            while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty { hash.update(data: chunk); size += Int64(chunk.count) }
            guard size == model.bytes, hash.finalize().map({ String(format: "%02x", $0) }).joined() == model.sha256.lowercased() else { throw LocalAgentError.invalidInput }
            modelFile = file
        }
        actor Capture {
            var saved: LocalDocument?
            var text = ""
            func save(_ value: LocalDocument) { saved = value }
            func append(_ value: String) { text += value }
        }
        let capture = Capture()
        let document = LocalDocument(name: "Note de test", text: "Total: 42")
        let workspace = LocalAgentWorkspace(conversations: [], documents: [document], event: { _ in }, saveDocument: { await capture.save($0) })
        try await DownloadedModelRuntime.shared.respond(model: library.validated(model), path: modelFile,
            messages: [ChatMessage(role: "user", content: "Dans le document \(document.id.uuidString), remplace exactement « Total: 42 » par « Total: 43 » avec edit_document. Ne crée pas de nouveau document.")],
            workspace: workspace) { await capture.append($0) }
        let saved = await capture.saved, text = await capture.text
        XCTAssertEqual(saved?.id, document.id, text)
        XCTAssertEqual(saved?.text, "Total: 43", text)
        #endif
    }
    func testInstalledQwenToolsThroughProductionCatalog() async throws {
        #if targetEnvironment(simulator)
        throw XCTSkip("Physical-device acceptance only")
        #else
        guard ProcessInfo.processInfo.environment["MULTIVIBE_LOCAL_DEVICE_TEST"] == "1" else {
            throw XCTSkip("Explicit opt-in required for on-device inference")
        }
        let library = LocalModelLibrary.shared
        let model = try XCTUnwrap(HuggingFaceCatalog.bundled.first { $0.name == "Qwen3 1.7B" })
        guard library.installation(model.id)?.state == .installed else {
            throw XCTSkip("Install Qwen3 1.7B before running this test; it never downloads models")
        }
        XCTAssertTrue(library.validated(model).supportsTools)
        actor Capture {
            var text = ""; var calls: [String] = []; var requests = 0
            func append(_ value: String) { text += value }
            func event(_ value: LocalAgentEvent) { calls.append(value.tool) }
            func fetched() { requests += 1 }
        }
        for scenario in ["allowed", "denied", "live"] {
            let denied = scenario == "denied"
            let live = scenario == "live"
            let capture = Capture()
            let workspace = LocalAgentWorkspace(conversations: [], documents: [],
                event: { await capture.event($0) }, saveDocument: { _ in },
                authorizeInternet: { _ in !denied },
                webFetch: { url, _ in
                    await capture.fetched()
                    if live { return try await LocalWebFetch.fetch(url: url, method: "GET") }
                    return LocalWebResponse(url: url, status: 200, contentType: "text/plain", text: "Validation code: ORION-742. Tomorrow: sunny, 21 C.")
                })
            try await DownloadedModelRuntime.shared.respond(model: library.validated(model), path: library.file(model),
                messages: [ChatMessage(role: "user", content: "Peux-tu vérifier sur Internet ?"),
                    ChatMessage(role: "assistant", content: "Je ne possède pas d’outils pour accéder à Internet."),
                    ChatMessage(role: "user", content: live
                        ? "Lis https://example.com avec tes outils et donne le titre exact en anglais de la page."
                        : "Utilise tes outils pour lire https://example.com et donne le code de validation indiqué dans la page.")],
                workspace: workspace) { await capture.append($0) }
            let calls = await capture.calls, text = await capture.text, requests = await capture.requests
            XCTAssertTrue(calls.contains("fetch_website"), "No web tool call: " + text)
            XCTAssertEqual(requests, denied ? 0 : 1)
            XCTAssertFalse(text.isEmpty)
            if live { XCTAssertTrue(text.contains("Example Domain"), text) }
            else if !denied { XCTAssertTrue(text.contains("ORION-742"), text) }
            else { XCTAssertFalse(text.contains("ORION-742"), text) }
            await DownloadedModelRuntime.shared.unload()
        }
        #endif
    }
    func testPiWeatherClarificationAndLiveForecast() async throws {
        #if targetEnvironment(simulator)
        throw XCTSkip("Physical-device acceptance only")
        #else
        guard ProcessInfo.processInfo.environment["MULTIVIBE_LOCAL_DEVICE_TEST"] == "1" else { throw XCTSkip("Opt in to device inference") }
        let library = LocalModelLibrary.shared
        let model = try XCTUnwrap(HuggingFaceCatalog.bundled.first { $0.name == "Qwen3 1.7B" })
        guard library.installation(model.id)?.state == .installed else { throw XCTSkip("Install Qwen3 1.7B") }
        actor Capture {
            var text = ""; var requests = 0; var events: [LocalAgentEvent] = []
            func append(_ value: String) { text += value }
            func fetch() { requests += 1 }
            func event(_ value: LocalAgentEvent) { events.append(value) }
        }
        for cityKnown in [false, true] {
            let capture = Capture()
            let workspace = LocalAgentWorkspace(conversations: [], documents: [], event: { await capture.event($0) }, saveDocument: { _ in },
                authorizeInternet: { _ in true }, webFetch: { url, method in
                    await capture.fetch()
                    XCTAssertTrue(cityKnown, "No network request may guess the missing city")
                    return try await LocalWebFetch.fetch(url: url, method: method)
                })
            var messages = [ChatMessage(role: "user", content: "Quel temps fera-t-il demain ?")]
            if cityKnown { messages += [ChatMessage(role: "assistant", content: "Pour quelle ville ?"), ChatMessage(role: "user", content: "Toulouse")] }
            try await DownloadedModelRuntime.shared.respond(model: model, path: library.file(model), messages: messages, workspace: workspace) { await capture.append($0) }
            let text = await capture.text, requests = await capture.requests, events = await capture.events
            XCTAssertTrue(events.contains { $0.tool == "pi_agent_core" })
            if cityKnown {
                XCTAssertEqual(requests, 2)
                XCTAssertTrue(events.contains { $0.tool == "weather_forecast" && $0.status == "success" })
                XCTAssertTrue(text.localizedCaseInsensitiveContains("Toulouse"), text)
                XCTAssertTrue(text.contains("°") || text.contains("degr"), text)
            } else {
                XCTAssertEqual(requests, 0)
                XCTAssertTrue(text.localizedCaseInsensitiveContains("ville"), text)
            }
            await DownloadedModelRuntime.shared.unload()
        }
        #endif
    }
    func testRealDownloadResumeAndLocalTools() async throws {
        #if targetEnvironment(simulator)
        throw XCTSkip("Physical-device acceptance only")
        #else
        guard ProcessInfo.processInfo.environment["MULTIVIBE_LOCAL_DEVICE_TEST"] == "1" else {
            throw XCTSkip("Explicit opt-in required for real model downloads")
        }
        let library = LocalModelLibrary.shared
        library.start()
        for _ in 0..<100 { if library.connected { break }; try await Task.sleep(for: .milliseconds(100)) }
        guard library.connected, !library.cellular else { throw XCTSkip("Connect device to Wi-Fi for multi-GB acceptance downloads") }
        for var model in HuggingFaceCatalog.bundled.prefix(2) {
            library.requestDownload(model)
            if library.installation(model.id)?.state != .installed {
                for _ in 0..<600 {
                    if (library.meters[model.id]?.bytes ?? 0) > 1_000_000 { break }
                    try await Task.sleep(for: .milliseconds(100))
                }
                library.pause(model.id)
                XCTAssertEqual(library.installation(model.id)?.state, .paused)
                try await Task.sleep(for: .seconds(1))
                library.resume(model.id)
            }
            for _ in 0..<1800 {
                if library.installation(model.id)?.state == .installed { break }
                if let failure = library.installation(model.id)?.failure { XCTFail(failure); return }
                try await Task.sleep(for: .seconds(1))
            }
            XCTAssertEqual(library.installation(model.id)?.state, .installed)
            guard library.installation(model.id)?.state == .installed else { return }
            actor Capture {
                var text = ""; var calls: [String] = []
                func append(_ value: String) { text += value }
                func event(_ value: LocalAgentEvent) { calls.append(value.tool) }
            }
            let capture = Capture()
            let workspace = LocalAgentWorkspace(conversations: [], documents: [], event: { await capture.event($0) }, saveDocument: { _ in })
            model.toolsValidated = true
            model.validatedDevices = [LocalHardware.identifier]
            try await DownloadedModelRuntime.shared.respond(model: model, path: library.file(model),
                messages: [ChatMessage(role: "user", content: "Use the current_date tool. Then answer briefly with the date that tool returned.")], workspace: workspace) { await capture.append($0) }
            let text = await capture.text, calls = await capture.calls
            XCTAssertFalse(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "The model returned no final answer")
            XCTAssertTrue(calls.contains("current_date"), "The model did not invoke the declared tool")
            await DownloadedModelRuntime.shared.unload()
        }
        #endif
    }
}
