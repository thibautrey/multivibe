import SwiftUI

struct AutomationsView: View {
    @State private var coordinator = AutomationCoordinator.shared
    @State private var adding = false
    var body: some View {
        List {
            if let error = coordinator.error { Text(error).foregroundStyle(.red) }
            Section {
                ForEach(coordinator.store?.jobs ?? []) { job in
                    NavigationLink {
                        AutomationDetailView(job: job)
                    } label: {
                        VStack(alignment: .leading) {
                            Text(job.title)
                            Text(job.trigger.label).font(.caption).foregroundStyle(.secondary)
                            Text(coordinator.readiness(job)).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                if coordinator.store?.jobs.isEmpty != false { ContentUnavailableView("Aucune automatisation", systemImage: "clock.arrow.circlepath", description: Text("Demandez à l’agent de programmer une tâche ou ajoutez-en une ici.")) }
            }
            Section {
                Button("Autoriser les notifications") { Task { await coordinator.requestPermissions() } }
                Button("Autoriser les déclencheurs géographiques") { Task { await coordinator.requestPermissions(location: true) } }
            } footer: { Text("Sur l’iPhone, iOS choisit les périodes d’exécution en arrière-plan. Les tâches Cloud s’exécutent sans attendre l’ouverture de l’app.") }
        }
        .navigationTitle("Automatisations")
        .toolbar { Button("Ajouter", systemImage: "plus") { adding = true } }
        .sheet(isPresented: $adding) { AutomationEditor() }
        .task { try? await coordinator.syncCloud() }
        .refreshable { do { try await coordinator.syncCloud() } catch { coordinator.error = error.localizedDescription } }
    }
}
private struct AutomationDetailView: View {
    let job: AgentAutomation
    @State private var coordinator = AutomationCoordinator.shared
    @State private var editing = false
    @State private var webhook: String?
    var current: AgentAutomation? { coordinator.store?.jobs.first { $0.id == job.id } }
    var body: some View {
        Group {
        if let current {
        List {
            Section { Text(current.prompt); Text(current.trigger.label); Text(coordinator.readiness(current)) }
            Section {
                Button("Exécuter maintenant") { action("run") }
                Button(current.enabled ? "Mettre en pause" : "Reprendre") { action(current.enabled ? "pause" : "resume") }
                Button("Modifier") { editing = true }
                if current.executor == "cloud", current.trigger.kind == "event" {
                    Button("Configuration du webhook") {
                        Task {
                            do {
                                guard let cloud = coordinator.cloud else { return }
                                let scope = coordinator.scope
                                let response = try await cloud(AutomationCodec.encoder.encode(["action": "webhook", "id": current.id.uuidString]))
                                guard scope == coordinator.scope, self.current != nil else { return }
                                webhook = String(decoding: response, as: UTF8.self)
                            } catch { coordinator.error = error.localizedDescription }
                        }
                    }
                }
                Button("Supprimer", role: .destructive) { action("delete") }
            }
            if let webhook { Section("Webhook — accès privé") { Text(webhook).font(.caption.monospaced()).textSelection(.enabled) } }
            if let error = coordinator.error { Text(error).foregroundStyle(.red) }
            Section("Exécutions") {
                ForEach((coordinator.store?.runs ?? []).filter { $0.automationID == job.id }.reversed()) { run in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(run.createdAt.formatted()).font(.caption)
                        Text(["queued": "En attente", "running": "En cours", "waiting": "Différé", "succeeded": "Terminé", "failed": "Échec", "interrupted": "Interrompu", "cancelled": "Annulé", "submitted": "Transmis au Cloud"][run.status] ?? run.status).font(.caption).foregroundStyle(.secondary)
                        if !run.output.isEmpty { Text(run.output).textSelection(.enabled) }
                    }
                }
            }
        }.navigationTitle(current.title)
        .sheet(isPresented: $editing) { AutomationEditor(existing: current) }
        } else { ContentUnavailableView("Automatisation indisponible", systemImage: "clock") }
        }
    }
    private func action(_ action: String) {
        Task {
            do { _ = try await AutomationTools.execute(AutomationCodec.string(["action": action, "id": job.id.uuidString]), model: job.model, scope: coordinator.scope) }
            catch { coordinator.error = error.localizedDescription }
        }
    }
}
private struct AutomationEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(ConversationManager.self) private var manager
    var existing: AgentAutomation?
    @State private var title = ""
    @State private var prompt = ""
    @State private var kind = "daily"
    @State private var date = Date().addingTimeInterval(3600)
    @State private var minutes = "60"
    @State private var event = ""
    @State private var executor = "local"
    @State private var model = LocalModel.id
    @State private var latitude = ""
    @State private var longitude = ""
    @State private var radius = "200"
    @State private var transition = "enter"
    @State private var domains = ""
    @State private var error: String?
    @State private var saving = false
    @State private var notify = true
    var body: some View {
        NavigationStack {
            Form {
                TextField("Nom", text: $title)
                TextField("Consigne pour chaque exécution", text: $prompt, axis: .vertical)
                Picker("Déclencheur", selection: $kind) {
                    Text("À une date").tag("at"); Text("Régulièrement").tag("interval"); Text("Chaque jour").tag("daily"); Text("Zone géographique").tag("geofence"); Text("Événement externe").tag("event")
                }
                if kind == "at" { DatePicker("Date", selection: $date) }
                if kind == "daily" { DatePicker("Heure", selection: $date, displayedComponents: .hourAndMinute); Text(TimeZone.current.identifier).font(.caption) }
                if kind == "interval" { TextField("Intervalle en minutes (minimum 15)", text: $minutes).keyboardType(.numberPad) }
                if kind == "event" { TextField("Nom de l’événement", text: $event); Text("Dans Raccourcis, utilisez « Transmettre un événement à MultiVibe ». L’identifiant doit être stable pour le même événement.").font(.caption) }
                if kind == "geofence" {
                    TextField("Latitude", text: $latitude); TextField("Longitude", text: $longitude); TextField("Rayon en mètres", text: $radius)
                    Picker("Déclencher à", selection: $transition) { Text("L’arrivée").tag("enter"); Text("Au départ").tag("exit") }
                }
                Picker("Exécution", selection: $executor) { Text("Sur cet iPhone").tag("local"); Text("MultiVibe Cloud").tag("cloud") }.disabled(existing != nil)
                Picker("Modèle", selection: $model) {
                    if executor == "local" {
                        Text("Apple Foundation Local").tag(LocalModel.id)
                        ForEach(LocalModelLibrary.shared.installed) { item in Text(item.name).tag(item.id) }
                    } else {
                        Text("Choisir un modèle Cloud").tag(LocalModel.id)
                        ForEach(manager.models.filter { !ModelExecution($0.id).isLocal }) { item in Text(item.name ?? item.id).tag(item.id) }
                    }
                }
                if executor == "local" { Toggle("Notifier à la fin", isOn: $notify) }
                if executor == "local" { TextField("Sites autorisés : example.com, …", text: $domains).textInputAutocapitalization(.never).autocorrectionDisabled() }
                else { Text("La consigne et les événements seront traités dans MultiVibe Cloud. Les appels utilisent vos crédits et le modèle indiqué.").font(.caption) }
                if let error { Text(error).foregroundStyle(.red) }
            }.navigationTitle(existing == nil ? "Nouvelle automatisation" : "Modifier")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annuler") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Enregistrer") { save() }.disabled(saving) }
            }
            .onAppear {
                if let j = existing { title = j.title; prompt = j.prompt; kind = j.trigger.kind; executor = j.executor; model = j.model; notify = j.notify; event = j.trigger.event ?? ""; minutes = String((j.trigger.seconds ?? 3600) / 60); date = j.trigger.at ?? Calendar.current.date(bySettingHour: j.trigger.hour ?? 9, minute: j.trigger.minute ?? 0, second: 0, of: Date())!; latitude = j.trigger.latitude.map { String($0) } ?? ""; longitude = j.trigger.longitude.map { String($0) } ?? ""; radius = String(j.trigger.radius ?? 200); transition = j.trigger.transition ?? "enter"; domains = j.allowedDomains.joined(separator: ",") }
                else if ModelExecution(manager.selectedModel).isLocal { model = manager.selectedModel }
            }
        }
    }
    private func save() {
        saving = true
        Task {
            defer { saving = false }
            do {
                var a: [String: Any] = ["action": existing == nil ? "create" : "update", "title": title, "prompt": prompt, "kind": kind, "executor": executor, "model": model, "domains": domains, "notify": notify]
                if let existing { a["id"] = existing.id.uuidString }
                if kind == "at" { a["at"] = ISO8601DateFormatter().string(from: date) }
                if kind == "daily" { a["hour"] = Calendar.current.component(.hour, from: date); a["minute"] = Calendar.current.component(.minute, from: date); a["timeZone"] = existing?.trigger.timeZone ?? TimeZone.current.identifier }
                if kind == "interval" { guard let n = Int(minutes), (15...525600).contains(n) else { throw LocalAgentError.invalidInput }; a["seconds"] = n * 60 }
                if kind == "event" { a["event"] = event }
                if kind == "geofence" { a["latitude"] = Double(latitude); a["longitude"] = Double(longitude); a["radius"] = Double(radius); a["transition"] = transition }
                _ = try await AutomationTools.execute(String(decoding: JSONSerialization.data(withJSONObject: a), as: UTF8.self), model: model, scope: AutomationCoordinator.shared.scope)
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}
