import Charts
import CoreTransferable
import SwiftUI
import UniformTypeIdentifiers

struct CloudUsageView: View {
    let accountId: String
    let initialBalance: CloudCreditBalance?
    @Environment(ConversationManager.self) private var manager
    @Environment(\.scenePhase) private var scenePhase
    @State private var snapshot: CloudUsageSnapshot?
    @State private var balance: CloudCreditBalance?
    @State private var loading = false
    @State private var failed = false

    var body: some View {
        Group {
            if manager.session?.accountId != accountId {
                ContentUnavailableView("Compte déconnecté", systemImage: "person.crop.circle.badge.exclamationmark")
            } else if let snapshot {
                CloudUsageDashboard(snapshot: snapshot, balance: balance ?? initialBalance,
                                    balanceIsCurrent: balance != nil, refreshFailed: failed)
                    .refreshable { await reload() }
            } else if failed {
                ContentUnavailableView {
                    Label("Usage indisponible", systemImage: "chart.bar.xaxis")
                } description: {
                    Text("Les statistiques n’ont pas pu être chargées. Vérifiez votre connexion et réessayez.")
                } actions: {
                    Button("Réessayer") { Task { await reload() } }
                        .accessibilityIdentifier("retryCloudUsage")
                }
            } else {
                ProgressView("Chargement de votre usage…").frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle("Usage et crédits")
        .navigationBarTitleDisplayMode(.inline)
        .background(MultiVibeTheme.softAccent.ignoresSafeArea())
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Actualiser", systemImage: "arrow.clockwise") { Task { await reload() } }
                    .disabled(loading || manager.session?.accountId != accountId)
                    .accessibilityIdentifier("refreshCloudUsage")
            }
        }
        .task { await reload() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await reload() } }
        }
        .onChange(of: manager.session?.accountId) { _, _ in snapshot = nil; balance = nil }
    }

    @MainActor private func reload() async {
        guard !loading, manager.session?.accountId == accountId else { return }
        loading = true
        defer { loading = false }
        do {
            let session = try await manager.validSession()
            guard session.accountId == accountId else { throw CancellationError() }
            async let latestBalance = try? ChatAPI.shared.creditBalance(token: session.accessToken)
            let latest = try await ChatAPI.shared.usageAnalytics(token: session.accessToken)
            let creditBalance = await latestBalance
            try Task.checkCancellation()
            guard manager.session?.accountId == accountId else { return }
            snapshot = latest
            balance = creditBalance
            failed = false
        } catch {
            guard !Task.isCancelled, manager.session?.accountId == accountId else { return }
            failed = true
        }
    }
}

private enum UsageChartMetric: String, CaseIterable, Identifiable {
    case credits = "Crédits", requests = "Requêtes", tokens = "Tokens"
    var id: String { rawValue }
    func value(_ metrics: CloudUsageMetrics) -> Double? {
        switch self {
        case .credits: metrics.measuredCost.map { NSDecimalNumber(decimal: $0).doubleValue }
        case .requests: Double(metrics.requests)
        case .tokens: metrics.totalTokens.map(Double.init)
        }
    }
    func formatted(_ metrics: CloudUsageMetrics) -> String {
        switch self {
        case .credits: CloudUsageFormat.credits(metrics.measuredCost)
        case .requests: CloudUsageFormat.count(metrics.requests)
        case .tokens: CloudUsageFormat.count(metrics.totalTokens)
        }
    }
}

struct CloudUsageCSV: Transferable {
    let text: String
    let filename: String
    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .commaSeparatedText) { Data($0.text.utf8) }
            .suggestedFileName { $0.filename }
    }
}

/// The same presentation renders real snapshots and deterministic DEBUG UI fixtures.
struct CloudUsageDashboard: View {
    let snapshot: CloudUsageSnapshot
    let balance: CloudCreditBalance?
    let balanceIsCurrent: Bool
    let refreshFailed: Bool
    @State private var range: CloudUsageRange = .week
    @State private var metric: UsageChartMetric = .credits
    @State private var selectedDate: Date?
    @State private var breakdown = "Modèles"
    @State private var showAll = false
    @State private var query = ""
    @State private var stateFilter = "all"
    @State private var selectedRequest: CloudUsageRequest?

