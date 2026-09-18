import AppKit

extension MultiVibeMenuBarApp {
    func ingestNotifications(_ summary: MenuBarSummary) {
        let incoming = summary.notifications ?? []
        let conditionIDs = Set(incoming.filter {
            isValid($0) && $0.repeatMode == "condition"
        }.map(\.id))
        pendingNotifications.removeAll {
            $0.repeatMode == "condition" && !conditionIDs.contains($0.id)
        }
        for id in activeConditionNotificationIDs.subtracting(conditionIDs) {
            activeConditionNotificationIDs.remove(id)
            UserDefaults.standard.removeObject(forKey: Self.notificationConditionLastShownPrefix + id)
        }

        let shouldPreferGitHub = summary.githubStarPrompt?.eligible == true
            && !githubStarPromptAcknowledged
            && !githubStarPromptPresented
        for notification in incoming {
            guard isValid(notification) else { continue }
            if shouldPreferGitHub && notification.kind == "output-tokens" {
                acknowledge(notification.id)
                continue
            }
            if notification.repeatMode == "once" && acknowledgedNotificationIDs.contains(notification.id) {
                continue
            }
            if notification.repeatMode == "condition" {
                activeConditionNotificationIDs.insert(notification.id)
                let lastShown = UserDefaults.standard.double(
                    forKey: Self.notificationConditionLastShownPrefix + notification.id
                )
                if lastShown > 0 && Date().timeIntervalSince1970 - lastShown < Self.notificationConditionReminder {
                    continue
                }
            }
            enqueue(notification)
        }

        if shouldPreferGitHub {
            enqueue(MenuBarNotification(
                id: "github-star:5000000",
                kind: "github-star",
                priority: 30,
                repeatMode: "edge",
                message: "Nice work — you’ve generated 5 million output tokens with MultiVibe. If it’s useful, please star the project on GitHub.",
                actionTitle: "⭐ Star MultiVibe on GitHub",
                actionURL: Self.githubRepositoryURL,
                actionPath: nil,
                confirmationMessage: "Thank you for supporting MultiVibe! ❤️",
                confirmationTitle: "Thank you! ❤️"
            ))
        }
    }

    func isValid(_ notification: MenuBarNotification) -> Bool {
        guard !notification.id.isEmpty, notification.id.count <= 160,
              !notification.message.isEmpty, notification.message.count <= 500,
              (0...100).contains(notification.priority),
              ["once", "condition", "edge"].contains(notification.repeatMode) else { return false }
        if let url = notification.actionURL, url.scheme != "https" { return false }
        if let path = notification.actionPath, path != "/admin/host/weekly-auto-reset" { return false }
        return true
    }

    func enqueue(_ notification: MenuBarNotification) {
        guard currentNotification?.id != notification.id,
              !pendingNotifications.contains(where: { $0.id == notification.id }) else { return }
        pendingNotifications.append(notification)
        pendingNotifications.sort { left, right in
            left.priority == right.priority ? left.id < right.id : left.priority > right.priority
        }
    }

    func acknowledge(_ id: String) {
        acknowledgedNotificationIDs.insert(id)
        UserDefaults.standard.set(
            acknowledgedNotificationIDs.sorted(),
            forKey: Self.notificationAcknowledgedIDsKey
        )
    }

    func presentNextNotificationIfNeeded() {
        guard operational, currentNotification == nil, !popover.isShown,
              !notificationPopover.isShown, let button = statusItem.button else { return }
        if !startupNotificationPresented {
            startupNotificationPresented = true
            notificationPopup.configure(.init(
                message: "MultiVibe started, get vibing!",
                actionTitle: "",
                confirmationMessage: nil,
                confirmationTitle: nil,
                action: {}
            ))
            notificationPopover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            closeNotification(after: 2)
            return
        }
        guard let next = pendingNotifications.first else { return }
        let urgent = next.priority >= 80
        let isBriefNotification = next.kind == "device-signin" || next.kind == "provider-quota-limit"
            || next.kind == "reset-credit-increased"
        let spacing = next.kind == "github-star" || isBriefNotification
            ? 0
            : (urgent ? Self.notificationUrgentSpacing : Self.notificationGamificationSpacing)
        let spacingKey = urgent
            ? Self.notificationLastUrgentPresentedAtKey
            : Self.notificationLastGamificationPresentedAtKey
        let lastPresented = UserDefaults.standard.double(forKey: spacingKey)
        if lastPresented > 0 && Date().timeIntervalSince1970 - lastPresented < spacing { return }

        pendingNotifications.removeFirst()
        currentNotification = next
        if next.repeatMode == "once" { acknowledge(next.id) }
        if next.repeatMode == "condition" {
            UserDefaults.standard.set(
                Date().timeIntervalSince1970,
                forKey: Self.notificationConditionLastShownPrefix + next.id
            )
        }
        if next.kind == "will-codex-reset",
           let score = summary?.forecast?.score, score.isFinite, score >= 0, score <= 100 {
            UserDefaults.standard.set(score, forKey: Self.notificationLastForecastScoreKey)
        }
        if next.kind == "github-star" {
            githubStarPromptPresented = true
            // Showing the invitation is enough: dismissal must survive a relaunch,
            // without requiring the user to open GitHub.
            githubStarPromptAcknowledged = true
            UserDefaults.standard.set(true, forKey: Self.githubStarPromptAcknowledgedKey)
        }
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: spacingKey)

        notificationPopup.configure(.init(
            message: next.message,
            actionTitle: next.actionTitle ?? "Got it",
            confirmationMessage: next.confirmationMessage,
            confirmationTitle: next.confirmationTitle,
            action: { [weak self] in self?.performNotificationAction(next) }
        ))
        notificationPopover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        if isBriefNotification {
            closeNotification(after: next.kind == "reset-credit-increased" ? 5 : 8)
        } else {
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
    }

    func performNotificationAction(_ notification: MenuBarNotification) {
        if let path = notification.actionPath {
            performNotificationRequest(path: path)
            return
        }
        if let url = notification.actionURL { NSWorkspace.shared.open(url) }
        if notification.kind == "github-star" {
            githubStarPromptAcknowledged = true
            UserDefaults.standard.set(true, forKey: Self.githubStarPromptAcknowledgedKey)
        }
        if notification.confirmationMessage != nil, notification.confirmationTitle != nil {
            notificationPopup.showConfirmation()
            closeNotification(after: 2)
        } else {
            notificationPopover.performClose(nil)
        }
    }

    func performNotificationRequest(path: String) {
        guard var request = authorizedRequest(path: path, method: "POST") else { return }
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        notificationPopup.showStatus(message: "Activating automatic reset…", actionTitle: "Please wait…", actionEnabled: false)
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if (200..<300).contains(status) {
                    self?.notificationPopup.showConfirmation()
                    self?.closeNotification(after: 2)
                    self?.refresh()
                } else {
                    self?.notificationPopup.showStatus(
                        message: "Automatic reset could not be activated. You can try again.",
                        actionTitle: "Try again",
                        actionEnabled: true
                    )
                }
            }
        }.resume()
    }

    func closeNotification(after seconds: TimeInterval) {
        notificationCloseWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.notificationPopover.performClose(nil)
        }
        notificationCloseWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: workItem)
    }

    func popoverDidClose(_ notification: Notification) {
        if let closedPopover = notification.object as? NSPopover,
           closedPopover === notificationPopover {
            notificationCloseWorkItem?.cancel()
            currentNotification = nil
        }
        presentNextNotificationIfNeeded()
    }
}
