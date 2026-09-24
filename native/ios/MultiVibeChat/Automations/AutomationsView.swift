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
    private var jobs: [AgentAutomation] { coordinator.store?.jobs.sorted { $0.createdAt > $1.createdAt } ?? [] }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                header
                if let error = coordinator.error { Text(error).foregroundStyle(.red).padding(.horizontal, 4) }
                if jobs.isEmpty { emptyState } else {
                    Text("Vos tâches").font(.title3.bold()).padding(.horizontal, 4)
                    ForEach(jobs) { job in
                        NavigationLink { AutomationDetailView(job: job) } label: { AutomationCard(job: job) }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button(job.enabled ? "Mettre en pause" : "Reprendre", systemImage: job.enabled ? "pause.circle" : "play.circle") { action(job.enabled ? "pause" : "resume", job) }
                                Button("Exécuter maintenant", systemImage: "play.fill") { action("run", job) }
                                Button("Supprimer", systemImage: "trash", role: .destructive) { action("delete", job) }
                            }
                    }
                }
                starterSection
                permissionSection
            }.padding(.horizontal, 18).padding(.bottom, 34)
        }
        .background(MultiVibeTheme.softAccent.ignoresSafeArea())
        .navigationTitle("Automatisations")
        .toolbar { Button("Ajouter", systemImage: "plus") { editor = .blank }.accessibilityIdentifier("addAutomation") }
        .safeAreaInset(edge: .bottom) {
            Button { editor = .blank } label: {
                HStack { Image(systemName: "plus"); Text("Planifier une tâche").fontWeight(.semibold); Spacer(); Image(systemName: "arrow.up").padding(8).background(MultiVibeTheme.accent, in: Circle()).foregroundStyle(.white) }
                    .padding(.leading, 18).padding(.trailing, 8).padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule()).overlay(Capsule().stroke(.primary.opacity(0.08)))
                    .shadow(color: .black.opacity(0.08), radius: 18, y: 7)
            }.buttonStyle(.plain).padding(.horizontal, 20).padding(.bottom, 8).accessibilityIdentifier("scheduleAutomation")
        }
        .sheet(item: $editor) { AutomationEditor(preset: $0) }
        .task { try? await coordinator.syncCloud() }
        .refreshable { do { try await coordinator.syncCloud() } catch { coordinator.error = error.localizedDescription } }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "clock.badge.checkmark").font(.title2).foregroundStyle(MultiVibeTheme.accent)
            Text("Planifiez ce qui compte").font(.largeTitle.bold())
            Text("MultiVibe exécutera votre consigne à la date choisie, régulièrement ou lorsqu’un événement se produit.").foregroundStyle(.secondary)
        }.padding(.top, 10).padding(.horizontal, 4)
    }
    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Aucune tâche planifiée").font(.title3.bold())
            Text("Commencez avec un exemple ou créez une tâche adaptée à votre besoin.").foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(22)
            .background(MultiVibeTheme.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
    private var starterSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Pour commencer").font(.title3.bold()).padding(.horizontal, 4)
            StarterCard(icon: "sun.max.fill", color: .orange, title: "Briefing quotidien", subtitle: "Recevez chaque matin une synthèse personnalisée.") { editor = .briefing }
            StarterCard(icon: "sparkles", color: MultiVibeTheme.accent, title: "Veille hebdomadaire", subtitle: "Suivez chaque semaine les nouveautés d’un sujet.") { editor = .watch }
        }
    }
    private var permissionSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Autorisations locales").font(.headline)
            Button("Autoriser les notifications", systemImage: "bell") { Task { await coordinator.requestPermissions() } }
            Button("Autoriser les zones géographiques", systemImage: "location") { Task { await coordinator.requestPermissions(location: true) } }
            Text("iOS choisit les périodes d’exécution en arrière-plan. Les tâches MultiVibe Cloud continuent même lorsque l’app est fermée.").font(.caption).foregroundStyle(.secondary)
        }.padding(20).background(MultiVibeTheme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
    private func action(_ name: String, _ job: AgentAutomation) {
        Task { do { _ = try await AutomationTools.execute(AutomationCodec.string(["action": name, "id": job.id.uuidString]), model: job.model, scope: coordinator.scope) } catch { coordinator.error = error.localizedDescription } }
    }
}

