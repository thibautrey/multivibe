import AppKit
import Darwin
import Foundation

let configuredHostPort: Int = {
    let configured = ProcessInfo.processInfo.environment["MULTIVIBE_HOST_PORT"] ?? "1455"
    return Int(configured).flatMap { (1...65535).contains($0) ? $0 : nil } ?? 1455
}()

let hasExplicitHostPort = ProcessInfo.processInfo.environment["MULTIVIBE_HOST_PORT"] != nil

@main
final class MultiVibeMenuBarApp: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    static let githubRepositoryURL = URL(string: "https://github.com/thibautrey/multivibe")!
    static let githubStarPromptAcknowledgedKey = "githubStarPromptAcknowledged"
    static let notificationAcknowledgedIDsKey = "notificationAcknowledgedIDs"
    static let notificationLastForecastScoreKey = "notificationLastForecastScore"
    static let notificationLastUrgentPresentedAtKey = "notificationLastUrgentPresentedAt"
    static let notificationLastGamificationPresentedAtKey = "notificationLastGamificationPresentedAt"
    static let notificationConditionLastShownPrefix = "notificationConditionLastShown."
    static let notificationUrgentSpacing: TimeInterval = 60 * 60
    static let notificationGamificationSpacing: TimeInterval = 7 * 24 * 60 * 60
    static let notificationConditionReminder: TimeInterval = 7 * 24 * 60 * 60
    let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let popover = NSPopover()
    let popoverController = HostPopoverController()
    let notificationPopover = NSPopover()
    let notificationPopup = NotificationPopup()
    var assistantWindows: [HostAssistantWindow] = []
    var refreshTimer: Timer?
    var quotaTimer: Timer?
    var quotaSelection = QuotaSelection(pin: UserDefaults.standard.string(forKey: "quotaProviderPin"))
    var providerActivity: ProviderActivity?
    var pollingActivity = false
    var quotaTicks = 0

    var signalSources: [DispatchSourceSignal] = []
    var ownedService: Process?
    var dashboardURL = URL(string: "http://127.0.0.1:\(configuredHostPort)")!
    var usesFallbackPort = false
    var pendingDashboardOpen = false
    var operational = false
    var statusText = "Starting…"
    var summary: MenuBarSummary?
    var workerConfigurationState: String?
    var workerSetupURL: URL?
    var refreshing = false
    var updateStatus: HostUpdateStatus?
    var updateBusy = false
    var didFinishLaunching = false
    var pendingEnrollmentToken: String?
    var enrollmentInProgress = false
    var githubStarPromptPresented = false
    var startupNotificationPresented = false
    var notificationCloseWorkItem: DispatchWorkItem?
    var githubStarPromptAcknowledged = UserDefaults.standard.bool(forKey: githubStarPromptAcknowledgedKey)
    var acknowledgedNotificationIDs = Set(
        UserDefaults.standard.stringArray(forKey: notificationAcknowledgedIDsKey) ?? []
    )
    var activeConditionNotificationIDs = Set<String>()
    var pendingNotifications: [MenuBarNotification] = []
    var currentNotification: MenuBarNotification?
#if DEBUG
    var previewWindow: NSWindow?
#endif

    static func main() {
        let app = NSApplication.shared
        let delegate = MultiVibeMenuBarApp()
        app.delegate = delegate
#if DEBUG
        if ProcessInfo.processInfo.environment["MULTIVIBE_HOST_MENU_PREVIEW"] == "1" {
            app.setActivationPolicy(.regular)
        } else {
            app.setActivationPolicy(.accessory)
        }
#else
        app.setActivationPolicy(.accessory)
#endif
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        didFinishLaunching = true
        configureStatusItem()
        configureAssistantIntegration()
        configurePopover()
        popoverController.selectQuotaProvider = { [weak self] id in
            guard let self else { return }
            self.quotaSelection.pin = id
            UserDefaults.standard.set(id, forKey: "quotaProviderPin")
            self.render()
        }
        quotaTimer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.renderQuota()
            self.quotaTicks += 1
            if self.quotaTicks % 2 == 0 { self.pollProviderActivity() }
        }
        RunLoop.main.add(quotaTimer!, forMode: .common)
        configureTerminationSignals()
        synchronizeLoginItem()
        render()
        ensureServiceIsRunning()
        if pendingEnrollmentToken != nil {
            DispatchQueue.main.async { [weak self] in self?.presentPendingEnrollmentConfirmation() }
        }
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.refresh() }
#if DEBUG
        if ProcessInfo.processInfo.environment["MULTIVIBE_HOST_MENU_PREVIEW"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) { [weak self] in self?.showPreviewWindow() }
        }
