import Foundation

enum CloudUsageRange: String, CaseIterable, Identifiable, Sendable {
    case day = "24h", week = "7d", month = "30d"
    var id: String { rawValue }
    var title: String {
        switch self { case .day: "24 h"; case .week: "7 jours"; case .month: "30 jours" }
    }
    var seconds: TimeInterval {
        switch self { case .day: 86_400; case .week: 604_800; case .month: 2_592_000 }
    }
}

/// Mirrors the Cloud snapshot. Unknown measurements remain nil, including zero-cost requests.
struct CloudUsageMetrics: Decodable, Sendable {
    let requests: Int
    let succeeded: Int
    let failed: Int
    let pending: Int
    let unknownOutcomeRequests: Int
    let costUsd: Decimal
    let costKnownRequests: Int
    let tokenKnownRequests: Int
    let inputTokens: Int?
    let outputTokens: Int?
    let totalTokens: Int?
    let cacheReadTokens: Int?
    let cacheWriteTokens: Int?
    let reasoningTokens: Int?
    let latencyP50Ms: Double?
    let latencyP95Ms: Double?
    let ttftP50Ms: Double?
    let ttftP95Ms: Double?
    let tokensPerSecond: Double?

    var measuredCost: Decimal? { requests == 0 || costKnownRequests > 0 ? costUsd : nil }
    var averageCost: Decimal? { costKnownRequests > 0 ? costUsd / Decimal(costKnownRequests) : nil }
    var successRate: Double? {
        let known = Double(succeeded) + Double(failed)
        return known > 0 ? Double(succeeded) / known : nil
    }
    var isValid: Bool {
        let counts = [requests, succeeded, failed, pending, unknownOutcomeRequests, costKnownRequests, tokenKnownRequests]
        let tokens = [inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens].compactMap { $0 }
        let durations = [latencyP50Ms, latencyP95Ms, ttftP50Ms, ttftP95Ms, tokensPerSecond].compactMap { $0 }
        return counts.allSatisfy { $0 >= 0 && $0 <= requests }
            && succeeded + failed + pending + unknownOutcomeRequests == requests
            && !costUsd.isNaN && costUsd >= 0
            && tokens.allSatisfy { $0 >= 0 }
            && durations.allSatisfy { $0.isFinite && $0 >= 0 }
    }
}

struct CloudUsageBucket: Decodable, Identifiable, Sendable {
    let date: Date
    let metrics: CloudUsageMetrics
    var id: Date { date }
    private enum CodingKeys: String, CodingKey { case date }
    init(from decoder: Decoder) throws {
        date = try decoder.container(keyedBy: CodingKeys.self).decode(Date.self, forKey: .date)
        metrics = try CloudUsageMetrics(from: decoder)
    }
}

struct CloudUsageBreakdown: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let metrics: CloudUsageMetrics
    private enum CodingKeys: String, CodingKey { case id, name }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        metrics = try CloudUsageMetrics(from: decoder)
    }
}

struct CloudUsageRequest: Decodable, Identifiable, Sendable {
    let id: String
    let createdAt: Date
    let model: String
    let project: String
    let provider: String
    let state: String
    let costUsd: Decimal?
    let inputTokens: Int?
    let outputTokens: Int?
    let totalTokens: Int?
    let durationMs: Double?
    let ttftMs: Double?

    var stateTitle: String {
        switch state {
        case "succeeded": "Réussie"
        case "failed": "Échouée"
        case "pending": "En cours"
        default: "Résultat indisponible"
        }
    }
    var isValid: Bool {
        (costUsd.map { !$0.isNaN && $0 >= 0 } ?? true)
            && [inputTokens, outputTokens, totalTokens].compactMap { $0 }.allSatisfy { $0 >= 0 }
            && [durationMs, ttftMs].compactMap { $0 }.allSatisfy { $0.isFinite && $0 >= 0 }
    }
}

struct CloudUsagePeriod: Decodable, Sendable {
    let summary: CloudUsageMetrics
    let timeSeries: [CloudUsageBucket]
    let models: [CloudUsageBreakdown]
    let projects: [CloudUsageBreakdown]
    let providers: [CloudUsageBreakdown]
    let recentRequests: [CloudUsageRequest]
    var isValid: Bool {
        summary.isValid && timeSeries.allSatisfy { $0.metrics.isValid }
            && (models + projects + providers).allSatisfy { $0.metrics.isValid }
            && recentRequests.allSatisfy(\.isValid)
            && Set(timeSeries.map(\.id)).count == timeSeries.count
            && [models, projects, providers].allSatisfy { Set($0.map(\.id)).count == $0.count }
            && Set(recentRequests.map(\.id)).count == recentRequests.count
    }

    /// Only request metadata is exported, never prompts, responses, or credentials.
    var csv: String {
        func cell(_ value: String) -> String {
            // Prevent spreadsheet formula evaluation in names supplied by users/providers.
            let safe = ["=", "+", "-", "@", "\t", "\r", "\n"].contains(where: value.hasPrefix) ? "'" + value : value
            return "\"" + safe.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }
        let header = "Date UTC,Modèle,Projet,Fournisseur,Statut,Crédits,Tokens entrée,Tokens sortie,Tokens total,Durée ms,Premier token ms"
        return ([header] + recentRequests.map { request in
            [request.createdAt.ISO8601Format(), request.model, request.project, request.provider, request.stateTitle,
             request.costUsd.map { NSDecimalNumber(decimal: $0).stringValue } ?? "",
             request.inputTokens.map(String.init) ?? "", request.outputTokens.map(String.init) ?? "",
             request.totalTokens.map(String.init) ?? "", request.durationMs.map { String($0) } ?? "",
             request.ttftMs.map { String($0) } ?? ""].map(cell).joined(separator: ",")
        }).joined(separator: "\r\n")
    }
}

struct CloudUsageSnapshot: Decodable, Sendable {
    let generatedAt: Date
    let windowDays: Int
    let periods: [String: CloudUsagePeriod]
    var isValid: Bool {
        windowDays == 30 && CloudUsageRange.allCases.allSatisfy { periods[$0.rawValue]?.isValid == true }
    }
}

enum CloudUsageFormat {
    static func credits(_ amount: Decimal?) -> String {
        guard let amount else { return "—" }
        return amount.formatted(.number.precision(.fractionLength(0...6)))
    }
    static func count(_ value: Int?) -> String { value?.formatted() ?? "—" }
    static func duration(_ value: Double?) -> String {
        guard let value else { return "—" }
        if value < 1_000 { return "\(value.formatted(.number.precision(.fractionLength(0)))) ms" }
        return "\((value / 1_000).formatted(.number.precision(.fractionLength(0...2)))) s"
    }
}