    private var period: CloudUsagePeriod? { snapshot.periods[range.rawValue] }
    private var bucketCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }
    private var chartStart: Date {
        let start = snapshot.generatedAt.addingTimeInterval(-range.seconds)
        return bucketCalendar.dateInterval(of: range == .day ? .hour : .day, for: start)?.start ?? start
    }
    private var breakdownRows: [CloudUsageBreakdown] {
        guard let period else { return [] }
        switch breakdown {
        case "Projets": return period.projects
        case "Fournisseurs": return period.providers
        default: return period.models
        }
    }
    private var filteredRequests: [CloudUsageRequest] {
        let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return (period?.recentRequests ?? []).filter {
            (stateFilter == "all" || $0.state == stateFilter)
                && (search.isEmpty || [$0.model, $0.project, $0.provider, $0.id].contains { $0.localizedCaseInsensitiveContains(search) })
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                balanceCard
                Picker("Période", selection: $range) {
                    ForEach(CloudUsageRange.allCases) { Text($0.title).tag($0) }
                }.pickerStyle(.segmented).accessibilityIdentifier("cloudUsageRange")
                if refreshFailed {
                    Label("Actualisation impossible. Les dernières statistiques chargées restent affichées.", systemImage: "wifi.exclamationmark")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let period {
                    overview(period.summary)
                    if period.summary.requests == 0 {
                        ContentUnavailableView("Aucun usage sur cette période", systemImage: "chart.bar.xaxis",
                                               description: Text("Essayez une autre période pour retrouver votre activité Cloud."))
                    } else {
                        activityChart(period)
                        tokenCard(period.summary)
                        breakdownCard
                        card("Performance et fiabilité") { UsagePerformance(metrics: period.summary) }
                        requestsCard
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Mis à jour le \(snapshot.generatedAt.formatted(date: .abbreviated, time: .shortened))")
                    Text("Usage Cloud de l’espace associé à votre compte, comme le solde. Les modèles locaux et les abonnements personnels utilisés en dehors du Cloud ne sont pas inclus. 1 crédit correspond à 1 USD d’usage.")
                    Text("Les totaux portent sur toute la période ; les répartitions montrent les 50 premières entrées et l’historique les 50 dernières requêtes. — signifie qu’une mesure n’est pas disponible. Les coûts et tokens partiels sont signalés ; les unités de tokens peuvent se recouper.")
                }.font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: 760)
            .padding(20)
            .frame(maxWidth: .infinity)
        }
        .accessibilityIdentifier("cloudUsageDashboard")
        .background(MultiVibeTheme.softAccent.ignoresSafeArea())
        .onChange(of: range) { _, _ in selectedDate = nil; showAll = false }
        .sheet(item: $selectedRequest) { request in
            NavigationStack {
                CloudUsageRequestDetail(request: request)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fermer") { selectedRequest = nil } } }
            }
        }
    }

    private var balanceCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Crédits disponibles", systemImage: "gauge.with.dots.needle.50percent")
                .font(.subheadline.weight(.medium))
            Text(CloudUsageFormat.credits(balance?.available))
                .font(.system(.largeTitle, design: .rounded, weight: .semibold))
                .monospacedDigit().contentTransition(.numericText())
            Text(balanceIsCurrent ? "Solde actuel · indépendant de la période sélectionnée" : "\(balance == nil ? "Solde indisponible" : "Dernier solde connu") · actualisez pour le vérifier")
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(22)
        .background(MultiVibeTheme.accent.opacity(0.1), in: RoundedRectangle(cornerRadius: 24))
    }

    private func overview(_ metrics: CloudUsageMetrics) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), alignment: .leading)], alignment: .leading, spacing: 16) {
            stat("Crédits consommés", value: CloudUsageFormat.credits(metrics.measuredCost),
                 detail: "\(metrics.costKnownRequests.formatted()) / \(metrics.requests.formatted()) requêtes chiffrées")
            stat("Requêtes", value: metrics.requests.formatted(), detail: "\(metrics.failed.formatted()) en échec")
            stat("Tokens rapportés", value: CloudUsageFormat.count(metrics.totalTokens),
                 detail: "\(metrics.tokenKnownRequests.formatted()) / \(metrics.requests.formatted()) mesurées")
            stat("Crédits / requête", value: CloudUsageFormat.credits(metrics.averageCost), detail: "Sur les requêtes chiffrées")
        }
    }

    private func stat(_ title: String, value: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold)).monospacedDigit()
            Text(detail).font(.caption2).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, minHeight: 92, alignment: .topLeading)
            .padding(14).background(.background, in: RoundedRectangle(cornerRadius: 18))
            .accessibilityElement(children: .combine)
    }

    private func activityChart(_ period: CloudUsagePeriod) -> some View {
        card("Évolution de l’usage") {
            Picker("Mesure", selection: $metric) {
                ForEach(UsageChartMetric.allCases) { Text($0.rawValue).tag($0) }
            }.pickerStyle(.segmented).accessibilityIdentifier("cloudUsageMetric")
            Chart {
                ForEach(period.timeSeries.sorted { $0.date < $1.date }) { bucket in
                    if let value = metric.value(bucket.metrics) {
                        BarMark(x: .value("Date", bucket.date, unit: range == .day ? .hour : .day, calendar: bucketCalendar),
                                y: .value(metric.rawValue, value))
                            .foregroundStyle(MultiVibeTheme.accent.gradient).cornerRadius(3)
                            .accessibilityLabel(bucket.date.formatted(date: .abbreviated, time: range == .day ? .shortened : .omitted))
                            .accessibilityValue("\(metric.formatted(bucket.metrics)) \(metric.rawValue.lowercased())")
                    }
                }
                if let selectedDate {
                    RuleMark(x: .value("Sélection", selectedDate)).foregroundStyle(.secondary.opacity(0.4))
                }
            }
            .chartXScale(domain: chartStart...snapshot.generatedAt)
            .chartXSelection(value: $selectedDate)
            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) }
            .frame(height: 190)
            .accessibilityIdentifier("cloudUsageChart")
            if let selectedDate {
                if let bucket = period.timeSeries.first(where: { bucketCalendar.isDate($0.date, equalTo: selectedDate, toGranularity: range == .day ? .hour : .day) }) {
                    Text("\(bucket.date.formatted(date: .abbreviated, time: range == .day ? .shortened : .omitted)) · \(metric.formatted(bucket.metrics)) \(metric.rawValue.lowercased())")
                        .font(.footnote.weight(.medium)).monospacedDigit()
                } else {
                    Text("Aucune requête enregistrée dans cette tranche.").font(.footnote)
                }
            }
            Text("\(range == .day ? "Par heure" : "Par jour") · touchez le graphique pour inspecter une mesure. Dates affichées dans votre fuseau horaire.")
                .font(.caption).foregroundStyle(.secondary)
            if period.summary.costKnownRequests < period.summary.requests && metric == .credits {
                Text("Coût partiel : seules les requêtes chiffrées sont représentées.").font(.caption).foregroundStyle(.secondary)
            }
            if period.summary.tokenKnownRequests < period.summary.requests && metric == .tokens {
                Text("Tokens partiels : seules les mesures rapportées sont représentées.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func tokenCard(_ metrics: CloudUsageMetrics) -> some View {
        let tokens: [(String, Int?)] = [("Entrée", metrics.inputTokens), ("Sortie", metrics.outputTokens),
            ("Cache lu", metrics.cacheReadTokens), ("Cache écrit", metrics.cacheWriteTokens), ("Raisonnement", metrics.reasoningTokens)]
        return card("Détail des tokens") {
            Chart(Array(tokens.enumerated()), id: \.offset) { _, item in
                if let value = item.1 {
                    BarMark(x: .value("Tokens", value), y: .value("Type", item.0))
                        .foregroundStyle(MultiVibeTheme.accent.gradient).cornerRadius(3)
                        .accessibilityLabel(item.0).accessibilityValue(value.formatted())
                }
            }.frame(height: 155)
            ForEach(Array(tokens.enumerated()), id: \.offset) { _, item in
                UsageFact(title: item.0, value: CloudUsageFormat.count(item.1))
            }
            Text("Les catégories de cache et de raisonnement peuvent être incluses dans les tokens d’entrée ou de sortie selon le fournisseur ; elles ne s’additionnent pas au total rapporté.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var breakdownCard: some View {
        card("Répartition de l’usage") {
            Picker("Répartition", selection: $breakdown) {
                ForEach(["Modèles", "Projets", "Fournisseurs"], id: \.self) { Text($0).tag($0) }
            }.pickerStyle(.segmented).accessibilityIdentifier("cloudUsageBreakdown")
            if breakdownRows.isEmpty {
                Text("Répartition indisponible.").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(showAll ? breakdownRows : Array(breakdownRows.prefix(5))) { row in
                DisclosureGroup {
                    UsageFact(title: "Tokens rapportés", value: CloudUsageFormat.count(row.metrics.totalTokens))
                    UsageFact(title: "Crédits / requête chiffrée", value: CloudUsageFormat.credits(row.metrics.averageCost))
                    UsageFact(title: "Requêtes chiffrées", value: "\(row.metrics.costKnownRequests) / \(row.metrics.requests)")
                    UsageFact(title: "Requêtes mesurées", value: "\(row.metrics.tokenKnownRequests) / \(row.metrics.requests)")
                    UsagePerformance(metrics: row.metrics)
                } label: {
                    VStack(alignment: .leading, spacing: 7) {
                        Text(row.name).font(.subheadline.weight(.medium)).foregroundStyle(.primary).lineLimit(2)
                        HStack {
                            Text("\(row.metrics.requests.formatted()) requêtes")
                            Spacer()
                            Text("\(CloudUsageFormat.credits(row.metrics.measuredCost)) crédits")
                        }.font(.caption).foregroundStyle(.secondary).monospacedDigit()
                        ProgressView(value: Double(row.metrics.requests), total: Double(max(period?.summary.requests ?? 1, 1)))
                            .tint(MultiVibeTheme.accent).accessibilityHidden(true)
                    }.padding(.vertical, 6)
                }
            }
            if breakdownRows.count > 5 {
                Button(showAll ? "Réduire" : "Afficher les \(breakdownRows.count) entrées") { showAll.toggle() }
                    .font(.subheadline)
            }
        }
    }

    private var requestsCard: some View {
        card("Dernières requêtes") {
            HStack {
                TextField("Modèle, projet, fournisseur…", text: $query)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("cloudUsageSearch")
                Menu {
                    Picker("Statut", selection: $stateFilter) {
                        Text("Tous les statuts").tag("all")
                        Text("Réussies").tag("succeeded")
                        Text("Échouées").tag("failed")
                        Text("En cours").tag("pending")
                        Text("Résultat indisponible").tag("unknown")
                    }
                } label: { Image(systemName: stateFilter == "all" ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill").font(.title3) }
                .accessibilityLabel("Filtrer par statut")
            }.padding(12).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 12))
            if filteredRequests.isEmpty {
                Text("Aucune requête ne correspond à ces filtres.").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(filteredRequests) { request in
                Button { selectedRequest = request } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(request.model).font(.subheadline.weight(.medium)).lineLimit(2)
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                        }
                        HStack {
                            Text(request.createdAt.formatted(date: .abbreviated, time: .shortened))
                            Spacer()
                            Text("\(CloudUsageFormat.credits(request.costUsd)) cr.")
                        }.font(.caption).foregroundStyle(.secondary).monospacedDigit()
                        Label(request.stateTitle, systemImage: request.state == "succeeded" ? "checkmark.circle" : request.state == "failed" ? "exclamationmark.circle" : "clock")
                            .font(.caption).foregroundStyle(request.state == "failed" ? Color.orange : Color.secondary)
                    }.padding(.vertical, 9).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityIdentifier("cloudUsageRequest-\(request.id)")
                Divider()
            }
            Text("Recherche et filtres sur les 50 dernières requêtes de la période.").font(.caption).foregroundStyle(.secondary)
            if let period, !period.recentRequests.isEmpty {
                ShareLink(item: CloudUsageCSV(text: period.csv, filename: "multivibe-usage-\(range.rawValue).csv"),
                          preview: SharePreview("Usage MultiVibe · \(range.title)")) {
                    Label("Exporter l’historique CSV", systemImage: "square.and.arrow.up")
                }.font(.subheadline).accessibilityIdentifier("exportCloudUsage")
            }
        }
    }

    private func card<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title).font(.headline).accessibilityAddTraits(.isHeader)
            content()
        }.padding(18).background(.background, in: RoundedRectangle(cornerRadius: 22))
    }
}

