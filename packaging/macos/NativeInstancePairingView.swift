import AppKit
import SwiftUI
import CoreImage.CIFilterBuiltins

/// Only this ephemeral sheet displays a handoff. It is never copied to history,
/// diagnostics, a browser URL, a persisted preference or analytics.
struct NativeInstancePairingView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var agent: NativeChatAgentCoordinator
    @State private var status: HarnessJSON = .null
    @State private var handoff: HarnessJSON = .null
    @State private var error: String?
    @State private var busy = false
    private func call(_ path: String = "", method: String = "GET", body: HarnessJSON? = nil) async throws -> HarnessJSON {
        guard let app = NSApp.delegate as? MultiVibeMenuBarApp,
              var request = app.authorizedRequest(path: "/admin/instance-relay/v1" + path, method: method) else { throw DesktopHarnessError.invalidResponse }
        request.timeoutInterval = 30
        if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "content-type") }
        let config = URLSessionConfiguration.ephemeral
        let session = URLSession(configuration: config, delegate: InstancePairingNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard data.count <= 1_048_576, let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw DesktopHarnessError.rejected("Le Host a refusé l’opération. Vérifiez le compte et la connexion Relay.") }
        return try JSONDecoder().decode(HarnessJSON.self, from: data)
    }
    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }; busy = true; error = nil
        Task { defer { busy = false }; do { try await action() } catch { self.error = error.localizedDescription } }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Utiliser ce Mac depuis votre iPhone").font(.title2.bold())
            Text("Connectez le même compte MultiVibe sur l’iPhone, puis ouvrez Compte → Instances → Scanner. Vos harness s’exécutent sur ce Mac, avec leurs autorisations habituelles.")
            if status["connected"] == .bool(true) {
                Label(status["running"] == .bool(true) ? "Relay connecté" : "Connexion Relay en cours", systemImage: "network")
                if let uri = handoff["uri"].string, let image = qr(uri) {
                    HStack(spacing: 20) {
                        Image(nsImage: image).interpolation(.none).resizable().scaledToFit().frame(width: 220, height: 220).padding(10).background(.white)
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Code manuel").font(.caption)
                            Text(handoff["code"].string ?? "").font(.title3.monospaced())
                            Text("Usage unique · 5 minutes · même compte").font(.caption).foregroundStyle(.secondary)
                            Text("Le code expire aussi dès son utilisation ou sa fermeture.").font(.caption)
                        }
                    }
                }
                Button("Afficher un nouveau code") { perform { handoff = try await call("/pairing", method: "POST", body: .object([:])) } }
                    .disabled(status["running"] != .bool(true))
                ForEach(status["devices"].array, id: \.display) { device in
                    HStack { Text(device["name"].string ?? "iPhone"); Spacer(); Button("Révoquer") { perform { status = try await call("/devices/" + (device["id"].string ?? ""), method: "DELETE") } } }
                }
                Button("Désactiver l’accès distant", role: .destructive) { perform {
                    let (token, _) = try await agent.instanceAuthorization()
                    _ = try await call("/disconnect", method: "POST", body: .object(["accessToken": .string(token)])); status = .null; handoff = .null
                } }
            } else {
                Button("Activer l’accès depuis mon compte") { perform {
                    let (token, account) = try await agent.instanceAuthorization()
                    status = try await call("/connect", method: "POST", body: .object(["accessToken": .string(token), "accountId": .string(account), "name": .string(Host.current().localizedName ?? "Mon Mac")]))
                } }.buttonStyle(.borderedProminent)
            }
            Text("Transport HTTPS sortant via MultiVibe Relay. Les échanges utilisent le quota Relay du compte. Le Cloud peut lire le contenu transitoire du transport.").font(.caption).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red) }
            HStack { if busy { ProgressView().controlSize(.small) }; Spacer(); Button("Fermer") { dismiss() }.keyboardShortcut(.cancelAction) }
        }.padding(24).frame(width: 620).disabled(busy)
        .task { while !Task.isCancelled { do { status = try await call() } catch { self.error = error.localizedDescription }; try? await Task.sleep(for: .seconds(2)) } }
        .onDisappear { handoff = .null; Task { _ = try? await call("/pairing", method: "DELETE") } }
    }
    private func qr(_ value: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator(); filter.message = Data(value.utf8); filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)), let image = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: output.extent.width, height: output.extent.height))
    }
}
private final class InstancePairingNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
