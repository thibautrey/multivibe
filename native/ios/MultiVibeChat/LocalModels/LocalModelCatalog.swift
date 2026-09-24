import Foundation
import CryptoKit
import os

enum ModelExecution: Equatable, Sendable {
    case remote, apple, downloaded
    init(_ id: String) {
        self = id == LocalModel.id ? .apple : id.hasPrefix("device-gguf:") ? .downloaded : .remote
    }
    var isLocal: Bool { self != .remote }
}

struct DownloadableModel: Codable, Identifiable, Equatable, Sendable {
    let repository: String
    let revision: String
    let filename: String
    let name: String
    let publisher: String
    let bytes: Int64
    let sha256: String
    let license: String
    let architecture: String
    let layers: Int
    let kvHeads: Int
    let headSize: Int
    var validatedDevices: [String] = []
    var toolsValidated: Bool = false
    var id: String { "device-gguf:" + repository + "/" + filename + "@" + revision }
    var key: String { SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined() }
    var url: URL {
        var url = URL(string: "https://huggingface.co")!
        for component in repository.split(separator: "/") { url.appendPathComponent(String(component)) }
        url.appendPathComponent("resolve"); url.appendPathComponent(revision)
        for component in filename.split(separator: "/") { url.appendPathComponent(String(component)) }
        return url
    }
    var option: ModelOption { ModelOption(id: id, name: name, author: publisher,
        description: "Conversation privée sur cet appareil, même sans Internet.") }
    var estimatedMemory: UInt64 {
        // F16 K/V at a fixed 4096-token context + weights + graph/Metal/scratch headroom.
        UInt64(max(0, bytes)) + UInt64(max(0, layers * kvHeads * headSize)) * 4096 * 4 + 512 * 1024 * 1024
    }
    var sizeLabel: String { ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file) }
}

struct LocalDeviceBudget: Sendable {
    let memory: UInt64
    let disk: Int64
    static var current: Self {
        let physical = ProcessInfo.processInfo.physicalMemory
        let ceiling = min(UInt64(Double(physical) * 0.6), physical > 1_500_000_000 ? physical - 1_500_000_000 : 0)
        let available = UInt64(os_proc_available_memory())
        let disk = (try? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage) ?? 0
        return Self(memory: min(ceiling, available), disk: disk)
    }
    func problem(_ model: DownloadableModel, downloading: Bool) -> String? {
        guard ["qwen3", "llama", "gemma3", "qwen2"].contains(model.architecture),
              model.layers > 0, model.kvHeads > 0, model.headSize > 0,
              model.bytes > 0, model.sha256.count == 64 else { return "Compatibilité non vérifiée pour ce modèle." }
        guard model.estimatedMemory <= memory else { return "Ce modèle nécessite plus de mémoire que cet appareil n’en a de disponible." }
        // Reserve staging plus final file space. Conservative because recovery may require copying.
        if downloading && disk < model.bytes * 2 + 512_000_000 { return "Espace insuffisant. Libérez du stockage puis réessayez." }
        return nil
    }
}

struct LocalCatalogPage: Sendable { let models: [DownloadableModel]; let next: URL? }
protocol LocalCatalogProviding: Sendable {
    func search(_ query: String, next: URL?) async throws -> LocalCatalogPage
}

