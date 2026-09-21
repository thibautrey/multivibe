import Foundation

struct HostCredentials: Decodable {
    let adminToken: String
    let proxyAPIKey: String?

    enum CodingKeys: String, CodingKey {
        case adminToken = "admin_token"
        case proxyAPIKey = "proxy_api_key"
    }
}

struct QuotaWindow: Decodable {
    let label: String?
    let remainingPercent: Double
    let resetAt: Double?
}

/// Absolute spendable credit for a pay-as-you-go provider. Never a percentage.
struct CreditBalance: Decodable {
    let remaining: Double
    let unit: String
}

struct MenuBarAccount: Decodable {
    let displayName: String
    let enabled: Bool
    let status: String
    let usageStatus: String
    let fetchedAt: Double?
    let fiveHour: QuotaWindow?
    let weekly: QuotaWindow?
    let monthly: QuotaWindow?
    let balance: CreditBalance?
}

struct MenuBarQuota: Decodable {
    let fiveHourRemainingPercent: Double?
    let fiveHourAccountCount: Int
    let weeklyRemainingPercent: Double?
    let weeklyAccountCount: Int
}

struct ProviderQuota: Decodable {
    struct Window: Decodable {
        let label: String
        let remainingPercent: Double
        let accountCount: Int
    }
    struct Balance: Decodable {
        let remaining: Double
        let unit: String
        let accountCount: Int
    }
    let id: String
    let displayName: String
    let accounts: [MenuBarAccount]
    let windows: [Window]
    let balance: Balance?
}

struct ProviderActivity: Decodable {
    let providerId: String
    let usedAt: Double
}

// Time is injected so activity freshness and concurrent-provider debounce are deterministic.
struct QuotaSelection {
    var selected: String?
    var pin: String?
    var changedAt: TimeInterval = -.infinity
    var observedUsage: Double = 0
    var pending: ProviderActivity?

    mutating func update(ids: [String], activity: ProviderActivity?, now: TimeInterval) {
        guard !ids.isEmpty else { selected = nil; pending = nil; return }
        if let activity, activity.usedAt > observedUsage {
            observedUsage = activity.usedAt
            if now - activity.usedAt / 1000 < 30, ids.contains(activity.providerId) {
                pending = activity
            }
        }
        if let pin, ids.contains(pin) {
            select(pin, now: now)
            pending = nil
            return
        }
        if !ids.contains(selected ?? "") { select(pending?.providerId ?? ids[0], now: now) }
        if let activity = pending {
            if now - activity.usedAt / 1000 >= 30 || !ids.contains(activity.providerId) {
                pending = nil
            } else if selected == activity.providerId || now - changedAt >= 5 {
                select(activity.providerId, now: now)
                pending = nil
            }
        }
    }

    private mutating func select(_ id: String, now: TimeInterval) {
        if selected != id { selected = id; changedAt = now }
    }
}

struct MenuBarGitHubStarPrompt: Decodable {
    let generatedOutputTokens: Double
    let threshold: Double
    let eligible: Bool
}

struct MenuBarForecast: Decodable {
    let score: Double
}

struct MenuBarNotification: Decodable {
    let id: String
    let kind: String
    let priority: Int
    let repeatMode: String
    let message: String
    let actionTitle: String?
    let actionURL: URL?
    let actionPath: String?
    let confirmationMessage: String?
    let confirmationTitle: String?

    enum CodingKeys: String, CodingKey {
        case id, kind, priority, repeatMode, message, actionTitle, actionPath, confirmationMessage, confirmationTitle
        case actionURL = "actionUrl"
    }
}

struct MenuBarSummary: Decodable {
    struct Earnings: Decodable {
        let available: Bool
        let currency: String?
        let today: Decimal?
        let week: Decimal?
        let month: Decimal?
        let lifetime: Decimal?

        var hasStartedEarning: Bool {
            available && [lifetime, today, week, month].compactMap { $0 }.contains { $0 > 0 }
        }
    }

    let operational: Bool
    let providers: [ProviderQuota]?
    let accounts: [MenuBarAccount]
    let quota: MenuBarQuota
    let githubStarPrompt: MenuBarGitHubStarPrompt?
    let forecast: MenuBarForecast?
    let notifications: [MenuBarNotification]?
    let earnings: Earnings
}

struct LocalWorkerStatusResponse: Decodable {
    struct LocalWorker: Decodable {
        let configurationState: String
        let connectURL: URL

        enum CodingKeys: String, CodingKey {
            case configurationState = "configuration_state"
            case connectURL = "connect_url"
        }
    }

    let localWorker: LocalWorker?
}

struct DesktopSession: Decodable {
    let path: String
}

struct HostUpdateStatus: Decodable {
    let status: String
    let availableVersion: String?
    let downloaded: Bool
    let installRequested: Bool
    let lastError: String?

    enum CodingKeys: String, CodingKey {
        case status
        case availableVersion = "available_version"
        case downloaded
        case installRequested = "install_requested"
        case lastError = "last_error"
    }
}

struct CloudEnrollmentResult: Decodable {
    let state: String
}

struct CloudEnrollmentError: Decodable {
    let error: String
}

enum CloudEnrollmentFailure {
    case invalidLink
    case localAgentUnavailable
    case expiredGrant
    case conflict
    case cloudRejected
    case cloudUnavailable
}
