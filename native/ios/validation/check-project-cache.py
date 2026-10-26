#!/usr/bin/env python3
"""Exercise the production projects() implementation with a counting relay stub."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'MultiVibeChat/Core/RemoteInstances.swift').read_text()
method = source[source.index('    func projects('):source.index('    func prepare(')]
with tempfile.TemporaryDirectory(prefix='multivibe-project-cache-') as folder:
    path = Path(folder)
    (path / 'main.swift').write_text('''
import Foundation
struct RemoteHarnessProject: Codable { let id: String }
enum HistoryJSON: Encodable {
    case string(String), array([HistoryJSON]), objectValue([String: HistoryJSON])
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .objectValue(let value): try container.encode(value)
        }
    }
    var object: [String: HistoryJSON]? { if case .objectValue(let value) = self { value } else { nil } }
}
struct Session { let accessToken = "test" }
@MainActor final class RemoteInstanceAPI {
    static let shared = RemoteInstanceAPI()
    var calls = 0
    var fail = false
    func control(_ machine: String, account: String, token: String, fields: [String: HistoryJSON]) async throws -> HistoryJSON {
        calls += 1
        if fail { throw CancellationError() }
        return .objectValue(["projects": .array([])])
    }
}
@MainActor final class Store {
    var projectCatalog: [String: [RemoteHarnessProject]] = [:]
    var projectCatalogFetchedAt: [String: Date] = [:]
    var busy = false
    var account: String? = "account"
    var generation = UUID()
    func authorizedFields(_ machine: String, operation: String) async throws -> (Session, [String: HistoryJSON]) { (Session(), [:]) }
    func check(_ owner: String, _ epoch: UUID) throws { precondition(owner == account && epoch == generation) }
''' + method + '''
}
@main struct Check {
    @MainActor static func main() async throws {
        let store = Store(), api = RemoteInstanceAPI.shared
        try await store.projects("a", harness: "h")
        precondition(api.calls == 1 && store.projectCatalog["a:h"] != nil)
        try await store.projects("a", harness: "h")
        precondition(api.calls == 1, "Empty lists must be reused across conversations")
        try await store.projects("b", harness: "h")
        try await store.projects("a", harness: "other")
        precondition(api.calls == 3, "Machine and harness must be isolated")
        try await store.projects("a", harness: "h", forceRefresh: true)
        precondition(api.calls == 4, "Manual refresh must bypass freshness")
        store.projectCatalogFetchedAt["a:h"] = Date().addingTimeInterval(-301)
        try await store.projects("a", harness: "h")
        precondition(api.calls == 5, "Expired lists must refresh")
        store.projectCatalogFetchedAt["a:h"] = Date().addingTimeInterval(100)
        try await store.projects("a", harness: "h")
        precondition(api.calls == 6, "Clock rollback must not prolong freshness")
        let successfulDate = store.projectCatalogFetchedAt["a:h"]
        api.fail = true
        do { try await store.projects("a", harness: "h", forceRefresh: true); preconditionFailure("Expected failure") }
        catch is CancellationError { }
        precondition(store.projectCatalog["a:h"] != nil && store.projectCatalogFetchedAt["a:h"] == successfulDate)
        precondition(!store.busy, "Failed refresh must release busy state")
        try await store.projects("a", harness: "h")
        precondition(api.calls == 7, "Failed refresh must preserve usable cached data")
        print("Project cache: 8 behavioral checks passed")
    }
}
''')
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '6', '-parse-as-library',
                    '-module-cache-path', str(path / 'cache'), str(path / 'main.swift'),
                    '-o', str(path / 'check')], check=True)
    subprocess.run([str(path / 'check')], check=True, timeout=30)
