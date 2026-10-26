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


@MainActor final class MultiCloudFixture {
    var legacy: NativeCloudCredential?
    var registry: NativeCloudAccountRegistry?
    var date = Date()
    var identity = "account-a"
    var sequence = 0
    var identities: [String: String] = [:]
    var requests: [URLRequest] = []
    var legacyClears = 0
    var failSave = false
    var pauseToken = false
    var pendingToken: CheckedContinuation<(Data, URLResponse), Error>?
    var storage: NativeCloudSessionStorage {
        .init(load: { self.legacy }, save: { self.legacy = $0 }, clear: { self.legacyClears += 1; self.legacy = nil })
    }
    var accountStorage: NativeCloudAccountStorage {
        .init(load: { self.registry }, save: {
            if self.failSave { throw NativeCloudSessionError.storage(-50) }
            self.registry = $0
        })
    }
    func session() throws -> NativeCloudSession {
        try NativeCloudSession(storage: storage, transport: transport, accountStorage: accountStorage, now: { self.date })
    }
    func seed(_ accounts: [NativeCloudStoredAccount], selected: String?) {
        registry = NativeCloudAccountRegistry(accounts: accounts, selectedAccountID: selected)
        for account in accounts { identities[account.credential.accessToken] = account.credential.accountID }
    }
    func account(_ id: String, expired: Bool = false) -> NativeCloudStoredAccount {
        .init(credential: .init(accessToken: "access-" + id, refreshToken: "refresh-" + id,
            expiresAt: expired ? .distantPast : date.addingTimeInterval(3600), accountID: id), displayName: id)
    }
    func transport(_ request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        if request.url?.path == "/oauth/token" {
            if pauseToken { return try await withCheckedThrowingContinuation { pendingToken = $0 } }
            sequence += 1
            let access = "issued-\(identity)-\(sequence)"
            identities[access] = identity
            return try response(request.url!, ["access_token": access, "refresh_token": "rotated-\(identity)-\(sequence)", "expires_in": 3600])
        }
        if request.url?.path == "/native/v1/auth/session" {
            let access = String((request.value(forHTTPHeaderField: "Authorization") ?? "").dropFirst(7))
            return try response(request.url!, ["accountId": identities[access] ?? identity, "name": "Profil " + (identities[access] ?? identity)])
        }
        return try response(request.url!, [:])
    }
    private func response(_ url: URL, _ payload: [String: Any]) throws -> (Data, URLResponse) {
        (try JSONSerialization.data(withJSONObject: payload), HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
    func release(_ id: String) throws {
        let access = "late-" + id
        identities[access] = id
        let value = try response(URL(string: "https://auth.multivibe.cloud/oauth/token")!,
            ["access_token": access, "refresh_token": "late-refresh-" + id, "expires_in": 3600])
        pendingToken?.resume(returning: value); pendingToken = nil; pauseToken = false
    }
    func authorize(_ session: NativeCloudSession, as identity: String) async throws {
        self.identity = identity
        let auth = try session.beginAuthorization()
        let callback = URL(string: "multivibe://oauth/callback/macos?state=" + auth.state + "&code=test")!
        try await session.completeAuthorization(callback, authorization: auth)
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
        for (error, expected) in [("access_denied", "accessDenied"), ("invalid_request", "invalidRequest")] {
            let rejected = URL(string: "multivibe://oauth/callback/macos?error=" + error + "&state=" + authorization.state)!
            do {
                _ = try NativeCloudSession.authorizationCode(rejected, expectedState: authorization.state)
                fatalError("OAuth error accepted as an authorization code")
            } catch NativeCloudSessionError.accessDenied where expected == "accessDenied" {
            } catch NativeCloudSessionError.invalidRequest where expected == "invalidRequest" {
            }
        }
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
        try await multiAccountChecks()
        print("NativeCloudSession: PKCE/callback, verified identity, migration, multi-account/PIN/lock and late rotation checks passed")
    }
    @MainActor static func multiAccountChecks() async throws {
        // A failed new-vault write leaves the original session untouched.
        let failedMigration = MultiCloudFixture()
        failedMigration.legacy = failedMigration.account("account-a").credential; failedMigration.failSave = true
        do { _ = try failedMigration.session(); fatalError("Failed migration accepted") } catch NativeCloudSessionError.storage {}
        precondition(failedMigration.legacy != nil && failedMigration.registry == nil && failedMigration.legacyClears == 0)
        let migration = MultiCloudFixture()
        migration.legacy = migration.account("account-a").credential
        migration.identities[migration.legacy!.accessToken] = "account-a"
        let migrated = try migration.session()
        precondition(migration.legacy == nil && migration.legacyClears == 1 && migration.registry?.accounts.count == 1)
        precondition(!migrated.needsIdentity && migrated.accountID == nil)
        _ = try await migrated.token()
        precondition(migrated.accountID == "account-a")

        // A registry-only injection is also isolated, without reading legacy Keychain storage.
        let empty = MultiCloudFixture()
        let explicitRegistry = try NativeCloudSession(transport: empty.transport, accountStorage: empty.accountStorage)
        precondition(explicitRegistry.profiles.isEmpty)

        let fixture = MultiCloudFixture(); let session = try fixture.session()
        try await fixture.authorize(session, as: "account-a")
        try session.renameAccount("account-a", name: "Alice")
        try await fixture.authorize(session, as: "account-b")
        precondition(session.profiles.count == 2 && session.accountID == "account-b")
        precondition(session.profiles.first { $0.id == "account-a" }?.displayName == "Alice")
        precondition(!fixture.requests.contains { $0.url?.path == "/oauth/revoke" })
        try await session.selectAccount("account-a")
        precondition(session.accountID == "account-a" && session.selectedAccountID == "account-a")
        session.lock()
        precondition(session.needsIdentity && session.accountID == nil)
        do { _ = try await session.token(); fatalError("Locked token accepted") } catch NativeCloudSessionError.disconnected {}
        try await session.selectAccount("account-b")
        do { try await session.setPIN("１２３４", for: "account-b"); fatalError("Non-ASCII PIN accepted") } catch NativeCloudSessionError.invalidPINFormat {}
        try await session.setPIN("4321", for: "account-b")
        precondition(session.profiles.first { $0.id == "account-b" }?.hasPIN == true)
        let encodedRegistry = try JSONEncoder().encode(fixture.registry)
        precondition(!String(data: encodedRegistry, encoding: .utf8)!.contains("\"4321\""))
        session.lock()
        do { try await session.selectAccount("account-b"); fatalError("Missing PIN accepted") } catch NativeCloudSessionError.pinRequired {}
        for attempt in 1...5 {
            do { try await session.selectAccount("account-b", pin: "1111"); fatalError("Incorrect PIN accepted") }
            catch NativeCloudSessionError.invalidPIN { precondition(attempt < 5) }
            catch NativeCloudSessionError.pinThrottled { precondition(attempt == 5) }
        }
        let restarted = try fixture.session()
        precondition(restarted.needsIdentity && restarted.accountID == nil)
        do { try await restarted.selectAccount("account-b", pin: "4321"); fatalError("Cooldown lost after restart") } catch NativeCloudSessionError.pinThrottled {}
        fixture.date = fixture.date.addingTimeInterval(31)
        try await restarted.selectAccount("account-b", pin: "4321")
        precondition(restarted.accountID == "account-b")
        precondition(fixture.registry?.accounts.first { $0.credential.accountID == "account-b" }?.failedPINAttempts == 0)
        do { try await restarted.setPIN(nil, for: "account-b"); fatalError("PIN removed without current PIN") } catch NativeCloudSessionError.pinRequired {}
        // OAuth for an already protected profile cannot bypass its PIN.
        try await fixture.authorize(restarted, as: "account-b")
        precondition(restarted.accountID == nil && restarted.needsIdentity)
        precondition(restarted.profiles.first { $0.id == "account-b" }?.hasPIN == true)
        try await restarted.selectAccount("account-b", pin: "4321")
        try await restarted.setPIN(nil, for: "account-b", currentPIN: "4321")
        precondition(restarted.profiles.first { $0.id == "account-b" }?.hasPIN == false)
        try restarted.setAsksEveryTime(true)
        let asking = try fixture.session()
        precondition(asking.asksEveryTime && asking.needsIdentity)
        do { _ = try await asking.token(); fatalError("Ask everytime restored a token") } catch NativeCloudSessionError.disconnected {}
        try await asking.selectAccount("account-a")
        try await asking.removeAccount("account-b")
        precondition(asking.accountID == "account-a" && asking.profiles.map(\.id) == ["account-a"])
        try await asking.disconnect()
        precondition(asking.profiles.isEmpty && asking.accountID == nil)

        // Rotation may complete after a switch: preserve only A's fresh credentials and keep B active.
        let rotation = MultiCloudFixture()
        rotation.seed([rotation.account("account-a", expired: true), rotation.account("account-b")], selected: "account-a")
        rotation.pauseToken = true
        let rotating = try rotation.session()
        let inFlight = Task { try await rotating.token() }
        for _ in 0..<100 where rotation.pendingToken == nil { await Task.yield() }
        precondition(rotation.pendingToken != nil)
        try await rotating.selectAccount("account-b")
        try rotation.release("account-a")
        do { _ = try await inFlight.value; fatalError("Old identity returned after switch") } catch NativeCloudSessionError.disconnected {}
        precondition(rotating.accountID == "account-b" && rotating.selectedAccountID == "account-b")
        precondition(rotation.registry?.accounts.first { $0.credential.accountID == "account-a" }?.credential.refreshToken == "late-refresh-account-a")
        try await rotating.selectAccount("account-a")
        precondition(rotating.accountID == "account-a" && rotation.requests.filter { $0.url?.path == "/oauth/token" }.count == 1)

        // Removing A while its rotation is pending cannot resurrect it or affect B.
        let removal = MultiCloudFixture()
        removal.seed([removal.account("account-a", expired: true), removal.account("account-b")], selected: "account-a")
        removal.pauseToken = true
        let removing = try removal.session()
        let pending = Task { try await removing.token() }
        for _ in 0..<100 where removal.pendingToken == nil { await Task.yield() }
        precondition(removal.pendingToken != nil)
        try await removing.removeAccount("account-a")
        try removal.release("account-a")
        do { _ = try await pending.value; fatalError("Removed identity returned") } catch NativeCloudSessionError.disconnected {}
        precondition(removing.profiles.map(\.id) == ["account-b"] && removing.accountID == nil)
        precondition(removal.requests.filter { $0.url?.path == "/oauth/revoke" }.count == 2)
        try await removing.selectAccount("account-b")
        // A failed persistence cannot publish a selected identity.
        removing.lock(); removal.failSave = true
        do { try await removing.selectAccount("account-b"); fatalError("Selection bypassed storage failure") } catch NativeCloudSessionError.storage {}
        precondition(removing.accountID == nil && removing.needsIdentity)
    }

}
