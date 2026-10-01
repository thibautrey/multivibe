import Foundation

@MainActor final class CloudFixture {
    var saved: NativeCloudCredential?
    var requests: [URLRequest] = []
    var pendingToken: CheckedContinuation<(Data, URLResponse), Error>?
    var pauseToken = false
    var identity = "account-a"
    var redirected = false
    var failure: Int?
    var storage: NativeCloudSessionStorage { .init(load: { self.saved }, save: { self.saved = $0 }, clear: { self.saved = nil }) }
    func transport(_ request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        if pauseToken && request.url?.path == "/oauth/token" {
            return try await withCheckedThrowingContinuation { pendingToken = $0 }
        }
        let payload: [String: Any]
        if request.url?.path == "/oauth/token" { payload = ["access_token": "access", "refresh_token": "refresh-new", "expires_in": 3600] }
        else if request.url?.path == "/native/v1/auth/session" { payload = ["accountId": identity] }
        else { payload = [:] }
        let url = redirected ? URL(string: "https://wrong.example/path")! : request.url!
        return (try JSONSerialization.data(withJSONObject: payload), HTTPURLResponse(url: url, statusCode: failure ?? 200, httpVersion: nil, headerFields: nil)!)
    }
    func releaseToken() throws {
        let response = HTTPURLResponse(url: URL(string: "https://auth.multivibe.cloud/oauth/token")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        pendingToken?.resume(returning: (try JSONSerialization.data(withJSONObject: ["access_token":"late-access","refresh_token":"late-refresh","expires_in":3600]), response))
        pendingToken = nil
    }
}

@main struct NativeCloudSessionChecks {
    @MainActor static func main() async throws {
        let fixture = CloudFixture()
        let session = try NativeCloudSession(storage: fixture.storage, transport: fixture.transport)
        let authorization = try session.beginAuthorization()
        let components = URLComponents(url: authorization.url, resolvingAgainstBaseURL: false)!
        precondition(components.host == "auth.multivibe.cloud")
        precondition(components.queryItems?.first(where: { $0.name == "client_id" })?.value == "multivibe-macos")
        let callback = URL(string: "multivibe://oauth/callback/macos?state=" + authorization.state + "&code=valid-code")!
        let code = try NativeCloudSession.authorizationCode(callback, expectedState: authorization.state)
        precondition(code == "valid-code")
        for invalid in ["multivibe://worker-handoff#token", "multivibe://oauth/callback/ios?state=x&code=c", "multivibe://oauth/callback/macos?state=x&code=c&state=x", "https://oauth/callback/macos?state=x&code=c"] {
            do { _ = try NativeCloudSession.authorizationCode(URL(string: invalid)!, expectedState: "x"); fatalError("Invalid callback accepted") } catch {}
        }
        try await session.completeAuthorization(callback, authorization: authorization)
        precondition(session.accountID == "account-a" && fixture.saved?.accountID == "account-a")
        let access = try await session.token()
        precondition(access == "access")
        precondition(fixture.requests.allSatisfy { ["auth.multivibe.cloud", "app.multivibe.cloud"].contains($0.url?.host) })
        try await session.disconnect()
        precondition(fixture.saved == nil && session.accountID == nil)
        // A refresh issued after logout cannot repopulate storage.
        let race = CloudFixture()
        race.saved = .init(accessToken: "old-access", refreshToken: "old-refresh", expiresAt: .distantPast, accountID: "account-a")
        race.pauseToken = true
        let racing = try NativeCloudSession(storage: race.storage, transport: race.transport)
        let refresh = Task { try await racing.token() }
        for _ in 0..<100 where race.pendingToken == nil { await Task.yield() }
        precondition(race.pendingToken != nil)
        try await racing.disconnect()
        try race.releaseToken()
        do { _ = try await refresh.value; fatalError("Late refresh accepted") } catch {}
        precondition(race.saved == nil && racing.accountID == nil)
        precondition(race.requests.filter { $0.url?.path == "/oauth/revoke" }.count == 2)
        // A fresh authorization exchange cannot restore the account after logout.
        let signInRace = CloudFixture(); signInRace.pauseToken = true
        let signingIn = try NativeCloudSession(storage: signInRace.storage, transport: signInRace.transport)
        let auth = try signingIn.beginAuthorization()
        let callbackRace = URL(string: "multivibe://oauth/callback/macos?state=" + auth.state + "&code=late")!
        let exchange = Task { try await signingIn.completeAuthorization(callbackRace, authorization: auth) }
        for _ in 0..<100 where signInRace.pendingToken == nil { await Task.yield() }
        precondition(signInRace.pendingToken != nil)
        try await signingIn.disconnect(); try signInRace.releaseToken()
        do { try await exchange.value; fatalError("Late authorization accepted") } catch {}
        for _ in 0..<100 where !signInRace.requests.contains(where: { $0.url?.path == "/oauth/revoke" }) { await Task.yield() }
        precondition(signInRace.saved == nil && signingIn.accountID == nil)
        precondition(signInRace.requests.contains(where: { $0.url?.path == "/oauth/revoke" }))
        // Even a synthetic successful response from another origin is rejected.
        let wrong = CloudFixture(); wrong.redirected = true
        wrong.saved = .init(accessToken: "a", refreshToken: "r", expiresAt: .distantFuture, accountID: "account-a")
        let wrongSession = try NativeCloudSession(storage: wrong.storage, transport: wrong.transport)
        do { _ = try await wrongSession.token(); fatalError("Cross-origin response accepted") } catch NativeCloudSessionError.invalidResponse {}
        // A live token whose verified identity changes is never accepted.
        let changed = CloudFixture(); changed.identity = "account-b"
        changed.saved = .init(accessToken: "a", refreshToken: "r", expiresAt: .distantFuture, accountID: "account-a")
        let changedSession = try NativeCloudSession(storage: changed.storage, transport: changed.transport)
        do { _ = try await changedSession.token(); fatalError("Changed account accepted") } catch NativeCloudSessionError.disconnected {}
        print("NativeCloudSession: PKCE/callback, identity, fixed hosts, logout/late refresh and account isolation checks passed")
    }
}
