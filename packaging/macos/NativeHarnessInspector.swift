import AppKit
import SwiftUI

@MainActor struct NativeHarnessInspector: View {
    @ObservedObject var store: NativeChatStore
    @Environment(\.dismiss) private var dismiss
    var onClose: (() -> Void)?
    var isEmbedded = false
    @State private var page = "overview"
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var targets: [DesktopHarnessTarget] = [.local]
    @State private var harnesses: [DesktopHarnessDescriptor] = []
    @State private var nativeSessions: [DesktopNativeSessionSource] = []
    @State private var hostSessions: [DesktopHarnessSession] = []
    @State private var subject = "capabilities"
    @State private var output = ""
    @State private var inspected: HarnessJSON = .null
    @State private var editingResource: HarnessJSON?
    @State private var resourceText = ""
    @State private var addingSchedule = false
    @State private var scheduleName = ""
    @State private var schedulePrompt = ""
    @State private var scheduleDate = Date().addingTimeInterval(3600)
    @State private var scheduleRepeat = "once"
    @State private var busy = false
    @State private var message: String?
    @State private var addingTarget = false
    @State private var targetKind = "ssh"
    @State private var targetName = ""
    @State private var sshHost = ""
    @State private var bridgePath = ""
    @State private var containerName = ""
    @State private var addingACP = false
    @State private var acpID = ""
    @State private var acpName = ""
    @State private var acpExecutable = ""
    @State private var acpArguments = "[]"
    @State private var nativeMethod = ""
    @State private var nativeParameters = "{}"
    @State private var configurationParameters = "{}"
    @State private var nativePreview: String?
    @State private var nativePreviewSource: DesktopNativeSessionSource?
    @State private var nativePreviewCursor = 0
    @State private var nativePreviewComplete = true
    private var conversation: NativeChatConversation? { store.current }
    private var target: String { conversation?.executionTargetID ?? "local" }
    private var locked: Bool { conversation?.messages.isEmpty == false || conversation?.runtimeSessionID != nil || conversation?.pendingSubmissions?.isEmpty == false }
    private var harnessID: String { conversation?.harnessID ?? "native" }
    private let subjects = ["capabilities", "settings", "models", "modes", "instructions", "context", "memory", "skills", "commands", "tools", "mcp", "plugins", "usage", "agents", "automations", "hooks", "terminals", "workspace", "history", "diagnostics"]
    private func binding(_ get: @escaping (NativeChatConversation?) -> String, _ set: @escaping (inout NativeChatConversation, String) -> Void) -> Binding<String> {
        Binding(get: { get(store.current) }, set: { value in store.edit { set(&$0, value) } })
    }
    private var descriptor: DesktopHarnessDescriptor? { harnesses.first { $0.id == harnessID } }
    private var capabilities: [String: DesktopHarnessCapability] { conversation?.runtimeSession?.capabilities ?? descriptor?.capabilities ?? [:] }
    private var availableCapabilities: [(String, DesktopHarnessCapability)] {
        capabilities.filter { $0.value.available }.sorted { HarnessPresentation.title($0.key).localizedStandardCompare(HarnessPresentation.title($1.key)) == .orderedAscending }
    }
    private var unavailableCapabilities: [(String, DesktopHarnessCapability)] {
        capabilities.filter { !$0.value.available }.sorted { HarnessPresentation.title($0.key).localizedStandardCompare(HarnessPresentation.title($1.key)) == .orderedAscending }
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                HarnessLogo(id: harnessID, name: descriptor?.name ?? "MultiVibe", size: 34)
                VStack(alignment: .leading, spacing: 5) {
                    Text("Détails de la conversation").font(.system(size: 18, weight: .semibold))
                    Text("\(descriptor?.name ?? "MultiVibe") · \(targets.first { $0.id == target }?.name ?? "Machine distante")").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                if !isEmbedded {
                    ChatIconButton(title: "Fermer les détails", icon: "xmark") { close() }.keyboardShortcut(.cancelAction)
                }
            }.padding(22)
            Picker("Section", selection: $page) {
                Label("Aperçu", systemImage: "rectangle.grid.1x2").tag("overview")
                Label("Réglages", systemImage: "slider.horizontal.3").tag("settings")
            }.labelsHidden().pickerStyle(.segmented).frame(width: 260).padding(.bottom, 16)
            Divider()
            if let message {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.circle")
                    Text(message).textSelection(.enabled)
                    Spacer()
                    ChatIconButton(title: "Masquer le message", icon: "xmark") { self.message = nil }
                }.font(.callout).foregroundStyle(.red).padding(.horizontal, 22).padding(.top, 14)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if page == "overview" {
                        if let id = conversation?.id { ForEach(store.runtimeInteractions[id] ?? []) { interaction in NativeHarnessInteractionView(store: store, conversationID: id, interaction: interaction) } }
                        executionSettings
                        if let session = conversation?.runtimeSession { sessionSummary(session) }
                        capabilityList
                        if harnessID != "native" { existingSessions }
                    } else { settingsPanel }
                }.padding(22)
            }.id(page)
        }
        .frame(minWidth: isEmbedded ? 390 : 610, idealWidth: isEmbedded ? 560 : 660, minHeight: 500, idealHeight: 680)
        .background(ChatPalette.elevated).tint(ChatPalette.accent)
        .animation(ChatPalette.motion(reduceMotion), value: page)
        .task(id: target) { await load() }
        .sheet(isPresented: $addingTarget) { targetForm }
        .sheet(isPresented: $addingACP) { acpForm }
        .sheet(isPresented: $addingSchedule) { scheduleForm }
        .sheet(isPresented: Binding(get: { editingResource != nil }, set: { if !$0 { editingResource = nil } })) { memoryForm }
        .sheet(isPresented: Binding(get: { nativePreview != nil }, set: { if !$0 { nativePreview = nil } })) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Historique natif · lecture seule").font(.headline)
                ScrollView { Text(nativePreview ?? "").font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                HStack { if !nativePreviewComplete, let source = nativePreviewSource { Button("Lire la suite") { Task { await previewNative(source, append: true) } } }; Spacer(); Button("Fermer") { nativePreview = nil } }
            }.padding(20).frame(width: 760, height: 580)
        }
    }
    private var executionSettings: some View {
        ChatSection(title: "Environnement", icon: "desktopcomputer") {
            VStack(alignment: .leading, spacing: 14) {
                if locked {
                    HStack(spacing: 10) {
                        environmentBadge(targets.first { $0.id == target }?.name ?? target, icon: "desktopcomputer")
                        environmentBadge(descriptor?.name ?? harnessID, icon: "bolt.horizontal.circle")
                        Spacer(minLength: 0)
                    }
                    inspectorValue("Dossier", conversation?.workspace ?? conversation?.runtimeSession?.workspace ?? "Non défini", monospaced: true)
                } else {
                    Picker("Machine", selection: binding({ $0?.executionTargetID ?? "local" }, { $0.executionTargetID = $1; $0.workspace = nil })) {
                        ForEach(targets) { Text($0.name).tag($0.id) }
                    }
                    Picker("Harness", selection: binding({ $0?.harnessID ?? "native" }, { $0.harnessID = $1 == "native" ? nil : $1; $0.nativeModelID = nil; $0.nativeModelProvider = nil; $0.workspace = nil })) {
                        if target == "local" { Text("MultiVibe").tag("native") }
                        ForEach(harnesses) { Text($0.name + ($0.available ? "" : " · indisponible")).tag($0.id) }
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Dossier").font(.caption).foregroundStyle(.secondary)
                        TextField("Chemin absolu sur cette machine", text: binding({ $0?.workspace ?? "" }, { $0.workspace = $1 })).textFieldStyle(.roundedBorder)
                    }
                }
                if locked { Label("Cet environnement est attaché à la conversation.", systemImage: "lock").font(.caption).foregroundStyle(.secondary) }
                if harnessID != "native" {
                    Divider()
                    if locked { inspectorValue("Accès aux modèles", conversation?.authMode == "multivibe" ? "MultiVibe" : "Accès habituel du harness") }
                    else {
                        Picker("Accès aux modèles", selection: binding({ $0?.authMode ?? "native" }, { $0.authMode = $1 })) {
                            Text("Accès habituel du harness").tag("native"); Text("MultiVibe").tag("multivibe")
                        }
                    }
                    Text(conversation?.authMode == "multivibe" ? "Choisissez le modèle dans le compositeur." : "Le harness utilise son modèle et son authentification habituels.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
    private func environmentBadge(_ title: String, icon: String) -> some View {
        Label(title, systemImage: icon)
            .font(.callout.weight(.medium)).lineLimit(1)
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
    private func inspectorValue(_ label: String, _ value: String, monospaced: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(label).foregroundStyle(.secondary)
            Spacer(minLength: 12)
            Text(value).font(monospaced ? .system(size: 12, design: .monospaced) : .body).lineLimit(2).truncationMode(.middle).textSelection(.enabled)
        }.font(.callout)
    }
    private func sessionSummary(_ session: DesktopHarnessSession) -> some View {
        ChatSection(title: HarnessPresentation.state(session.state), icon: session.running ? "circle.dotted" : "checkmark.circle") {
            HStack(spacing: 12) {
                Button(session.queuePaused ? "Reprendre la file" : "Suspendre la file") { if let id = conversation?.id { store.runtimeCommand(id, type: session.queuePaused ? "resume_queue" : "pause_queue") } }
                Button("Compacter le contexte") { if let id = conversation?.id { store.runtimeCommand(id, type: "compact") } }.disabled(session.running || session.capabilities["compaction"]?.available != true)
                Spacer()
                Button("Exporter") { Task { await exportSession() } }
            }.controlSize(.small)
            if session.state == "uncertain" { Text("L’acceptation d’un travail est incertaine. Consultez l’historique natif ; aucune action ne sera rejouée automatiquement. Vous pouvez continuer dans une copie depuis les sessions existantes.").font(.caption).foregroundStyle(.orange) }
            DisclosureGroup("Identifiants et versions") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Harness : \(session.harnessId) \(session.harnessVersion ?? "")")
                    Text("Session : \(session.nativeSessionId ?? session.id)")
                    Text("Dossier : \(session.workspace)")
                }.font(.caption.monospaced()).textSelection(.enabled).padding(.top, 6)
            }.font(.caption).foregroundStyle(.secondary)
        }
    }
    private var capabilityList: some View {
        ChatSection(title: "Fonctions", icon: "sparkles") {
            if capabilities.isEmpty {
                Label("Les fonctions apparaîtront au démarrage de la conversation.", systemImage: "hourglass")
                    .font(.callout).foregroundStyle(.secondary)
            } else {
                HStack(alignment: .firstTextBaseline) {
                    Text("\(availableCapabilities.count) disponibles").font(.title3.weight(.semibold))
                    if !unavailableCapabilities.isEmpty { Text("· \(unavailableCapabilities.count) non disponibles").font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                }
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible())], spacing: 10) {
                    ForEach(availableCapabilities, id: \.0) { item in
                        capabilityTile(item.0, item.1)
                    }
                }
                if !unavailableCapabilities.isEmpty {
                    DisclosureGroup("Voir les fonctions indisponibles ou inconnues") {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(unavailableCapabilities, id: \.0) { item in
                                HStack(spacing: 9) {
                                    Image(systemName: item.1.support == "unknown" ? "questionmark.circle" : "minus.circle").foregroundStyle(.secondary)
                                    Text(HarnessPresentation.title(item.0)).font(.callout)
                                    Spacer()
                                    Text(item.1.reason ?? HarnessPresentation.origin(item.1.support)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }
                        }.padding(.top, 8)
                    }.font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
    private func capabilityTile(_ key: String, _ capability: DesktopHarnessCapability) -> some View {
        HStack(spacing: 10) {
            Image(systemName: capabilityIcon(key))
                .font(.system(size: 14, weight: .medium)).foregroundStyle(ChatPalette.accent)
                .frame(width: 28, height: 28).background(ChatPalette.accent.opacity(0.10), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(HarnessPresentation.title(key)).font(.callout.weight(.medium)).lineLimit(1)
                Text(HarnessPresentation.origin(capability.support)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    }
    private func capabilityIcon(_ key: String) -> String {
        switch key {
        case "tools", "commands": return "hammer"
        case "automations", "hooks": return "clock.arrow.2.circlepath"
        case "diagnostics", "usage": return "waveform.path.ecg"
        case "workspace", "artifacts", "attachments": return "folder"
        case "memory", "context": return "brain"
        case "sessions", "history": return "clock.arrow.circlepath"
        case "mcp", "plugins": return "puzzlepiece.extension"
        case "agents": return "person.2"
        case "audio": return "waveform"
        case "images", "video": return "photo.on.rectangle"
        default: return "checkmark.circle"
        }
    }
    private var existingSessions: some View {
        ChatSection(title: "Reprendre une conversation", icon: "clock.arrow.circlepath") {
            Text("Retrouvez les sessions de ce Host et celles créées dans le terminal.").font(.callout).foregroundStyle(.secondary)
            Button("Rechercher les sessions") { Task { await loadSessions() } }.disabled(busy)
            ForEach(hostSessions, id: \.id) { session in
                HStack {
                    VStack(alignment: .leading, spacing: 3) { Text(session.title).font(.callout); Text(HarnessPresentation.state(session.state)).font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                    Button("Ouvrir") { store.importRuntimeSession(session, target: target); close() }
                }
            }
            ForEach(nativeSessions) { session in
                HStack {
                    VStack(alignment: .leading, spacing: 4) { Text(session.title).lineLimit(1); Text(session.reason ?? "Continuer dans une copie isolée").font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                    Button("Lire") { Task { await previewNative(session) } }
                    Button("Continuer") { Task { await importNative(session) } }.disabled(!session.canContinue)
                }.font(.callout)
            }
        }
    }
    private var inspectionPanel: some View {
        ChatSection(title: "Explorer les fonctions", icon: "magnifyingglass") {
            HStack {
                Picker("Fonction", selection: $subject) { ForEach(subjects, id: \.self) { Text(HarnessPresentation.title($0)).tag($0) } }
                Button("Consulter") { Task { await inspect() } }.disabled(busy || conversation?.runtimeSessionID == nil)
            }
            if conversation?.runtimeSessionID == nil { Text("Démarrez une conversation pour consulter ses fonctions effectives.").font(.caption).foregroundStyle(.secondary) }
            inspectionControls
            if !output.isEmpty {
                DisclosureGroup("Résultat et données du harness") {
                    ScrollView { Text(output).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 260)
                }.font(.caption)
            }
        }
    }
    private var settingsPanel: some View {
        VStack(alignment: .leading, spacing: 16) {
            if harnessID != "native" { inspectionPanel }
            ChatSection(title: "Machines et intégrations", icon: "network") {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        addTargetButton
                        addHarnessButton
                        Spacer()
                        refreshButton
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 10) {
                            addTargetButton
                            addHarnessButton
                        }
                        refreshButton
                    }
                }
            }
            if harnessID != "native" {
                ChatSection(title: "Réglages natifs", icon: "slider.horizontal.3") {
                    Text("Ces réglages et opérations suivent le format propre au harness.").font(.callout).foregroundStyle(.secondary)
                    DisclosureGroup("Modifier les réglages de la session") {
                        TextEditor(text: $configurationParameters).font(.caption.monospaced()).frame(height: 100)
                        Button("Appliquer les réglages") {
                            Task {
                                do { let value = try JSONDecoder().decode(HarnessJSON.self, from: Data(configurationParameters.utf8)); guard case .object = value else { throw DesktopHarnessError.invalidResponse }; await configure(value) }
                                catch { message = error.localizedDescription }
                            }
                        }.disabled(store.isGenerating(conversation?.id) || conversation?.runtimeSessionID == nil)
                    }
                    DisclosureGroup("Exécuter une opération native") {
                        TextField("Nom de l’opération", text: $nativeMethod).textFieldStyle(.roundedBorder)
                        TextEditor(text: $nativeParameters).font(.caption.monospaced()).frame(height: 100)
                        Button("Exécuter") { Task { await nativeOperation() } }.disabled(nativeMethod.isEmpty || store.isGenerating(conversation?.id) || conversation?.runtimeSessionID == nil)
                    }
                    if !output.isEmpty { DisclosureGroup("Résultat") { Text(output).font(.caption.monospaced()).textSelection(.enabled) } }
                }
            }
        }
    }
    private var addTargetButton: some View {
        Button("Ajouter une machine…") { addingTarget = true }.fixedSize()
    }
    private var addHarnessButton: some View {
        Button("Ajouter un harness…") { addingACP = true }.fixedSize()
    }
    private var refreshButton: some View {
        Button("Actualiser", systemImage: "arrow.clockwise") { Task { await load() } }.disabled(busy).fixedSize()
    }
    private func previewNative(_ source: DesktopNativeSessionSource, append: Bool = false) async {
        do {
            let after = append ? nativePreviewCursor : 0
            let result = try await DesktopHarnessClient.shared.call("/native-sessions/\(source.sourceId)?harnessId=\(harnessID)&after=\(after)", target: target)
            nativePreviewSource = source; nativePreviewCursor = (try? result["cursor"].decode(Int.self)) ?? 0; nativePreviewComplete = result["complete"] == .bool(true)
            nativePreview = append ? (nativePreview ?? "") + "\n\n" + result["records"].display : result.display
        } catch { message = error.localizedDescription }
    }
    private var targetForm: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Ajouter un environnement").font(.headline)
            Picker("Type", selection: $targetKind) { Text("Machine SSH").tag("ssh"); Text("Conteneur Docker du Host").tag("container") }.pickerStyle(.segmented)
            TextField("Nom affiché", text: $targetName)
            if targetKind == "ssh" {
                TextField("Alias SSH déjà configuré", text: $sshHost)
                TextField("Chemin du bridge MultiVibe installé sur la machine", text: $bridgePath)
                Text("Utilise l’authentification SSH existante et un Host persistant sur cette machine. La clé d’hôte doit déjà être connue.").font(.caption).foregroundStyle(.secondary)
            } else {
                TextField("Nom du conteneur en cours d’exécution", text: $containerName)
                TextField("Chemin du bridge installé dans le conteneur (facultatif)", text: $bridgePath)
                Text("Le bridge donne accès à toutes les fonctions du Host dans le conteneur. Sans bridge, les CLI compatibles utilisent une connexion directe.").font(.caption).foregroundStyle(.secondary)
            }
            HStack { Button("Annuler") { addingTarget = false }; Spacer(); Button("Ajouter") { Task { await addTarget() } }.disabled(targetName.isEmpty || (targetKind == "ssh" ? sshHost.isEmpty || bridgePath.isEmpty : containerName.isEmpty)) }
        }.padding(20).frame(width: 530)
    }
    private var acpForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Ajouter un harness ACP").font(.headline)
            TextField("Identifiant", text: $acpID); TextField("Nom", text: $acpName)
            TextField("Chemin absolu de l’exécutable sur le Host", text: $acpExecutable)
            TextField("Arguments (tableau JSON)", text: $acpArguments)
            HStack { Button("Annuler") { addingACP = false }; Spacer(); Button("Enregistrer") { Task { await registerACP() } }.disabled(acpID.isEmpty || acpName.isEmpty || acpExecutable.isEmpty) }
        }.padding(20).frame(width: 530)
    }
    private func load() async {
        busy = true; defer { busy = false }
        do {
            let values = try await DesktopHarnessClient.shared.call("/targets"); targets = try values["targets"].decode([DesktopHarnessTarget].self)
            let catalog = try await DesktopHarnessClient.shared.call("/catalog", target: target); harnesses = try catalog["harnesses"].decode([DesktopHarnessDescriptor].self)
            message = nil
        } catch { message = error.localizedDescription }
    }
    private func loadSessions() async {
        busy = true; defer { busy = false }
        do {
            let hosted = try await DesktopHarnessClient.shared.call("/sessions", target: target); hostSessions = try hosted["sessions"].decode([DesktopHarnessSession].self)
            let sources = try await DesktopHarnessClient.shared.call("/native-sessions?harnessId=\(harnessID)", target: target); nativeSessions = try sources["sessions"].decode([DesktopNativeSessionSource].self)
        } catch { message = error.localizedDescription }
    }
    private func importNative(_ source: DesktopNativeSessionSource) async {
        busy = true; defer { busy = false }
        do {
            let result = try await DesktopHarnessClient.shared.call("/sessions/import", method: "POST", target: target, body: .object(["harnessId": .string(source.harnessId), "sourceId": .string(source.sourceId)]))
            store.importRuntimeSession(try result["session"].decode(DesktopHarnessSession.self), target: target); close()
        } catch { message = error.localizedDescription }
    }
    private func inspect() async {
        guard let id = conversation?.id else { return }; busy = true; defer { busy = false }
        do { let receipt = try await store.command(id, type: "inspect", value: .object(["subject": .string(subject)])); inspected = receipt.result ?? .null; output = receipt.result?.display ?? "Aucun résultat"; message = nil }
        catch { message = error.localizedDescription }
    }
    private func nativeOperation() async {
        guard let id = conversation?.id else { return }; busy = true; defer { busy = false }
        do { let parameters = try JSONDecoder().decode(HarnessJSON.self, from: Data(nativeParameters.utf8)); let receipt = try await store.command(id, type: "native", value: .object(["method": .string(nativeMethod), "params": parameters])); output = receipt.result?.display ?? "Opération terminée" }
        catch { message = error.localizedDescription }
    }
    private func addTarget() async {
        do {
            var values: [String: HarnessJSON] = ["name": .string(targetName), "kind": .string(targetKind)]
            if targetKind == "ssh" { values["sshHost"] = .string(sshHost); values["bridgePath"] = .string(bridgePath) } else { values["container"] = .string(containerName); if !bridgePath.isEmpty { values["bridgePath"] = .string(bridgePath) } }
            _ = try await DesktopHarnessClient.shared.call("/targets", method: "POST", body: .object(values)); addingTarget = false; await load()
        } catch { message = error.localizedDescription }
    }
    private func registerACP() async {
        do {
            let args = try JSONDecoder().decode(HarnessJSON.self, from: Data(acpArguments.utf8))
            _ = try await DesktopHarnessClient.shared.call("/registrations", method: "POST", target: target, body: .object(["id": .string(acpID), "name": .string(acpName), "executable": .string(acpExecutable), "args": args]))
            addingACP = false; await load()
        } catch { message = error.localizedDescription }
    }
    private func exportSession() async {
        guard let sessionID = conversation?.runtimeSessionID else { return }
        do {
            let export = try await DesktopHarnessClient.shared.call("/sessions/\(sessionID)/export", target: target)
            let panel = NSSavePanel(); panel.nameFieldStringValue = "conversation.json"
            if panel.runModal() == .OK, let url = panel.url { try JSONEncoder().encode(export).write(to: url, options: .atomic) }
        } catch { message = error.localizedDescription }
    }
    @ViewBuilder private var inspectionControls: some View {
        if subject == "memory" {
            ForEach(Array(inspected["sources"].array.enumerated()), id: \.offset) { _, source in
                HStack { Text(source["name"].string ?? "Mémoire"); Spacer(); Button("Modifier") { editingResource = source; resourceText = source["text"].string ?? "" }.disabled(source["writable"] != .bool(true)) }
            }
        }
        if subject == "automations" {
            Button("Planifier un message") { addingSchedule = true }
            ForEach(Array(inspected["schedules"].array.enumerated()), id: \.offset) { _, schedule in
                HStack {
                    Text(schedule["name"].string ?? "Tâche")
                    Spacer()
                    Button(schedule["enabled"] == .bool(true) ? "Suspendre" : "Activer") { Task { await configure(.object(["schedule": .object(["id": schedule["id"], "enabled": .bool(schedule["enabled"] != .bool(true))])])) } }
                    Button("Supprimer") { Task { await configure(.object(["schedule": .object(["id": schedule["id"], "remove": .bool(true)])])) } }
                }
            }
        }
        if subject == "commands" || subject == "skills" && ["openai-codex", "pi", "claude-code"].contains(harnessID) {
            ForEach(Array(commandChoices.enumerated()), id: \.offset) { _, name in
                Button(name) {
                    let prefix = subject == "skills" ? (harnessID == "openai-codex" ? "$" : harnessID == "pi" ? "/skill:" : "/") : "/"
                    store.edit { $0.draft += ($0.draft.isEmpty ? "" : " ") + prefix + name + " " }; close()
                }.buttonStyle(.borderless)
            }
        }
        if subject == "models" {
            ForEach(Array(modelChoices.enumerated()), id: \.offset) { _, option in
                Button(option.name) { Task { var values: [String: HarnessJSON] = ["model": .string(option.id)]; if let provider = option.provider { values["provider"] = .string(provider) }; await configure(.object(values)) } }.disabled(store.isGenerating(conversation?.id))
            }
        }
        if subject == "modes" {
            ForEach(Array(modeChoices.enumerated()), id: \.offset) { _, mode in
                Button(mode["name"].string ?? mode["mode"].string ?? mode["id"].string ?? "Mode") { Task { await configure(.object(["mode": mode["mode"] != .null ? mode["mode"] : mode["id"]])) } }.disabled(store.isGenerating(conversation?.id))
            }
        }
    }
    private func close() {
        if let onClose { onClose() }
        else { dismiss() }
    }
    private var commandChoices: [String] {
        var rows = inspected.array
        if rows.isEmpty { rows = inspected["commands"].array }
        if rows.isEmpty { rows = inspected["data"].array.flatMap { $0["skills"].array } }
        return rows.compactMap { $0["name"].string }.prefix(100).map { $0.hasPrefix("/") ? String($0.dropFirst()) : $0 }
    }
    private struct ModelChoice { let id: String; let name: String; let provider: String? }
    private var modelChoices: [ModelChoice] {
        var rows = inspected.array
        if rows.isEmpty { rows = inspected["data"].array }
        if rows.isEmpty { rows = inspected["models"].array }
        if rows.isEmpty { rows = inspected["models"]["availableModels"].array }
        var options = rows.compactMap { row -> ModelChoice? in
            guard let id = row["model"].string ?? row["modelId"].string ?? row["id"].string ?? row["value"].string else { return nil }
            return .init(id: id, name: row["displayName"].string ?? row["name"].string ?? id, provider: row["provider"].string)
        }
        for provider in inspected["all"].array {
            guard let providerID = provider["id"].string else { continue }
            for (id, model) in provider["models"].object.sorted(by: { $0.key < $1.key }) { options.append(.init(id: providerID + "/" + id, name: (provider["name"].string ?? providerID) + " · " + (model["name"].string ?? id), provider: nil)) }
        }
        return Array(options.prefix(100))
    }
    private var modeChoices: [HarnessJSON] { let modes = inspected["modes"]["availableModes"].array; return modes.isEmpty ? inspected["data"].array : modes }
    private func configure(_ value: HarnessJSON) async {
        guard let id = conversation?.id else { return }
        do { let result = try await store.command(id, type: "configure", value: value); output = result.result?.display ?? "Configuration appliquée"; try await store.refreshRuntime(id); if subject == "automations" { await inspect() } }
        catch { message = error.localizedDescription }
    }
    private var memoryForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Mémoire du harness").font(.headline)
            Text(editingResource?["path"].string ?? "").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $resourceText).frame(minHeight: 250)
            HStack { Button("Annuler") { editingResource = nil }; Spacer(); Button("Enregistrer") { Task { guard let resource = editingResource else { return }; await configure(.object(["resource": .object(["kind": .string("memory"), "path": resource["path"], "sha256": resource["sha256"], "text": .string(resourceText)])])); editingResource = nil; await inspect() } } }
        }.padding(20).frame(width: 600)
    }
    private var scheduleForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Planifier un message sur ce Host").font(.headline)
            TextField("Nom", text: $scheduleName)
            TextEditor(text: $schedulePrompt).frame(height: 120)
            DatePicker("Prochaine exécution", selection: $scheduleDate)
            Picker("Répétition", selection: $scheduleRepeat) { Text("Une fois").tag("once"); Text("Chaque heure").tag("hourly"); Text("Toutes les 24 heures").tag("daily") }
            Text("Le Host doit rester en fonctionnement. Les exécutions sont ajoutées à la file de cette conversation ; les échéances manquées sont regroupées.").font(.caption).foregroundStyle(.secondary)
            HStack { Button("Annuler") { addingSchedule = false }; Spacer(); Button("Planifier") { Task { var schedule: [String: HarnessJSON] = ["name": .string(scheduleName), "parts": .array([.object(["type": .string("text"), "text": .string(schedulePrompt)])]), "nextAt": .number(floor(scheduleDate.timeIntervalSince1970 * 1000))]; if scheduleRepeat != "once" { schedule["intervalMs"] = .number(scheduleRepeat == "hourly" ? 3_600_000 : 86_400_000) }; await configure(.object(["schedule": .object(schedule)])); addingSchedule = false } }.disabled(scheduleName.isEmpty || schedulePrompt.isEmpty) }
        }.padding(20).frame(width: 560)
    }
}

