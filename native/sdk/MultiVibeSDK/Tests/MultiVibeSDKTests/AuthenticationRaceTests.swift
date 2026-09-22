import XCTest
@testable import MultiVibeSDK

/// Exchanges are explicitly released by the test, so races do not rely on
/// network scheduling, sleeps or timing thresholds.
@MainActor private final class AuthenticationWire {
    let clientID:String
    private var exchanges:[String:CheckedContinuation<(Data,URLResponse),Error>] = [:]
    private var observers:[String:CheckedContinuation<Void,Never>] = [:]
    private(set) var revoked:[String] = []
    init(clientID:String) {self.clientID = clientID}
    func request(_ request:URLRequest) async throws -> (Data,URLResponse) {
        let path = request.url!.path
        if path == "/developers/oauth/token" {
            let query = URLComponents(string:"?" + String(decoding:request.httpBody ?? Data(),as:UTF8.self))!.queryItems ?? []
            let key = query.first(where:{$0.name == "code"})?.value ?? query.first(where:{$0.name == "refresh_token"})!.value!
            return try await withCheckedThrowingContinuation {continuation in exchanges[key] = continuation;observers.removeValue(forKey:key)?.resume()}
        }
        if path == "/developers/oauth/revoke" {
            let query = URLComponents(string:"?" + String(decoding:request.httpBody ?? Data(),as:UTF8.self))!.queryItems ?? []
            if let token = query.first(where:{$0.name == "token"})?.value {revoked.append(token)}
            return reply([:])
        }
        if path == "/sdk/v1/session" {return reply(["accountId":request.value(forHTTPHeaderField:"Authorization")!.replacingOccurrences(of:"Bearer ",with:""),"appId":clientID])}
        if path == "/sdk/v1/models" || path == "/sdk/v1/conversations" {return reply(["data":[]])}
        throw MultiVibeError.invalidResponse
    }
    func waitForExchange(_ key:String) async {
        if exchanges[key] != nil {return}
        await withCheckedContinuation {observers[key] = $0}
    }
    func finish(_ key:String,accessToken:String) {
        exchanges.removeValue(forKey:key)!.resume(returning:reply(["access_token":accessToken,"refresh_token":"refresh-" + accessToken,"expires_in":3600]))
    }
    private func reply(_ body:[String:Any]) -> (Data,URLResponse) {
        (try! JSONSerialization.data(withJSONObject:body),HTTPURLResponse(url:URL(string:"https://app.multivibe.cloud")!,statusCode:200,httpVersion:nil,headerFields:nil)!)
    }
}

final class AuthenticationRaceTests:XCTestCase {
    @MainActor private func fixture() -> (MultiVibeClient,AuthenticationWire,SDKKeychain) {
        let id = UUID().uuidString.lowercased()
        let client = MultiVibeClient(configuration:.init(clientID:id,redirectURI:URL(string:"https://example.com/callback")!))
        let wire = AuthenticationWire(clientID:id)
        client.dataTransportOverride = {try await wire.request($0)}
        return (client,wire,SDKKeychain(service:"cloud.multivibe.sdk.app.multivibe.cloud.\(id)"))
    }
    @MainActor private func callback(_ auth:MultiVibeAuthorization,code:String) -> URL {URL(string:"https://example.com/callback?state=\(auth.state)&code=\(code)")!}
    @MainActor func testDisconnectWhileAuthorizationExchangesCannotReconnect() async throws {
        let (client,wire,keychain) = fixture();defer {keychain.clear()}
        let auth = try client.beginAuthorization()
        let pending = Task {try await client.handleOpenURL(callback(auth,code:"old"))}
        await wire.waitForExchange("old")
        try await client.disconnect()
        wire.finish("old",accessToken:"old-account")
        do {try await pending.value;XCTFail("abandoned authorization restored credentials")} catch MultiVibeError.invalidCallback {}
        XCTAssertNil(try keychain.load())
        XCTAssertNil(client.accountID)
        XCTAssertFalse(client.isConnected)
        do {_ = try await client.token();XCTFail("old token survived")} catch MultiVibeError.authenticationRequired {}
    }
    @MainActor func testLateAuthorizationCannotOverwriteNewAccountCredentials() async throws {
        let (client,wire,keychain) = fixture();defer {keychain.clear()}
        let old = try client.beginAuthorization()
        let oldTask = Task {try await client.handleOpenURL(callback(old,code:"old"))}
        await wire.waitForExchange("old")
        let current = try client.beginAuthorization()
        let currentTask = Task {try await client.handleOpenURL(callback(current,code:"current"))}
        await wire.waitForExchange("current")
        wire.finish("current",accessToken:"current-account")
        try await currentTask.value
        wire.finish("old",accessToken:"old-account")
        do {try await oldTask.value;XCTFail("old authorization won")} catch MultiVibeError.invalidCallback {}
        XCTAssertEqual(client.accountID,"current-account")
        XCTAssertEqual(try keychain.load()?.accessToken,"current-account")
        XCTAssertEqual(try keychain.load()?.refreshToken,"refresh-current-account")
        let token = try await client.token();XCTAssertEqual(token,"current-account")
    }
    @MainActor func testCancelledRefreshCallerPersistsSuccessfulRotation() async throws {
        let id = UUID().uuidString.lowercased()
        let keychain = SDKKeychain(service:"cloud.multivibe.sdk.app.multivibe.cloud.\(id)");defer {keychain.clear()}
        try keychain.save(StoredSession(accessToken:"expired",refreshToken:"old-refresh",expiresAt:Date.distantPast))
        let client = MultiVibeClient(configuration:.init(clientID:id,redirectURI:URL(string:"https://example.com/callback")!))
        let wire = AuthenticationWire(clientID:id);client.dataTransportOverride = {try await wire.request($0)}
        let pending = Task {try await client.token()}
        await wire.waitForExchange("old-refresh")
        pending.cancel()
        wire.finish("old-refresh",accessToken:"rotated")
        do {_ = try await pending.value;XCTFail("caller cancellation was ignored")} catch is CancellationError {}
        XCTAssertEqual(try keychain.load()?.refreshToken,"refresh-rotated")
        let token = try await client.token();XCTAssertEqual(token,"rotated")
    }
    @MainActor func testRefreshCannotRestoreCredentialsAfterDisconnect() async throws {
        let id = UUID().uuidString.lowercased()
        let keychain = SDKKeychain(service:"cloud.multivibe.sdk.app.multivibe.cloud.\(id)");defer {keychain.clear()}
        try keychain.save(StoredSession(accessToken:"expired",refreshToken:"old-refresh",expiresAt:Date.distantPast))
        let client = MultiVibeClient(configuration:.init(clientID:id,redirectURI:URL(string:"https://example.com/callback")!))
        let wire = AuthenticationWire(clientID:id);client.dataTransportOverride = {try await wire.request($0)}
        let pending = Task {try await client.token()}
        await wire.waitForExchange("old-refresh")
        try await client.disconnect()
        wire.finish("old-refresh",accessToken:"abandoned")
        do {_ = try await pending.value;XCTFail("refresh restored credentials")} catch MultiVibeError.authenticationRequired {}
        XCTAssertNil(try keychain.load())
        XCTAssertFalse(client.isConnected)
    }
}