private struct AutomationCard: View {
    let job: AgentAutomation
    private var icon: String { switch job.trigger.kind { case "at": "calendar.badge.clock"; case "daily": "sun.max"; case "interval": "repeat"; case "geofence": "location"; default: "bolt" } }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                Image(systemName: icon).font(.title3).foregroundStyle(MultiVibeTheme.accent).frame(width: 34, height: 34).background(MultiVibeTheme.accent.opacity(0.12), in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text(job.trigger.kind == "at" ? "À VENIR" : job.trigger.kind == "daily" ? "QUOTIDIEN" : "AUTOMATISÉE").font(.caption2.bold()).foregroundStyle(MultiVibeTheme.accent)
                    Text(job.title).font(.title3.bold()).foregroundStyle(.primary)
                }
                Spacer(); Image(systemName: "ellipsis").foregroundStyle(.secondary)
            }
            Text(job.prompt).foregroundStyle(.secondary).lineLimit(3)
            Divider()
            HStack {
                Label(job.trigger.label, systemImage: "clock").font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                Text(job.enabled ? "Active" : "En pause").font(.caption.bold()).padding(.horizontal, 10).padding(.vertical, 6)
                    .background((job.enabled ? MultiVibeTheme.accent : Color.secondary).opacity(0.12), in: Capsule())
                    .foregroundStyle(job.enabled ? MultiVibeTheme.accent : .secondary)
            }
        }.padding(20).background(MultiVibeTheme.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(.primary.opacity(0.07)))
    }
}

private struct StarterCard: View {
    let icon: String, color: Color, title: String, subtitle: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon).font(.title2).foregroundStyle(color).frame(width: 40)
                VStack(alignment: .leading, spacing: 4) { Text(title).font(.headline).foregroundStyle(.primary); Text(subtitle).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.leading) }
                Spacer(); Image(systemName: "plus").font(.headline).foregroundStyle(.secondary)
            }.padding(18).background(MultiVibeTheme.card.opacity(0.7), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(style: StrokeStyle(lineWidth: 1, dash: [6])).foregroundStyle(.secondary.opacity(0.28)))
        }.buttonStyle(.plain)
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
                    Section { Text(current.prompt); LabeledContent("Planification", value: current.trigger.label); LabeledContent("Exécution", value: current.executor == "cloud" ? "MultiVibe Cloud" : "Cet iPhone") }
                    Section {
                        Button("Exécuter maintenant", systemImage: "play.fill") { action("run") }
                        Button(current.enabled ? "Mettre en pause" : "Reprendre", systemImage: current.enabled ? "pause.circle" : "play.circle") { action(current.enabled ? "pause" : "resume") }
                        Button("Modifier", systemImage: "pencil") { editing = true }
                        if current.executor == "cloud", current.trigger.kind == "event" { Button("Configuration du webhook", systemImage: "link") { loadWebhook(current) } }
                        Button("Supprimer", systemImage: "trash", role: .destructive) { action("delete") }
                    }
                    if let webhook { Section("Webhook — accès privé") { Text(webhook).font(.caption.monospaced()).textSelection(.enabled) } }
                    if let error = coordinator.error { Text(error).foregroundStyle(.red) }
                    Section("Exécutions") {
                        ForEach((coordinator.store?.runs ?? []).filter { $0.automationID == job.id }.reversed()) { run in
                            VStack(alignment: .leading, spacing: 8) { Text(run.createdAt.formatted()).font(.caption); Text(status(run.status)).font(.caption).foregroundStyle(.secondary); if !run.output.isEmpty { Text(run.output).textSelection(.enabled) } }
                        }
                    }
                }.navigationTitle(current.title).sheet(isPresented: $editing) { AutomationEditor(existing: current) }
            } else { ContentUnavailableView("Automatisation indisponible", systemImage: "clock") }
        }
    }
    private func status(_ value: String) -> String { ["queued":"En attente","running":"En cours","waiting":"Différé","succeeded":"Terminé","failed":"Échec","interrupted":"Interrompu","cancelled":"Annulé","submitted":"Transmis au Cloud"][value] ?? value }
    private func action(_ action: String) { Task { do { _ = try await AutomationTools.execute(AutomationCodec.string(["action": action, "id": job.id.uuidString]), model: job.model, scope: coordinator.scope) } catch { coordinator.error = error.localizedDescription } } }
    private func loadWebhook(_ current: AgentAutomation) { Task { do { guard let cloud = coordinator.cloud else { return }; let scope = coordinator.scope; let response = try await cloud(AutomationCodec.encoder.encode(["action":"webhook","id":current.id.uuidString])); guard scope == coordinator.scope, self.current != nil else { return }; webhook = String(decoding: response, as: UTF8.self) } catch { coordinator.error = error.localizedDescription } } }
}

