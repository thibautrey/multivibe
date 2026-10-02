import Foundation

/// Builds the MultiVibe-controlled Chat URL. This value contains only the
/// public application identifier; credentials and history keys stay in Safari.
public struct MultiVibeIsolatedChat: Sendable {
    public let url: URL
    public init(configuration: MultiVibeConfiguration) throws {
        guard UUID(uuidString: configuration.clientID) != nil,
              configuration.baseURL.scheme == "https",
              configuration.baseURL.user == nil,
              configuration.baseURL.password == nil,
              configuration.baseURL.query == nil,
              configuration.baseURL.fragment == nil,
              configuration.baseURL.path.isEmpty || configuration.baseURL.path == "/" else {
            throw MultiVibeError.invalidArguments
        }
        var components = URLComponents(url: configuration.baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/sdk/chat/isolated"
        components.queryItems = [URLQueryItem(name: "client_id", value: configuration.clientID.lowercased())]
        guard let value = components.url else { throw MultiVibeError.invalidArguments }
        url = value
    }
}