@MainActor struct NativeHarnessInteractionView: View {
    @ObservedObject var store: NativeChatStore
    let conversationID: UUID
    let interaction: DesktopHarnessInteraction
    @State private var values: [String: String] = [:]
    @State private var error: String?
    @State private var showingAuthentication = false
    @State private var sending = false
    @StateObject private var authenticationBrowser = ChromiumBrowser()
    private var elicitation: Bool { interaction.detail["_kind"].string == "mcp_elicitation" }
    private var schema: HarnessJSON { interaction.detail["requestedSchema"] }
    private var authenticationURL: String? {
        for key in ["url", "authUrl", "authorizationUrl", "loginUrl", "verification_uri_complete"] {
            if let value = interaction.detail[key].string, let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? "") { return value }
        }
        return nil
    }
    private var questions: [HarnessJSON] { let direct = interaction.detail["questions"].array; return direct.isEmpty ? interaction.detail["input"]["questions"].array : direct }
    private func answer(_ value: HarnessJSON) {
        guard !sending else { return }
        sending = true; error = nil
        Task {
            do { _ = try await store.command(conversationID, type: "respond", value: .object(["interactionId": .string(interaction.id), "answer": value])); try await store.refreshRuntime(conversationID) }
            catch { self.error = error.localizedDescription; sending = false }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: interaction.kind == "permission" ? "lock.shield" : interaction.kind == "authentication" ? "key" : "questionmark.bubble")
                    .font(.system(size: 15)).foregroundStyle(ChatPalette.accent).padding(.top, 1)
                VStack(alignment: .leading, spacing: 5) {
                    Text(interaction.kind == "permission" ? "Autorisation demandée" : interaction.kind == "authentication" ? "Connexion nécessaire" : "Votre réponse est attendue")
                        .font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                    Text(interaction.title).font(.system(size: 13, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                if sending { ProgressView().controlSize(.small) }
            }.padding(.bottom, 4)
            if interaction.kind == "authentication" {
                Text(interaction.detail["message"].string ?? "Ouvrez le parcours de connexion, puis revenez ici.").font(.caption)
                HStack {
                    if let url = authenticationURL { Button("Se connecter") { authenticationBrowser.userNavigate(url); showingAuthentication = true } }
                    Button("Connexion effectuée") { answer(.object(["action": .string("accept")])) }
                    Button("Annuler") { answer(.object(["action": .string("cancel")])) }
                }
            } else if elicitation {
                Text(interaction.detail["message"].string ?? interaction.title).font(.caption)
                ForEach(schema["properties"].object.keys.sorted(), id: \.self) { key in
                    let field = schema["properties"][key]
                    if field["type"].string == "boolean" {
                        Toggle(field["title"].string ?? key, isOn: Binding(get: { values[key] == "true" || values[key] == nil && field["default"] == .bool(true) }, set: { values[key] = $0 ? "true" : "false" }))
                    } else if !field["enum"].array.isEmpty {
                        Picker(field["title"].string ?? key, selection: Binding(get: { values[key] ?? field["default"].string ?? "" }, set: { values[key] = $0 })) {
                            Text("Choisir…").tag("")
                            ForEach(Array(field["enum"].array.enumerated()), id: \.offset) { _, value in Text(value.string ?? value.display).tag(value.string ?? value.display) }
                        }
                    } else { TextField(field["title"].string ?? key, text: Binding(get: { values[key] ?? "" }, set: { values[key] = $0 })) }
                    if let description = field["description"].string { Text(description).font(.caption).foregroundStyle(.secondary) }
                }
                HStack {
                    Button("Envoyer") { do { answer(.object(["action": .string("accept"), "content": try DesktopHarnessForm.content(schema: schema, values: values)])) } catch { self.error = error.localizedDescription } }
                    Button("Refuser") { answer(.object(["action": .string("decline")])) }
                    Button("Annuler") { answer(.object(["action": .string("cancel")])) }
                }
            } else if interaction.kind == "permission" {
                DisclosureGroup("Détails de l’action") { Text(interaction.detail.display).font(.caption.monospaced()).textSelection(.enabled) }
                HStack {
                    ForEach(Array(interaction.detail["options"].array.enumerated()), id: \.offset) { _, option in
                        Button(option["name"].string ?? option["optionId"].string ?? "Répondre") { answer(.object(["optionId": option["optionId"]])) }
                    }
                }
            } else if interaction.detail["method"].string == "confirm" {
                HStack { Button("Oui") { answer(.object(["confirmed": .bool(true)])) }; Button("Non") { answer(.object(["confirmed": .bool(false)])) } }
            } else if interaction.detail["method"].string == "select" {
                ForEach(Array(interaction.detail["options"].array.enumerated()), id: \.offset) { _, option in Button(option.string ?? option.display) { answer(.object(["value": option])) } }
            } else {
                if !questions.isEmpty {
                    ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                        let key = question["id"].string ?? question["question"].string ?? String(index)
                        Text(question["question"].string ?? question["header"].string ?? "Réponse")
                        ForEach(Array(question["options"].array.enumerated()), id: \.offset) { _, option in
                            let label = option["label"].string ?? option.string ?? option.display
                            Button { values[key] = label } label: {
                                HStack(alignment: .top, spacing: 9) {
                                    Image(systemName: values[key] == label ? "checkmark.circle.fill" : "circle").foregroundStyle(values[key] == label ? ChatPalette.accent : Color.secondary)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(label).font(.system(size: 12, weight: .medium))
                                        if let description = option["description"].string { Text(description).font(.system(size: 11)).foregroundStyle(.secondary) }
                                    }
                                    Spacer(minLength: 0)
                                }.padding(9)
                            }.buttonStyle(ChatActionStyle(selected: values[key] == label))
                        }
                        TextField(question["options"].array.isEmpty ? "Votre réponse" : "Ou précisez votre réponse", text: Binding(get: { values[key] ?? "" }, set: { values[key] = $0 }))
                    }
                } else {
                    TextField("Votre réponse", text: Binding(get: { values["value"] ?? "" }, set: { values["value"] = $0 }))
                    DisclosureGroup("Détails") { Text(interaction.detail.display).font(.caption.monospaced()).textSelection(.enabled) }
                }
                HStack {
                    Button("Répondre") { submitQuestions() }.buttonStyle(.borderedProminent).disabled(values.values.allSatisfy { $0.isEmpty })
                    Button("Annuler le tour") { store.runtimeCommand(conversationID, type: "interrupt") }
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(ChatPalette.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(ChatPalette.accent.opacity(0.32), lineWidth: 1))
        .disabled(sending).tint(ChatPalette.accent)
        .sheet(isPresented: $showingAuthentication, onDismiss: { authenticationBrowser.close() }) {
            VStack { ChromiumBrowserPanel(browser: authenticationBrowser); Button("Revenir à la demande") { showingAuthentication = false } }.padding(12).frame(width: 800, height: 600)
        }
    }
    private func submitQuestions() {
        let harness = store.conversations.first(where: { $0.id == conversationID })?.harnessID
        if harness == "openai-codex" {
            answer(.object(["answers": .object(values.mapValues { .object(["answers": .array([.string($0)])]) })]))
        } else if harness == "opencode" {
            answer(.object(["answers": .array(questions.enumerated().map { index, question in .array([.string(values[question["id"].string ?? question["question"].string ?? String(index)] ?? "")]) })]))
        } else if harness == "claude-code" {
            answer(.object(["answers": .object(values.mapValues { .string($0) })]))
        } else if harness == "pi" {
            answer(.object(["value": .string(values["value"] ?? values.values.first ?? ""), "confirmed": .bool(values["value"]?.lowercased() == "yes")]))
        } else { answer(.object(["action": .string("accept"), "content": .object(values.mapValues { .string($0) }), "value": .string(values["value"] ?? "")])) }
    }
}
