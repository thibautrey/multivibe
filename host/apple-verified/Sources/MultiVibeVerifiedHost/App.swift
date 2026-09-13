// SPDX-License-Identifier: Apache-2.0
import AppKit
import AppleVerifiedCore
import CHardening
import Foundation
import Security

struct TransportMessage<P: Encodable>: Encodable { let type: String; let payload: P }

struct RuntimeConfiguration: Decodable {
    let enabled: Bool
    let hostId: String
    let cloudOrigin: URL
    let releaseDigest: String
    let modelDigest: String
    let modelDirectory: String
}

/// Transport lifecycle is owned by this app. Neither the legacy Host nor an HTTP
/// request can provide an admission lease, APNs challenge, or decrypted prompt.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var configuration: RuntimeConfiguration?
    private var runtime: MLXRuntime?
    private var identity: AppleProcessIdentity?
    private var inference: InferenceSession?
    private var connection: URLSessionWebSocketTask?
    private var apnsToken: String?
    private var sessionId: String?
    private var receiveTask: Task<Void, Never>?
    private var manifest: ModelManifest?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Task {
            do { try await start() }
            catch { await stop(); NSApplication.shared.terminate(nil) }
        }
    }

    private func start() async throws {
        #if !arch(arm64)
        throw VerifiedHostError.unavailable
        #else
        guard multivibe_harden_process() == 0, let resources = Bundle.main.resourceURL
        else { throw VerifiedHostError.unsafeProcess }
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
              SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess
        else { throw VerifiedHostError.unsafeProcess }
        let config = try Wire.decode(RuntimeConfiguration.self,
            from: Data(contentsOf: resources.appendingPathComponent("runtime.json")))
        guard config.enabled, config.cloudOrigin.scheme == "https", config.cloudOrigin.user == nil,
              config.cloudOrigin.password == nil, config.cloudOrigin.host != nil,
              config.cloudOrigin.query == nil, config.cloudOrigin.fragment == nil,
              ["", "/"].contains(config.cloudOrigin.path), Wire.validDigest(config.releaseDigest),
              Wire.validDigest(config.modelDigest), config.modelDirectory.hasPrefix("/")
        else { throw VerifiedHostError.runtimeNotQualified }
        let manifest = try Wire.decode(ModelManifest.self,
            from: Data(contentsOf: resources.appendingPathComponent("model-manifest.json")))
        let engine = try await MLXRuntime(directory: URL(fileURLWithPath: config.modelDirectory),
            manifest: manifest, manifestDigest: config.modelDigest)
        self.configuration = config; self.manifest = manifest; self.runtime = engine
        NSApplication.shared.registerForRemoteNotifications()
        #endif
    }

    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        apnsToken = token.hex
        Task {
            do { try connect() }
            catch { await stop(); NSApplication.shared.terminate(nil) }
        }
    }

    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { await stop(); NSApplication.shared.terminate(nil) }
    }

    func application(_ application: NSApplication, didReceiveRemoteNotification userInfo: [String: Any]) {
        // Challenge arrives only through NSApplication's APNs callback, never the websocket.
        guard let payload = userInfo["multivibe"], let identity, let current = connection,
              JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload), data.count <= 4096
        else { return }
        Task {
            do {
                let challenge = try Wire.decode(AppleChallenge.self, from: data)
                let response = try await identity.respond(to: challenge, now: Self.now)
                guard connection === current else { throw VerifiedHostError.bindingMismatch }
                try await send("challenge_response", payload: response, on: current)
            } catch { await stop(); NSApplication.shared.terminate(nil) }
        }
    }

    private func connect() throws {
        guard let config = configuration, let token = apnsToken, connection == nil
        else { throw VerifiedHostError.unavailable }
        var components = URLComponents(url: config.cloudOrigin, resolvingAgainstBaseURL: false)!
        components.scheme = "wss"; components.path = "/v1/apple-host/connect"
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer " + (try connectionCredential(hostId: config.hostId)), forHTTPHeaderField: "Authorization")
        request.setValue("multivibe-apple-host-session-v1", forHTTPHeaderField: "Sec-WebSocket-Protocol")
        let sessionConfig = URLSessionConfiguration.ephemeral
        sessionConfig.urlCache = nil; sessionConfig.httpCookieStorage = nil
        sessionConfig.requestCachePolicy = .reloadIgnoringLocalCacheData
        let socket = URLSession(configuration: sessionConfig).webSocketTask(with: request)
        socket.maximumMessageSize = Wire.maxEnvelopeBytes
        connection = socket; socket.resume()
        receiveTask = Task {
            do {
                try await send("apns_registration", payload: ["token": token], on: socket)
                while connection === socket {
                    let message = try await socket.receive()
                    let data: Data
                    switch message {
                    case .data(let bytes): data = bytes
                    case .string(let text): data = Data(text.utf8)
                    @unknown default: throw VerifiedHostError.invalidEnvelope
                    }
                    try await receive(data, on: socket)
                }
            } catch { await stop(); NSApplication.shared.terminate(nil) }
        }
    }

    private func receive(_ data: Data, on socket: URLSessionWebSocketTask) async throws {
        guard data.count <= Wire.maxEnvelopeBytes, connection === socket,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["type", "payload"], let type = object["type"] as? String,
              let payload = object["payload"], JSONSerialization.isValidJSONObject(payload)
        else { throw VerifiedHostError.invalidEnvelope }
        let body = try JSONSerialization.data(withJSONObject: payload)
        switch type {
        case "hello":
            struct Hello: Decodable { let hostId: String; let sessionId: String }
            let hello = try Wire.decode(Hello.self, from: body)
            guard identity == nil, let config = configuration, hello.hostId == config.hostId
            else { throw VerifiedHostError.bindingMismatch }
            let enclaveKey = try EnclaveKeyStore.loadOrCreate(account: config.hostId)
            let identity = try AppleProcessIdentity(hostId: hello.hostId, sessionId: hello.sessionId,
                releaseDigest: config.releaseDigest, modelDigest: config.modelDigest, signingKey: enclaveKey)
            self.identity = identity; self.sessionId = hello.sessionId
            try await send("binding", payload: identity.binding, on: socket)
        case "lease":
            guard let identity, let manifest, inference == nil else { throw VerifiedHostError.unavailable }
            let lease = try Wire.decode(AppleVerificationLease.self, from: body)
            self.inference = try await identity.admit(model: manifest.model, lease: lease, now: Self.now)
        case "request":
            guard let inference, let runtime else { throw VerifiedHostError.runtimeNotQualified }
            let request = try RequestEnvelope.parse(body)
            let opened = try await inference.open(request, now: Self.now)
            let output = try await runtime.execute(opened.plaintext)
            guard connection === socket, Self.now < request.expiresAt else { throw VerifiedHostError.expired }
            try await send("response", payload: opened.seal(response: output), on: socket)
        case "revoke":
            throw VerifiedHostError.unavailable
        default: throw VerifiedHostError.invalidEnvelope
        }
    }

    private func send<T: Encodable>(_ type: String, payload: T, on socket: URLSessionWebSocketTask) async throws {
        guard connection === socket else { throw VerifiedHostError.bindingMismatch }
        try await socket.send(.data(Wire.encode(TransportMessage(type: type, payload: payload))))
    }

    private func stop() async {
        let socket = connection; connection = nil
        socket?.cancel(with: .goingAway, reason: nil)
        await inference?.close(); await identity?.close()
        inference = nil; identity = nil; runtime = nil
        receiveTask?.cancel(); receiveTask = nil
    }

    private func connectionCredential(hostId: String) throws -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.multivibe.apple-verified.connection", kSecAttrAccount as String: hostId,
            kSecReturnData as String: true]
        var value: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess,
              let data = value as? Data, let token = String(data: data, encoding: .utf8),
              (32...4096).contains(token.count), token.utf8.allSatisfy({ (33...126).contains($0) })
        else { throw VerifiedHostError.unavailable }
        return token
    }

    private static var now: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

@main
struct MultiVibeVerifiedHost {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.run() }
    }
}
