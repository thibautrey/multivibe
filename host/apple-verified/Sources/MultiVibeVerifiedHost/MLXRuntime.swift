// SPDX-License-Identifier: Apache-2.0
import AppleVerifiedCore
import CryptoKit
import Foundation
import MLX
import MLXLLM
import MLXLMCommon

/// Signed-bundle metadata; approved remotely through the release/model allowlist.
struct ModelManifest: Codable {
    let model: String
    let files: [String: String]
}

struct ChatInput: Decodable {
    struct Message: Decodable { let role: String; let content: String }
    let messages: [Message]
    let maxTokens: Int
}

/// No HTTP adapter, Python process, tool execution, prompt log or disk conversation cache.
actor MLXRuntime {
    private let container: ModelContainer
    private var executing = false

    init(directory: URL, manifest: ModelManifest, manifestDigest: String) async throws {
        let manifestBytes = try Wire.encode(manifest)
        guard Data(SHA256.hash(data: manifestBytes)).hex == manifestDigest,
              !manifest.files.isEmpty, manifest.files.count <= 1024,
              manifest.files["config.json"] != nil, manifest.files["tokenizer.json"] != nil,
              manifest.files["tokenizer_config.json"] != nil
        else { throw VerifiedHostError.unsafeModel }
        try Self.verify(directory: directory, manifest: manifest)
        self.container = try await LLMModelFactory.shared.loadContainer(configuration: .init(directory: directory))
        // Recheck after loading: a changed local model never reaches the admission path.
        try Self.verify(directory: directory, manifest: manifest)
    }

    private static func verify(directory: URL, manifest: ModelManifest) throws {
        let base = directory.standardizedFileURL
        guard base.isFileURL, base.resolvingSymlinksInPath() == base else { throw VerifiedHostError.unsafeModel }
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .isSymbolicLinkKey, .isDirectoryKey]
        guard let enumerator = FileManager.default.enumerator(at: base, includingPropertiesForKeys: Array(keys))
        else { throw VerifiedHostError.unsafeModel }
        var found = Set<String>()
        for case let file as URL in enumerator {
            let values = try file.resourceValues(forKeys: keys)
            guard values.isSymbolicLink != true else { throw VerifiedHostError.unsafeModel }
            if values.isDirectory == true { continue }
            let relative = String(file.path.dropFirst(base.path.count + 1))
            guard values.isRegularFile == true, let expected = manifest.files[relative], Wire.validDigest(expected)
            else { throw VerifiedHostError.unsafeModel }
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            var hasher = SHA256()
            while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty { hasher.update(data: chunk) }
            guard Data(hasher.finalize()).hex == expected else { throw VerifiedHostError.unsafeModel }
            found.insert(relative)
        }
        guard found == Set(manifest.files.keys) else { throw VerifiedHostError.unsafeModel }
    }

    func execute(_ plaintext: Data) async throws -> Data {
        guard !executing, plaintext.count <= 256 * 1024 else { throw VerifiedHostError.unavailable }
        executing = true
        defer { executing = false; GPU.clearCache() }
        let input = try Wire.decode(ChatInput.self, from: plaintext)
        guard !input.messages.isEmpty, input.messages.count <= 128,
              (1...2048).contains(input.maxTokens), input.messages.allSatisfy({
                  ["system", "user", "assistant"].contains($0.role) && $0.content.utf8.count <= 65536
              }) else { throw VerifiedHostError.invalidEnvelope }
        let messages: [[String: any Sendable]] = input.messages.map { ["role": $0.role, "content": $0.content] }
        let prepared = try await container.prepare(input: UserInput(messages: messages))
        let stream = try await container.generate(input: prepared,
            parameters: GenerateParameters(maxTokens: input.maxTokens, temperature: 0))
        var output = ""
        for await generation in stream {
            try Task.checkCancellation()
            if case .chunk(let text) = generation { output += text }
            guard output.utf8.count <= 512 * 1024 else { throw VerifiedHostError.invalidEnvelope }
        }
        struct Output: Encodable { let content: String }
        return try Wire.encode(Output(content: output))
    }
}
