import Foundation
import Security

/// Keep credentials and background work in the installed application's namespace.
/// QA builds must never adopt the production app's fixed service identifiers.
enum NativeApplicationIdentity {
    static func identifier(_ suffix: String, bundleIdentifier: String? = Bundle.main.bundleIdentifier) -> String {
        // A host without an application bundle must not default to production.
        "\(bundleIdentifier ?? "cloud.multivibe.chat.unidentified").\(suffix)"
    }
}

enum SecureStore {
    private static let service = NativeApplicationIdentity.identifier("session")
    static func save(_ session: NativeSession) throws {
        let data = try JSONEncoder().encode(session)
        let key: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                 kSecAttrService as String: service, kSecAttrAccount as String: "current"]
        let update = SecItemUpdate(key as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecItemNotFound {
            var item = key
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw APIError.invalidResponse }
        } else if update != errSecSuccess { throw APIError.invalidResponse }
    }
    static func load() -> NativeSession? {
        var item: CFTypeRef?
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "current",
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(NativeSession.self, from: data)
    }
    static func clear() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                       kSecAttrService as String: service] as CFDictionary)
    }
}