actor HuggingFaceCatalog: LocalCatalogProviding {
    static let shared = HuggingFaceCatalog()
    private let session: URLSession
    init(session: URLSession = .shared) { self.session = session }
    static var bundled: [DownloadableModel] {
        guard let url = Bundle.main.url(forResource: "LocalModelManifest", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([DownloadableModel].self, from: data)) ?? []
    }
    func search(_ query: String, next: URL? = nil) async throws -> LocalCatalogPage {
        var components = URLComponents(string: "https://huggingface.co/api/models")!
        components.queryItems = [.init(name: "search", value: query), .init(name: "filter", value: "gguf"),
                                .init(name: "sort", value: "downloads"), .init(name: "direction", value: "-1"),
                                .init(name: "limit", value: "12")]
        let url = next ?? components.url!
        guard url.scheme == "https", url.host == "huggingface.co", url.path == "/api/models" else { throw URLError(.badURL) }
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw URLError(.badServerResponse) }
        struct Entry: Decodable { let id: String; let gated: Gated?; let `private`: Bool? }
        enum Gated: Decodable { case yes, no
            init(from decoder: Decoder) throws {
                let c = try decoder.singleValueContainer()
                self = (try? c.decode(Bool.self)) == false ? .no : .yes
            }
        }
        let entries = try JSONDecoder().decode([Entry].self, from: data)
        var result: [DownloadableModel] = []
        // Bounded sequential metadata fetch avoids HF throttling and honours cancellation.
        for entry in entries where entry.private != true {
            try Task.checkCancellation()
            if case .yes = entry.gated { continue }
            if let model = try? await resolve(entry.id) { result.append(model) }
        }
        let link = http.value(forHTTPHeaderField: "Link") ?? ""
        let nextPart = link.split(separator: ",").first { $0.contains("rel=\"next\"") }
        let nextURL = nextPart.flatMap { part -> URL? in
            guard let start = part.firstIndex(of: "<"), let end = part.firstIndex(of: ">") else { return nil }
            return URL(string: String(part[part.index(after: start)..<end]))
        }
        return LocalCatalogPage(models: result, next: nextURL)
    }
    func resolve(_ repository: String) async throws -> DownloadableModel {
        guard repository.split(separator: "/").count == 2 else { throw URLError(.badURL) }
        let url = URL(string: "https://huggingface.co/api/models/\(repository)?blobs=true")!
        let (data, response) = try await session.data(from: url)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              root["private"] as? Bool != true,
              root["gated"] as? Bool == false,
              let revision = root["sha"] as? String,
              let files = root["siblings"] as? [[String: Any]] else { throw URLError(.cannotParseResponse) }
        // Never expose split files, projectors, or a technical file selector.
        let candidates = files.filter { file in
            let name = (file["rfilename"] as? String ?? "").lowercased()
            return name.hasSuffix(".gguf") && name.contains("q4_k_m") && !name.contains("mmproj") && !name.contains("-of-")
        }
        guard let file = candidates.sorted(by: { ($0["rfilename"] as? String ?? "") < ($1["rfilename"] as? String ?? "") }).first,
              let filename = file["rfilename"] as? String, let lfs = file["lfs"] as? [String: Any],
              let bytes = lfs["size"] as? Int64, let hash = lfs["sha256"] as? String else { throw URLError(.cannotParseResponse) }
        // Inspect GGUF metadata instead of guessing memory from the repository name.
        var request = URLRequest(url: URL(string: "https://huggingface.co/\(repository)/resolve/\(revision)/\(filename)")!)
        request.setValue("bytes=0-1048575", forHTTPHeaderField: "Range")
        let header = try await LimitedModelHeader.fetch(request)
        let info = try GGUFHeader.read(header)
        let card = root["cardData"] as? [String: Any]
        return DownloadableModel(repository: repository, revision: revision, filename: filename,
            name: repository.split(separator: "/").last.map(String.init)?.replacingOccurrences(of: "-GGUF", with: "") ?? repository,
            publisher: String(repository.split(separator: "/")[0]), bytes: bytes, sha256: hash,
            license: card?["license"] as? String ?? "Voir la licence du modèle", architecture: info.architecture,
            layers: info.layers, kvHeads: info.kvHeads, headSize: info.headSize)
    }
}

// A capped stream prevents a server ignoring Range from downloading multi-GB weights during search.
enum LimitedModelHeader {
    static func fetch(_ request: URLRequest) async throws -> Data {
        let (stream, response) = try await URLSession.shared.bytes(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 206 else { throw URLError(.badServerResponse) }
        var data = Data(); data.reserveCapacity(1_048_576)
        for try await byte in stream { data.append(byte); if data.count >= 1_048_576 { break } }
        return data
    }
}

enum GGUFHeader {
    struct Info { let architecture: String; let layers: Int; let kvHeads: Int; let headSize: Int }
    static func read(_ data: Data) throws -> Info {
        var offset = 0
        func number(_ count: Int) throws -> UInt64 {
            guard count <= 8, offset + count <= data.count else { throw URLError(.cannotParseResponse) }
            defer { offset += count }
            return (0..<count).reduce(UInt64(0)) { $0 | UInt64(data[offset + $1]) << (8 * $1) }
        }
        func string() throws -> String {
            let count = try number(8)
            guard count <= 1_048_576, offset + Int(count) <= data.count else { throw URLError(.cannotParseResponse) }
            defer { offset += Int(count) }
            return String(decoding: data[offset..<offset + Int(count)], as: UTF8.self)
        }
        func value(_ type: UInt64, depth: Int = 0) throws -> String? {
            guard depth < 2 else { throw URLError(.cannotParseResponse) }
            switch type {
            case 0, 1, 7: return String(try number(1))
            case 2, 3: return String(try number(2))
            case 4, 5: return String(try number(4))
            case 6: _ = try number(4); return nil
            case 8: return try string()
            case 9:
                let subtype = try number(4), count = try number(8)
                guard count < 1_000_000 else { throw URLError(.cannotParseResponse) }
                for _ in 0..<count { _ = try value(subtype, depth: depth + 1) }; return nil
            case 10, 11, 12: _ = try number(8); return nil
            default: throw URLError(.cannotParseResponse)
            }
        }
        guard try number(4) == 0x46554747, try number(4) == 3 else { throw URLError(.cannotParseResponse) }
        _ = try number(8); let count = try number(8)
        guard count < 100_000 else { throw URLError(.cannotParseResponse) }
        var values: [String: String] = [:]
        for _ in 0..<count {
            let key = try string(), type = try number(4)
            if let val = try value(type) { values[key] = val }
            if let architecture = values["general.architecture"],
               let layers = values[architecture + ".block_count"].flatMap(Int.init),
               let kv = values[architecture + ".attention.head_count_kv"].flatMap(Int.init),
               let heads = values[architecture + ".attention.head_count"].flatMap(Int.init), heads > 0,
               let embedding = values[architecture + ".embedding_length"].flatMap(Int.init) {
                let headSize = values[architecture + ".attention.key_length"].flatMap(Int.init) ?? embedding / heads
                guard layers > 0, layers < 1024, kv > 0, kv < 1024, headSize > 0, headSize < 16384 else { throw URLError(.cannotParseResponse) }
                return Info(architecture: architecture, layers: layers, kvHeads: kv, headSize: headSize)
            }
        }
        throw URLError(.cannotParseResponse)
    }
}
