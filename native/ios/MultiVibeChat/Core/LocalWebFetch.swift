import Foundation

enum ConversationInternetPermission: String, Codable, Sendable {
    case allowed, denied
}

struct InternetApprovalRequest: Identifiable {
    let id = UUID()
    let conversation: UUID
    let url: URL
}

struct LocalWebResponse: Sendable {
    var url: URL
    var status: Int
    var contentType: String
    var text: String
}

enum LocalWebError: LocalizedError {
    case invalidURL, denied, unsupportedContent, tooLarge
    var errorDescription: String? {
        switch self {
        case .invalidURL: "Utilisez une URL HTTPS publique, sans identifiant ni mot de passe."
        case .denied: "L’accès à Internet a été refusé pour cette conversation. Continuez avec les outils hors ligne."
        case .unsupportedContent: "Ce contenu ne peut pas être lu comme une page web, du texte ou du JSON."
        case .tooLarge: "Cette page dépasse la limite de lecture de 256 Ko."
        }
    }
}

/// A native, read-only HTTP client rather than a shell. No account cookies,
/// authorization headers, credentials, JavaScript, or arbitrary curl flags.
enum LocalWebFetch {
    static let maximumBytes = 262_144
    static func validatedURL(_ raw: String) throws -> URL {
        guard raw.utf8.count <= 4096, let parts = URLComponents(string: raw),
              parts.scheme?.lowercased() == "https", parts.user == nil, parts.password == nil,
              parts.port == nil || parts.port == 443,
              let host = parts.host?.lowercased(), host.contains("."),
              !host.hasSuffix("."), !host.contains(":"),
              !host.allSatisfy({ $0.isNumber || $0 == "." }),
              !["localhost", "local", "internal", "lan", "home", "test", "invalid"].contains(host.split(separator: ".").last.map(String.init) ?? ""),
              let url = parts.url else { throw LocalWebError.invalidURL }
        return url
    }
    static func fetch(url: URL, method: String) async throws -> LocalWebResponse {
        let url = try validatedURL(url.absoluteString)
        guard ["GET", "HEAD"].contains(method) else { throw LocalAgentError.invalidInput }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 30
        let session = URLSession(configuration: configuration, delegate: PublicWebRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("MultiVibe-Local/1.0", forHTTPHeaderField: "User-Agent")
        request.setValue("text/html,text/plain,application/json,application/xml;q=0.9", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse, let finalURL = response.url else { throw APIError.invalidResponse }
        _ = try validatedURL(finalURL.absoluteString)
        let contentType = response.mimeType?.lowercased() ?? ""
        if method == "HEAD" {
            return LocalWebResponse(url: finalURL, status: response.statusCode, contentType: contentType, text: "Content-Type: \(contentType)\nContent-Length: \(response.expectedContentLength)")
        }
        guard contentType.hasPrefix("text/") || contentType.contains("json") || contentType.contains("xml") else { throw LocalWebError.unsupportedContent }
        guard response.expectedContentLength <= Int64(maximumBytes) else { throw LocalWebError.tooLarge }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < maximumBytes else { throw LocalWebError.tooLarge }
            data.append(byte)
        }
        guard let raw = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else { throw LocalWebError.unsupportedContent }
        let text = contentType.contains("html") ? readableHTML(raw) : raw
        return LocalWebResponse(url: finalURL, status: response.statusCode, contentType: contentType, text: text)
    }
    static func readableHTML(_ html: String) -> String {
        var text = html.replacingOccurrences(of: #"(?is)<(script|style|noscript)\b[^>]*>.*?</\1\s*>"#, with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?s)<!--.*?-->"#, with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: #"<[^>]+>"#, with: " ", options: .regularExpression)
        for (entity, value) in [("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'")] {
            text = text.replacingOccurrences(of: entity, with: value)
        }
        return text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private final class PublicWebRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var redirects = 0
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        lock.lock(); redirects += 1; let count = redirects; lock.unlock()
        guard count <= 5, let url = request.url, (try? LocalWebFetch.validatedURL(url.absoluteString)) != nil else {
            completionHandler(nil); return
        }
        completionHandler(request)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        // Preserve normal TLS verification; never use saved HTTP authentication.
        completionHandler(challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
    }
}