#endif
    }

    func applicationWillTerminate(_ notification: Notification) {
        refreshTimer?.invalidate()
        quotaTimer?.invalidate()
        notificationCloseWorkItem?.cancel()
        if let process = ownedService, process.isRunning { process.terminate() }
    }

    func configureStatusItem() {
        guard let button = statusItem.button else { return }
        let iconURL = Bundle.main.resourceURL?.appendingPathComponent("MultiVibeMenuBarTemplate.png")
        if let iconURL, let image = NSImage(contentsOf: iconURL) {
            image.size = NSSize(width: 18, height: 18)
            image.isTemplate = true
            button.image = image
        } else {
            button.image = NSImage(systemSymbolName: "waveform.path", accessibilityDescription: "MultiVibe")
        }
        button.imagePosition = .imageLeading
        // Let the status bar choose its foreground for the current background and selection.
        button.contentTintColor = nil
        button.target = self
        button.action = #selector(togglePopover)
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        button.toolTip = "MultiVibe Host"
    }

    func configurePopover() {
        popover.behavior = .transient
        popover.animates = true
        popover.contentSize = NSSize(width: 420, height: 570)
        popover.contentViewController = popoverController
        popover.delegate = self
        popoverController.openAssistant = { [weak self] in
            self?.popover.performClose(nil)
            Task { @MainActor in self?.showAssistant() }
        }
        popoverController.openDashboard = { [weak self] in
            self?.openDashboard()
        }
        popoverController.configureWorker = { [weak self] in
            guard let self, let workerSetupURL = self.workerSetupURL else { return }
            self.popover.performClose(nil)
            NSWorkspace.shared.open(workerSetupURL)
        }
        popoverController.checkForUpdates = { [weak self] in self?.runUpdateAction(path: "/admin/host-update/check") }
        popoverController.installUpdate = { [weak self] in self?.runUpdateAction(path: "/admin/host-update/apply") }
        popoverController.setStartAtLogin = { [weak self] enabled in self?.setStartAtLogin(enabled) }
        popoverController.quit = { [weak self] in self?.quitApplication() }

        notificationPopover.behavior = .transient
        notificationPopover.animates = true
        notificationPopover.contentSize = NSSize(width: 340, height: 150)
        notificationPopover.contentViewController = notificationPopup
        notificationPopover.delegate = self
    }

    func configureTerminationSignals() {
        for signalNumber in [SIGINT, SIGTERM] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { NSApplication.shared.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }
    }

    func renderQuota() {
        guard let button = statusItem.button else { return }
        let now = Date().timeIntervalSince1970
        let providers = summary?.providers ?? []
        let eligible = providers.filter { !$0.windows.isEmpty || $0.balance != nil || $0.id == quotaSelection.pin }
        quotaSelection.update(ids: eligible.map(\.id), activity: providerActivity, now: now)
        var title = ""
        var tooltip = "MultiVibe Host — \(statusText)"
        let font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
        statusItem.length = NSStatusItem.variableLength
        if operational, let provider = eligible.first(where: { $0.id == quotaSelection.selected }) {
            let values = provider.windows.map { "\($0.label):\(Int($0.remainingPercent.rounded()))%" }.joined(separator: "  ")
            // Credit-only providers expose an absolute balance, not a quota window.
            let quota: String
            if !values.isEmpty {
                quota = values
            } else if let balance = provider.balance {
                quota = creditBalanceText(remaining: balance.remaining, unit: balance.unit)
            } else {
                quota = "Quota unavailable"
            }
            title = "  " + (now - quotaSelection.changedAt < 3 ? "\(provider.displayName) · " : "") + quota
            tooltip = "\(provider.displayName) — \(quota)"
        } else {
            if operational, providers.isEmpty, let quota = summary?.quota {
                title = [quota.weeklyRemainingPercent.map { "W:\(Int($0.rounded()))%" }, quota.fiveHourRemainingPercent.map { "5h:\(Int($0.rounded()))%" }].compactMap { $0 }.joined(separator: "  ")
            }
        }
        if button.title != title {
            if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                button.wantsLayer = true
                let transition = CATransition()
                transition.type = .fade
                transition.duration = 0.2
                button.layer?.add(transition, forKey: "quotaFade")
            }
            button.title = title
        }
        button.font = font
        button.toolTip = tooltip
        button.setAccessibilityLabel(tooltip)
    }

    func render() {
        renderQuota()
        popoverController.pinnedQuotaProvider = quotaSelection.pin
        popoverController.render(
            summary: summary,
            workerNeedsSetup: workerConfigurationState == "unconfigured" && workerSetupURL != nil,
            status: statusText,
            operational: operational,
            updateStatus: updateStatus,
            updateBusy: updateBusy,
            startAtLogin: UserDefaults.standard.object(forKey: "startAtLogin") as? Bool ?? true
        )
        presentNextNotificationIfNeeded()
    }

    @objc func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            render()
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            NSApplication.shared.activate(ignoringOtherApps: true)
            refresh()
        }
    }

    @objc func refreshNow() {
        refreshing = false
        refresh()
    }

    @objc func openDashboard() {
        pendingDashboardOpen = true
        if !operational {
            updateState(operational: false, status: "Starting…")
            ensureServiceIsRunning()
            return
        }
        requestDashboardSession()
    }

    func requestDashboardSession() {
        let canonicalURL = URL(string: "http://127.0.0.1:\(configuredHostPort)")!
        var candidates = [dashboardURL]
        if dashboardURL != canonicalURL { candidates.append(canonicalURL) }
        requestDashboardSession(using: candidates)
    }

    func requestDashboardSession(using candidates: [URL]) {
        guard let baseURL = candidates.first else {
            DispatchQueue.main.async { [weak self] in
                self?.pendingDashboardOpen = false
            }
            return
        }
        guard let credentials = readCredentials(),
              let url = URL(string: "/admin/desktop-session", relativeTo: baseURL) else {
            ensureServiceIsRunning()
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 3
        request.setValue(credentials.adminToken, forHTTPHeaderField: "x-admin-token")
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            guard let data, (response as? HTTPURLResponse)?.statusCode == 200,
                  let session = try? JSONDecoder().decode(DesktopSession.self, from: data),
                  let dashboard = URL(string: session.path, relativeTo: baseURL) else {
                self.requestDashboardSession(using: Array(candidates.dropFirst()))
                return
            }
            DispatchQueue.main.async {
                self.pendingDashboardOpen = false
                if NSWorkspace.shared.open(dashboard) {
                    self.popover.performClose(nil)
                }
            }
        }.resume()
    }

    @objc func quitApplication() {
        stopHostService()
        NSApplication.shared.terminate(nil)
    }
}
