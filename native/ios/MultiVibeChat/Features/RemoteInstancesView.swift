import SwiftUI
import VisionKit
import UIKit

struct RemoteInstancesView: View {
    @Environment(ConversationManager.self) private var manager
    @Environment(\.dismiss) private var dismiss
    @State private var instances = RemoteInstances.shared
    @Environment(\.scenePhase) private var scenePhase
    @State private var advanced = false
    @State private var scanning = false
    @State private var code = ""
    @State private var selectedMachine = ""
    @State private var confirming: RemotePairing?
    @State private var failure: String?
    private var normalizedCode: String {
        String(code.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }.prefix(12))
    }
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
                                        Text(instances.paired.contains(machine.id) ? (machine.online ? "Connecté" : "Hors ligne · association conservée") : instances.pairingStates[machine.id] == "pending" ? "Validation attendue sur le Mac" : instances.pairingStates[machine.id] == "revoked" ? "Accès révoqué" : machine.online ? "Disponible" : "Hors ligne").font(.caption).foregroundStyle(machine.online ? Color.secondary : .orange)
                                    }
                                    Spacer()
                                    if instances.paired.contains(machine.id) { Image(systemName: "checkmark.shield.fill").foregroundStyle(.green) }
                                }
                            }.accessibilityIdentifier("remoteInstanceRow")
                        }
                        if instances.machines.isEmpty {
                            ContentUnavailableView("Aucune instance", systemImage: "desktopcomputer",
                                description: Text("Sur le Mac, ouvrez Actions → Connecter un iPhone à ce Mac, puis activez l’accès."))
                        }
                    } header: { Text("Instances de votre compte") } footer: { Text("L’exécution reste sur l’instance choisie. Vos modèles et conversations sur l’iPhone restent accessibles en fermant cet écran.") }
                    Section {
                        DisclosureGroup("QR et code · options avancées", isExpanded: $advanced) {
                        Button("Scanner le QR du Mac", systemImage: "qrcode.viewfinder") { scanning = true }
                            .disabled(!DataScannerViewController.isSupported || !DataScannerViewController.isAvailable)
                            .accessibilityIdentifier("scanRemoteInstance")
                        if !DataScannerViewController.isSupported || !DataScannerViewController.isAvailable {
                            Text("Le scanner n’est pas disponible. Utilisez le code affiché sur le Mac.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Picker("Instance", selection: $selectedMachine) {
                            Text("Choisir une instance").tag("")
                            ForEach(instances.machines.filter { $0.supportsHarness }) { Text($0.name).tag($0.id) }
                        }
                        TextField("Code à usage unique", text: $code)
                            .textContentType(.oneTimeCode)
                            .keyboardType(.asciiCapable)
                            .textInputAutocapitalization(.characters).autocorrectionDisabled().privacySensitive()
                            .font(.body.monospaced())
                            .onChange(of: code) { _, _ in if code != normalizedCode { code = normalizedCode } }
                            .accessibilityIdentifier("remotePairingCode")
                        Button("Vérifier l’instance") { confirming = .init(machine: selectedMachine, handoff: normalizedCode) }
                            .disabled(selectedMachine.isEmpty || normalizedCode.count != 12)
                    }
                    }
                    if let error = failure ?? instances.error { Section { MultiVibeStatusMessage(message: error) } }
                }
            }.navigationTitle("Instances")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Actualiser", systemImage: "arrow.clockwise") { Task { await instances.reload() } }.disabled(instances.busy) }
                ToolbarItem(placement: .topBarTrailing) { Button("Fermer") { dismiss() } }
            }
            .task(id: "\(manager.session?.accountId ?? "")-\(scenePhase)") {
                guard scenePhase == .active else { return }
                instances.activate(manager.session?.accountId); await instances.reload(); confirming = instances.pendingPairing
                var ticks = 0
                while !Task.isCancelled {
                    await instances.pollPairings(); ticks += 1
                    if ticks % 5 == 0 { await instances.reload() }
                    do { try await Task.sleep(for: .seconds(2)) } catch { return }
                }
            }
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
                    ScrollView {
                        VStack(spacing: 22) {
                            Image(systemName: "desktopcomputer.and.iphone").font(.system(size: 64)).foregroundStyle(MultiVibeTheme.accent)
                            Text(instances.machines.first { $0.id == pairing.machine }?.name ?? "Instance inconnue").font(.title2.bold())
                            Text("Cette instance pourra exécuter vos messages avec ses harness et leurs outils. Vérifiez que son nom correspond au Mac devant vous.").multilineTextAlignment(.center)
                            Button("Confirmer cet appairage") {
                                Task {
                                    do { try await instances.pair(pairing, name: UIDevice.current.name); code = ""; confirming = nil }
                                    catch { failure = "Appairage refusé ou expiré. Vérifiez le compte et générez un nouveau code sur le Mac."; confirming = nil }
                                }
                            }
                            .buttonStyle(.borderedProminent).controlSize(.large)
                            .disabled(instances.busy || !instances.machines.contains { $0.id == pairing.machine && $0.online && $0.supportsHarness })
                                .accessibilityIdentifier("confirmRemotePairing")
                            Button("Annuler", role: .cancel) { confirming = nil; code = ""; instances.pendingPairing = nil }
                        }.padding(28).navigationTitle("Confirmer l’instance")
                    }
                }.presentationDetents([.large])
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
    @State private var disconnectConfirmation = false
    private var isPaired: Bool { instances.paired.contains(machine.id) }
    private var currentMachine: RemoteMachine { instances.machines.first { $0.id == machine.id } ?? machine }
    @Environment(\.scenePhase) private var scenePhase
    @State private var connecting = false
    var body: some View {
        List {
            Section {
                Label(machine.name, systemImage: "desktopcomputer")
                if !currentMachine.online { Text("Mac hors ligne. La connexion reprendra automatiquement ; vos conversations sont conservées.").foregroundStyle(.orange) }
                if !isPaired {
                    if ["pending", "cancelling"].contains(instances.pairingStates[machine.id] ?? "") {
                        Label(instances.pairingStates[machine.id] == "cancelling" ? "Annulation en cours" : "Autorisez cet iPhone sur votre Mac", systemImage: "clock")
                        Text("Une demande apparaît dans MultiVibe sur le Mac. Elle expire après cinq minutes.").font(.caption)
                        Button("Annuler la demande", role: .cancel) { Task { do { try await instances.cancelConnection(machine.id) } catch { failure = RemoteInstances.connectionError(error) } } }
                    } else {
                        if instances.pairingStates[machine.id] == "refused" { Text("La demande a été refusée sur le Mac.") }
                        if instances.pairingStates[machine.id] == "expired" { Text("La demande a expiré. Vous pouvez réessayer.") }
                        if instances.pairingStates[machine.id] == "revoked" { Text("L’accès a été révoqué. Une nouvelle autorisation est nécessaire.") }
                        Button("Connecter cet iPhone", systemImage: "iphone.and.arrow.forward") {
                            connecting = true
                            Task {
                                defer { connecting = false }
                                do { try await instances.requestConnection(machine.id, name: UIDevice.current.name); failure = nil }
                                catch { failure = RemoteInstances.connectionError(error) }
                            }
                        }.buttonStyle(.borderedProminent).disabled(!currentMachine.online || connecting)
                        Text("Même compte, une autorisation sur le Mac, puis reconnexion automatique.").font(.caption)
                    }
                }
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
                    }.disabled(harness.isEmpty || !currentMachine.online || instances.busy)
                    ForEach(instances.chats.filter { $0.machine == machine.id && !$0.messages.isEmpty }.reversed()) { chat in
                        Button(chat.title) { instances.select(chat.id); openChat() }.accessibilityIdentifier("remoteChatRow")
                    }
                }
            }
            Section {
                if isPaired {
                    Button("Déconnecter cet iPhone", role: .destructive) { disconnectConfirmation = true }
                }
                Button("Révoquer l’instance pour mon compte", role: .destructive) { revokeConfirmation = true }
            }
            if let failure { MultiVibeStatusMessage(message: failure) }
        }.navigationTitle(machine.name).disabled(instances.busy)
        .task(id: "\(isPaired)-\(currentMachine.online)-\(scenePhase)") {
            guard scenePhase == .active else { return }
            harness = instances.preferences[machine.id]?.harness ?? ""
            if isPaired && currentMachine.online {
                do { try await instances.catalog(machine.id); failure = nil }
                catch { failure = RemoteInstances.connectionError(error) }
            }
        }
        .confirmationDialog("Révoquer cette instance pour tous vos appareils ?", isPresented: $revokeConfirmation, titleVisibility: .visible) {
            Button("Révoquer l’instance", role: .destructive) { Task { do { try await instances.disconnect(machine.id, revokeMachine: true); await instances.reload() } catch { failure = "La révocation de l’instance n’a pas pu être confirmée." } } }
        }
        .confirmationDialog("Déconnecter cet iPhone de cette instance ?", isPresented: $disconnectConfirmation, titleVisibility: .visible) {
            Button("Déconnecter cet iPhone", role: .destructive) {
                Task { do { try await instances.disconnect(machine.id) } catch { failure = "Accès local effacé ; révocation distante non confirmée. Révoquez cet appareil depuis le Mac si celui-ci reste hors ligne." } }
            }
        } message: { Text("Il faudra appairer à nouveau cet iPhone pour utiliser les harness de cette instance.") }
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
                    if let failure { MultiVibeStatusMessage(message: failure) }
                }
            }.disabled(instances.busy || chat?.messages.isEmpty != true)
                .searchable(text: $search, prompt: "Rechercher un projet")
                .navigationTitle("Dossier de projet").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { Button("Fermer") { dismiss() } }
                    ToolbarItem(placement: .topBarTrailing) { Button("Actualiser", systemImage: "arrow.clockwise") {
                        guard let chat else { return }
                        Task { do { try await instances.projects(chat.machine, harness: chat.harness, forceRefresh: true); failure = nil } catch { failure = "Projets indisponibles sur cette instance." } }
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
