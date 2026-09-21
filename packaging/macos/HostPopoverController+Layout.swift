import AppKit

extension HostPopoverController {
    func makeHeader() -> NSView {
        let container = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false

        let icon = NSImageView()
        icon.image = appIcon()
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false

        headerTitle.font = .systemFont(ofSize: 17, weight: .semibold)
        headerTitle.textColor = MenuBarPalette.text
        headerStatus.font = .systemFont(ofSize: 11, weight: .regular)
        headerStatus.textColor = MenuBarPalette.success
        headerVersion.font = .systemFont(ofSize: 10, weight: .regular)
        headerVersion.textColor = MenuBarPalette.muted
        let identity = NSStackView(views: [headerTitle, headerVersion])
        identity.orientation = .horizontal
        identity.alignment = .firstBaseline
        identity.spacing = 8
        let labels = NSStackView(views: [identity, headerStatus])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 2
        labels.translatesAutoresizingMaskIntoConstraints = false

        let divider = makeDivider()
        divider.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(icon)
        container.addSubview(labels)
        container.addSubview(divider)

        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 18),
            icon.centerYAnchor.constraint(equalTo: container.centerYAnchor, constant: -1),
            icon.widthAnchor.constraint(equalToConstant: 36),
            icon.heightAnchor.constraint(equalToConstant: 36),
            labels.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 12),
            labels.centerYAnchor.constraint(equalTo: icon.centerYAnchor),
            labels.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -18),
            divider.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            divider.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            divider.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            divider.heightAnchor.constraint(equalToConstant: 1),
        ])
        return container
    }

    func makeFooter() -> NSView {
        let container = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false
        let divider = makeDivider()
        divider.translatesAutoresizingMaskIntoConstraints = false

        styleButton(primaryButton, kind: .primary)
        primaryButton.target = self
        primaryButton.action = #selector(didOpenDashboard)
        let quitButton = NSButton(title: "Quit", target: self, action: #selector(didQuit))
        styleButton(quitButton, kind: .quiet)

        primaryButton.image = NSImage(systemSymbolName: "arrow.up.right.square", accessibilityDescription: nil)
        primaryButton.imagePosition = .imageTrailing
        let askButton = NSButton(title: "Ouvrir l’app", target: self, action: #selector(didOpenAssistant))
        styleButton(askButton, kind: .secondary)
        let actions = NSStackView(views: [primaryButton, askButton, NSView(), quitButton])
        actions.orientation = .horizontal
        actions.alignment = .centerY
        actions.spacing = 8
        actions.translatesAutoresizingMaskIntoConstraints = false
        primaryButton.setContentHuggingPriority(.defaultLow, for: .horizontal)

        container.addSubview(divider)
        container.addSubview(actions)
        NSLayoutConstraint.activate([
            divider.topAnchor.constraint(equalTo: container.topAnchor),
            divider.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            divider.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            divider.heightAnchor.constraint(equalToConstant: 1),
            actions.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 18),
            actions.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -18),
            actions.centerYAnchor.constraint(equalTo: container.centerYAnchor, constant: 1),
            primaryButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 170),
            primaryButton.heightAnchor.constraint(equalToConstant: 36),
            quitButton.heightAnchor.constraint(equalToConstant: 34),
        ])
        return container
    }

    func makeDivider() -> NSView {
        AdaptiveLayerView(backgroundColor: MenuBarPalette.line)
    }

    enum ButtonKind {
        case primary
        case secondary
        case quiet
    }

    func styleButton(_ button: NSButton, kind: ButtonKind) {
        button.bezelStyle = .rounded
        button.controlSize = .regular
        button.font = .systemFont(ofSize: 12, weight: .semibold)
        button.focusRingType = .default
        switch kind {
        case .primary:
            button.bezelColor = MenuBarPalette.primary
            button.contentTintColor = .white
        case .secondary:
            button.bezelColor = MenuBarPalette.surfaceMuted
            button.contentTintColor = MenuBarPalette.mutedStrong
        case .quiet:
            button.isBordered = false
            button.contentTintColor = MenuBarPalette.muted
        }
    }

    func sectionLabel(_ text: String) -> NSTextField {
        label(text, size: 10, weight: .semibold, color: MenuBarPalette.muted)
    }

    func card() -> NSView {
        let view = AdaptiveLayerView(backgroundColor: MenuBarPalette.panel, borderColor: MenuBarPalette.line)
        view.layer?.cornerRadius = 14
        view.layer?.borderWidth = 0.5
        view.layer?.masksToBounds = true
        view.translatesAutoresizingMaskIntoConstraints = false
        view.widthAnchor.constraint(equalToConstant: 384).isActive = true
        return view
    }

    func summaryCard(_ quota: MenuBarQuota?) -> NSView {
        let container = card()
        let weekly = quotaCell(title: "Weekly", value: quota?.weeklyRemainingPercent, detail: accountCount(quota?.weeklyAccountCount ?? 0))
        var quotaCells: [NSView] = []
        if quota?.fiveHourAccountCount ?? 0 > 0 {
            quotaCells.append(
                quotaCell(
                    title: "5 hours",
                    value: quota?.fiveHourRemainingPercent,
                    detail: accountCount(quota?.fiveHourAccountCount ?? 0)
                )
            )
        }
        quotaCells.append(weekly)
        let stack = NSStackView(views: quotaCells)
        stack.orientation = .horizontal
        stack.distribution = .fillEqually
        stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 14),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -16),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -14),
        ])
        return container
    }

    func quotaCell(title: String, value: Double?, detail: String) -> NSView {
        let titleLabel = label(title, size: 11, weight: .semibold, color: MenuBarPalette.muted)
        let valueLabel = label(percent(value), size: 24, weight: .semibold, color: MenuBarPalette.text)
        valueLabel.font = .monospacedDigitSystemFont(ofSize: 22, weight: .semibold)
        let detailLabel = label(detail, size: 10, color: MenuBarPalette.muted)
        let bar = QuotaBarView()
        bar.remainingPercent = value
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.setAccessibilityLabel(title)
        bar.setAccessibilityValue(percent(value))
        let heading = NSStackView(views: [titleLabel, NSView(), valueLabel])
        heading.orientation = .horizontal
        heading.alignment = .firstBaseline
        let stack = NSStackView(views: [heading, bar, detailLabel])
        // Both views must share an ancestor before activating their constraint.
        heading.widthAnchor.constraint(equalTo: bar.widthAnchor).isActive = true
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 5
        bar.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        return stack
    }

    func accountsCard(_ accounts: [MenuBarAccount]) -> NSView {
        let container = card()
        let rows = NSStackView()
        rows.orientation = .vertical
        rows.alignment = .leading
        rows.spacing = 0
        rows.translatesAutoresizingMaskIntoConstraints = false
        for (index, account) in accounts.enumerated() {
            if index > 0 {
                let divider = makeDivider()
                rows.addArrangedSubview(divider)
                divider.widthAnchor.constraint(equalTo: rows.widthAnchor).isActive = true
                divider.heightAnchor.constraint(equalToConstant: 1).isActive = true
            }
            let row = accountCard(account)
            rows.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: rows.widthAnchor).isActive = true
        }
        container.addSubview(rows)
        NSLayoutConstraint.activate([
            rows.topAnchor.constraint(equalTo: container.topAnchor),
            rows.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            rows.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            rows.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
        return container
    }

    func accountCard(_ account: MenuBarAccount) -> NSView {
        let container = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false
        let name = label(account.displayName, size: 12, weight: .semibold, color: MenuBarPalette.text)
        name.lineBreakMode = .byTruncatingMiddle
        name.maximumNumberOfLines = 1
        let state = statusBadge(account.status)
        let header = NSStackView(views: [name, NSView(), state])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 8

        let unsupported = account.usageStatus == "unsupported"
        let quotaWindows: [(title: String, window: QuotaWindow?)] = [
            ("5 hours", account.fiveHour),
            ("Weekly", account.weekly),
            ("Monthly", account.monthly),
        ]
        let updatedText = usageDetail(account)
        let visibleQuotaWindows: [NSView] = unsupported
            ? []
            : quotaWindows.compactMap { item in
                guard let window = item.window else { return nil }
                return compactQuota(title: window.label ?? item.title, window: window)
        }

        var contentViews: [NSView] = [header]
        var windowsView: NSStackView?
        if !visibleQuotaWindows.isEmpty {
            let windows = NSStackView(views: visibleQuotaWindows)
            windows.orientation = .horizontal
            windows.distribution = .fillEqually
            windows.spacing = 12
            windowsView = windows
            contentViews.append(windows)
        }
        let updated = label(updatedText, size: 10, color: MenuBarPalette.muted)
        updated.lineBreakMode = .byTruncatingTail
        updated.maximumNumberOfLines = 1
        if visibleQuotaWindows.isEmpty {
            // Credit-only providers report an absolute balance instead of windows.
            if let balance = account.balance, !unsupported {
                contentViews.append(compactBalance(balance))
            }
            contentViews.append(updated)
        }
        name.toolTip = account.displayName + " · " + updatedText
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        state.setContentCompressionResistancePriority(.required, for: .horizontal)

        let stack = NSStackView(views: contentViews)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        windowsView?.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 12),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 15),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -15),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -12),
        ])
        return container
    }

    func compactQuota(title: String, window: QuotaWindow) -> NSView {
        let titleLabel = label(title, size: 10, weight: .semibold, color: MenuBarPalette.muted)
        let value = label(percent(window.remainingPercent), size: 14, weight: .medium, color: MenuBarPalette.text)
        value.font = .monospacedDigitSystemFont(ofSize: 14, weight: .medium)
        let reset = label(resetText(window.resetAt), size: 10, color: MenuBarPalette.muted)
        reset.lineBreakMode = .byTruncatingTail
        let bar = QuotaBarView()
        bar.remainingPercent = window.remainingPercent
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.setAccessibilityLabel(title)
        bar.setAccessibilityValue(percent(window.remainingPercent))
        let heading = NSStackView(views: [titleLabel, NSView(), value])
        heading.orientation = .horizontal
        heading.alignment = .firstBaseline
        heading.spacing = 4
        let stack = NSStackView(views: [heading, bar, reset])
        heading.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        bar.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        return stack
    }

    func compactBalance(_ balance: CreditBalance) -> NSView {
        let text = creditBalanceText(remaining: balance.remaining, unit: balance.unit)
        let titleLabel = label("Credit", size: 10, weight: .semibold, color: MenuBarPalette.muted)
        let value = label(text, size: 14, weight: .medium, color: MenuBarPalette.text)
        value.font = .monospacedDigitSystemFont(ofSize: 14, weight: .medium)
        value.setAccessibilityLabel("Credit")
        value.setAccessibilityValue(text)
        let stack = NSStackView(views: [titleLabel, value])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2
        return stack
    }

    /// Provider-level credit card: no quota bar, because a balance has no total.
    func balanceCell(title: String, balance: ProviderQuota.Balance) -> NSView {
        let titleLabel = label(title, size: 11, weight: .semibold, color: MenuBarPalette.muted)
        let valueLabel = label(creditBalanceText(remaining: balance.remaining, unit: balance.unit), size: 24, weight: .semibold, color: MenuBarPalette.text)
        valueLabel.font = .monospacedDigitSystemFont(ofSize: 22, weight: .semibold)
        let detailLabel = label(accountCount(balance.accountCount), size: 10, color: MenuBarPalette.muted)
        let heading = NSStackView(views: [titleLabel, NSView(), valueLabel])
        heading.orientation = .horizontal
        heading.alignment = .firstBaseline
        let stack = NSStackView(views: [heading, detailLabel])
        heading.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 5
        return stack
    }

    func statusBadge(_ status: String) -> NSTextField {
        let copy: String
        let color: NSColor
        let background: NSColor
        switch status {
        case "ready":
            (copy, color, background) = ("Ready", MenuBarPalette.success, MenuBarPalette.successSoft)
        case "paused":
            (copy, color, background) = ("Paused", MenuBarPalette.mutedStrong, MenuBarPalette.surfaceMuted)
        case "limited":
            (copy, color, background) = ("Limited", MenuBarPalette.warning, MenuBarPalette.warningSoft)
        default:
            (copy, color, background) = ("Attention", MenuBarPalette.danger, MenuBarPalette.dangerSoft)
        }
        let badge = AdaptiveLayerTextField(
            labelWithString: "\u{00a0}\(copy)\u{00a0}",
            backgroundColor: background,
            borderColor: color.withAlphaComponent(0.2)
        )
        badge.font = .systemFont(ofSize: 10, weight: .semibold)
        badge.textColor = color
        badge.layer?.cornerRadius = 8
        badge.layer?.borderWidth = 0.5
        return badge
    }

    func emptyAccountsCard(operational: Bool) -> NSView {
        let container = card()
        let title = label(operational ? "No account connected yet" : "Host data unavailable", size: 13, weight: .semibold, color: MenuBarPalette.text)
        let detail = label(
            operational ? "Add an account from the dashboard to see its quota here." : "Start or refresh MultiVibe Host to load your accounts.",
            size: 11,
            color: MenuBarPalette.muted
        )
        detail.maximumNumberOfLines = 2
        let stack = NSStackView(views: [title, detail])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 5
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 15),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 15),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -15),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -15),
        ])
        return container
    }

    func earningsCard(_ earnings: MenuBarSummary.Earnings?) -> NSView {
        let container = card()
        let rows = NSStackView(views: [
            earningRow("Today", value: earningText(earnings?.today, earnings: earnings)),
            earningRow("This week", value: earningText(earnings?.week, earnings: earnings)),
            earningRow("This month", value: earningText(earnings?.month, earnings: earnings)),
        ])
        rows.orientation = .vertical
        rows.alignment = .leading
        rows.spacing = 8
        rows.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(rows)
        NSLayoutConstraint.activate([
            rows.topAnchor.constraint(equalTo: container.topAnchor, constant: 13),
            rows.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 15),
            rows.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -15),
            rows.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -13),
        ])
        return container
    }

    func workerSetupCard() -> NSView {
        let container = card()
        let title = label("Set up your local worker", size: 13, weight: .semibold, color: MenuBarPalette.text)
        let detail = label("Connect this worker to MultiVibe Cloud to start earning.", size: 11, color: MenuBarPalette.muted)
        detail.maximumNumberOfLines = 2
        let copy = NSStackView(views: [title, detail])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = 5
        copy.translatesAutoresizingMaskIntoConstraints = false
        let configureButton = NSButton(title: "Configure", target: self, action: #selector(didConfigureWorker))
        styleButton(configureButton, kind: .primary)
        let body = NSStackView(views: [copy, NSView(), configureButton])
        body.orientation = .horizontal
        body.alignment = .centerY
        body.spacing = 12
        body.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(body)
        NSLayoutConstraint.activate([
            body.topAnchor.constraint(equalTo: container.topAnchor, constant: 15),
            body.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 15),
            body.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -15),
            body.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -15),
        ])
        return container
    }

    func updateCard(_ update: HostUpdateStatus?, busy: Bool) -> NSView {
        let container = card()
        let title: String
        let detail: String
        if update?.status == "failed" {
            title = "Update failed"
            detail = update?.lastError ?? "Check for updates to retry."
        } else if let version = update?.availableVersion {
            title = "Version \(version) available"
            detail = update?.downloaded == true ? "Ready to install." : "Download and install the latest version."
        } else if update?.status == "current" {
            title = "MultiVibe Host is up to date"
            detail = "Automatic checks are enabled."
        } else {
            title = "Updates"
            detail = "Keep MultiVibe up to date."
        }

        let titleLabel = label(title, size: 13, weight: .semibold, color: MenuBarPalette.text)
        let detailLabel = label(detail, size: 11, color: MenuBarPalette.muted)
        detailLabel.maximumNumberOfLines = 2
        let checkButton = NSButton(title: busy ? "Checking…" : "Check Now", target: self, action: #selector(didCheckForUpdates))
        styleButton(checkButton, kind: .secondary)
        checkButton.isEnabled = !busy
        let actions = NSStackView(views: [checkButton])
        actions.orientation = .horizontal
        actions.spacing = 8
        if update?.availableVersion != nil {
            let installTitle = update?.installRequested == true ? "Installation queued" : "Install update"
            let installButton = NSButton(title: installTitle, target: self, action: #selector(didInstallUpdate))
            styleButton(installButton, kind: .primary)
            installButton.isEnabled = !busy && update?.installRequested != true
            actions.addArrangedSubview(installButton)
        }

        let stack = NSStackView(views: [titleLabel, detailLabel, actions])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 9
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 14),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 15),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -15),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -14),
        ])
        return container
    }

    func earningRow(_ title: String, value: String) -> NSView {
        let titleLabel = label(title, size: 11, color: MenuBarPalette.muted)
        let valueLabel = label(value, size: 12, weight: .semibold, color: MenuBarPalette.text)
        let row = NSStackView(views: [titleLabel, NSView(), valueLabel])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.widthAnchor.constraint(equalToConstant: 354).isActive = true
        return row
    }

    func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = .labelColor) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .systemFont(ofSize: size, weight: weight)
        field.textColor = color
        return field
    }

    func appIcon() -> NSImage? {
        let url = Bundle.main.resourceURL?.appendingPathComponent("MultiVibeMenuBarIcon.png")
        return url.flatMap(NSImage.init(contentsOf:)) ?? NSImage(systemSymbolName: "waveform.path", accessibilityDescription: "MultiVibe")
    }

    func percent(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return "\(Int(value.rounded()))%"
    }

    func accountCount(_ count: Int) -> String {
        count == 1 ? "1 account" : "\(count) accounts"
    }

    func hasResetTime(_ timestamp: Double?) -> Bool {
        guard let timestamp else { return false }
        return timestamp.isFinite
    }

    func resetText(_ timestamp: Double?) -> String {
        guard let timestamp, timestamp.isFinite else { return "No reset time" }
        let date = Date(timeIntervalSince1970: timestamp / 1_000)
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "en")
        formatter.unitsStyle = .short
        return "Resets \(formatter.localizedString(for: date, relativeTo: Date()))"
    }

    func usageDetail(_ account: MenuBarAccount) -> String {
        if account.usageStatus == "unsupported" { return "This provider does not expose quota usage for this account." }
        guard let fetchedAt = account.fetchedAt, fetchedAt.isFinite else { return "Waiting for the first quota refresh." }
        let date = Date(timeIntervalSince1970: fetchedAt / 1_000)
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "en")
        formatter.unitsStyle = .short
        return "Updated \(formatter.localizedString(for: date, relativeTo: Date()))"
    }

    func earningText(_ value: Decimal?, earnings: MenuBarSummary.Earnings?) -> String {
        guard let earnings, earnings.available, let value, let currency = earnings.currency else { return "Not available" }
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currency
        return formatter.string(from: value as NSDecimalNumber) ?? "\(value) \(currency)"
    }
}
