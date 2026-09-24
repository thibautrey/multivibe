import SwiftUI

struct LocalModelsView: View {
    @Environment(ConversationManager.self) private var manager
    let search: String
    let select: (ModelOption) -> Void
    @State private var results: [DownloadableModel] = []
    @State private var next: URL?
    @State private var loading = false
    @State private var error: String?
    private var library: LocalModelLibrary { .shared }
    private func matches(_ model: DownloadableModel) -> Bool {
        search.isEmpty || (model.name + " " + model.publisher).localizedCaseInsensitiveContains(search)
    }
    var body: some View {
        List {
            let active = library.installations.filter { $0.state != .installed && matches($0.model) }
            if !active.isEmpty {
                Section("Téléchargements") { ForEach(active) { LocalModelCard(model: $0.model, select: select) } }
            }
            Section("Téléchargés") {
                let installed = library.installed.filter(matches)
                if installed.isEmpty { Text("Vos modèles téléchargés seront disponibles ici, même sans Internet.").foregroundStyle(.secondary) }
                ForEach(installed) { LocalModelCard(model: $0, select: select) }
                if !library.installed.isEmpty {
                    Text("Stockage utilisé : " + ByteCountFormatter.string(fromByteCount: library.installed.reduce(0) { $0 + $1.bytes }, countStyle: .file))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Section(search.isEmpty ? "À télécharger" : "Résultats") {
                let candidates = search.isEmpty ? HuggingFaceCatalog.bundled : results
                ForEach(candidates.filter { library.installation($0.id) == nil && matches($0) }) { LocalModelCard(model: $0, select: select) }
                if loading { ProgressView("Recherche de modèles…") }
                if let error { Text(error).font(.callout); Button("Réessayer") { Task { await load(reset: true) } } }
                if !search.isEmpty && !loading && results.isEmpty && error == nil {
                    Text("Aucun modèle pris en charge trouvé. Essayez un autre nom.").foregroundStyle(.secondary)
                }
                if next != nil && !loading { Button("Afficher plus") { Task { await load(reset: false) } } }
            }
            Section {
                Button("Modifier le choix des données mobiles") { library.resetCellularChoice() }
                    .font(.footnote)
            }
        }
        .task(id: search) {
            next = nil
            if search.isEmpty { results = []; return }
            results = library.cachedModels.filter(matches)
            do { try await Task.sleep(for: .milliseconds(350)); try Task.checkCancellation(); await load(reset: true) } catch { }
        }
        .onChange(of: library.installed.map(\.id), initial: true) { _, _ in manager.refreshDownloadedModels() }
    }
    @MainActor private func load(reset: Bool) async {
        let query = search
        guard !query.isEmpty else { return }
        loading = true
        defer { if query == search { loading = false } }
        do {
            let page = try await HuggingFaceCatalog.shared.search(query, next: reset ? nil : next)
            try Task.checkCancellation(); guard query == search else { return }
            var seen = Set<String>()
            results = ((reset ? [] : results) + page.models).filter { seen.insert($0.id).inserted }
            next = page.next; error = nil; library.cache(page.models)
        } catch is CancellationError { }
        catch { if query == search { self.error = "Recherche indisponible. Les modèles déjà enregistrés restent accessibles." } }
    }
}

struct LocalModelDiscoveryShelf: View {
    let select: (ModelOption) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Sur cet appareil · hors ligne").font(.title3.bold())
            ForEach(HuggingFaceCatalog.bundled.filter { LocalDeviceBudget.current.problem($0, downloading: false) == nil }) {
                LocalModelCard(model: $0, select: select).padding(12)
                    .background(.background, in: RoundedRectangle(cornerRadius: 18))
            }
        }
    }
}