private struct AutomationEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(ConversationManager.self) private var manager
    var existing: AgentAutomation?
    var preset: AutomationPreset = .blank
    @State private var title = "", prompt = "", kind = "daily", minutes = "60", event = "", executor = "local", model = LocalModel.id, latitude = "", longitude = "", radius = "200", transition = "enter", domains = ""
    @State private var date = Date().addingTimeInterval(3600)
    @State private var error: String?
    @State private var saving = false, notify = true, advanced = false

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
                    }
                    editorCard {
                        LabeledContent("Exécuter avec") { Picker("Exécution", selection: $executor) { Text("Cet iPhone").tag("local"); Text("MultiVibe Cloud").tag("cloud") }.labelsHidden().disabled(existing != nil) }
                        Divider()
                        LabeledContent("Modèle") { modelPicker.labelsHidden() }
                        if executor == "local" { Divider(); Toggle("Notifier à la fin", isOn: $notify) }
                    }
                    DisclosureGroup("Options avancées", isExpanded: $advanced) {
                        VStack(spacing: 14) {
                            if executor == "local" { TextField("Sites autorisés : example.com", text: $domains).textInputAutocapitalization(.never).autocorrectionDisabled() }
                            Text(executor == "cloud" ? "La tâche continue dans MultiVibe Cloud et utilise vos crédits." : "iOS choisit le moment exact des exécutions en arrière-plan.").font(.caption).foregroundStyle(.secondary)
                        }.padding(.top, 14)
                    }.padding(18).background(MultiVibeTheme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    if let error { Text(error).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading) }
                }.padding(18)
            }.background(MultiVibeTheme.softAccent.ignoresSafeArea())
                .navigationTitle(existing == nil ? "Planifier" : "Modifier")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Annuler") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button(saving ? "Enregistrement…" : "Enregistrer") { save() }.disabled(saving || title.trimmingCharacters(in: .whitespaces).isEmpty || prompt.trimmingCharacters(in: .whitespaces).isEmpty).accessibilityIdentifier("saveAutomation") }
                }
                .onAppear(perform: load)
        }
    }
    @ViewBuilder private var triggerFields: some View {
        if kind == "at" { DatePicker("Date et heure", selection: $date, in: Date()...) }
        else if kind == "daily" { DatePicker("Chaque jour à", selection: $date, displayedComponents: .hourAndMinute); Text(TimeZone.current.identifier).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading) }
        else if kind == "interval" { HStack { Text("Toutes les"); TextField("60", text: $minutes).keyboardType(.numberPad).multilineTextAlignment(.trailing); Text("minutes").foregroundStyle(.secondary) } }
        else if kind == "event" { TextField("Nom de l’événement", text: $event); Text("Utilisable depuis Raccourcis ou un webhook Cloud.").font(.caption).foregroundStyle(.secondary) }
        else if kind == "geofence" { TextField("Latitude", text: $latitude).keyboardType(.decimalPad); Divider(); TextField("Longitude", text: $longitude).keyboardType(.decimalPad); Divider(); TextField("Rayon en mètres", text: $radius).keyboardType(.numberPad); Divider(); Picker("Déclencher", selection: $transition) { Text("À l’arrivée").tag("enter"); Text("Au départ").tag("exit") } }
    }
    private var modelPicker: some View { Picker("Modèle", selection: $model) { if executor == "local" { Text("Apple Foundation Local").tag(LocalModel.id); ForEach(LocalModelLibrary.shared.installed) { Text($0.name).tag($0.id) } } else { Text("Choisir un modèle Cloud").tag(LocalModel.id); ForEach(manager.models.filter { !ModelExecution($0.id).isLocal }) { Text($0.name ?? $0.id).tag($0.id) } } } }
    private func editorCard<Content: View>(@ViewBuilder content: () -> Content) -> some View { VStack(alignment: .leading, spacing: 14, content: content).padding(18).background(MultiVibeTheme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous)).overlay(RoundedRectangle(cornerRadius: 22).stroke(.primary.opacity(0.07))) }
    private func load() {
        if let j = existing { title=j.title; prompt=j.prompt; kind=j.trigger.kind; executor=j.executor; model=j.model; notify=j.notify; event=j.trigger.event ?? ""; minutes=String((j.trigger.seconds ?? 3600)/60); date=j.trigger.at ?? Calendar.current.date(bySettingHour:j.trigger.hour ?? 9,minute:j.trigger.minute ?? 0,second:0,of:Date())!; latitude=j.trigger.latitude.map(String.init) ?? ""; longitude=j.trigger.longitude.map(String.init) ?? ""; radius=String(j.trigger.radius ?? 200); transition=j.trigger.transition ?? "enter"; domains=j.allowedDomains.joined(separator:",") }
        else { title=preset.title; prompt=preset.prompt; if preset == .watch { kind="interval"; minutes="10080" }; if ModelExecution(manager.selectedModel).isLocal { model=manager.selectedModel } }
    }
    private func save() {
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
