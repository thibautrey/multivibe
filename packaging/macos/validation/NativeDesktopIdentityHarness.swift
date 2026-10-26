import AppKit
import Foundation
import Security

struct NativeChatMessage: Codable { let id: UUID; let role: String; let content: String; let interrupted: Bool }
struct NativeChatConversation: Codable { let id: UUID; let title: String; let model: String; let messages: [NativeChatMessage] }

@MainActor private final class IdentityFixture {
    var registry: NativeCloudAccountRegistry?
    var appearance = NativeAppearanceSettings()
    var failAppearance = false
    var time: TimeInterval = 0
    var writes = 0
    var storage: NativeAppearanceStorage { .init(load: { self.appearance }, save: {
        if self.failAppearance { throw NativeCloudSessionError.storage(errSecIO) }
        self.writes += 1; self.appearance = $0
    }) }
    func transport(_ request: URLRequest) async throws -> (Data, URLResponse) {
        let id = request.value(forHTTPHeaderField: "Authorization") == "Bearer b" ? "b" : "a"
        let object: [String: Any] = ["accountId": id, "cloudEnabled": true, "exportSources": [], "revision": 1]
        return (try JSONSerialization.data(withJSONObject: object), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

@main struct DesktopIdentityChecks {
    @MainActor static func main() async throws {
        var activity = NativeIdentityActivity()
        activity.unlocked(at: 10)
        precondition(!activity.expired(at: 609))
        precondition(activity.interact(at: 609))
        precondition(!activity.expired(at: 1208))
        precondition(activity.expired(at: 1209))
        precondition(!activity.interact(at: 1209), "The event after expiry cannot renew the old identity")
        activity.clear(); precondition(!activity.interact(at: 1210))

        let fixture = IdentityFixture()
        fixture.registry = NativeCloudAccountRegistry(accounts: [
            .init(credential: .init(accessToken: "a", refreshToken: "refresh-a", expiresAt: .distantFuture, accountID: "a"), displayName: "Alice"),
            .init(credential: .init(accessToken: "b", refreshToken: "refresh-b", expiresAt: .distantFuture, accountID: "b"), displayName: "Noah"),
        ], selectedAccountID: "a")
        let session = try NativeCloudSession(transport: fixture.transport, accountStorage: .init(load: { fixture.registry }, save: { fixture.registry = $0 }))
        let client = NativeAgentClient(token: { try await session.token() }, account: { session.accountID }, transport: fixture.transport)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("identity-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let agent = NativeChatAgentCoordinator(session: session, client: client, root: root)
        await agent.restore()
        let identity = NativeDesktopIdentity(agent: agent, storage: fixture.storage, now: { fixture.time })
        precondition(identity.activeProfile?.displayName == "Alice")
        identity.setAsksEveryTime(true)
        fixture.time = 599; identity.interaction()
        fixture.time = 1198; identity.tick(); precondition(!identity.requiresSelection)
        fixture.time = 1199; identity.interaction()
        precondition(identity.requiresSelection && agent.accountID == nil && session.accountID == nil)
        precondition(agent.cloudConversations.isEmpty && agent.runs.isEmpty && agent.models.isEmpty)
        do { _ = try await session.token(); fatalError("Locked credentials escaped") } catch {}
        identity.interaction(); precondition(identity.requiresSelection)
        await identity.unlock("b")
        precondition(identity.activeProfile?.id == "b" && agent.accountID == "b")

        let sample = (0..<128).map { Float($0 + 1) / 1000 }
        do { try identity.saveAppearance([sample], accountID: "b"); fatalError("Incomplete enrollment saved") } catch {}
        precondition(fixture.writes == 0)
        do { try identity.saveAppearance(Array(repeating: sample, count: 5), accountID: "a"); fatalError("Another identity's face saved") } catch {}
        try identity.saveAppearance(Array(repeating: sample, count: 5), accountID: "b")
        precondition(identity.cameraEnabled && identity.enrolled && fixture.appearance.faces["b"]?.count == 5)
        let previous = fixture.appearance
        fixture.failAppearance = true
        do { try identity.saveAppearance(Array(repeating: sample.map { $0 + 0.1 }, count: 5), accountID: "b"); fatalError("Storage failure ignored") } catch {}
        precondition(identity.appearance == previous && fixture.appearance == previous)
        fixture.failAppearance = false
        identity.deleteAppearance(); precondition(!identity.cameraEnabled && !identity.enrolled && fixture.appearance.faces.isEmpty)
        try await session.setPIN("2468", for: "b")
        identity.lock(); identity.choose(identity.profiles.first { $0.id == "b" }!)
        precondition(identity.pendingAccountID == "b" && identity.requiresSelection)
        await identity.unlock("b", pin: "1357"); precondition(identity.requiresSelection)
        await identity.unlock("b", pin: "2468"); precondition(identity.activeProfile?.id == "b")
        print("PASS identity inactivity boundary and reset, locked tokens, per-account Cloud state, PIN and transactional appearance; camera never accessed")
    }
}
