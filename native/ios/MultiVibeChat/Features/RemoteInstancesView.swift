import SwiftUI
import VisionKit
import UIKit

struct RemoteInstancesView: View {
    @Environment(ConversationManager.self) private var manager
    @Environment(\.dismiss) private var dismiss
    @State private var instances = RemoteInstances.shared
    @State private var scanning = false
    @State private var code = ""
    @State private var selectedMachine = ""
    @State private var confirming: RemotePairing?
    @State private var failure: String?
    var body: some View {
        NavigationStack {
            List {
                if manager.session == nil {
                    ContentUnavailableView("Connectez votre compte", systemImage: "person.crop.circle", description: Text("Utilisez le même compte MultiVibe sur votre iPhone et votre Mac."))
                    Button("Se connecter") { manager.authenticationPresented = true; dismiss() }
                } else {
                    Section {
                        ForEach(instances.machines) { machine in
                            NavigationLink { RemoteMachineView(machine: machine, openChat: { dismiss() }) } label: {
                                HStack {
                                    Image(systemName: "desktopcomputer").font(.title2)
                                    VStack(alignment: .leading) {
                                        Text(machine.name)
                                        Text(machine.online ? machine.supportsHarness ? "Harness disponibles" : "Instance sans passerelle de harness" : "Indisponible · hors ligne").font(.caption).foregroundStyle(machine.online ? Color.secondary : .orange)
                                    }
                                    Spacer()
                                    if instances.paired.contains(machine.id) { Image(systemName: "checkmark.shield.fill").foregroundStyle(.green) }
                                }
                            }.accessibilityIdentifier("remoteInstanceRow")
                        }
                        if instances.machines.isEmpty { Text("Sur le Mac, ouvrez Actions → Connecter un iPhone à ce Mac, puis activez l’accès.").foregroundStyle(.secondary) }
                    } header: { Text("Instances de votre compte") } footer: { Text("L’exécution reste sur l’instance choisie. Vos modèles et conversations sur l’iPhone restent accessibles en fermant cet écran.") }
                    Section("Appairer une instance") {
                        Button("Scanner le QR du Mac", systemImage: "qrcode.viewfinder") { scanning = true }
                            .disabled(!DataScannerViewController.isSupported || !DataScannerViewController.isAvailable)
                            .accessibilityIdentifier("scanRemoteInstance")
                        Picker("Instance", selection: $selectedMachine) {
                            Text("Choisir une instance").tag("")
                            ForEach(instances.machines.filter { $0.supportsHarness }) { Text($0.name).tag($0.id) }
                        }
                        TextField("Code à usage unique", text: $code).textInputAutocapitalization(.characters).autocorrectionDisabled().privacySensitive()
                            .accessibilityIdentifier("remotePairingCode")
                        Button("Vérifier l’instance") { confirming = .init(machine: selectedMachine, handoff: code.uppercased()) }
                            .disabled(selectedMachine.isEmpty || code.count != 12)
                    }
                    if let error = failure ?? instances.error { Section { Text(error).foregroundStyle(.red) } }
                    Section { Text("Accès HTTPS via le Relay MultiVibe et quota Relay du compte. Le contenu transitoire peut être lu par le Cloud.").font(.caption).foregroundStyle(.secondary) }
                }
            }.navigationTitle("Instances")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Actualiser", systemImage: "arrow.clockwise") { Task { await instances.reload() } }.disabled(instances.busy) }
                ToolbarItem(placement: .topBarTrailing) { Button("Fermer") { dismiss() } }
            }
            .task(id: manager.session?.accountId) { instances.activate(manager.session?.accountId); await instances.reload(); confirming = instances.pendingPairing }
            .sheet(isPresented: $scanning) {
                NavigationStack {
                    InstanceQRScanner { value in
                        guard let url = URL(string: value), let pairing = RemotePairing.parse(url) else { failure = "Ce QR n’est pas un appairage MultiVibe valide."; scanning = false; return }
                        scanning = false; confirming = pairing
                    }.ignoresSafeArea(edges: .bottom).navigationTitle("Scanner le Mac")
                        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Annuler") { scanning = false } } }
                }
            }
            .sheet(item: $confirming) { pairing in
                NavigationStack {
                    VStack(spacing: 22) {
                        Image(systemName: "desktopcomputer.and.iphone").font(.system(size: 64)).foregroundStyle(MultiVibeTheme.accent)
                        Text(instances.machines.first { $0.id == pairing.machine }?.name ?? "Instance inconnue").font(.title2.bold())
                        Text("Cette instance pourra exécuter vos messages avec ses harness et leurs outils. Vérifiez que son nom correspond au Mac devant vous.").multilineTextAlignment(.center)
                        Button("Confirmer cet appairage") {
                            Task {
                                do { try await instances.pair(pairing, name: UIDevice.current.name); code = ""; confirming = nil }
                                catch { failure = "Appairage refusé ou expiré. Vérifiez le compte et générez un nouveau code sur le Mac."; confirming = nil }
                            }
                        }.buttonStyle(.borderedProminent).disabled(instances.busy || !instances.machines.contains { $0.id == pairing.machine && $0.online && $0.supportsHarness })
                            .accessibilityIdentifier("confirmRemotePairing")
                        Button("Annuler", role: .cancel) { confirming = nil; code = ""; instances.pendingPairing = nil }
                    }.padding(28).navigationTitle("Confirmer l’instance")
                }.presentationDetents([.medium, .large])
            }
        }
    }
}

