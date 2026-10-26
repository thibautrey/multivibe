import Foundation

struct RelayAllowance: Decodable, Sendable {
    let periodStart: String
    let periodEnd: String
    let included: Int
    let used: Int
    let reserved: Int
    let remaining: Int?
    let unlimited: Bool

    var remainingLabel: String { unlimited ? "Illimités" : remaining!.formatted() }
    var renewalDate: Date { Self.day(periodEnd)! }

    static func day(_ raw: String) -> Date? {
        guard raw.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        guard let date = formatter.date(from: raw), formatter.string(from: date) == raw else { return nil }
        return date
    }
    private enum CodingKeys: String, CodingKey { case periodStart, periodEnd, included, used, reserved, remaining, unlimited }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        periodStart = try c.decode(String.self, forKey: .periodStart)
        periodEnd = try c.decode(String.self, forKey: .periodEnd)
        included = try c.decode(Int.self, forKey: .included)
        used = try c.decode(Int.self, forKey: .used)
        reserved = try c.decode(Int.self, forKey: .reserved)
        remaining = try c.decodeIfPresent(Int.self, forKey: .remaining)
        unlimited = try c.decode(Bool.self, forKey: .unlimited)
        guard let start = Self.day(periodStart), let end = Self.day(periodEnd), start < end,
              included > 0, included <= 1_000_000, used >= 0, reserved >= 0,
              used <= included, reserved <= included - used,
              unlimited ? remaining == nil : remaining == included - used - reserved else { throw APIError.invalidResponse }
    }
}

struct RelayUsage: Decodable, Sendable {
    struct Counts: Decodable, Sendable {
        let started: Int
        let pending: Int
        let released: Int
        let unclassified: Int
        var valid: Bool { [started, pending, released, unclassified].allSatisfy { (0...1_000_000_000).contains($0) } }
    }
    struct Day: Decodable, Identifiable, Sendable {
        let date: String
        let started: Int
        let pending: Int
        let released: Int
        let unclassified: Int
        var id: String { date }
        var timestamp: Date { RelayAllowance.day(date)! }
    }
    struct Group: Decodable, Identifiable, Sendable {
        let id: String
        let name: String
        let started: Int
        var displayName: String { name == "multivibe/host-harness-v1" ? "Instance MultiVibe" : name }
    }
    let accountId: String
    let from: String
    let to: String
    let days: Int
    let allowance: RelayAllowance
    let summary: Counts
    let daily: [Day]
    let models: [Group]
    let machines: [Group]

    func validate(accountID: String, days requestedDays: Int) throws {
        guard accountId == accountID, days == requestedDays, [7, 30, 90].contains(days),
              summary.valid, daily.count == days, models.count <= 21, machines.count <= 21,
              Set(daily.map(\.date)).count == days else { throw APIError.invalidResponse }
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let start = format.date(from: from), let end = format.date(from: to), start < end,
              end.timeIntervalSince(start) <= Double(days) * 86_400 else { throw APIError.invalidResponse }
        for (index, day) in daily.enumerated() {
            guard let date = RelayAllowance.day(day.date), date == start.addingTimeInterval(Double(index) * 86_400),
                  [day.started, day.pending, day.released, day.unclassified].allSatisfy({ (0...1_000_000_000).contains($0) }) else { throw APIError.invalidResponse }
        }
        guard daily.reduce(0, { $0 + $1.started }) == summary.started,
              daily.reduce(0, { $0 + $1.pending }) == summary.pending,
              daily.reduce(0, { $0 + $1.released }) == summary.released,
              daily.reduce(0, { $0 + $1.unclassified }) == summary.unclassified else { throw APIError.invalidResponse }
        for groups in [models, machines] {
            guard Set(groups.map(\.id)).count == groups.count,
                  groups.allSatisfy({ !$0.id.isEmpty && !$0.name.isEmpty && $0.name.count <= 256 && (1...1_000_000_000).contains($0.started) }),
                  groups.reduce(0, { $0 + $1.started }) == summary.started else { throw APIError.invalidResponse }
        }
    }
}

actor RelayUsageAPI {
    static let shared = RelayUsageAPI()
    private let session: URLSession
    init(session supplied: URLSession? = nil) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForRequest = 30
        session = supplied ?? URLSession(configuration: configuration, delegate: NativeTransportDelegate(), delegateQueue: nil)
    }
    static func request(days: Int? = nil, token: String) throws -> URLRequest {
        guard days == nil || [7, 30, 90].contains(days!) else { throw APIError.invalidResponse }
        var url = URLComponents(string: "https://app.multivibe.cloud/relay/v1/" + (days == nil ? "allowance" : "usage"))!
        if let days { url.queryItems = [.init(name: "days", value: String(days))] }
        var request = URLRequest(url: url.url!)
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }
    private func read(days: Int? = nil, token: String) async throws -> Data {
        let (data, response) = try await session.data(for: Self.request(days: days, token: token))
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse, http.url?.host == "app.multivibe.cloud", http.url?.scheme == "https", data.count <= 1_048_576 else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw APIError.server(http.statusCode, "relay_usage_unavailable") }
        return data
    }
    func allowance(token: String) async throws -> RelayAllowance {
        try JSONDecoder().decode(RelayAllowance.self, from: await read(token: token))
    }
    func usage(token: String, accountID: String, days: Int) async throws -> RelayUsage {
        let value = try JSONDecoder().decode(RelayUsage.self, from: await read(days: days, token: token))
        try value.validate(accountID: accountID, days: days)
        return value
    }
}
