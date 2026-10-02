import CryptoKit
import Darwin
import Foundation

struct CloudArtifactLocalFile: Codable, Sendable, Equatable {
    let id: String
    let byteLength: Int
    let sha256: String
}

/// Account-owned spool. The history journal stores only handles; bytes never enter history JSON.
actor CloudWorkspaceArtifactStore {
    static let shared = CloudWorkspaceArtifactStore()
    private let root: URL?
    init(root: URL? = nil) { self.root = root }

    private func directory(_ accountId: String) throws -> URL {
        guard UUID(uuidString: accountId)?.uuidString.lowercased() == accountId else { throw APIError.invalidResponse }
        let base = try root ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let components = ["MultiVibe", "HermesArtifacts", digest(Data(accountId.utf8))]
        var directory = base
        try checkDirectory(directory)
        for component in components {
            directory.appendPathComponent(component, isDirectory: true)
            if mkdir(directory.path, 0o700) != 0 && errno != EEXIST { throw CocoaError(.fileWriteUnknown) }
            try checkDirectory(directory)
            try protect(directory)
        }
        return directory
    }
    private func checkDirectory(_ url: URL) throws {
        var info = stat()
        guard lstat(url.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR else { throw APIError.invalidResponse }
    }
    private func protect(_ url: URL) throws {
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete, .posixPermissions: url.hasDirectoryPath ? 0o700 : 0o600], ofItemAtPath: url.path)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var target = url; try target.setResourceValues(values)
    }
    private func path(_ account: String, _ file: CloudArtifactLocalFile, partial: Bool = false) throws -> URL {
        guard UUID(uuidString: file.id)?.uuidString.lowercased() == file.id,
              (0...CloudArtifactIdentity.maxFileBytes).contains(file.byteLength),
              file.sha256.count == 64, file.sha256.allSatisfy({ "0123456789abcdef".contains($0) }) else { throw APIError.invalidResponse }
        return try directory(account).appendingPathComponent(file.id + (partial ? ".part" : ".bin"))
    }
    private func opened(_ url: URL, flags: Int32) throws -> FileHandle {
        let descriptor = open(url.path, flags | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw CocoaError(.fileReadUnknown) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_nlink == 1,
              info.st_size >= 0, info.st_size <= CloudArtifactIdentity.maxFileBytes else {
            close(descriptor); throw APIError.invalidResponse
        }
        return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }
    private func syncDirectory(_ directory: URL) throws {
        let descriptor = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { close(descriptor) }
        guard fsync(descriptor) == 0 else { throw CocoaError(.fileWriteUnknown) }
    }
    private func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func verified(_ handle: FileHandle, file: CloudArtifactLocalFile) throws {
        try handle.seek(toOffset: 0)
        var sha = SHA256(), count = 0
        while let bytes = try handle.read(upToCount: CloudArtifactIdentity.chunkBytes), !bytes.isEmpty {
            count += bytes.count
            guard count <= file.byteLength else { throw APIError.invalidResponse }
            sha.update(data: bytes)
        }
        guard count == file.byteLength, sha.finalize().map({ String(format: "%02x", $0) }).joined() == file.sha256 else { throw APIError.invalidResponse }
    }

    /// Caller keeps security-scoped access active until this bounded copy finishes.
    func importFile(accountId: String, source: URL) throws -> CloudArtifactLocalFile {
        guard source.isFileURL else { throw APIError.invalidResponse }
        let input = try opened(source, flags: O_RDONLY)
        defer { try? input.close() }
        let id = UUID().uuidString.lowercased()
        let folder = try directory(accountId)
        let temporary = folder.appendingPathComponent(id + ".part")
        let destination = folder.appendingPathComponent(id + ".bin")
        let output = try opened(temporary, flags: O_WRONLY | O_CREAT | O_EXCL)
        var published = false
        defer { try? output.close(); if !published { try? FileManager.default.removeItem(at: temporary) } }
        try protect(temporary)
        var sha = SHA256(), count = 0
        while let bytes = try input.read(upToCount: CloudArtifactIdentity.chunkBytes), !bytes.isEmpty {
            try Task.checkCancellation()
            count += bytes.count
            guard count <= CloudArtifactIdentity.maxFileBytes else { throw APIError.invalidResponse }
            sha.update(data: bytes); try output.write(contentsOf: bytes)
        }
        try output.synchronize(); try output.close()
        try FileManager.default.moveItem(at: temporary, to: destination)
        published = true
        try syncDirectory(folder)
        return .init(id: id, byteLength: count, sha256: sha.finalize().map { String(format: "%02x", $0) }.joined())
    }
    func readChunk(accountId: String, file: CloudArtifactLocalFile, index: Int) throws -> Data {
        let identity = CloudArtifactIdentity(artifactId: file.id, projectId: file.id, fileId: file.id, byteLength: file.byteLength, sha256: file.sha256)
        let size = try identity.chunkLength(index)
        let input = try opened(path(accountId, file), flags: O_RDONLY)
        defer { try? input.close() }
        try input.seek(toOffset: UInt64(index * CloudArtifactIdentity.chunkBytes))
        guard let bytes = try input.read(upToCount: size), bytes.count == size else { throw APIError.invalidResponse }
        return bytes
    }
    func beginDownload(accountId: String, artifact: CloudArtifactIdentity) throws -> CloudArtifactLocalFile {
        try artifact.validate()
        let file = CloudArtifactLocalFile(id: UUID().uuidString.lowercased(), byteLength: artifact.byteLength, sha256: artifact.sha256)
        let target = try path(accountId, file, partial: true)
        let output = try opened(target, flags: O_WRONLY | O_CREAT | O_EXCL)
        defer { try? output.close() }
        do { try protect(target); try output.synchronize() }
        catch { try? FileManager.default.removeItem(at: target); throw error }
        return file
    }
    func appendDownload(accountId: String, file: CloudArtifactLocalFile, index: Int, data: Data) throws {
        let identity = CloudArtifactIdentity(artifactId: file.id, projectId: file.id, fileId: file.id, byteLength: file.byteLength, sha256: file.sha256)
        guard data.count == (try identity.chunkLength(index)) else { throw APIError.invalidResponse }
        let output = try opened(path(accountId, file, partial: true), flags: O_RDWR)
        defer { try? output.close() }
        let offset = UInt64(index * CloudArtifactIdentity.chunkBytes)
        let current = try output.seekToEnd()
        guard current == offset || current >= offset + UInt64(data.count) else { throw APIError.invalidResponse }
        try output.seek(toOffset: offset)
        if current > offset {
            guard try output.read(upToCount: data.count) == data else { throw APIError.invalidResponse }
        } else { try output.write(contentsOf: data); try output.synchronize() }
    }
    func finishDownload(accountId: String, file: CloudArtifactLocalFile) throws -> CloudArtifactLocalFile {
        let source = try path(accountId, file, partial: true)
        let destination = try path(accountId, file)
        if FileManager.default.fileExists(atPath: destination.path) {
            _ = try url(accountId: accountId, file: file)
            if unlink(source.path) != 0 && errno != ENOENT { throw CocoaError(.fileWriteUnknown) }
            try syncDirectory(destination.deletingLastPathComponent())
            return file
        }
        let input = try opened(source, flags: O_RDONLY)
        defer { try? input.close() }
        try verified(input, file: file)
        try FileManager.default.moveItem(at: source, to: destination)
        try syncDirectory(destination.deletingLastPathComponent())
        return file
    }
    func url(accountId: String, file: CloudArtifactLocalFile) throws -> URL {
        let target = try path(accountId, file)
        let input = try opened(target, flags: O_RDONLY)
        defer { try? input.close() }
        try verified(input, file: file)
        return target
    }
    func remove(accountId: String, file: CloudArtifactLocalFile) throws {
        for partial in [false, true] {
            let target = try path(accountId, file, partial: partial)
            if unlink(target.path) != 0 && errno != ENOENT { throw CocoaError(.fileWriteUnknown) }
        }
    }
}
