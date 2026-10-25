import AppKit
import SwiftUI

@MainActor struct NativeHarnessInspector: View {
    @ObservedObject var store: NativeChatStore
    @Environment(\.dismiss) private var dismiss
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
    private var conversation: NativeChatConversation? { store.current }
    private var target: String { conversation?.executionTargetID ?? "local" }
    private var locked: Bool { conversation?.messages.isEmpty == false || conversation?.runtimeSessionID != nil || conversation?.pendingSubmissions?.isEmpty == false }
    private var harnessID: String { conversation?.harnessID ?? "native" }
    private let subjects = ["capabilities", "settings", "models", "modes", "instructions", "context", "memory", "skills", "commands", "tools", "mcp", "plugins", "usage", "agents", "automations", "hooks", "terminals", "workspace", "history", "diagnostics"]
    private func binding(_ get: @escaping (NativeChatConversation?) -> String, _ set: @escaping (inout NativeChatConversation, String) -> Void) -> Binding<String> {
        Binding(get: { get(store.current) }, set: { value in store.edit { set(&$0, value) } })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text("Session et capacités").font(.title2.weight(.semibold)); Spacer(); if busy { ProgressView().controlSize(.small) }; Button("Fermer") { dismiss() } }
            if let message { Text(message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled) }
            if let id = conversation?.id { ForEach(store.runtimeInteractions[id] ?? []) { interaction in NativeHarnessInteractionView(store: store, conversationID: id, interaction: interaction) } }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    GroupBox("Exécution") {
                        VStack(alignment: .leading, spacing: 10) {
                            Picker("Machine", selection: binding({ $0?.executionTargetID ?? "local" }, { $0.executionTargetID = $1 })) {
                                ForEach(targets) { Text($0.name).tag($0.id) }
                            }.disabled(locked)
                            HStack { Button("Ajouter une machine ou un conteneur") { addingTarget = true }; Button("Actualiser") { Task { await load() } } }
                            Picker("Harness", selection: binding({ $0?.harnessID ?? "native" }, { $0.harnessID = $1 == "native" ? nil : $1 })) {
                                if target == "local" { Text("MultiVibe natif").tag("native") }
                                ForEach(harnesses) { Text($0.name + ($0.available ? "" : " · indisponible")).tag($0.id) }
                            }.disabled(locked)
                            TextField("Dossier de travail (chemin absolu sur cette machine)", text: binding({ $0?.workspace ?? "" }, { $0.workspace = $1 })).disabled(locked)
                            if locked { Text("Le harness et la machine sont attachés à cette conversation.").font(.caption).foregroundStyle(.secondary) }
                            if harnessID != "native" {
                                Picker("Accès aux modèles", selection: binding({ $0?.authMode ?? "native" }, { $0.authMode = $1 })) {
                                    Text("Accès habituel du harness").tag("native"); Text("MultiVibe").tag("multivibe")
                                }.disabled(locked)
                                if conversation?.authMode == "multivibe" { Text("Le modèle se choisit dans le compositeur.").font(.caption).foregroundStyle(.secondary) }
                                else { Text("Le harness conserve son authentification et son modèle habituels. Ses identifiants restent sur sa machine.").font(.caption).foregroundStyle(.secondary) }
                            }
                            Button("Ajouter un harness ACP…") { addingACP = true }
                        }.padding(7)
                    }
                    if let session = conversation?.runtimeSession {
                        GroupBox("État de la session") {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("\(session.state) · \(targets.first(where: { $0.id == target })?.name ?? target)")
                                Text(session.workspace).font(.caption.monospaced()).textSelection(.enabled)
                                if let native = session.nativeSessionId { Text(native).font(.caption.monospaced()).textSelection(.enabled) }
                                HStack {
                                    Button(session.queuePaused ? "Reprendre la file" : "Suspendre la file") { if let id = conversation?.id { store.runtimeCommand(id, type: session.queuePaused ? "resume_queue" : "pause_queue") } }
                                    Button("Compacter") { if let id = conversation?.id { store.runtimeCommand(id, type: "compact") } }.disabled(session.running || session.capabilities["compaction"]?.available != true)
                                    Button("Exporter") { Task { await exportSession() } }
                                }
                                if session.state == "uncertain" { Text("L’acceptation d’un travail est incertaine. Consultez l’historique natif ; aucune action ne sera rejouée automatiquement. Vous pouvez continuer dans une copie depuis les sessions existantes.").font(.caption).foregroundStyle(.orange) }
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(7)
                        }
                        GroupBox("Capacités effectives") {
                            VStack(alignment: .leading, spacing: 5) {
                                ForEach(session.capabilities.keys.sorted(), id: \.self) { key in
                                    let capability = session.capabilities[key]!
                                    HStack(alignment: .top) {
                                        Image(systemName: capability.available ? "checkmark.circle" : "minus.circle").foregroundStyle(capability.available ? Color.green : Color.secondary)
                                        Text(key).frame(width: 110, alignment: .leading)
                                        Text(capability.available ? capability.support : (capability.reason ?? capability.support)).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }.padding(7)
                        }
                    }
                    if harnessID != "native" {
                        GroupBox("Sessions existantes") {
                            VStack(alignment: .leading, spacing: 8) {
                                Button("Retrouver les sessions de cette machine") { Task { await loadSessions() } }
                                ForEach(hostSessions, id: \.id) { session in
                                    HStack { VStack(alignment: .leading) { Text(session.title); Text(session.state).font(.caption).foregroundStyle(.secondary) }; Spacer(); Button("Ouvrir") { store.importRuntimeSession(session, target: target); dismiss() } }
                                }
                                ForEach(nativeSessions) { session in
                                    HStack {
                                        VStack(alignment: .leading) { Text(session.title).lineLimit(1); Text(session.reason ?? "Continuité de l’historique dans une copie isolée").font(.caption).foregroundStyle(.secondary) }
                                        Spacer()
                                        Button("Continuer dans une copie") { Task { await importNative(session) } }.disabled(!session.canContinue)
                                    }
                                }
                            }.padding(7)
                        }
                        GroupBox("Inspecter le harness") {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack { Picker("Fonction", selection: $subject) { ForEach(subjects, id: \.self) { Text($0).tag($0) } }; Button("Lire") { Task { await inspect() } } }
                                inspectionControls
                                if subject == "settings" {
                                    DisclosureGroup("Modifier les réglages de la session") {
                                        TextEditor(text: $configurationParameters).font(.caption.monospaced()).frame(height: 85)
                                        Button("Appliquer") {
                                            Task {
                                                do { let value = try JSONDecoder().decode(HarnessJSON.self, from: Data(configurationParameters.utf8)); guard case .object = value else { throw DesktopHarnessError.invalidResponse }; await configure(value) }
                                                catch { message = error.localizedDescription }
                                            }
                                        }.disabled(store.isGenerating(conversation?.id))
                                    }
                                }
                                if !output.isEmpty { Text(output).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                                DisclosureGroup("Opération native avancée") {
                                    TextField("Nom de l’opération exposée par l’adaptateur", text: $nativeMethod)
                                    TextEditor(text: $nativeParameters).font(.caption.monospaced()).frame(height: 80)
                                    Button("Exécuter l’opération") { Task { await nativeOperation() } }.disabled(nativeMethod.isEmpty || store.isGenerating(conversation?.id))
                                }
                            }.padding(7)
                        }
                    }
                }
            }
        }.padding(20).frame(minWidth: 640, idealWidth: 700, minHeight: 540, idealHeight: 720)
        .task(id: target) { await load() }
        .sheet(isPresented: $addingTarget) { targetForm }
        .sheet(isPresented: $addingACP) { acpForm }
        .sheet(isPresented: $addingSchedule) { scheduleForm }
        .sheet(isPresented: Binding(get: { editingResource != nil }, set: { if !$0 { editingResource = nil } })) { memoryForm }
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
            store.importRuntimeSession(try result["session"].decode(DesktopHarnessSession.self), target: target); dismiss()
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
                    store.edit { $0.draft += ($0.draft.isEmpty ? "" : " ") + prefix + name + " " }; dismiss()
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
    private func answer(_ value: HarnessJSON) { store.runtimeCommand(conversationID, type: "respond", value: .object(["interactionId": .string(interaction.id), "answer": value])) }
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label(interaction.title, systemImage: interaction.kind == "permission" ? "lock.shield" : "questionmark.bubble").font(.callout.weight(.semibold))
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
                            Button(label) { values[key] = label }.buttonStyle(.bordered)
                        }
                        TextField("Votre réponse", text: Binding(get: { values[key] ?? "" }, set: { values[key] = $0 }))
                    }
                } else {
                    TextField("Votre réponse", text: Binding(get: { values["value"] ?? "" }, set: { values["value"] = $0 }))
                    DisclosureGroup("Détails") { Text(interaction.detail.display).font(.caption.monospaced()).textSelection(.enabled) }
                }
                HStack {
                    Button("Répondre") { submitQuestions() }.disabled(values.values.allSatisfy { $0.isEmpty })
                    Button("Annuler le tour") { store.runtimeCommand(conversationID, type: "interrupt") }
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
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
