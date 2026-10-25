import Foundation

/// Shared by the file picker and Finder drops. A failed batch never replaces the draft.
enum NativeChatFileImport {
    private struct ImportError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static func appending(_ urls: [URL], to draft: String) throws -> String {
        var combined = draft
        for url in urls {
            guard url.isFileURL else {
                throw ImportError(message: "Déposez un fichier local.")
            }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values.isRegularFile == true else {
                throw ImportError(message: "\(url.lastPathComponent) : les dossiers ne sont pas pris en charge.")
            }
            guard let size = values.fileSize, size <= 100_000 else {
                throw ImportError(message: "\(url.lastPathComponent) dépasse la limite de 100 Ko.")
            }
            // Bound the read even if the file grows after the metadata check.
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let data = try handle.read(upToCount: 100_001) ?? Data()
            guard data.count <= 100_000 else {
                throw ImportError(message: "\(url.lastPathComponent) dépasse la limite de 100 Ko.")
            }
            guard let text = String(data: data, encoding: .utf8), !text.contains("\0") else {
                throw ImportError(message: "\(url.lastPathComponent) : seuls les documents texte UTF-8 sont pris en charge pour le moment.")
            }
            combined += "\n\nDocument : \(url.lastPathComponent)\n\(text)"
            guard combined.count <= 32_000 else {
                throw ImportError(message: "Le message avec ses documents dépasse la limite de 32 000 caractères.")
            }
        }
        return combined
    }
}