struct LocalModelCard: View {
    @Environment(ConversationManager.self) private var manager
    let model: DownloadableModel
    let select: (ModelOption) -> Void
    @State private var deleting = false
    private var library: LocalModelLibrary { .shared }
    private var entry: ModelInstallation? { library.installation(model.id) }
    private var problem: String? { LocalDeviceBudget.current.problem(model, downloading: entry?.state != .installed) }
    private var usingModel: Bool { manager.isStreaming && manager.selectedModel == model.id }
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "cpu").font(.title2).foregroundStyle(MultiVibeTheme.accent)
                    .frame(width: 42, height: 42).background(.quaternary, in: RoundedRectangle(cornerRadius: 12)).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.name).font(.headline)
                    Text(model.publisher + " · " + model.sizeLabel).font(.caption).foregroundStyle(.secondary)
                    Text(model.toolsValidated ? "Outils locaux" : "Conversation uniquement").font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if entry == nil || entry?.state == .installed {
                    Button(entry?.state == .installed ? "Utiliser" : "Télécharger") {
                        if entry?.state == .installed { select(model.option) } else { library.requestDownload(model) }
                    }
                    .buttonStyle(.bordered).controlSize(.small)
                    .disabled(entry?.state != .installed && problem != nil)
                    .accessibilityLabel((entry?.state == .installed ? "Utiliser " : "Télécharger ") + model.name)
                }
            }
            if let entry {
                switch entry.state {
                case .downloading, .queued, .waiting:
                    let meter = library.meters[model.id] ?? DownloadMeter(bytes: entry.completed)
                    ProgressView(value: Double(meter.bytes), total: Double(model.bytes))
                        .accessibilityLabel("Téléchargement de " + model.name)
                    Text(!library.connected ? "En attente de connexion" : entry.state == .waiting && library.cellular ? "En attente du Wi-Fi" : meter.label(total: model.bytes))
                        .font(.caption).monospacedDigit()
                    HStack { Button("Pause") { library.pause(model.id) }; Spacer(); Button("Annuler", role: .destructive) { deleting = true } }.font(.caption)
                case .paused, .failed:
                    Text(entry.failure ?? "Téléchargement en pause").font(.caption).foregroundStyle(.secondary)
                    HStack { Button("Reprendre") { library.resume(model.id) }; Spacer(); Button("Annuler", role: .destructive) { deleting = true } }.font(.caption)
                case .verifying: ProgressView("Vérification du modèle…").font(.caption)
                case .installed:
                    HStack {
                        Label("Disponible hors ligne", systemImage: "checkmark.circle.fill").foregroundStyle(.secondary)
                        Spacer()
                        Button("Supprimer", role: .destructive) { deleting = true }
                    }.font(.caption)
                }
            } else if let problem { Text(problem).font(.caption).foregroundStyle(.secondary) }
            if entry == nil { Text("Réponses privées, même sans Internet.").font(.caption).foregroundStyle(.secondary) }
            Link("Licence : " + model.license, destination: URL(string: "https://huggingface.co/" + model.repository)!)
                .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(.vertical, 5)
        .alert("Télécharger avec les données mobiles ?", isPresented: Binding(get: { library.cellularRequest?.id == model.id }, set: { if !$0 { library.cellularRequest = nil } })) {
            Button("Télécharger maintenant") { library.cellularChoice(allow: true) }
            Button("Attendre le Wi-Fi") { library.cellularChoice(allow: false) }
            Button("Annuler", role: .cancel) { library.cellularRequest = nil }
        } message: { Text("Ce modèle occupe \(model.sizeLabel). Votre choix sera conservé pour les prochains téléchargements.") }
        .alert(usingModel ? "Arrêter et supprimer ce modèle ?" : "Supprimer ce téléchargement ?", isPresented: $deleting) {
            Button(usingModel ? "Arrêter et supprimer" : "Supprimer", role: .destructive) {
                if usingModel { manager.stop() }
                Task {
                    do { try await library.delete(model.id); manager.refreshDownloadedModels() }
                    catch { library.storageError = error.localizedDescription }
                }
            }
            Button("Annuler", role: .cancel) { }
        } message: { Text("Vos conversations et favoris seront conservés. Vous pourrez télécharger ce modèle à nouveau.") }
    }
}
