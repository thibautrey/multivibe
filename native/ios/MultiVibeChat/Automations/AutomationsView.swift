import SwiftUI

private enum AutomationPreset: String, Identifiable {
    case blank, briefing, watch
    var id: String { rawValue }
    var title: String { switch self { case .blank: ""; case .briefing: "Briefing quotidien"; case .watch: "Veille hebdomadaire" } }
    var prompt: String { switch self {
    case .blank: ""
    case .briefing: "Prépare un briefing concis sur les sujets qui comptent pour moi, avec les informations nouvelles et leurs sources."
    case .watch: "Recherche les nouveautés importantes sur ce sujet et résume uniquement ce qui a changé depuis la dernière exécution."
    } }
}

struct AutomationsView: View {
    @State private var coordinator = AutomationCoordinator.shared
    @State private var editor: AutomationPreset?
    @State private var deletionTarget: AgentAutomation?
    private var jobs: [AgentAutomation] { coordinator.store?.jobs.sorted { $0.createdAt > $1.createdAt } ?? [] }

    var body: some View {
        List {
            if let error = coordinator.error {
                MultiVibeStatusMessage(message: error, actionTitle: "Fermer") { coordinator.error = nil }
            }
            Section {
                if jobs.isEmpty {
                    ContentUnavailableView("Aucune tâche planifiée", systemImage: "calendar.badge.clock",
                        description: Text("Créez une tâche ou partez d’une suggestion."))
                        .frame(maxWidth: .infinity)
                } else {
                    ForEach(jobs) { job in
                        NavigationLink { AutomationDetailView(job: job) } label: { AutomationRow(job: job) }
                            .contextMenu {
                                Button(job.enabled ? "Mettre en pause" : "Reprendre", systemImage: job.enabled ? "pause.circle" : "play.circle") { action(job.enabled ? "pause" : "resume", job) }
                                Button("Exécuter maintenant", systemImage: "play.fill") { action("run", job) }
                                Button("Supprimer", systemImage: "trash", role: .destructive) { deletionTarget = job }
                            }
                    }
                }
            }
            Section("Suggestions") {
                StarterRow(icon: "sun.max.fill", color: .orange, title: "Briefing quotidien", subtitle: "Une synthèse personnalisée chaque matin") { editor = .briefing }
                StarterRow(icon: "sparkles", color: MultiVibeTheme.accent, title: "Veille hebdomadaire", subtitle: "Les nouveautés importantes d’un sujet") { editor = .watch }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Tâches planifiées")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button(notificationPermissionTitle, systemImage: notificationPermissionIcon) {
                        if coordinator.notificationAuthorization == .notDetermined {
                            Task { await coordinator.requestPermissions() }
                        } else { openSettings() }
                    }
                    Button(locationPermissionTitle, systemImage: locationPermissionIcon) {
                        if coordinator.locationAuthorization == .denied || coordinator.locationAuthorization == .restricted {
                            openSettings()
                        } else { Task { await coordinator.requestPermissions(location: true) } }
                    }
                } label: {
                    Label("Autorisations", systemImage: "ellipsis")
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            Button { editor = .blank } label: {
                Label("Planifier une tâche", systemImage: "plus")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(MultiVibeTheme.accent)
            .padding(.horizontal, 20)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial)
            .accessibilityIdentifier("scheduleAutomation")
        }
        .sheet(item: $editor) { AutomationEditor(preset: $0) }
        .confirmationDialog("Supprimer cette automatisation ?", isPresented: Binding(
            get: { deletionTarget != nil },
            set: { if !$0 { deletionTarget = nil } }
        ), titleVisibility: .visible) {
            Button("Supprimer", role: .destructive) {
                guard let job = deletionTarget else { return }
                deletionTarget = nil
                action("delete", job)
            }
        } message: {
            Text("La planification et son historique d’exécution seront supprimés.")
        }
        .task {
            await coordinator.refreshPermissionStatus()
            try? await coordinator.syncCloud()
        }
        .refreshable { do { try await coordinator.syncCloud() } catch { coordinator.error = error.localizedDescription } }
    }
    private var notificationPermissionTitle: String {
        switch coordinator.notificationAuthorization {
        case .authorized, .provisional, .ephemeral: "Notifications autorisées"
        case .denied: "Notifications désactivées · Ouvrir Réglages"
        case .notDetermined: "Autoriser les notifications"
        @unknown default: "Gérer les notifications"
        }
    }
    private var notificationPermissionIcon: String {
        switch coordinator.notificationAuthorization {
        case .authorized, .provisional, .ephemeral: "checkmark.circle.fill"
        case .denied: "bell.slash"
        default: "bell"
        }
    }
    private var locationPermissionTitle: String {
        switch coordinator.locationAuthorization {
        case .authorizedAlways: "Zones géographiques autorisées"
        case .authorizedWhenInUse: "Autoriser les zones en arrière-plan"
        case .denied, .restricted: "Localisation désactivée · Ouvrir Réglages"
        case .notDetermined: "Autoriser les zones géographiques"
        @unknown default: "Gérer la localisation"
        }
    }
    private var locationPermissionIcon: String {
        switch coordinator.locationAuthorization {
        case .authorizedAlways: "checkmark.circle.fill"
        case .denied, .restricted: "location.slash"
        default: "location"
        }
    }
    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
    private func action(_ name: String, _ job: AgentAutomation) {
        Task { do { _ = try await AutomationTools.execute(AutomationCodec.string(["action": name, "id": job.id.uuidString]), model: job.model, scope: coordinator.scope) } catch { coordinator.error = error.localizedDescription } }
    }
}

