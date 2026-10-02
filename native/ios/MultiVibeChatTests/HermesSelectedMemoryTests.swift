import XCTest
@testable import MultiVibeChat

final class HermesSelectedMemoryTests: XCTestCase {
    let account = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    func make(_ content: String? = "", target: String = "memory") throws -> HermesSelectedMemory {
        try HermesSelectedMemory(accountID: account, snapshots: [.init(accountID: account,
            objectID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", parents: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
            type: "hermes_core_memory", target: target, content: content)])
    }
    func testWholeEntryMatchingAndRemoval() throws {
        let source = try make("one\n§\none plus\n§\nother")
        let exact = try source.prepare(action: "replace", target: "memory", old_text: "one", content: "new")
        XCTAssertEqual(exact.content, "new\n§\none plus\n§\nother")
        XCTAssertEqual(exact.matchedEntry, "one")
        XCTAssertEqual(exact.original, source.snapshots[0])
        XCTAssertEqual(try source.prepare(action: "remove", target: "memory", old_text: "plus").content, "one\n§\nother")
        XCTAssertThrowsError(try source.prepare(action: "remove", target: "memory", old_text: "o")) { XCTAssertEqual($0 as? HermesSelectedMemory.Failure, .ambiguousMatch) }
        XCTAssertThrowsError(try source.prepare(action: "replace", target: "memory", old_text: "missing", content: "x")) { XCTAssertEqual($0 as? HermesSelectedMemory.Failure, .missingMatch) }
        XCTAssertEqual(try make("one").prepare(action: "remove", target: "memory", old_text: "one").content, "")
    }
    func testUnicodeBudgetsAndDelimiterCount() throws {
        let source = try make()
        XCTAssertEqual(try source.prepare(action: "add", target: "memory", content: String(repeating: "😀", count: 2200)).usedCharacters, 2200)
        XCTAssertThrowsError(try source.prepare(action: "add", target: "memory", content: String(repeating: "e\u{301}", count: 1101)))
        XCTAssertEqual(try make(target: "user").prepare(action: "add", target: "user", content: String(repeating: "x", count: 1375)).usage, "1375/1375")
        XCTAssertThrowsError(try make(target: "user").prepare(action: "add", target: "user", content: String(repeating: "x", count: 1376)))
        XCTAssertThrowsError(try make(String(repeating: "x", count: 2197)).prepare(action: "add", target: "memory", content: "y"))
        let accents = try make("é\n§\ne\u{301}")
        XCTAssertEqual(try accents.prepare(action: "remove", target: "memory", old_text: "é").content, "e\u{301}")
    }
    func testLiteralSourceAndNoImplicitTarget() throws {
        let literal = "${ENV_SECRET} `command` <instructions>literal</instructions> §"
        let source = try make(literal)
        XCTAssertFalse(try source.prepare(action: "add", target: "memory", content: literal).changed)
        XCTAssertThrowsError(try source.prepare(action: "add", target: "user", content: "x"))
        XCTAssertThrowsError(try source.prepare(action: "batch", target: "memory", content: "x"))
        XCTAssertThrowsError(try source.prepare(action: "add", target: "memory", content: "x\n§\ny"))
        XCTAssertThrowsError(try make(" x ").prepare(action: "remove", target: "memory", old_text: "x"))
        XCTAssertThrowsError(try make("x\0"))
        XCTAssertEqual(try make(nil).prepare(action: "add", target: "memory", content: "new").content, "new")
        XCTAssertThrowsError(try HermesSelectedMemory(accountID: account, snapshots: source.snapshots + source.snapshots))
    }
}