private struct UsageFact: View {
    let title: String
    let value: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(title).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Text(value).monospacedDigit().multilineTextAlignment(.trailing).textSelection(.enabled)
        }.font(.subheadline).accessibilityElement(children: .combine)
    }
}

private struct UsagePerformance: View {
    let metrics: CloudUsageMetrics
    var body: some View {
        UsageFact(title: "Réussite (résultats connus)", value: metrics.successRate?.formatted(.percent.precision(.fractionLength(1))) ?? "—")
        UsageFact(title: "Réussies / échouées", value: "\(metrics.succeeded.formatted()) / \(metrics.failed.formatted())")
        UsageFact(title: "En cours / résultat inconnu", value: "\(metrics.pending.formatted()) / \(metrics.unknownOutcomeRequests.formatted())")
        UsageFact(title: "Latence médiane · p50", value: CloudUsageFormat.duration(metrics.latencyP50Ms))
        UsageFact(title: "Latence · p95", value: CloudUsageFormat.duration(metrics.latencyP95Ms))
        UsageFact(title: "Premier token · p50", value: CloudUsageFormat.duration(metrics.ttftP50Ms))
        UsageFact(title: "Premier token · p95", value: CloudUsageFormat.duration(metrics.ttftP95Ms))
        UsageFact(title: "Vitesse de sortie", value: metrics.tokensPerSecond.map { "\($0.formatted(.number.precision(.fractionLength(1)))) tok/s" } ?? "—")
        Text("p50 : la moitié des mesures est inférieure à cette durée. p95 : 95 % le sont. Les mesures absentes sont exclues.")
            .font(.caption).foregroundStyle(.secondary)
    }
}

