import CryptoKit
import XCTest
@testable import MultiVibeChat

final class CloudWorkspaceArtifactStoreTests: XCTestCase {
    private func id() -> String { UUID().uuidString.lowercased() }
    private func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func testArtifactEnvelopeRejectsCrossAccountIdentityAndCorruptChunks() throws {
        let bytes = Data([0, 1, 2]), account = id()
        let identity = CloudArtifactIdentity(artifactId: id(), projectId: id(), fileId: id(), byteLength: 3, sha256: hash(bytes))
        let manifest = CloudArtifactManifest(artifactId: identity.artifactId, projectId: identity.projectId, fileId: identity.fileId, byteLength: 3, sha256: identity.sha256, chunkBytes: 262144, state: "complete", received: [0])
        XCTAssertEqual(try CloudArtifactReply(accountId: account, artifact: manifest).checked(accountId: account, expected: identity), manifest)
        XCTAssertThrowsError(try CloudArtifactReply(accountId: account, artifact: manifest).checked(accountId: id(), expected: identity))
        let wrong = CloudArtifactIdentity(artifactId: id(), projectId: identity.projectId, fileId: identity.fileId, byteLength: 3, sha256: identity.sha256)
        XCTAssertThrowsError(try manifest.checked(expected: wrong))
        let chunk = CloudArtifactChunkReply(accountId: account, chunk: .init(index: 0, data: bytes.base64EncodedString(), sha256: hash(bytes)))
        XCTAssertEqual(try chunk.checked(accountId: account, expected: identity, index: 0), bytes)
        let corrupt = CloudArtifactChunkReply(accountId: account, chunk: .init(index: 0, data: "AAAA", sha256: hash(bytes)))
        XCTAssertThrowsError(try corrupt.checked(accountId: account, expected: identity, index: 0))
        XCTAssertThrowsError(try chunk.checked(accountId: account, expected: identity, index: 1))
    }
    func testBoundedImportDownloadAndAccountIsolation() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(id(), isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("source")
        let bytes = Data((0..<270000).map { UInt8($0 % 251) })
        try bytes.write(to: source)
        let store = CloudWorkspaceArtifactStore(root: root), account = id()
        let local = try await store.importFile(accountId: account, source: source)
        XCTAssertEqual(local.byteLength, bytes.count); XCTAssertEqual(local.sha256, hash(bytes))
        let identity = CloudArtifactIdentity(artifactId: id(), projectId: id(), fileId: id(), byteLength: bytes.count, sha256: hash(bytes))
        let download = try await store.beginDownload(accountId: account, artifact: identity)
        for index in 0..<identity.chunkCount {
            let chunk = try await store.readChunk(accountId: account, file: local, index: index)
            try await store.appendDownload(accountId: account, file: download, index: index, data: chunk)
            try await store.appendDownload(accountId: account, file: download, index: index, data: chunk)
        }
        _ = try await store.finishDownload(accountId: account, file: download)
        let url = try await store.url(accountId: account, file: download)
        XCTAssertEqual(try Data(contentsOf: url), bytes)
        XCTAssertFalse(url.path.contains(account))
        do { _ = try await store.url(accountId: id(), file: local); XCTFail("Cross-account access") } catch {}
        let link = root.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: source)
        do { _ = try await store.importFile(accountId: account, source: link); XCTFail("Symlink accepted") } catch {}
        let hard = root.appendingPathComponent("hard")
        try FileManager.default.linkItem(at: source, to: hard)
        do { _ = try await store.importFile(accountId: account, source: hard); XCTFail("Hardlink accepted") } catch {}
        try await store.remove(accountId: account, file: local)
    }
    func testOversizedSparseFileAndIncompleteDownloadRejected() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(id(), isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("large")
        FileManager.default.createFile(atPath: source.path, contents: nil)
        let handle = try FileHandle(forWritingTo: source)
        try handle.truncate(atOffset: UInt64(CloudArtifactIdentity.maxFileBytes + 1)); try handle.close()
        let store = CloudWorkspaceArtifactStore(root: root), account = id()
        do { _ = try await store.importFile(accountId: account, source: source); XCTFail("Oversize accepted") } catch {}
        let identity = CloudArtifactIdentity(artifactId: id(), projectId: id(), fileId: id(), byteLength: 3, sha256: hash(Data([1, 2, 3])))
        let file = try await store.beginDownload(accountId: account, artifact: identity)
        do { _ = try await store.finishDownload(accountId: account, file: file); XCTFail("Incomplete exposed") } catch {}
        try await store.appendDownload(accountId: account, file: file, index: 0, data: Data([3, 2, 1]))
        do { _ = try await store.finishDownload(accountId: account, file: file); XCTFail("Wrong hash exposed") } catch {}
    }
}
