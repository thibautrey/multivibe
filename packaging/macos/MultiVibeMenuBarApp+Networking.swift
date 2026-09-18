import AppKit

extension MultiVibeMenuBarApp {
    struct DeviceSignIn: Decodable {
        let id: String
        let provider: String
        let code: String
        let expiresAt: Double
    }

    func receiveDeviceSignIn(_ event: DeviceSignIn) {
        guard event.expiresAt > Date().timeIntervalSince1970 * 1000,
              !event.code.isEmpty, event.code.count <= 64 else { return }
        NSPasteboard.general.clearContents()
        let copied = NSPasteboard.general.setString(event.code, forType: .string)
        let provider = ["openai": "ChatGPT", "github-copilot": "GitHub Copilot", "opencode": "OpenCode", "xai": "Grok"][event.provider] ?? "Provider"
        enqueue(MenuBarNotification(
            id: "device-signin:" + event.id, kind: "device-signin", priority: 100, repeatMode: "edge",
            message: copied ? "\(provider) sign-in code copied. Paste it on the provider’s sign-in page." : "Could not copy the \(provider) sign-in code. Copy it from the dashboard.",
            actionTitle: nil, actionURL: nil, actionPath: nil, confirmationMessage: nil, confirmationTitle: nil
        ))
        presentNextNotificationIfNeeded()
    }

    func pollProviderActivity() {
        guard operational, !pollingActivity, let request = authorizedRequest(path: "/admin/host/menu-bar/activity") else { return }
        pollingActivity = true
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            struct Response: Decodable { let activity: ProviderActivity?; let deviceSignIn: DeviceSignIn? }
            let decoded = (response as? HTTPURLResponse)?.statusCode == 200
                ? data.flatMap { try? JSONDecoder().decode(Response.self, from: $0) } : nil
            DispatchQueue.main.async {
                self?.pollingActivity = false
                self?.providerActivity = decoded?.activity
                if let event = decoded?.deviceSignIn { self?.receiveDeviceSignIn(event) }
                self?.renderQuota()
            }
        }.resume()
    }

    func credentialsURL() -> URL? {
        if let configured = ProcessInfo.processInfo.environment["MULTIVIBE_HOST_DATA_DIR"], !configured.isEmpty {
            return URL(fileURLWithPath: configured, isDirectory: true).appendingPathComponent("host-credentials.json")
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/MultiVibe", isDirectory: true)
            .appendingPathComponent("host-credentials.json")
    }

    func readCredentials() -> HostCredentials? {
        guard let url = credentialsURL(), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(HostCredentials.self, from: data)
    }

    func authorizedRequest(path: String, method: String = "GET") -> URLRequest? {
        guard let credentials = readCredentials(), let url = URL(string: path, relativeTo: dashboardURL) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 3
        request.setValue(credentials.adminToken, forHTTPHeaderField: "x-admin-token")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        return request
    }

    func refresh() {
        guard !refreshing else { return }
        refreshing = true
        render()
        var summaryPath = "/admin/host/menu-bar?consume_notifications=1"
        if UserDefaults.standard.object(forKey: Self.notificationLastForecastScoreKey) != nil {
            let previousScore = UserDefaults.standard.double(forKey: Self.notificationLastForecastScoreKey)
            if previousScore.isFinite && previousScore >= 0 && previousScore <= 100 {
                summaryPath += "&previous_forecast_score=\(previousScore)"
            }
        }
        guard let request = authorizedRequest(path: summaryPath) else {
            refreshing = false
            workerConfigurationState = nil
            workerSetupURL = nil
            updateState(operational: false, status: "Starting…")
            if ownedService?.isRunning != true { ensureServiceIsRunning() }
            return
        }
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let http = response as? HTTPURLResponse
            guard let data, http?.statusCode == 200,
                  let summary = try? JSONDecoder().decode(MenuBarSummary.self, from: data) else {
                DispatchQueue.main.async {
                    self?.refreshing = false
                    self?.workerConfigurationState = nil
                    self?.workerSetupURL = nil
                    self?.updateState(operational: false, status: "Unavailable")
                    if self?.ownedService?.isRunning != true { self?.launchService(avoidingOccupiedPort: http != nil) }
                }
                return
            }
            DispatchQueue.main.async {
                self?.summary = summary
                self?.ingestNotifications(summary)
                let forecastCrossingIsPending = summary.notifications?.contains {
                    $0.kind == "will-codex-reset"
                } == true
                if !forecastCrossingIsPending,
                   let score = summary.forecast?.score, score.isFinite, score >= 0, score <= 100 {
                    UserDefaults.standard.set(score, forKey: Self.notificationLastForecastScoreKey)
                }
                self?.updateState(operational: summary.operational, status: summary.operational ? "Operational" : "Unavailable")
                if summary.operational, self?.pendingDashboardOpen == true { self?.requestDashboardSession() }
                if summary.operational, self?.pendingEnrollmentToken != nil { self?.submitPendingEnrollment() }
                self?.refreshUpdateStatus()
                self?.refreshLocalWorkerStatus()
            }
        }.resume()
    }

    func refreshLocalWorkerStatus() {
        guard let request = authorizedRequest(path: "/admin/provider-agent/local-worker") else {
            workerConfigurationState = nil
            workerSetupURL = nil
            refreshing = false
            render()
            return
        }
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let worker = data
                .flatMap { try? JSONDecoder().decode(LocalWorkerStatusResponse.self, from: $0) }
            let isSuccessful = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                guard let self else { return }
                if isSuccessful, let localWorker = worker?.localWorker {
                    self.workerConfigurationState = localWorker.configurationState
                    self.workerSetupURL = localWorker.configurationState == "unconfigured" ? localWorker.connectURL : nil
                } else {
                    self.workerConfigurationState = nil
                    self.workerSetupURL = nil
                }
                self.refreshing = false
                self.render()
            }
        }.resume()
    }

    func refreshUpdateStatus() {
        guard let request = authorizedRequest(path: "/admin/host-update") else { return }
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let data, (response as? HTTPURLResponse)?.statusCode == 200,
                  let status = try? JSONDecoder().decode(HostUpdateStatus.self, from: data) else { return }
            DispatchQueue.main.async {
                self?.updateStatus = status
                self?.updateBusy = false
                self?.render()
            }
        }.resume()
    }

    func runUpdateAction(path: String) {
        guard var request = authorizedRequest(path: path, method: "POST") else { return }
        updateBusy = true
        render()
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            guard let self else { return }
            let accepted = (response as? HTTPURLResponse)?.statusCode ?? 500
            DispatchQueue.main.async {
                if (200...299).contains(accepted) {
                    self.refreshUpdateStatus()
                } else {
                    self.updateBusy = false
                    self.render()
                }
            }
        }.resume()
    }

    func updateState(operational: Bool, status: String) {
        self.operational = operational
        self.statusText = status
        render()
    }
}
