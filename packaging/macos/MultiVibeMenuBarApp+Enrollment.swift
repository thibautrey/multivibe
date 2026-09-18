import AppKit

extension MultiVibeMenuBarApp {
    func application(_ application: NSApplication, open urls: [URL]) {
        guard urls.count == 1, let token = enrollmentToken(from: urls[0]) else {
            if didFinishLaunching { showEnrollmentAlert(success: false, failure: .invalidLink) }
            return
        }
        guard pendingEnrollmentToken == nil, !enrollmentInProgress else { return }
        pendingEnrollmentToken = token
        if didFinishLaunching { presentPendingEnrollmentConfirmation() }
    }

    func enrollmentToken(from url: URL) -> String? {
        guard url.absoluteString.count <= 256,
              url.scheme?.lowercased() == "multivibe",
              url.host?.lowercased() == "add-worker",
              url.path.isEmpty,
              url.port == nil,
              url.user == nil,
              url.password == nil,
              url.query == nil,
              let fragment = url.fragment,
              let fragmentComponents = URLComponents(string: "multivibe://fragment?\(fragment)"),
              let items = fragmentComponents.queryItems,
              items.count == 1,
              items[0].name == "enrollment_token",
              let token = items[0].value,
              token.range(of: #"^mve_[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil
        else { return nil }
        return token
    }

    func presentPendingEnrollmentConfirmation() {
        guard pendingEnrollmentToken != nil, !enrollmentInProgress else { return }
        NSApplication.shared.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "Add this worker to MultiVibe Cloud?"
        alert.informativeText = "MultiVibe Host will register this worker's public device identity. Cloud jobs use only MultiVibe's managed Ollama runtime and still require your saved capacity consent. Your private key and local runtime settings stay on this worker."
        alert.addButton(withTitle: "Add this worker")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else {
            pendingEnrollmentToken = nil
            return
        }
        if operational { submitPendingEnrollment() }
        else {
            updateState(operational: false, status: "Connecting…")
            ensureServiceIsRunning()
        }
    }

    func submitPendingEnrollment() {
        guard let token = pendingEnrollmentToken, !enrollmentInProgress,
              var request = authorizedRequest(path: "/admin/provider-agent/cloud-shadow/enroll-handoff", method: "POST")
        else { return }
        enrollmentInProgress = true
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["enrollment_token": token])
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, requestError in
            guard let self else { return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let connected = (200...299).contains(status)
                && data.flatMap { try? JSONDecoder().decode(CloudEnrollmentResult.self, from: $0) }?.state == "submitted"
            let errorCode = data.flatMap { try? JSONDecoder().decode(CloudEnrollmentError.self, from: $0) }?.error
            let failure: CloudEnrollmentFailure? = if connected {
                nil
            } else if requestError != nil || status == 0 || status == 503 || errorCode == "provider_agent_unavailable" {
                .localAgentUnavailable
            } else if status == 400 || errorCode == "invalid_provider_cloud_handoff" {
                .invalidLink
            } else if status == 409 || errorCode == "provider_cloud_enrollment_conflict" {
                .conflict
            } else if status == 410 || errorCode == "provider_cloud_enrollment_expired" {
                .expiredGrant
            } else if status == 502 || errorCode == "provider_cloud_unavailable" {
                .cloudUnavailable
            } else {
                .cloudRejected
            }
            DispatchQueue.main.async {
                self.pendingEnrollmentToken = nil
                self.enrollmentInProgress = false
                self.showEnrollmentAlert(success: connected, failure: failure)
                self.refreshNow()
            }
        }.resume()
    }

    func showEnrollmentAlert(success: Bool, failure: CloudEnrollmentFailure? = nil) {
        NSApplication.shared.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = success ? .informational : .warning
        alert.messageText = success ? "This worker is connected" : "This worker could not be connected"
        if success {
            alert.informativeText = "Its public identity was registered securely. Cloud jobs use only MultiVibe's managed Ollama runtime and still require your saved capacity consent."
        } else {
            switch failure {
            case .invalidLink:
                alert.informativeText = "The MultiVibe connection link is invalid or incomplete. Start again from MultiVibe Cloud."
            case .localAgentUnavailable:
                alert.informativeText = "The local worker service is unavailable. Restart MultiVibe Host, then try again from MultiVibe Cloud."
            case .expiredGrant:
                alert.informativeText = "The MultiVibe connection link has expired. Start again from MultiVibe Cloud to create a new link."
            case .conflict:
                alert.informativeText = "This worker already has a different Cloud enrollment. Refresh MultiVibe Cloud and use the existing connection."
            case .cloudUnavailable:
                alert.informativeText = "MultiVibe Cloud is temporarily unavailable. Keep MultiVibe Host open and try again shortly."
            case .cloudRejected, .none:
                alert.informativeText = "MultiVibe Cloud rejected the connection. Start again from MultiVibe Cloud with a new connection link."
            }
        }
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

#if DEBUG
    func showPreviewWindow() {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: NSSize(width: 420, height: 570)),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "MultiVibe Host menu preview"
        window.contentViewController = popoverController
        window.center()
        window.makeKeyAndOrderFront(nil)
        previewWindow = window
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
#endif
}
