import SwiftUI
import MultiVibeSDK

@MainActor struct MultiVibeModelPicker: View {
    let client: MultiVibeClient
    @Binding var selection: String
    @Environment(\.dismiss) private var dismiss
    @State private var section = MultiVibeModelSection.cloud
    var body: some View {
        NavigationStack {
            VStack {
                Picker("Source du modèle", selection: $section) {
                    ForEach(MultiVibeModelSection.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented).padding()
                if section == .relay {
                    Text("Les modèles de vos appareils.").font(.caption)
                    if let allowance = client.relayAllowance {
                        Text(allowance.unlimited ? "Messages Relay illimités avec votre abonnement Cloud." : "\(max(0, allowance.remaining ?? 0)) / \(allowance.included) messages disponibles ce mois-ci.")
                            .font(.caption)
                    }
                    if let error = client.relayCatalogueError { Text(error).foregroundStyle(.secondary).font(.caption) }
                }
                List {
                    ForEach(client.models.filter { $0.section == section }) { model in
                        Button {
                            selection = model.id; dismiss()
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(model.displayName)
                                    if let machine = model.machineName { Text(machine).font(.caption).foregroundStyle(.secondary) }
                                    if model.available == false { Text("Hors ligne").font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer()
                                if model.id == selection { Image(systemName: "checkmark") }
                            }
                        }.disabled(model.available == false)
                    }
                    if !client.models.contains(where: { $0.section == section }) {
                        Text("Aucun modèle disponible dans cette section.").foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Choisir un modèle")
            .toolbar { Button("Fermer") { dismiss() } }
            .onAppear { section = client.models.first(where: { $0.id == selection })?.section ?? .cloud }
        }
    }
}