private struct CloudUsageRequestDetail: View {
    let request: CloudUsageRequest
    var body: some View {
        Form {
            Section("Requête") {
                UsageFact(title: "Modèle", value: request.model)
                UsageFact(title: "Projet", value: request.project)
                UsageFact(title: "Fournisseur", value: request.provider)
                UsageFact(title: "Statut", value: request.stateTitle)
                UsageFact(title: "Date", value: request.createdAt.formatted(date: .complete, time: .standard))
            }
            Section("Consommation") {
                UsageFact(title: "Crédits", value: CloudUsageFormat.credits(request.costUsd))
                UsageFact(title: "Tokens entrée", value: CloudUsageFormat.count(request.inputTokens))
                UsageFact(title: "Tokens sortie", value: CloudUsageFormat.count(request.outputTokens))
                UsageFact(title: "Tokens rapportés", value: CloudUsageFormat.count(request.totalTokens))
            }
            Section("Performance") {
                UsageFact(title: "Durée totale", value: CloudUsageFormat.duration(request.durationMs))
                UsageFact(title: "Premier token", value: CloudUsageFormat.duration(request.ttftMs))
            }
            Section("Identifiant") { Text(request.id).font(.footnote.monospaced()).textSelection(.enabled) }
            Section { Text("Aucun contenu de conversation n’est affiché ni exporté. — signifie que la mesure n’est pas disponible.") }
        }.navigationTitle("Détail de la requête").navigationBarTitleDisplayMode(.inline)
            .accessibilityIdentifier("cloudUsageRequestDetail")
    }
}

