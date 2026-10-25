import Foundation

@main struct NativeChatFileImportHarness {
    static func main() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        func file(_ name: String, _ data: Data) throws -> URL {
            let url = folder.appendingPathComponent(name)
            try data.write(to: url)
            return url
        }
        func reject(_ urls: [URL], draft: String = "Brouillon") {
            do {
                _ = try NativeChatFileImport.appending(urls, to: draft)
                fatalError("Expected import rejection")
            } catch { }
        }
        let first = try file("premier.txt", Data("Été".utf8))
        let second = try file("second.json", Data("{\"ok\":true}".utf8))
        let imported = try NativeChatFileImport.appending([first, second], to: "Brouillon")
        precondition(imported == "Brouillon\n\nDocument : premier.txt\nÉté\n\nDocument : second.json\n{\"ok\":true}")
        let unchanged = try NativeChatFileImport.appending([], to: "Brouillon")
        precondition(unchanged == "Brouillon")
        reject([folder])
        reject([URL(string: "https://example.com/file.txt")!])
        reject([try file("binary.png", Data([0x89, 0x50, 0xff]))])
        reject([try file("binary.dat", Data([65, 0, 66]))])
        reject([try file("large.txt", Data(repeating: 65, count: 100_001))])
        reject([first], draft: String(repeating: "a", count: 32_000))
        let full = try file("full.txt", Data(repeating: 65, count: 16_000))
        reject([full, full])
        let original = "Brouillon préservé"
        reject([first, folder], draft: original)
        precondition(original == "Brouillon préservé")
        print("PASS ordered multi-file import, draft preservation, invalid files and size limits")
    }
}
