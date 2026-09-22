import XCTest
@testable import MultiVibeSDK

final class ProtocolTests:XCTestCase {
    func testSSEPreservesUTF8AndAllLineEndings() throws {
        var parser = SSEByteParser()
        let events = try Array("\u{FEFF}: keepalive\r\ndata: café\rdata: deuxième\r\rdata: [DONE]\n\n".utf8).compactMap {try parser.consume($0)}
        XCTAssertEqual(events,["café\ndeuxième","[DONE]"])
    }
    func testSSEBoundsCommentsAndInvalidUTF8() {
        var parser = SSEByteParser(maximumBytes:8)
        XCTAssertThrowsError(try Array(":0123456789".utf8).forEach {_ = try parser.consume($0)})
        var invalid = SSEByteParser()
        XCTAssertThrowsError(try [UInt8(255),10].forEach {_ = try invalid.consume($0)})
    }
    func testOAuthBindsExactCallbackAndState() throws {
        let auth = try MultiVibeAuthorization(configuration:.init(clientID:UUID().uuidString,redirectURI:URL(string:"https://example.com/callback")!))
        let url = URL(string:"https://example.com/callback?code=good&state=\(auth.state)")!
        XCTAssertEqual(try auth.code(from:url),"good")
        for invalid in ["https://evil.com/callback?code=good&state=\(auth.state)","https://example.com/other?code=good&state=\(auth.state)","https://example.com/callback?code=good&state=wrong","https://example.com/callback?code=good&state=\(auth.state)&state=\(auth.state)","https://example.com/callback?code=good&state=\(auth.state)#fragment"] {XCTAssertThrowsError(try auth.code(from:URL(string:invalid)!))}
        let params = URLComponents(url:auth.url(broker:false),resolvingAgainstBaseURL:false)!.queryItems!
        XCTAssertEqual(params.first(where:{$0.name == "code_challenge_method"})?.value,"S256")
        XCTAssertEqual(auth.verifier.count,43)
        XCTAssertNotEqual(auth.state,auth.verifier)
    }
    func testSchemaRejectsUnknownPropertiesAndConstraints() throws {
        let schema:JSONValue = .object(["type":.string("object"),"properties":.object(["title":.object(["type":.string("string")])]),"required":.array([.string("title")]),"additionalProperties":.bool(false)])
        try MultiVibeToolSchema.validate(.object(["title":.string("hello")]),schema:schema)
        XCTAssertThrowsError(try MultiVibeToolSchema.validate(.object([:]),schema:schema))
        XCTAssertThrowsError(try MultiVibeToolSchema.validate(.object(["title":.string("hi"),"unexpected":.bool(true)]),schema:schema))
        XCTAssertThrowsError(try MultiVibeToolSchema.validate(.string("hi"),schema:.object(["type":.string("string"),"pattern":.string("secret")])) )
    }
    func testToolJournalDoesNotRepeatExecution() async throws {
        let key = UUID().uuidString
        let first = try await ToolJournal.shared.run(key:key,arguments:"{}") {"once"}
        let second = try await ToolJournal.shared.run(key:key,arguments:"{}") {throw MultiVibeError.invalidResponse}
        XCTAssertEqual(first,second)
        do {_ = try await ToolJournal.shared.run(key:key,arguments:"changed") {"twice"}; XCTFail("changed arguments accepted")} catch {}
    }
    func testInterruptedToolRemainsUnknownRatherThanRetrying() async throws {
        let key = UUID().uuidString
        do {_ = try await ToolJournal.shared.run(key:key,arguments:"{}") {throw MultiVibeError.cancelled}; XCTFail()} catch {}
        do {_ = try await ToolJournal.shared.run(key:key,arguments:"{}") {"duplicate mutation"}; XCTFail("unsafe retry")} catch MultiVibeError.unknownToolOutcome {} catch {XCTFail("unexpected \(error)")}
    }
    func testUUIDWireNormalization() throws {
        let id = UUID().uuidString
        let value = MultiVibeConversation(id:id,appId:id)
        XCTAssertEqual(value.id,id.lowercased())
        XCTAssertEqual(value.appId,id.lowercased())
        let config = MultiVibeConfiguration(clientID:id,redirectURI:URL(string:"https://example.com/callback")!)
        XCTAssertEqual(config.clientID,id.lowercased())
        let decoded = try JSONDecoder().decode(MultiVibeConversation.self,from:JSONEncoder().encode(value))
        XCTAssertEqual(decoded.id,value.id)
    }
    func testToolDeadlineReturnsUnknownOutcome() async {
        do {
            _ = try await withToolDeadline(timeout:.milliseconds(10)) {
                try await Task.sleep(for:.seconds(10));return "should not finish"
            }
            XCTFail("deadline ignored")
        } catch MultiVibeError.unknownToolOutcome {} catch {XCTFail("unexpected \(error)")}
    }
    @MainActor func testApplicationRejectsForeignConversationBeforeNetwork() async throws {
        let client = MultiVibeClient(configuration:.init(clientID:"first",redirectURI:URL(string:"https://first.example/callback")!))
        do {_ = try await client.save(MultiVibeConversation(appId:"other"));XCTFail("cross-app write accepted")} catch MultiVibeError.invalidArguments {} catch {XCTFail("unexpected \(error)")}
    }
}
