import XCTest
@testable import MultiVibeChat

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
        let manager = ConversationManager()
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
    func testUnavailableModelRequiresExplicitReplacement() {
        let manager = ConversationManager()
        manager.session = nil
        let conversation = Conversation(model: "removed")
        manager.models = [ModelOption(id: "available")]
        manager.selectedModel = "available"
        manager.conversations = [conversation]
        manager.selection = conversation.id
        XCTAssertEqual(manager.selectedModel, "")
    }
    func testReselectingSameConversationDoesNotStopGeneration() {
        let manager = ConversationManager()
        manager.session = nil
        let conversation = Conversation(model: "first")
        manager.conversations = [conversation]
        manager.selection = conversation.id
        manager.isStreaming = true
        manager.selection = conversation.id
        XCTAssertTrue(manager.isStreaming)
    }
}
