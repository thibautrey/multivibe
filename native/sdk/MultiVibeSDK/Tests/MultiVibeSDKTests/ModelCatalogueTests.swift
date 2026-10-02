import XCTest
@testable import MultiVibeSDK

final class ModelCatalogueTests: XCTestCase {
    private let machine = "11111111-1111-4111-8111-111111111111"
    @MainActor private func fixture(relayStatus: Int = 200) -> MultiVibeClient {
        let client = MultiVibeClient(configuration: .init(clientID: "multivibe-ios", redirectURI: URL(string: "https://example.com/callback")!), mode: .accountOwner, tokenProvider: { "fixture" })
        let machine = machine
        client.dataTransportOverride = { request in
            let body: [String: Any], status: Int
            switch request.url!.path {
            case "/native/v1/auth/session": body = ["accountId": "22222222-2222-4222-8222-222222222222"]; status = 200
            case "/native/v1/models": body = ["data": [["id": "cloud/model"], ["id": "personal/account/model", "source": "personal"]]]; status = 200
            case "/relay/v1/models":
                body = ["data": [
                    ["id": "relay/\(machine)/online", "name": "My model", "source": "relay", "machineName": "My Mac", "available": true, "supportsTools": true],
                    ["id": "relay/\(machine)/offline", "available": false]
                ], "allowance": ["periodStart": "2026-10-01", "periodEnd": "2026-11-01", "included": 250, "used": 2, "reserved": 1, "remaining": 247, "unlimited": false]]
                status = relayStatus
            default: throw MultiVibeError.invalidResponse
            }
            return (try JSONSerialization.data(withJSONObject: body), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
        return client
    }
    @MainActor func testCatalogueSectionsMetadataAndExactRelayRoute() async throws {
        let client = fixture(); try await client.connect()
        XCTAssertEqual(client.models.map(\.section), [.cloud, .accounts, .relay, .relay])
        XCTAssertEqual(client.models[2].displayName, "My model")
        XCTAssertEqual(client.models[2].machineName, "My Mac")
        XCTAssertEqual(client.relayAllowance?.remaining, 247)
        XCTAssertEqual(try client.completionPath(body: JSONEncoder().encode(["model": "relay/\(machine)/online"])), "/relay/v1/completions")
        XCTAssertEqual(try client.completionPath(body: JSONEncoder().encode(["model": "cloud/model"])), "/native/v1/completions")
        XCTAssertThrowsError(try client.completionPath(body: JSONEncoder().encode(["model": "relay/\(machine)/offline"])))
        XCTAssertThrowsError(try client.completionPath(body: JSONEncoder().encode(["model": "relay/\(machine)/unknown"])))
        try await client.disconnect(); XCTAssertNil(client.relayAllowance)
    }
    @MainActor func testRelayFailureKeepsCloudButNeverFallsBackForRelaySelection() async throws {
        let client = fixture(relayStatus: 503); try await client.connect()
        XCTAssertEqual(client.models.count, 2)
        XCTAssertNotNil(client.relayCatalogueError)
        XCTAssertNil(client.relayAllowance)
        XCTAssertThrowsError(try client.completionPath(body: JSONEncoder().encode(["model": "relay/\(machine)/online"])))
    }
    @MainActor func testRelayAuthenticationFailureIsNotHidden() async throws {
        let client = fixture(relayStatus: 401)
        do { try await client.connect(); XCTFail() } catch MultiVibeError.server(let code, _) { XCTAssertEqual(code, 401) }
    }
}