#if DEBUG
enum CloudUsageFixture {
    static func data(empty: Bool = false, missing: Bool = false) throws -> Data {
        func metrics(_ count: Int, cost: Double) -> [String: Any] {
            ["requests": count, "succeeded": count, "failed": 0, "pending": 0, "unknownOutcomeRequests": 0,
             "costUsd": missing ? 0 : cost, "costKnownRequests": missing ? 0 : count, "tokenKnownRequests": missing ? 0 : count,
             "inputTokens": missing ? NSNull() : count * 1200, "outputTokens": missing ? NSNull() : count * 300,
             "totalTokens": missing ? NSNull() : count * 1500, "cacheReadTokens": missing ? NSNull() : count * 800,
             "cacheWriteTokens": missing ? NSNull() : count * 50, "reasoningTokens": missing ? NSNull() : count * 80,
             "latencyP50Ms": missing ? NSNull() : 1240, "latencyP95Ms": missing ? NSNull() : 3200,
             "ttftP50Ms": missing ? NSNull() : 180, "ttftP95Ms": missing ? NSNull() : 620,
             "tokensPerSecond": missing ? NSNull() : 54.2]
        }
        let generatedAt = Date(timeIntervalSince1970: 1_793_040_000)
        var periods: [String: Any] = [:]
        for range in CloudUsageRange.allCases {
            let series = (1...6).map { index -> [String: Any] in
                var row = metrics(index * 2, cost: Double(index) * 0.12)
                row["date"] = generatedAt.addingTimeInterval(-Double(7 - index) * (range == .day ? 3600 : 86_400)).ISO8601Format()
                return row
            }
            let models = [("model-a", "Claude Sonnet", 28, 1.8), ("model-b", "GPT", 14, 0.72)].map { id, name, count, cost in
                var row = metrics(count, cost: cost); row["id"] = id; row["name"] = name; return row
            }
            var project = metrics(42, cost: 2.52); project["id"] = "project-1"; project["name"] = "Personnel"
            var provider = metrics(42, cost: 2.52); provider["id"] = "cloud"; provider["name"] = "MultiVibe Cloud"
            let requests: [[String: Any]] = (1...4).map { index in
                ["id": "request-\(index)", "createdAt": generatedAt.addingTimeInterval(-Double(index) * 120).ISO8601Format(),
                 "model": index == 1 ? "Claude Sonnet" : "GPT", "project": "Personnel", "provider": "cloud",
                 "state": missing ? "unknown" : "succeeded", "costUsd": missing ? NSNull() : 0.000001,
                 "inputTokens": missing ? NSNull() : 1200, "outputTokens": missing ? NSNull() : 300,
                 "totalTokens": missing ? NSNull() : 1500, "durationMs": missing ? NSNull() : 1240,
                 "ttftMs": missing ? NSNull() : 180]
            }
            periods[range.rawValue] = ["summary": metrics(empty ? 0 : 42, cost: empty ? 0 : 2.52),
                "timeSeries": empty ? [] : series, "models": empty ? [] : models,
                "projects": empty ? [] : [project], "providers": empty ? [] : [provider], "recentRequests": empty ? [] : requests]
        }
        return try JSONSerialization.data(withJSONObject: ["generatedAt": generatedAt.ISO8601Format(), "windowDays": 30, "periods": periods])
    }

    static func snapshot(empty: Bool = false, missing: Bool = false) throws -> CloudUsageSnapshot {
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(CloudUsageSnapshot.self, from: data(empty: empty, missing: missing))
    }
}

struct CloudUsageFixtureView: View {
    var body: some View {
        let args = ProcessInfo.processInfo.arguments
        NavigationStack {
            List {
                NavigationLink {
                    if let snapshot = try? CloudUsageFixture.snapshot(empty: args.contains("-usage-empty"), missing: args.contains("-usage-missing")) {
                        CloudUsageDashboard(snapshot: snapshot, balance: try? JSONDecoder().decode(CloudCreditBalance.self,
                            from: Data(#"{"currency":"USD","totalAvailableUsd":"17.485321"}"#.utf8)), balanceIsCurrent: true, refreshFailed: args.contains("-usage-stale"))
                            .navigationTitle("Usage et crédits").navigationBarTitleDisplayMode(.inline)
                    }
                } label: { LabeledContent("Crédits disponibles", value: "17,485321") }
                    .accessibilityIdentifier("cloudCreditBalance")
            }.navigationTitle("Compte")
        }
    }
}
#endif
