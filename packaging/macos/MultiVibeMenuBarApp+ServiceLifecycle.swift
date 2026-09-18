import AppKit
import ServiceManagement

extension MultiVibeMenuBarApp {
    var startAtLoginEnabled: Bool {
        UserDefaults.standard.object(forKey: "startAtLogin") as? Bool ?? true
    }

    func synchronizeLoginItem() {
        do {
            if startAtLoginEnabled {
                if SMAppService.mainApp.status == .notRegistered {
                    try SMAppService.mainApp.register()
                }
            } else if SMAppService.mainApp.status == .enabled || SMAppService.mainApp.status == .requiresApproval {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            // The Host remains usable when macOS refuses a login-item change.
            // The next explicit toggle retries and macOS exposes approval in System Settings.
        }
    }

    @discardableResult
    func runLaunchctl(_ arguments: [String]) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    var hostLaunchAgentService: String {
        "gui/\(getuid())/cloud.multivibe.host"
    }

    var hostLaunchAgentURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/cloud.multivibe.host.plist")
    }

    func stopHostService() {
        if let service = ownedService, service.isRunning {
            service.terminate()
            ownedService = nil
        }
        _ = runLaunchctl(["bootout", hostLaunchAgentService])
        updateState(operational: false, status: "Stopped")
    }

    func startHostLaunchAgent() {
        _ = runLaunchctl(["enable", hostLaunchAgentService])
        if FileManager.default.isReadableFile(atPath: hostLaunchAgentURL.path) {
            _ = runLaunchctl(["bootstrap", "gui/\(getuid())", hostLaunchAgentURL.path])
            _ = runLaunchctl(["kickstart", "-k", hostLaunchAgentService])
        }
    }

    func setStartAtLogin(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: "startAtLogin")
        var loginItemNeedsAttention = false
        do {
            if enabled {
                if SMAppService.mainApp.status == .notRegistered {
                    try SMAppService.mainApp.register()
                }
            } else if SMAppService.mainApp.status == .enabled || SMAppService.mainApp.status == .requiresApproval {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            loginItemNeedsAttention = true
        }

        if enabled {
            startHostLaunchAgent()
            ensureServiceIsRunning()
        } else {
            _ = runLaunchctl(["disable", hostLaunchAgentService])
            stopHostService()
        }
        if loginItemNeedsAttention {
            updateState(operational: operational, status: "Login setting needs approval")
        }
        render()
    }

    func ensureServiceIsRunning() {
        guard UserDefaults.standard.object(forKey: "startAtLogin") as? Bool ?? true else { return }
        if ownedService?.isRunning == true {
            refreshing = false
            refresh()
            return
        }
        if let request = authorizedRequest(path: "/admin/host/menu-bar") {
            URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
                let http = response as? HTTPURLResponse
                let isOurs = http?.statusCode == 200 && data.flatMap { try? JSONDecoder().decode(MenuBarSummary.self, from: $0) } != nil
                DispatchQueue.main.async {
                    self?.refreshing = false
                    if isOurs { self?.refresh() }
                    else { self?.launchService(avoidingOccupiedPort: http != nil) }
                }
            }.resume()
            return
        }
        var health = URLRequest(url: dashboardURL.appendingPathComponent("health"))
        health.timeoutInterval = 1
        URLSession.shared.dataTask(with: health) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                self?.refreshing = false
                self?.launchService(avoidingOccupiedPort: response != nil)
            }
        }.resume()
    }

    func launchService(avoidingOccupiedPort: Bool = false) {
        if let process = ownedService, process.isRunning { return }
        if avoidingOccupiedPort && !hasExplicitHostPort && !usesFallbackPort {
            dashboardURL = URL(string: "http://127.0.0.1:1456")!
            usesFallbackPort = true
        }
        guard let executable = Bundle.main.executableURL else {
            updateState(operational: false, status: "Bundle error")
            return
        }
        let command = executable.deletingLastPathComponent().appendingPathComponent("multivibe-host")
        let process = Process()
        process.executableURL = command
        process.arguments = ["run"]
        var environment = ProcessInfo.processInfo.environment
        environment["MULTIVIBE_HOST_PORT"] = String(dashboardURL.port ?? configuredHostPort)
        process.environment = environment
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.ownedService = nil
                self?.updateState(operational: false, status: "Stopped")
            }
        }
        do {
            try process.run()
            ownedService = process
            updateState(operational: false, status: "Starting…")
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.refresh() }
        } catch {
            updateState(operational: false, status: "Failed to start")
        }
    }
}