private struct AutomationRow: View {
    let job: AgentAutomation
    private var icon: String { switch job.trigger.kind { case "at": "calendar.badge.clock"; case "daily": "sun.max"; case "interval": "repeat"; case "geofence": "location"; default: "bolt" } }
    private var schedule: String {
        guard job.trigger.kind == "daily" else { return job.trigger.label }
        let time = String(format: "Chaque jour à %02d:%02d", job.trigger.hour ?? 0, job.trigger.minute ?? 0)
        guard let timeZone = job.trigger.timeZone, timeZone != TimeZone.current.identifier else { return time }
        return time + " · " + timeZone
    }
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.body.weight(.semibold))
                .foregroundStyle(MultiVibeTheme.accent)
                .frame(width: 34, height: 34)
                .background(MultiVibeTheme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(job.title).font(.headline).foregroundStyle(.primary).lineLimit(1)
                    if !job.enabled {
                        Image(systemName: "pause.circle.fill").font(.caption).foregroundStyle(.secondary)
                            .accessibilityLabel("En pause")
                    }
                }
                Text(job.prompt).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                Label(schedule, systemImage: "clock")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 6)
    }
}

private struct StarterRow: View {
    let icon: String, color: Color, title: String, subtitle: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.body.weight(.semibold)).foregroundStyle(color).frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline).foregroundStyle(.primary)
                    Text(subtitle).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.leading).lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(); Image(systemName: "plus").font(.headline).foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}

