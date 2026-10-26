import SwiftUI
import Charts

struct RelayAccountRow: View {
    @Environment(ConversationManager.self) private var manager
    @Environment(\.scenePhase) private var scenePhase
    @State private var allowance: RelayAllowance?
    @State private var loading = true
    @State private var failed = false

    var body: some View {
        NavigationLink {
            RelayUsageView()
                .id(manager.session?.accountId)
        } label: {
            HStack(spacing: 14) {
                Image(systemName: "message.badge.waveform")
                    .frame(width: 26)
                Text("Messages Relay disponibles")
                Spacer(minLength: 8)
                if loading { ProgressView().accessibilityLabel("Chargement") }
                else { Text(allowance?.remainingLabel ?? "Indisponible").foregroundStyle(.secondary) }
                Image(systemName: "chevron.right").font(.caption.bold()).foregroundStyle(.tertiary)
            }
            .foregroundStyle(.primary)
            .frame(minHeight: 60)
            .padding(.horizontal, 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("openRelayUsage")
        .accessibilityHint(failed ? "Ouvrir les statistiques et réessayer le chargement" : "Afficher les statistiques MultiVibe Relay")
        .task(id: "\(manager.session?.accountId ?? "")-\(scenePhase)") {
            guard scenePhase == .active, let account = manager.session?.accountId else { return }
            loading = true; failed = false; allowance = nil
            defer { loading = false }
            do {
                let session = try await manager.validSession()
                guard session.accountId == account else { return }
                let result = try await RelayUsageAPI.shared.allowance(token: session.accessToken)
                try Task.checkCancellation()
                guard manager.session?.accountId == account else { return }
                allowance = result
            } catch { if !Task.isCancelled, manager.session?.accountId == account { failed = true } }
        }
    }
}

struct RelayUsageView: View {
    @Environment(ConversationManager.self) private var manager
    @Environment(\.scenePhase) private var scenePhase
    @State private var days = 30
    @State private var usage: RelayUsage?
    @State private var loading = false
    @State private var failed = false
    @State private var generation = UUID()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Retrouvez les messages utilisés sur vos instances et applications connectées à MultiVibe Relay.")
                    .font(.subheadline).foregroundStyle(.secondary)
                Picker("Période", selection: $days) {
                    Text("7 jours").tag(7)
                    Text("30 jours").tag(30)
                    Text("90 jours").tag(90)
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("relayUsagePeriod")
                if manager.session == nil {
                    ContentUnavailableView("Connexion requise", systemImage: "person.crop.circle", description: Text("Connectez-vous pour consulter vos usages Relay."))
                } else if loading {
                    ProgressView("Chargement des usages Relay…").frame(maxWidth: .infinity, minHeight: 200)
                } else if failed {
                    ContentUnavailableView {
                        Label("Statistiques indisponibles", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text("Impossible de charger vos usages Relay pour le moment.")
                    } actions: {
                        Button("Réessayer") { Task { await load() } }.buttonStyle(.borderedProminent)
                    }
                } else if let usage {
                    RelayUsageDashboard(usage: usage)
                }
            }
            .padding(20)
        }
        .background(MultiVibeTheme.softAccent.ignoresSafeArea())
        .navigationTitle("MultiVibe Relay")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("relayUsageScreen")
        .refreshable { await load() }
        .task(id: "\(manager.session?.accountId ?? "")-\(days)-\(scenePhase)") {
            usage = nil
            if scenePhase == .active { await load() }
        }
    }

    @MainActor private func load() async {
        let requestID = UUID(); generation = requestID
        guard let account = manager.session?.accountId else { usage = nil; return }
        let requestedDays = days
        loading = true; failed = false; usage = nil
        defer { if generation == requestID { loading = false } }
        do {
            let session = try await manager.validSession()
            guard session.accountId == account else { throw CancellationError() }
            let result = try await RelayUsageAPI.shared.usage(token: session.accessToken, accountID: account, days: requestedDays)
            try Task.checkCancellation()
            guard generation == requestID, manager.session?.accountId == account, days == requestedDays else { return }
            usage = result
        } catch {
            guard !Task.isCancelled, generation == requestID, manager.session?.accountId == account, days == requestedDays else { return }
            failed = true
        }
    }
}

struct RelayUsageDashboard: View {
    let usage: RelayUsage
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var selectedDate: Date?
    private let utc = TimeZone(secondsFromGMT: 0)!
    private var selectedDay: RelayUsage.Day? {
        guard let selectedDate else { return nil }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = utc
        return usage.daily.first { calendar.isDate($0.timestamp, inSameDayAs: selectedDate) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            quota
            card {
                Text("Sur les \(usage.days) derniers jours")
                    .font(.headline)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 20) { metrics }
                    VStack(alignment: .leading, spacing: 16) { metrics }
                }
            }
            if usage.summary.unclassified > 0 {
                Label("\(usage.summary.unclassified.formatted()) accès anciens ne peuvent pas être distingués des consultations techniques. Ils sont exclus des graphiques.", systemImage: "info.circle")
                    .font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("relayUsageIncompleteHistory")
            }
            if usage.summary.started == 0 {
                ContentUnavailableView("Aucun message mesuré", systemImage: "chart.bar", description: Text("Les messages Relay mesurés apparaîtront ici. Essayez une autre période."))
            } else {
                dailyChart
                breakdown("Par modèle", groups: usage.models, identifier: "relayUsageModels")
                breakdown("Par machine", groups: usage.machines, identifier: "relayUsageMachines")
            }
            Text("Un message est compté lorsque votre instance démarre son exécution, même si elle échoue ensuite. Les appels d’outils et les consultations de projets ou d’historique n’ajoutent aucun message. Les jours et le renouvellement mensuel sont calculés en UTC.")
                .font(.footnote).foregroundStyle(.primary.opacity(0.82))
        }
    }

    private var quota: some View {
        card {
            Label("Messages disponibles ce mois-ci", systemImage: "message")
                .font(.headline)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            Text(usage.allowance.remainingLabel)
                .font(.system(.largeTitle, design: .rounded, weight: .bold))
                .accessibilityIdentifier("relayRemainingMessages")
            if usage.allowance.unlimited {
                Text("Relay illimité avec votre abonnement Cloud.").font(.subheadline).foregroundStyle(.secondary)
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 22) { quotaChart; quotaLegend }
                    VStack(alignment: .leading, spacing: 14) { quotaChart; quotaLegend }
                }
                Text("Renouvellement le \(usage.allowance.renewalDate.formatted(dateFormat))")
                    .font(.footnote).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
    private var quotaChart: some View {
        Chart {
            SectorMark(angle: .value("Utilisés", usage.allowance.used), innerRadius: .ratio(0.72)).foregroundStyle(MultiVibeTheme.accent)
            SectorMark(angle: .value("Réservés", usage.allowance.reserved), innerRadius: .ratio(0.72)).foregroundStyle(.orange)
            SectorMark(angle: .value("Disponibles", usage.allowance.remaining ?? 0), innerRadius: .ratio(0.72)).foregroundStyle(MultiVibeTheme.accent.opacity(0.12))
        }
        .frame(width: 84, height: 84)
        .accessibilityHidden(true)
    }
    private var quotaLegend: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(usage.allowance.used) utilisés").foregroundStyle(MultiVibeTheme.accent)
            Text("\(usage.allowance.reserved) réservés").foregroundStyle(.secondary)
            Text("\(usage.allowance.included) inclus par mois").foregroundStyle(.secondary)
        }
        .font(.subheadline)
        .fixedSize(horizontal: false, vertical: true)
    }
    @ViewBuilder private var metrics: some View {
        metric(usage.summary.started, "Utilisés")
        metric(usage.summary.pending, "En attente")
        metric(usage.summary.released, "Libérés sans usage")
    }
    private func metric(_ value: Int, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(value.formatted()).font(.title2.bold()).monospacedDigit()
            Text(label).font(.caption).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private var dailyChart: some View {
        card {
            Text("Messages par jour").font(.headline)
            Text(selectedDay.map { "\($0.date) · \($0.started) messages" } ?? "Touchez le graphique pour voir un jour.")
                .font(.caption).foregroundStyle(.secondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Chart(usage.daily) { day in
                BarMark(x: .value("Jour", day.timestamp, unit: .day, calendar: utcCalendar), y: .value("Messages", day.started))
                    .foregroundStyle(MultiVibeTheme.accent).cornerRadius(3)
                    .accessibilityLabel(day.timestamp.formatted(dateFormat))
                    .accessibilityValue("\(day.started) messages")
                if let selectedDay, day.id == selectedDay.id {
                    RuleMark(x: .value("Jour sélectionné", day.timestamp)).foregroundStyle(.secondary.opacity(0.4))
                }
            }
            .chartXSelection(value: $selectedDate)
            .chartXAxis {
                if dynamicTypeSize.isAccessibilitySize {
                    AxisMarks { AxisGridLine() }
                } else {
                    AxisMarks(values: .automatic(desiredCount: 4)) { _ in AxisValueLabel(format: dateFormat); AxisGridLine() }
                }
            }
            .chartYAxis { AxisMarks(values: .automatic(desiredCount: 4)) { value in
                if let count = value.as(Int.self), count >= 0 { AxisValueLabel(); AxisGridLine() }
            } }
            .chartYScale(domain: 0...max(1, usage.daily.map(\.started).max() ?? 1))
            .frame(height: 190)
            .accessibilityIdentifier("relayUsageDailyChart")
            if dynamicTypeSize.isAccessibilitySize {
                HStack {
                    Text(usage.daily.first!.timestamp.formatted(dateFormat))
                    Spacer()
                    Text(usage.daily.last!.timestamp.formatted(dateFormat))
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
        }
    }
    private var dateFormat: Date.FormatStyle { Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: utc).day().month(.abbreviated) }
    private var utcCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = utc; return calendar
    }
    private func breakdown(_ title: String, groups: [RelayUsage.Group], identifier: String) -> some View {
        card {
            Text(title).font(.headline)
            ForEach(groups) { group in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(group.displayName).font(.subheadline).lineLimit(3)
                        Spacer(minLength: 8)
                        Text(group.started.formatted()).font(.subheadline.weight(.semibold)).monospacedDigit()
                    }
                    ProgressView(value: Double(group.started), total: Double(max(1, usage.summary.started)))
                        .tint(MultiVibeTheme.accent).accessibilityHidden(true)
                }
                .accessibilityElement(children: .combine)
            }
        }.accessibilityIdentifier(identifier)
    }
    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 16, content: content)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
            .background(MultiVibeTheme.card, in: RoundedRectangle(cornerRadius: 24))
    }
}