private struct RemoteMachineView: View {
    let machine: RemoteMachine
    @State private var instances = RemoteInstances.shared
    @State private var harness = ""
    let openChat: () -> Void
    @State private var failure: String?
    @State private var revokeConfirmation = false
    private var isPaired: Bool { instances.paired.contains(machine.id) }
    var body: some View {
        List {
            Section {
                Label(machine.name, systemImage: "desktopcomputer")
                Text(instances.transportLabel).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("remoteTransport")
                if !machine.online { Text("Instance indisponible. Vos conversations sont conservées.").foregroundStyle(.orange) }
                if !isPaired { Text("Scannez le QR ou saisissez le code affiché par ce Mac pour autoriser cet iPhone.") }
            }
            if isPaired {
                Section("Harness") {
                    Picker("Exécuter avec", selection: $harness) {
                        Text("Choisir un harness").tag("")
                        ForEach(instances.harnesses[machine.id] ?? []) { h in Text(h.name + (h.available ? "" : " · indisponible")).tag(h.id).disabled(!h.available) }
                    }.accessibilityIdentifier("remoteHarnessPicker")
                    if let h = instances.harnesses[machine.id]?.first(where: { $0.id == harness }) {
                        Text(h.reason ?? (h.configured ? "Configuré sur cette instance" : "Authentification à vérifier sur l’instance")).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section("Conversations sur cette instance") {
                    Button("Ouvrir dans le chat", systemImage: "square.and.pencil") {
                        do {
                            _ = try instances.newChat(machine.id, harness: harness)
                            openChat()
                        } catch { failure = "Choisissez d’abord un harness disponible." }
                    }.disabled(harness.isEmpty || !machine.online || instances.busy)
                    ForEach(instances.chats.filter { $0.machine == machine.id && !$0.messages.isEmpty }.reversed()) { chat in
                        Button(chat.title) { instances.select(chat.id); openChat() }.accessibilityIdentifier("remoteChatRow")
                    }
                }
            }
            Section {
                if isPaired {
                    Button("Déconnecter cet iPhone", role: .destructive) { Task { do { try await instances.disconnect(machine.id) } catch { failure = "Accès local effacé ; révocation distante non confirmée. Révoquez cet appareil depuis le Mac si celui-ci reste hors ligne." } } }
                }
                Button("Révoquer l’instance pour mon compte", role: .destructive) { revokeConfirmation = true }
            }
            if let failure { Text(failure).foregroundStyle(.red) }
        }.navigationTitle(machine.name).disabled(instances.busy)
        .task { harness = instances.preferences[machine.id]?.harness ?? ""; if isPaired && machine.online { do { try await instances.catalog(machine.id) } catch { failure = "Catalogue indisponible ou autorisation expirée. Réappairez l’iPhone si nécessaire." } } }
        .confirmationDialog("Révoquer cette instance pour tous vos appareils ?", isPresented: $revokeConfirmation, titleVisibility: .visible) {
            Button("Révoquer l’instance", role: .destructive) { Task { do { try await instances.disconnect(machine.id, revokeMachine: true); await instances.reload() } catch { failure = "La révocation de l’instance n’a pas pu être confirmée." } } }
        }
    }
}

struct RemoteHarnessModelPicker: View {
    let chatID: UUID
    @Environment(\.dismiss) private var dismiss
    @State private var instances = RemoteInstances.shared
    @State private var search = ""
    @State private var failure: String?
    private var chat: RemoteChat? { instances.chats.first { $0.id == chatID } }
    private var models: [RemoteHarnessModel] {
        guard let chat else { return [] }
        return (instances.modelCatalog[chat.machine + ":" + chat.harness] ?? []).filter {
            search.isEmpty || $0.displayName.localizedCaseInsensitiveContains(search) || $0.id.localizedCaseInsensitiveContains(search)
        }
    }
    var body: some View {
        NavigationStack {
            List {
                if let failure { Text(failure).foregroundStyle(.red) }
                ForEach(models, id: \.selectionID) { model in
                    Button {
                        guard let chat else { return }
                        Task {
                            do {
                                try await instances.choose(chat.machine, harness: chat.harness, model: model)
                                dismiss()
                                do { try await instances.efforts(chat.machine, harness: chat.harness, model: model.id, provider: model.provider) }
                                catch { instances.error = "Le modèle est sélectionné ; son catalogue d’effort est momentanément indisponible." }
                            } catch { failure = "Le changement n’a pas été confirmé. Reprenez sa vérification depuis le chat." }
                        }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(model.displayName).foregroundStyle(.primary)
                                if let provider = model.provider { Text(provider).font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer()
                            if chat?.model == model.id && chat?.provider == model.provider { Image(systemName: "checkmark") }
                        }.padding(.vertical, 4)
                    }.disabled(instances.busy || chat?.pendingConfiguration != nil).accessibilityIdentifier("remoteModelRow")
                }
                if models.isEmpty && !instances.busy { Text("Aucun modèle. Actualisez le catalogue ou modifiez la recherche.").foregroundStyle(.secondary) }
            }
            .searchable(text: $search, prompt: "Rechercher un modèle")
            .navigationTitle("Modèle du harness").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Fermer") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Actualiser", systemImage: "arrow.clockwise") {
                        guard let chat else { return }
                        Task { do { try await instances.models(chat.machine, harness: chat.harness); failure = nil } catch { failure = "Catalogue indisponible sur cette instance." } }
                    }.disabled(instances.busy)
                }
            }
            .overlay { if instances.busy { ProgressView() } }
        }
    }
}