private struct AutomationDetailView: View {
    let job: AgentAutomation
    @Environment(\.dismiss) private var dismiss
    @State private var coordinator = AutomationCoordinator.shared
    @State private var editing = false
    @State private var webhook: String?
    @State private var confirmsDeletion = false
    var current: AgentAutomation? { coordinator.store?.jobs.first { $0.id == job.id } }
    var body: some View {
        Group {
            if let current {
                List {
                    Section { Text(current.prompt); LabeledContent("Planification", value: current.trigger.label); LabeledContent("Exécution", value: current.executor == "cloud" ? "MultiVibe Cloud" : "Cet iPhone") }
                    Section {
                        Button("Exécuter maintenant", systemImage: "play.fill") { action("run") }
                        Button(current.enabled ? "Mettre en pause" : "Reprendre", systemImage: current.enabled ? "pause.circle" : "play.circle") { action(current.enabled ? "pause" : "resume") }
                        Button("Modifier", systemImage: "pencil") { editing = true }
                        if current.executor == "cloud", current.trigger.kind == "event" { Button("Configuration du webhook", systemImage: "link") { loadWebhook(current) } }
                        Button("Supprimer", systemImage: "trash", role: .destructive) { confirmsDeletion = true }
                    }
                    if let webhook { Section("Webhook — accès privé") { Text(webhook).font(.caption.monospaced()).textSelection(.enabled) } }
                    if let error = coordinator.error { MultiVibeStatusMessage(message: error) }
                    Section("Exécutions") {
                        let runs = (coordinator.store?.runs ?? []).filter { $0.automationID == job.id }
                        if runs.isEmpty {
                            ContentUnavailableView("Aucune exécution", systemImage: "clock.arrow.circlepath",
                                description: Text("Les résultats apparaîtront ici après la première exécution."))
                        }
                        ForEach(runs.reversed()) { run in
                            VStack(alignment: .leading, spacing: 8) { Text(run.createdAt.formatted()).font(.caption); Text(status(run.status)).font(.caption).foregroundStyle(.secondary); if !run.output.isEmpty { Text(run.output).textSelection(.enabled) } }
                        }
                    }
                }
                .navigationTitle(current.title)
                .sheet(isPresented: $editing) { AutomationEditor(existing: current) }
                .confirmationDialog("Supprimer cette automatisation ?", isPresented: $confirmsDeletion, titleVisibility: .visible) {
                    Button("Supprimer", role: .destructive) { action("delete") }
                } message: {
                    Text("La planification et son historique d’exécution seront supprimés.")
                }
            } else { ContentUnavailableView("Automatisation indisponible", systemImage: "clock") }
        }
    }
    private func status(_ value: String) -> String { ["queued":"En attente","running":"En cours","waiting":"Différé","succeeded":"Terminé","failed":"Échec","interrupted":"Interrompu","cancelled":"Annulé","submitted":"Transmis au Cloud"][value] ?? value }
    private func action(_ action: String) { Task { do {
        _ = try await AutomationTools.execute(AutomationCodec.string(["action": action, "id": job.id.uuidString]), model: job.model, scope: coordinator.scope)
        if action == "delete" { dismiss() }
    } catch { coordinator.error = error.localizedDescription } } }
    private func loadWebhook(_ current: AgentAutomation) { Task { do { guard let cloud = coordinator.cloud else { return }; let scope = coordinator.scope; let response = try await cloud(AutomationCodec.encoder.encode(["action":"webhook","id":current.id.uuidString])); guard scope == coordinator.scope, self.current != nil else { return }; webhook = String(decoding: response, as: UTF8.self) } catch { coordinator.error = error.localizedDescription } } }
}

