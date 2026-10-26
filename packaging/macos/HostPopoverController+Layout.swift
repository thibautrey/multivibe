import AppKit

extension HostPopoverController {
    func makeHeader() -> NSView {
        let container = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false

        let icon = NSImageView()
        icon.image = NSApplication.shared.applicationIconImage
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

        styleButton(settingsButton, kind: .quiet)
        settingsButton.target = self
        settingsButton.action = #selector(didToggleSettings)
        settingsButton.imagePosition = .imageOnly
        settingsButton.translatesAutoresizingMaskIntoConstraints = false

        let divider = makeDivider()
        divider.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(icon)
        container.addSubview(labels)
        container.addSubview(settingsButton)
        container.addSubview(divider)

        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: MenuBarLayoutMetrics.contentInset),
            icon.centerYAnchor.constraint(equalTo: container.centerYAnchor, constant: -1),
            icon.widthAnchor.constraint(equalToConstant: 36),
            icon.heightAnchor.constraint(equalToConstant: 36),
            labels.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: MenuBarSpacing.medium),
            labels.centerYAnchor.constraint(equalTo: icon.centerYAnchor),
            labels.trailingAnchor.constraint(lessThanOrEqualTo: settingsButton.leadingAnchor, constant: -MenuBarSpacing.medium),
            settingsButton.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -MenuBarLayoutMetrics.contentInset),
            settingsButton.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            settingsButton.widthAnchor.constraint(equalToConstant: 34),
            settingsButton.heightAnchor.constraint(equalToConstant: 34),
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
        let actions = NSStackView(views: [primaryButton, NSView(), quitButton])
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
            actions.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: MenuBarLayoutMetrics.contentInset),
            actions.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -MenuBarLayoutMetrics.contentInset),
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

    func sectionHeading(_ title: String, detail: String) -> NSView {
        let titleLabel = sectionLabel(title)
        let detailLabel = label(detail, size: 10, color: MenuBarPalette.muted)
        let row = NSStackView(views: [titleLabel, NSView(), detailLabel])
        row.orientation = .horizontal
        row.alignment = .firstBaseline
        row.widthAnchor.constraint(equalToConstant: MenuBarLayoutMetrics.contentWidth).isActive = true
        return row
    }

    func card() -> NSView {
        let view = AdaptiveLayerView(backgroundColor: MenuBarPalette.panel, borderColor: MenuBarPalette.line)
        view.layer?.cornerRadius = MenuBarLayoutMetrics.cardCornerRadius
        view.layer?.borderWidth = 0.5
        view.layer?.masksToBounds = true
        view.translatesAutoresizingMaskIntoConstraints = false
        view.widthAnchor.constraint(equalToConstant: MenuBarLayoutMetrics.contentWidth).isActive = true
        return view
    }

    func providerPickerCard(_ picker: NSPopUpButton) -> NSView {
        let container = AdaptiveLayerView(backgroundColor: MenuBarPalette.panel)
        container.layer?.cornerRadius = 12
        container.layer?.masksToBounds = true
        container.translatesAutoresizingMaskIntoConstraints = false
        container.widthAnchor.constraint(equalToConstant: MenuBarLayoutMetrics.contentWidth).isActive = true

        let icon = NSImageView(image: NSImage(systemSymbolName: "sparkles", accessibilityDescription: nil) ?? NSImage())
        icon.contentTintColor = MenuBarPalette.mutedStrong
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium)
        icon.translatesAutoresizingMaskIntoConstraints = false
        let title = label("ACTIVE PROVIDER", size: 9, weight: .semibold, color: MenuBarPalette.muted)
        let copy = NSStackView(views: [title, picker])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = 3
        copy.translatesAutoresizingMaskIntoConstraints = false
        picker.translatesAutoresizingMaskIntoConstraints = false
        picker.widthAnchor.constraint(equalTo: copy.widthAnchor).isActive = true

        container.addSubview(icon)
        container.addSubview(copy)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: MenuBarSpacing.large),
            icon.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 18),
            icon.heightAnchor.constraint(equalToConstant: 18),
            copy.topAnchor.constraint(equalTo: container.topAnchor, constant: MenuBarSpacing.medium),
            copy.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: MenuBarSpacing.medium),
            copy.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -MenuBarSpacing.medium),
            copy.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -MenuBarSpacing.medium),
        ])
        return container
    }

    func providerCapacityCard(_ provider: ProviderQuota) -> NSView {
        let container = card()
        let content: NSView
        if let limiting = provider.windows.min(by: { $0.remainingPercent < $1.remainingPercent }) {
            let title = label("\(limiting.label) capacity", size: 10, weight: .semibold, color: MenuBarPalette.muted)
            title.alignment = .center
            let value = label(percent(limiting.remainingPercent), size: 42, weight: .semibold, color: MenuBarPalette.text)
            value.font = .monospacedDigitSystemFont(ofSize: 42, weight: .semibold)
            value.alignment = .center

            let bar = QuotaBarView()
            bar.remainingPercent = limiting.remainingPercent
            bar.translatesAutoresizingMaskIntoConstraints = false
            bar.setAccessibilityLabel("\(limiting.label) capacity remaining")
            bar.setAccessibilityValue(percent(limiting.remainingPercent))

            var context = [capacityResetText(provider: provider, label: limiting.label), accountCount(limiting.accountCount)]
            let otherWindows = provider.windows
                .filter { $0.label != limiting.label }
                .map { "\($0.label) \(percent($0.remainingPercent))" }
                .joined(separator: " · ")
            if !otherWindows.isEmpty { context.insert(otherWindows, at: 0) }
            let detail = label(context.joined(separator: "   "), size: 10, color: MenuBarPalette.muted)
            detail.lineBreakMode = .byTruncatingTail
            detail.maximumNumberOfLines = 1
            detail.alignment = .center

            let stack = NSStackView(views: [title, value, bar, detail])
            stack.orientation = .vertical
            stack.alignment = .centerX
            stack.spacing = MenuBarSpacing.small
            bar.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            detail.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            content = stack
        } else if let balance = provider.balance {
            let title = label("Available credit", size: 10, weight: .semibold, color: MenuBarPalette.muted)
            title.alignment = .center
            let amount = creditBalanceText(remaining: balance.remaining, unit: balance.unit)
            let value = label(amount, size: 34, weight: .semibold, color: MenuBarPalette.text)
            value.font = .monospacedDigitSystemFont(ofSize: 34, weight: .semibold)
            value.alignment = .center
            value.setAccessibilityLabel("Available credit")
            value.setAccessibilityValue(amount)
            let detail = label(accountCount(balance.accountCount), size: 10, color: MenuBarPalette.muted)
            detail.alignment = .center
            let stack = NSStackView(views: [title, value, detail])
            stack.orientation = .vertical
            stack.alignment = .centerX
            stack.spacing = MenuBarSpacing.small
            content = stack
        } else {
            content = label("Capacity unavailable", size: 11, color: MenuBarPalette.muted)
        }
        content.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: container.topAnchor, constant: MenuBarSpacing.xLarge),
            content.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: MenuBarSpacing.large),
            content.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -MenuBarSpacing.large),
            content.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -MenuBarSpacing.xLarge),
        ])
        return container
    }

    func providerAvailabilityCard(_ provider: ProviderQuota) -> NSView {
        let container = card()
        let accounts = provider.accounts
        let unsupported = !accounts.isEmpty && accounts.allSatisfy { $0.usageStatus == "unsupported" }
        let content: NSStackView

        if unsupported {
            let icon = NSImageView(image: NSImage(systemSymbolName: "eye.slash", accessibilityDescription: nil) ?? NSImage())
            icon.contentTintColor = MenuBarPalette.primary
            icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 22, weight: .medium)
            let title = label("Quota unavailable", size: 15, weight: .semibold, color: MenuBarPalette.text)
            let detail = label("This provider does not expose quota usage.", size: 11, color: MenuBarPalette.muted)
            detail.alignment = .center
            detail.maximumNumberOfLines = 2
            content = NSStackView(views: [icon, title, detail])
        } else if accounts.count > 1 {
            let ready = accounts.filter { $0.status == "ready" }.count
            let title = label("Accounts ready", size: 10, weight: .semibold, color: MenuBarPalette.muted)
            let value = label("\(ready)/\(accounts.count)", size: 38, weight: .semibold, color: MenuBarPalette.text)
            value.font = .monospacedDigitSystemFont(ofSize: 38, weight: .semibold)
            let detail = label("Quota data will appear after the first refresh.", size: 10, color: MenuBarPalette.muted)
            detail.alignment = .center
            content = NSStackView(views: [title, value, detail])
        } else {
            let icon = NSImageView(image: NSImage(systemSymbolName: "clock", accessibilityDescription: nil) ?? NSImage())
            icon.contentTintColor = MenuBarPalette.primary
            icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 22, weight: .medium)
            let title = label("Quota pending", size: 15, weight: .semibold, color: MenuBarPalette.text)
            let detail = label(accounts.first.map(usageDetail) ?? "Waiting for provider usage data.", size: 11, color: MenuBarPalette.muted)
            detail.alignment = .center
            detail.maximumNumberOfLines = 2
            content = NSStackView(views: [icon, title, detail])
        }

        content.orientation = .vertical
        content.alignment = .centerX
        content.spacing = MenuBarSpacing.small
        content.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: container.topAnchor, constant: MenuBarSpacing.xLarge),
            content.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: MenuBarSpacing.large),
            content.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -MenuBarSpacing.large),
            content.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -MenuBarSpacing.xLarge),
        ])
        return container
    }

    func renderExtensionWidgets(_ widgets: [MenuBarExtensionWidget]) {
        for child in extensionSection.arrangedSubviews {
            extensionSection.removeArrangedSubview(child)
            child.removeFromSuperview()
        }
        extensionSection.orientation = .vertical
        extensionSection.alignment = .leading
        extensionSection.spacing = MenuBarSpacing.small
        let visible = Array(widgets.prefix(4))
        guard !visible.isEmpty else { return }
        extensionSection.addArrangedSubview(sectionHeading("EXTENSIONS", detail: "\(visible.count) visible"))
        for widget in visible {
            extensionSection.addArrangedSubview(extensionWidgetCard(widget))
        }
    }

    func extensionWidgetCard(_ widget: MenuBarExtensionWidget) -> NSView {
        let container = card()
        let fallbackIcon = NSImage(systemSymbolName: "puzzlepiece.extension", accessibilityDescription: nil) ?? NSImage()
        let iconImage = widget.systemImage.flatMap { NSImage(systemSymbolName: $0, accessibilityDescription: nil) } ?? fallbackIcon
        let icon = NSImageView(image: iconImage)
        icon.contentTintColor = MenuBarPalette.primary
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium)
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 28).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 28).isActive = true

        let title = label(widget.title, size: 12, weight: .semibold, color: MenuBarPalette.text)
        title.lineBreakMode = .byTruncatingTail
        title.maximumNumberOfLines = 1
        let subtitle = label(widget.subtitle ?? widget.extensionId, size: 10, color: MenuBarPalette.muted)
        subtitle.lineBreakMode = .byTruncatingTail
        subtitle.maximumNumberOfLines = 1
        let copy = NSStackView(views: [title, subtitle])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = MenuBarSpacing.xSmall
        copy.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        var headerViews: [NSView] = [icon, copy, NSView()]
        if let badge = widget.badge?.trimmingCharacters(in: .whitespacesAndNewlines), !badge.isEmpty {
            let copy = String(badge.prefix(24))
            let badgeLabel = AdaptiveLayerTextField(
                labelWithString: copy,
                backgroundColor: MenuBarPalette.surfaceMuted,
                borderColor: MenuBarPalette.line
            )
            badgeLabel.font = .systemFont(ofSize: 10, weight: .semibold)
            badgeLabel.textColor = MenuBarPalette.mutedStrong
            badgeLabel.alignment = .center
            badgeLabel.layer?.cornerRadius = 8
            badgeLabel.layer?.borderWidth = 0.5
            badgeLabel.translatesAutoresizingMaskIntoConstraints = false
            let width = ceil((copy as NSString).size(withAttributes: [.font: badgeLabel.font!]).width) + MenuBarSpacing.large
            badgeLabel.widthAnchor.constraint(equalToConstant: width).isActive = true
            badgeLabel.heightAnchor.constraint(equalToConstant: 20).isActive = true
            badgeLabel.setContentHuggingPriority(.required, for: .horizontal)
            badgeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
            headerViews.append(badgeLabel)
        }
        let header = NSStackView(views: headerViews)
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = MenuBarSpacing.medium
        let headerContainer = insetView(header, horizontal: MenuBarSpacing.medium, vertical: MenuBarSpacing.small)

        let body: NSView
        if widget.presentation == "progress", let progress = widget.progressPercent, progress.isFinite {
            let metricLabel = label(widget.label ?? "Progress", size: 10, color: MenuBarPalette.muted)
            let metricValue = label(widget.value ?? percent(progress), size: 12, weight: .semibold, color: MenuBarPalette.text)
            let metric = NSStackView(views: [metricLabel, NSView(), metricValue])
            metric.orientation = .horizontal
            metric.alignment = .firstBaseline
            let bar = QuotaBarView()
            bar.remainingPercent = progress
            bar.setAccessibilityLabel(widget.label ?? widget.title)
            bar.setAccessibilityValue(percent(progress))
            let views: [NSView] = widget.detail.map {
                let detail = label($0, size: 10, color: MenuBarPalette.muted)
                detail.lineBreakMode = .byTruncatingTail
                detail.maximumNumberOfLines = 1
                return [metric, bar, detail]
            } ?? [metric, bar]
            let stack = NSStackView(views: views)
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = MenuBarSpacing.small
            metric.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            bar.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            body = stack
        } else {
            let metricLabel = label(widget.label ?? "Status", size: 10, color: MenuBarPalette.muted)
            let metricValue = label(widget.value ?? "Available", size: 12, weight: .semibold, color: MenuBarPalette.text)
            metricValue.lineBreakMode = .byTruncatingTail
            let metric = NSStackView(views: [metricLabel, NSView(), metricValue])
            metric.orientation = .horizontal
            metric.alignment = .firstBaseline
            if let detailText = widget.detail, !detailText.isEmpty {
                let detail = label(detailText, size: 10, color: MenuBarPalette.muted)
                detail.lineBreakMode = .byTruncatingTail
                detail.maximumNumberOfLines = 1
                let stack = NSStackView(views: [metric, detail])
                stack.orientation = .vertical
                stack.alignment = .leading
                stack.spacing = MenuBarSpacing.small
                metric.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
                body = stack
            } else {
                body = metric
            }
        }
        let bodyContainer = insetView(body, horizontal: MenuBarSpacing.medium, vertical: MenuBarSpacing.medium)
        let divider = makeDivider()
        divider.heightAnchor.constraint(equalToConstant: 1).isActive = true
        let stack = NSStackView(views: [headerContainer, divider, bodyContainer])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false
        headerContainer.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        divider.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        bodyContainer.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        container.setAccessibilityLabel("\(widget.title) extension widget")
        return container
    }

    func insetView(_ content: NSView, horizontal: CGFloat, vertical: CGFloat) -> NSView {
        let container = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false
        content.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: container.topAnchor, constant: vertical),
            content.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: horizontal),
            content.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -horizontal),
            content.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -vertical),
        ])
        return container
    }

    func capacityResetText(provider: ProviderQuota, label: String) -> String {
        let candidates: [(String, QuotaWindow?)] = provider.accounts.flatMap { account in
            [("5 hours", account.fiveHour), ("Weekly", account.weekly), ("Monthly", account.monthly)]
        }
        let reset = candidates.compactMap { fallback, window -> Double? in
            guard let window, (window.label ?? fallback).localizedCaseInsensitiveCompare(label) == .orderedSame else { return nil }
            return window.resetAt
        }.filter(\.isFinite).min()
        return resetText(reset)
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
        stack.spacing = MenuBarSpacing.large
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: MenuBarSpacing.large),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: MenuBarSpacing.large),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -MenuBarSpacing.large),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -MenuBarSpacing.large),
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

    func accountIdentityCard(_ account: MenuBarAccount) -> NSView {
        let container = card()
        let name = label(account.displayName, size: 12, weight: .semibold, color: MenuBarPalette.text)
        name.lineBreakMode = .byTruncatingMiddle
        name.maximumNumberOfLines = 1
        name.toolTip = account.displayName
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let state = statusBadge(account.status)
        let row = NSStackView(views: [name, NSView(), state])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = MenuBarSpacing.small
        row.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: container.topAnchor, constant: MenuBarSpacing.medium),
            row.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: MenuBarSpacing.large),
            row.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -MenuBarSpacing.large),
            row.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -MenuBarSpacing.medium),
        ])
        return container
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
        stack.spacing = MenuBarSpacing.small
        stack.translatesAutoresizingMaskIntoConstraints = false
        header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        windowsView?.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: MenuBarSpacing.medium),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: MenuBarSpacing.large),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -MenuBarSpacing.large),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -MenuBarSpacing.medium),
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
        stack.spacing = MenuBarSpacing.small
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
            labelWithString: copy,
            backgroundColor: background,
            borderColor: color.withAlphaComponent(0.2)
        )
        badge.font = .systemFont(ofSize: 10, weight: .semibold)
        badge.textColor = color
        badge.alignment = .center
        badge.layer?.cornerRadius = 8
        badge.layer?.borderWidth = 0.5
        badge.translatesAutoresizingMaskIntoConstraints = false
        let width = ceil((copy as NSString).size(withAttributes: [.font: badge.font!]).width) + MenuBarSpacing.large
        badge.widthAnchor.constraint(equalToConstant: width).isActive = true
        badge.heightAnchor.constraint(equalToConstant: 20).isActive = true
        badge.setContentHuggingPriority(.required, for: .horizontal)
        badge.setContentCompressionResistancePriority(.required, for: .horizontal)
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
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: MenuBarSpacing.large),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: MenuBarSpacing.large),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -MenuBarSpacing.large),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -MenuBarSpacing.large),
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
        rows.spacing = MenuBarSpacing.small
        rows.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(rows)
        NSLayoutConstraint.activate([
            rows.topAnchor.constraint(equalTo: container.topAnchor, constant: MenuBarSpacing.medium),
            rows.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: MenuBarSpacing.large),
            rows.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -MenuBarSpacing.large),
            rows.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -MenuBarSpacing.medium),
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
        stack.spacing = MenuBarSpacing.medium
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: MenuBarSpacing.large),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: MenuBarSpacing.large),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -MenuBarSpacing.large),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -MenuBarSpacing.large),
        ])
        return container
    }

    func earningRow(_ title: String, value: String) -> NSView {
        let titleLabel = label(title, size: 11, color: MenuBarPalette.muted)
        let valueLabel = label(value, size: 12, weight: .semibold, color: MenuBarPalette.text)
        let row = NSStackView(views: [titleLabel, NSView(), valueLabel])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.widthAnchor.constraint(
            equalToConstant: MenuBarLayoutMetrics.contentWidth - MenuBarSpacing.large * 2
        ).isActive = true
        return row
    }

    func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = .labelColor) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .systemFont(ofSize: size, weight: weight)
        field.textColor = color
        return field
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
