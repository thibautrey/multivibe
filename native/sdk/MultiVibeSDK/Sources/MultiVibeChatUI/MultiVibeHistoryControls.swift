import SwiftUI
import MultiVibeSDK

/// Account-owner UI for the official MultiVibe app. Never place a global recovery
/// prompt in an integrating application's UI.
@MainActor public struct MultiVibeHistoryControls: View {
    private let client: MultiVibeClient
    private let changed: @MainActor (MultiVibeConversation?) -> Void
    @State private var recoveryCode = ""
    @State private var busy = false
    @State private var error: String?
    @State private var discarding = false
    public init(client: MultiVibeClient, changed: @escaping @MainActor (MultiVibeConversation?) -> Void = { _ in }) {
        self.client = client; self.changed = changed
    }
    public var body: some View {
        if client.mode == .accountOwner {
            VStack(alignment: .leading, spacing: 10) {
                if !client.isHistoryUnlocked {
                    Text("Votre historique est chiffré").font(.headline)
                    Text("Saisissez votre code de récupération MultiVibe pour le lire sur cet appareil. Il reste sur cet appareil et n’est pas enregistré.").font(.caption)
                    SecureField("Code de récupération", text: $recoveryCode)
                        .autocorrectionDisabled()
                    Button("Déverrouiller") {
                        let code = recoveryCode; recoveryCode = ""
                        run { try await client.unlockHistory(recoveryCode: code); changed(nil) }
                    }.disabled(busy || recoveryCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Link("Gérer la récupération dans MultiVibe", destination: URL(string: "https://app.multivibe.cloud")!)
                } else if client.hasPendingHistoryWrite {
                    Text("Une sauvegarde reste à confirmer").font(.headline)
                    Text("Réessayer envoie la même sauvegarde chiffrée. Aucune réponse du modèle ni action de l’application ne sera relancée.").font(.caption)
                    Button("Réessayer la sauvegarde") { run { let saved = try await client.retryHistoryWrite(); changed(saved) } }.disabled(busy)
                    Button("Abandonner et recharger", role: .destructive) { discarding = true }.disabled(busy)
                }
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
                if busy { ProgressView() }
            }
            .confirmationDialog("Abandonner la sauvegarde en attente ?", isPresented: $discarding, titleVisibility: .visible) {
                Button("Abandonner et recharger", role: .destructive) { run { try await client.discardHistoryWrite(); changed(nil) } }
            } message: { Text("Les changements non reçus par MultiVibe seront perdus. Cette action n’annule pas une sauvegarde déjà reçue.") }
            .onDisappear { recoveryCode = "" }
        }
    }
    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        busy = true; error = nil
        Task { defer { busy = false }; do { try await action() } catch { self.error = error.localizedDescription } }
    }
}
