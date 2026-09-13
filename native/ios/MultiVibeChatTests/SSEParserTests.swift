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
}