struct RemoteHarnessProjectPicker: View {
    let chatID: UUID
    @Environment(\.dismiss) private var dismiss
    @State private var instances = RemoteInstances.shared
    @State private var search = ""
    @State private var failure: String?
    private var chat: RemoteChat? { instances.chats.first { $0.id == chatID } }
    var body: some View {
        NavigationStack {
            List {
                if let chat {
                    Section {
                        Button { select(nil, machine: chat.machine) } label: {
                            Label("Aucun projet", systemImage: chat.projectId == nil ? "checkmark" : "folder.badge.minus")
                        }
                        ForEach((instances.projectCatalog[chat.machine + ":" + chat.harness] ?? []).filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }) { project in
                            Button { select(project, machine: chat.machine) } label: {
                                Label(project.name, systemImage: chat.projectId == project.id ? "checkmark" : "folder")
                            }
                        }
                    } footer: { Text("Dossiers existants de cette instance. Le projet est fixé au premier message.") }
                    if let failure { Text(failure).foregroundStyle(.red) }
                }
            }.disabled(instances.busy || chat?.messages.isEmpty != true)
                .searchable(text: $search, prompt: "Rechercher un projet")
                .navigationTitle("Dossier de projet").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { Button("Fermer") { dismiss() } }
                    ToolbarItem(placement: .topBarTrailing) { Button("Actualiser", systemImage: "arrow.clockwise") {
                        guard let chat else { return }
                        Task { do { try await instances.projects(chat.machine, harness: chat.harness); failure = nil } catch { failure = "Projets indisponibles sur cette instance." } }
                    }.disabled(instances.busy) }
                }
        }
    }
    private func select(_ project: RemoteHarnessProject?, machine: String) {
        do { try instances.chooseProject(project, machine: machine); dismiss() }
        catch { failure = "Le projet n’a pas pu être enregistré." }
    }
}

private struct InstanceQRScanner: UIViewControllerRepresentable {
    let scanned: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(scanned) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let c = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
        c.delegate = context.coordinator; try? c.startScanning(); return c
    }
    func updateUIViewController(_ uiViewController: DataScannerViewController, context: Context) { }
    static func dismantleUIViewController(_ uiViewController: DataScannerViewController, coordinator: Coordinator) { uiViewController.stopScanning() }
    @MainActor final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let scanned: (String) -> Void; var done = false
        init(_ scanned: @escaping (String) -> Void) { self.scanned = scanned }
        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !done else { return }
            for item in addedItems { if case .barcode(let code) = item, let value = code.payloadStringValue { done = true; dataScanner.stopScanning(); scanned(value); return } }
        }
    }
}