private struct AutomationEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(ConversationManager.self) private var manager
    var existing: AgentAutomation?
    var preset: AutomationPreset = .blank
    @State private var title = ""
    @State private var prompt = ""
    @State private var kind = "daily"
    @State private var minutes = "60"
    @State private var event = ""
    @State private var executor = "local"
    @State private var model = LocalModel.id
    @State private var latitude = ""
    @State private var longitude = ""
    @State private var radius = "200"
    @State private var transition = "enter"
    @State private var domains = ""
    @State private var date = Date().addingTimeInterval(3600)
    @State private var error: String?
    @State private var saving = false
    @State private var notify = true
    @State private var advanced = false

    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedPrompt: String { prompt.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var triggerValidationMessage: String? {
        switch kind {
        case "interval":
            guard let value = Int(minutes), (15...525_600).contains(value) else {
                return "Choisissez un intervalle compris entre 15 minutes et un an."
            }
        case "event":
            guard !event.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return "Donnez un nom à l’événement."
            }
        case "geofence":
            guard let lat = Double(latitude), (-90...90).contains(lat),
                  let lon = Double(longitude), (-180...180).contains(lon),
                  let distance = Double(radius), (100...100_000).contains(distance) else {
                return "Renseignez des coordonnées valides et un rayon de 100 m à 100 km."
            }
        default: break
        }
        return nil
    }
    private var modelValidationMessage: String? {
        if executor == "cloud" && ModelExecution(model).isLocal { return "Choisissez un modèle Cloud." }
        if executor == "local" && !ModelExecution(model).isLocal { return "Choisissez un modèle installé sur cet iPhone." }
        return nil
    }
    private var canSave: Bool {
        !saving && !trimmedTitle.isEmpty && !trimmedPrompt.isEmpty
            && triggerValidationMessage == nil && modelValidationMessage == nil
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    editorCard {
                        TextField("Nom de la tâche", text: $title).font(.title3.bold()).accessibilityIdentifier("automationTitle")
                        Divider()
                        TextField("Que doit faire MultiVibe ?", text: $prompt, axis: .vertical).lineLimit(4...12).accessibilityIdentifier("automationPrompt")
                    }
                    editorCard {
                        LabeledContent("Répéter") { Picker("Répéter", selection: $kind) { Text("Une fois").tag("at"); Text("Chaque jour").tag("daily"); Text("À intervalle régulier").tag("interval"); Text("Dans une zone").tag("geofence"); Text("À un événement").tag("event") }.labelsHidden() }
                        Divider(); triggerFields
                        if let triggerValidationMessage {
                            Label(triggerValidationMessage, systemImage: "exclamationmark.circle")
                                .font(.caption).foregroundStyle(.orange)
                        }
                    }
                    editorCard {
                        LabeledContent("Exécuter avec") { Picker("Exécution", selection: $executor) { Text("Cet iPhone").tag("local"); Text("MultiVibe Cloud").tag("cloud") }.labelsHidden().disabled(existing != nil) }
                        Divider()
                        LabeledContent("Modèle") { modelPicker.labelsHidden() }
                        if let modelValidationMessage {
                            Label(modelValidationMessage, systemImage: "exclamationmark.circle")
                                .font(.caption).foregroundStyle(.orange)
                        }
                        if executor == "local" { Divider(); Toggle("Notifier à la fin", isOn: $notify) }
                    }
                    DisclosureGroup("Options avancées", isExpanded: $advanced) {
                        VStack(spacing: 14) {
                            if executor == "local" { TextField("Sites autorisés : example.com", text: $domains).textInputAutocapitalization(.never).autocorrectionDisabled() }
                            Text(executor == "cloud" ? "La tâche continue dans MultiVibe Cloud et utilise vos crédits." : "iOS choisit le moment exact des exécutions en arrière-plan.").font(.caption).foregroundStyle(.secondary)
                        }.padding(.top, 14)
                    }.padding(18).background(MultiVibeTheme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    if let error { MultiVibeStatusMessage(message: error) }
                }.padding(18)
            }.background(MultiVibeTheme.softAccent.ignoresSafeArea())
                .navigationTitle(existing == nil ? "Planifier" : "Modifier")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Annuler") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(saving ? "Enregistrement…" : "Enregistrer") { save() }
                            .disabled(!canSave)
                            .accessibilityHint(canSave ? "" : "Complétez les champs signalés avant d’enregistrer.")
                            .accessibilityIdentifier("saveAutomation")
                    }
                }
                .onAppear(perform: load)
        }
    }
    @ViewBuilder private var triggerFields: some View {
        if kind == "at" { DatePicker("Date et heure", selection: $date, in: Date()...) }
        else if kind == "daily" { DatePicker("Chaque jour à", selection: $date, displayedComponents: .hourAndMinute); Text(TimeZone.current.identifier).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading) }
        else if kind == "interval" { HStack { Text("Toutes les"); TextField("60", text: $minutes).keyboardType(.numberPad).multilineTextAlignment(.trailing).accessibilityLabel("Intervalle en minutes"); Text("minutes").foregroundStyle(.secondary) } }
        else if kind == "event" { TextField("Nom de l’événement", text: $event); Text("Utilisable depuis Raccourcis ou un webhook Cloud.").font(.caption).foregroundStyle(.secondary) }
        else if kind == "geofence" { TextField("Latitude", text: $latitude).keyboardType(.numbersAndPunctuation); Divider(); TextField("Longitude", text: $longitude).keyboardType(.numbersAndPunctuation); Divider(); TextField("Rayon en mètres", text: $radius).keyboardType(.numberPad); Divider(); Picker("Déclencher", selection: $transition) { Text("À l’arrivée").tag("enter"); Text("Au départ").tag("exit") } }
    }
    private var modelPicker: some View { Picker("Modèle", selection: $model) { if executor == "local" { Text("Apple Foundation Local").tag(LocalModel.id); ForEach(LocalModelLibrary.shared.installed) { Text($0.name).tag($0.id) } } else { Text("Choisir un modèle Cloud").tag(LocalModel.id); ForEach(manager.models.filter { !ModelExecution($0.id).isLocal }) { Text($0.name ?? $0.id).tag($0.id) } } } }
    private func editorCard<Content: View>(@ViewBuilder content: () -> Content) -> some View { VStack(alignment: .leading, spacing: 14, content: content).padding(18).background(MultiVibeTheme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous)).overlay(RoundedRectangle(cornerRadius: 22).stroke(.primary.opacity(0.07))) }
    private func load() {
        if let j = existing { title=j.title; prompt=j.prompt; kind=j.trigger.kind; executor=j.executor; model=j.model; notify=j.notify; event=j.trigger.event ?? ""; minutes=String((j.trigger.seconds ?? 3600)/60); date=j.trigger.at ?? Calendar.current.date(bySettingHour:j.trigger.hour ?? 9,minute:j.trigger.minute ?? 0,second:0,of:Date())!; latitude=j.trigger.latitude.map { String($0) } ?? ""; longitude=j.trigger.longitude.map { String($0) } ?? ""; radius=String(j.trigger.radius ?? 200); transition=j.trigger.transition ?? "enter"; domains=j.allowedDomains.joined(separator:",") }
        else { title=preset.title; prompt=preset.prompt; if preset == .watch { kind="interval"; minutes="10080" }; if ModelExecution(manager.selectedModel).isLocal { model=manager.selectedModel } }
    }
    private func save() {
        guard canSave else { return }
        saving=true
        Task { defer { saving=false }; do {
            var a:[String:Any]=["action":existing == nil ? "create":"update","title":title,"prompt":prompt,"kind":kind,"executor":executor,"model":model,"domains":domains,"notify":notify]
            if let existing { a["id"]=existing.id.uuidString }
            if kind=="at" { a["at"]=ISO8601DateFormatter().string(from:date) }
            if kind=="daily" { a["hour"]=Calendar.current.component(.hour,from:date); a["minute"]=Calendar.current.component(.minute,from:date); a["timeZone"]=existing?.trigger.timeZone ?? TimeZone.current.identifier }
            if kind=="interval" { guard let n=Int(minutes),(15...525600).contains(n) else { throw AutomationFailure.invalid("Choisissez un intervalle d’au moins 15 minutes.") }; a["seconds"]=n*60 }
            if kind=="event" { a["event"]=event }
            if kind=="geofence" { a["latitude"]=Double(latitude); a["longitude"]=Double(longitude); a["radius"]=Double(radius); a["transition"]=transition }
            _=try await AutomationTools.execute(String(decoding:JSONSerialization.data(withJSONObject:a),as:UTF8.self),model:model,scope:AutomationCoordinator.shared.scope); dismiss()
        } catch { self.error=error.localizedDescription } }
    }
}
