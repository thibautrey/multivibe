import Foundation
import CryptoKit
import Security

public struct MultiVibeAuthorization: Sendable {
    public let state: String
    public let verifier: String
    public let configuration: MultiVibeConfiguration
    public init(configuration: MultiVibeConfiguration) throws {
        self.configuration = configuration
        func random() throws -> String {
            var bytes = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw MultiVibeError.invalidResponse }
            return Data(bytes).base64URLEncoded
        }
        state = try random(); verifier = try random()
    }
    public func url(broker: Bool) -> URL {
        var url = URLComponents(url: configuration.baseURL.appending(path: broker ? "/sdk/authorize" : "/developers/oauth/authorize"), resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "client_id", value: configuration.clientID), URLQueryItem(name: "redirect_uri", value: configuration.redirectURI.absoluteString), URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "state", value: state), URLQueryItem(name: "code_challenge_method", value: "S256"), URLQueryItem(name: "code_challenge", value: Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded), URLQueryItem(name: "scope", value: "models:read chat:write conversations:read conversations:write")]
        return url.url!
    }
    public func code(from url: URL) throws -> String {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false), let expected = URLComponents(url: configuration.redirectURI, resolvingAgainstBaseURL: false), components.scheme == expected.scheme, components.host == expected.host, components.port == expected.port, components.path == expected.path, components.user == nil, components.password == nil, components.fragment == nil else { throw MultiVibeError.invalidCallback }
        let items = components.queryItems ?? []
        guard items.filter({ $0.name == "state" }).count == 1, items.first(where: {$0.name == "state"})?.value == state, items.filter({$0.name == "code"}).count == 1, let code = items.first(where: {$0.name == "code"})?.value, !code.isEmpty, !items.contains(where: {$0.name == "error"}) else { throw MultiVibeError.invalidCallback }
        return code
    }
}
extension Data { var base64URLEncoded: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") } }
struct StoredSession: Codable { var accessToken: String; var refreshToken: String; var expiresAt: Date }
struct SDKKeychain {
    let service: String
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "session"] }
    func load() throws -> StoredSession? {
        var q = query; q[kSecReturnData as String] = true
        var result: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw MultiVibeError.authenticationRequired }
        return try JSONDecoder().decode(StoredSession.self, from: data)
    }
    func save(_ value: StoredSession) throws {
        let data = try JSONEncoder().encode(value)
        let result = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if result == errSecItemNotFound {
            var q = query; q[kSecValueData as String] = data; q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw MultiVibeError.authenticationRequired }
        } else if result != errSecSuccess { throw MultiVibeError.authenticationRequired }
    }
    func clear() { SecItemDelete(query as CFDictionary) }
}
final class SDKTransportDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
