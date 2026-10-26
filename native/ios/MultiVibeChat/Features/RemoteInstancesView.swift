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
                            NavigationLink { RemoteMachineView(machine: machine) } label: {
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
    @State private var chatID: UUID?
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
                    Button("Charger les modèles") { Task { do { try await instances.models(machine.id, harness: harness) } catch { failure = "Le harness n’a pas exposé ses modèles. Vérifiez sa connexion sur le Mac." } } }.disabled(harness.isEmpty || !machine.online || instances.busy)
                    ForEach(instances.modelCatalog[machine.id + ":" + harness] ?? []) { model in
                        Button {
                            do { try instances.choose(machine.id, harness: harness, model: model) } catch { failure = error.localizedDescription }
                        } label: {
                            HStack { Text(model.displayName); Spacer(); if instances.preferences[machine.id]?.harness == harness && instances.preferences[machine.id]?.model == model.id { Image(systemName: "checkmark") } }
                        }.accessibilityIdentifier("remoteModelRow")
                    }
                }
                Section("Conversations sur cette instance") {
                    Button("Nouvelle conversation", systemImage: "square.and.pencil") {
                        do { chatID = try instances.newChat(machine.id) } catch { failure = "Choisissez d’abord un harness et un modèle." }
                    }.disabled(instances.preferences[machine.id] == nil)
                    ForEach(instances.chats.filter { $0.machine == machine.id }.reversed()) { chat in
                        Button(chat.title) { chatID = chat.id }.accessibilityIdentifier("remoteChatRow")
                    }
                }
                Section {
                    Button("Déconnecter cet iPhone", role: .destructive) { Task { do { try await instances.disconnect(machine.id) } catch { failure = "Accès local effacé ; révocation distante non confirmée. Révoquez cet appareil depuis le Mac si celui-ci reste hors ligne." } } }
                    Button("Révoquer l’instance pour mon compte", role: .destructive) { revokeConfirmation = true }
                }
            }
            if let failure { Text(failure).foregroundStyle(.red) }
        }.navigationTitle(machine.name).disabled(instances.busy)
        .task { harness = instances.preferences[machine.id]?.harness ?? ""; if isPaired && machine.online { do { try await instances.catalog(machine.id) } catch { failure = "Catalogue indisponible ou autorisation expirée. Réappairez l’iPhone si nécessaire." } } }
        .sheet(isPresented: Binding(get: { chatID != nil }, set: { if !$0 { chatID = nil } })) { if let id = chatID { RemoteInstanceChatView(chatID: id, machineName: machine.name) } }
        .confirmationDialog("Révoquer cette instance pour tous vos appareils ?", isPresented: $revokeConfirmation, titleVisibility: .visible) {
            Button("Révoquer l’instance", role: .destructive) { Task { do { try await instances.disconnect(machine.id, revokeMachine: true) } catch { failure = "La révocation de l’instance n’a pas pu être confirmée." } } }
        }
    }
}

private struct RemoteInstanceChatView: View {
    let chatID: UUID; let machineName: String
    @Environment(\.dismiss) private var dismiss
    @State private var instances = RemoteInstances.shared
    @State private var draft = ""
    private var chat: RemoteChat? { instances.chats.first { $0.id == chatID } }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                VStack(spacing: 3) {
                    Text(machineName + " · " + (chat?.harness ?? "")).font(.subheadline.weight(.medium))
                    Text(chat?.model ?? "").font(.caption).foregroundStyle(.secondary)
                    Text(instances.transportLabel).font(.caption2).foregroundStyle(.secondary).accessibilityIdentifier("remoteChatTransport")
                }.padding(12)
                Divider()
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 18) {
                            ForEach(chat?.messages ?? []) { message in
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(message.role == "user" ? "Vous" : machineName).font(.caption.bold()).foregroundStyle(.secondary)
                                    Text(message.content.isEmpty ? "Réponse en cours…" : message.content).textSelection(.enabled)
                                        .accessibilityIdentifier(message.role == "assistant" ? "remoteAssistantReply" : "remoteUserMessage")
                                }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(message.role == "user" ? Color.accentColor.opacity(0.08) : Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 16))
                            }
                            Color.clear.frame(height: 1).id("end")
                        }.padding()
                    }.onChange(of: chat?.messages.last?.content) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
                }
                if let error = instances.error { Text(error).font(.caption).foregroundStyle(.red).padding(.horizontal) }
                if instances.activeChat == chatID {
                    HStack { ProgressView(); Text("Exécution sur le Mac"); Button("Fermer le suivi") { instances.stopFollowing() } }.font(.caption).padding()
                } else if chat?.command != nil {
                    Button("Reprendre le suivi sans renvoyer") { instances.send("", chat: chatID, recover: true) }.padding().accessibilityIdentifier("recoverRemoteTurn")
                }
                HStack(alignment: .bottom) {
                    TextField("Message à cette instance", text: $draft, axis: .vertical).lineLimit(1...5).textFieldStyle(.roundedBorder).accessibilityIdentifier("remoteMessage")
                    Button("Envoyer", systemImage: "arrow.up.circle.fill") { let text = draft; instances.send(text, chat: chatID); if instances.activeChat == chatID { draft = "" } }
                        .labelStyle(.iconOnly).font(.title2).disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || chat?.command != nil || instances.activeChat != nil).accessibilityIdentifier("sendRemoteMessage")
                }.padding()
            }.navigationTitle(chat?.title ?? "Instance distante").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Fermer") { dismiss() } } }
        }
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
