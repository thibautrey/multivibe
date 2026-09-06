import AppKit
import Foundation

private let configuredHostPort: Int = {
    let configured = ProcessInfo.processInfo.environment["MULTIVIBE_HOST_PORT"] ?? "1455"
    return Int(configured).flatMap { (1...65535).contains($0) ? $0 : nil } ?? 1455
}()

private let hasExplicitHostPort = ProcessInfo.processInfo.environment["MULTIVIBE_HOST_PORT"] != nil

private struct HostCredentials: Decodable {
    let adminToken: String

    enum CodingKeys: String, CodingKey {
        case adminToken = "admin_token"
    }
}

private struct QuotaWindow: Decodable {
    let remainingPercent: Double
    let resetAt: Double?
}

private struct MenuBarAccount: Decodable {
    let displayName: String
    let enabled: Bool
    let status: String
    let usageStatus: String
    let fetchedAt: Double?
    let fiveHour: QuotaWindow?
    let weekly: QuotaWindow?
    let monthly: QuotaWindow?
}

private struct MenuBarQuota: Decodable {
    let fiveHourRemainingPercent: Double?
    let fiveHourAccountCount: Int
    let weeklyRemainingPercent: Double?
    let weeklyAccountCount: Int
}

private struct MenuBarGitHubStarPrompt: Decodable {
    let generatedOutputTokens: Double
    let threshold: Double
    let eligible: Bool
}

private struct MenuBarSummary: Decodable {
    struct Earnings: Decodable {
        let available: Bool
        let currency: String?
        let today: Decimal?
        let week: Decimal?
        let month: Decimal?
    }

    let operational: Bool
    let accounts: [MenuBarAccount]
    let quota: MenuBarQuota
    let githubStarPrompt: MenuBarGitHubStarPrompt?
    let earnings: Earnings
}

private struct DesktopSession: Decodable {
    let path: String
}

private struct HostUpdateStatus: Decodable {
    let status: String
    let availableVersion: String?
    let downloaded: Bool
    let installRequested: Bool

    enum CodingKeys: String, CodingKey {
        case status
        case availableVersion = "available_version"
        case downloaded
        case installRequested = "install_requested"
    }
}

private struct CloudEnrollmentResult: Decodable {
    let state: String
}

private final class QuotaBarView: NSView {
    var remainingPercent: Double? {
        didSet { needsDisplay = true }
    }

    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: 6) }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let track = NSBezierPath(roundedRect: bounds, xRadius: 3.5, yRadius: 3.5)
        NSColor.quaternaryLabelColor.withAlphaComponent(0.6).setFill()
        track.fill()
        guard let remainingPercent else { return }
        let safeValue = max(0, min(100, remainingPercent))
        let fillRect = NSRect(x: 0, y: 0, width: bounds.width * safeValue / 100, height: bounds.height)
        guard fillRect.width > 0 else { return }
        let fill = NSBezierPath(roundedRect: fillRect, xRadius: 3.5, yRadius: 3.5)
        let color: NSColor = safeValue <= 10 ? .systemRed : safeValue <= 30 ? .systemOrange : .controlAccentColor
        color.setFill()
        fill.fill()
    }
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

private final class HostPopoverController: NSViewController {
    var openDashboard: (() -> Void)?
    var refresh: (() -> Void)?
    var checkForUpdates: (() -> Void)?
    var installUpdate: (() -> Void)?
    var setStartAtLogin: ((Bool) -> Void)?
    var quit: (() -> Void)?

    private let headerTitle = NSTextField(labelWithString: "MultiVibe Host")
    private let headerVersion = NSTextField(labelWithString: "")
    private let headerStatus = NSTextField(labelWithString: "Starting…")
    private let headerStatusDot = NSView()
    private let contentStack = NSStackView()
    private let primaryButton = NSButton(title: "Open Dashboard", target: nil, action: nil)
    private let refreshButton = NSButton(title: "Refresh", target: nil, action: nil)
    private let startAtLoginButton = NSButton(checkboxWithTitle: "Start MultiVibe Host when I log in", target: nil, action: nil)

    private let popoverWidth: CGFloat = 440
    private let cardWidth: CGFloat = 404

    override func loadView() {
        let background = NSVisualEffectView()
        background.material = .popover
        background.blendingMode = .behindWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.24).cgColor
        view = background

        let header = makeHeader()
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        let document = FlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = 10
        contentStack.edgeInsets = NSEdgeInsets(top: 11, left: 18, bottom: 14, right: 18)
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(contentStack)
        scrollView.documentView = document

        let footer = makeFooter()
        background.addSubview(header)
        background.addSubview(scrollView)
        background.addSubview(footer)

        NSLayoutConstraint.activate([
            background.widthAnchor.constraint(equalToConstant: popoverWidth),
            background.heightAnchor.constraint(equalToConstant: 620),
            header.topAnchor.constraint(equalTo: background.topAnchor),
            header.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            header.heightAnchor.constraint(equalToConstant: 78),
            scrollView.topAnchor.constraint(equalTo: header.bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: footer.topAnchor),
            footer.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            footer.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            footer.bottomAnchor.constraint(equalTo: background.bottomAnchor),
            footer.heightAnchor.constraint(equalToConstant: 88),
            document.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor),
            contentStack.topAnchor.constraint(equalTo: document.topAnchor),
            contentStack.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            contentStack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            contentStack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
        ])
    }

    private func makeHeader() -> NSView {
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.055).cgColor
        container.translatesAutoresizingMaskIntoConstraints = false

        let icon = NSImageView()
        icon.image = appIcon()
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.wantsLayer = true
        icon.layer?.cornerRadius = 12
        icon.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.13).cgColor
        icon.layer?.shadowColor = NSColor.black.withAlphaComponent(0.24).cgColor
        icon.layer?.shadowOpacity = 1
        icon.layer?.shadowRadius = 8
        icon.layer?.shadowOffset = CGSize(width: 0, height: 3)
        icon.translatesAutoresizingMaskIntoConstraints = false

        headerTitle.font = .systemFont(ofSize: 17, weight: .semibold)
        headerVersion.font = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        headerVersion.textColor = .secondaryLabelColor
        let titleLine = NSStackView(views: [headerTitle, headerVersion])
        titleLine.orientation = .horizontal
        titleLine.alignment = .centerY
        titleLine.spacing = 7

        headerStatus.font = .systemFont(ofSize: 12, weight: .medium)
        headerStatus.textColor = .systemGreen
        headerStatusDot.wantsLayer = true
        headerStatusDot.layer?.cornerRadius = 4
        headerStatusDot.layer?.backgroundColor = NSColor.systemGreen.cgColor
        headerStatusDot.translatesAutoresizingMaskIntoConstraints = false
        let statusLine = NSStackView(views: [headerStatusDot, headerStatus])
        statusLine.orientation = .horizontal
        statusLine.alignment = .centerY
        statusLine.spacing = 7

        let labels = NSStackView(views: [titleLine, statusLine])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 4
        labels.translatesAutoresizingMaskIntoConstraints = false

        let divider = NSBox()
        divider.boxType = .separator
        divider.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(icon)
        container.addSubview(labels)
        container.addSubview(divider)

        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
            icon.centerYAnchor.constraint(equalTo: container.centerYAnchor, constant: -2),
            icon.widthAnchor.constraint(equalToConstant: 42),
            icon.heightAnchor.constraint(equalToConstant: 42),
            labels.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 10),
            labels.centerYAnchor.constraint(equalTo: icon.centerYAnchor),
            labels.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -16),
            headerStatusDot.widthAnchor.constraint(equalToConstant: 7),
            headerStatusDot.heightAnchor.constraint(equalToConstant: 7),
            divider.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            divider.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            divider.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        return container
    }

    private func makeFooter() -> NSView {
        let container = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false
        let divider = NSBox()
        divider.boxType = .separator
        divider.translatesAutoresizingMaskIntoConstraints = false

        primaryButton.bezelStyle = .rounded
        primaryButton.controlSize = .regular
        primaryButton.image = NSImage(systemSymbolName: "arrow.up.right.square", accessibilityDescription: "Open Dashboard")
        primaryButton.imagePosition = .imageTrailing
        primaryButton.target = self
        primaryButton.action = #selector(didOpenDashboard)
        refreshButton.bezelStyle = .rounded
        refreshButton.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "Refresh")
        refreshButton.imagePosition = .imageLeading
        refreshButton.target = self
        refreshButton.action = #selector(didRefresh)
        let quitButton = NSButton(title: "Quit", target: self, action: #selector(didQuit))
        quitButton.bezelStyle = .rounded
        quitButton.image = NSImage(systemSymbolName: "power", accessibilityDescription: "Quit")
        quitButton.imagePosition = .imageLeading
        quitButton.contentTintColor = .systemRed

        startAtLoginButton.controlSize = .small
        startAtLoginButton.font = .systemFont(ofSize: 10, weight: .medium)
        startAtLoginButton.contentTintColor = .secondaryLabelColor
        startAtLoginButton.translatesAutoresizingMaskIntoConstraints = false
        startAtLoginButton.target = self
        startAtLoginButton.action = #selector(didChangeStartAtLogin)

        let actions = NSStackView(views: [primaryButton, refreshButton, quitButton])
        actions.orientation = .horizontal
        actions.alignment = .centerY
        actions.spacing = 8
        actions.translatesAutoresizingMaskIntoConstraints = false
        primaryButton.setContentHuggingPriority(.defaultLow, for: .horizontal)

        container.addSubview(divider)
        container.addSubview(startAtLoginButton)
        container.addSubview(actions)
        NSLayoutConstraint.activate([
            divider.topAnchor.constraint(equalTo: container.topAnchor),
            divider.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            divider.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            startAtLoginButton.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 14),
            startAtLoginButton.topAnchor.constraint(equalTo: divider.bottomAnchor, constant: 5),
            actions.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 14),
            actions.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -14),
            actions.topAnchor.constraint(equalTo: startAtLoginButton.bottomAnchor, constant: 5),
            actions.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -10),
            primaryButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 160),
        ])
        return container
    }

    func render(
        summary: MenuBarSummary?,
        status: String,
        operational: Bool,
        refreshing: Bool,
        updateStatus: HostUpdateStatus?,
        updateBusy: Bool,
        startAtLogin: Bool
    ) {
        loadViewIfNeeded()
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        headerTitle.stringValue = "MultiVibe Host"
        headerVersion.stringValue = version
        headerStatus.stringValue = status
        let statusColor: NSColor = operational ? .systemGreen : .systemOrange
        headerStatus.textColor = statusColor
        headerStatusDot.layer?.backgroundColor = statusColor.cgColor
        primaryButton.title = operational ? "Open Dashboard" : "Start Host"
        refreshButton.title = refreshing ? "Refreshing…" : "Refresh"
        refreshButton.isEnabled = !refreshing

        for child in contentStack.arrangedSubviews {
            contentStack.removeArrangedSubview(child)
            child.removeFromSuperview()
        }

        contentStack.addArrangedSubview(sectionHeader("OpenAI Capacity", symbol: "gauge.with.dots.needle.67percent", tint: .systemBlue))
        contentStack.addArrangedSubview(summaryCard(summary?.quota))
        contentStack.addArrangedSubview(sectionHeader("Accounts", symbol: "person.2.fill", tint: .systemPurple, trailing: accountCount(summary?.accounts.count ?? 0)))
        if let accounts = summary?.accounts, !accounts.isEmpty {
            for account in accounts { contentStack.addArrangedSubview(accountCard(account)) }
        } else {
            contentStack.addArrangedSubview(emptyAccountsCard(operational: operational))
        }
        contentStack.addArrangedSubview(sectionHeader("Earnings", symbol: "chart.bar.fill", tint: .systemGreen))
        contentStack.addArrangedSubview(earningsCard(summary?.earnings))
        contentStack.addArrangedSubview(sectionHeader("Host Updates", symbol: "megaphone.fill", tint: .systemOrange))
        contentStack.addArrangedSubview(updateCard(updateStatus, busy: updateBusy))
        startAtLoginButton.state = startAtLogin ? .on : .off
    }

    private func sectionHeader(_ title: String, symbol: String, tint: NSColor, trailing: String? = nil) -> NSView {
        let icon = iconBubble(symbol: symbol, color: tint, size: 26)
        let titleLabel = label(title, size: 14, weight: .semibold)
        var views: [NSView] = [icon, titleLabel, NSView()]
        if let trailing {
            views.append(label(trailing, size: 12, weight: .medium, color: .secondaryLabelColor))
        }
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 7
        row.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 26).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 26).isActive = true
        row.widthAnchor.constraint(equalToConstant: cardWidth).isActive = true
        return row
    }

    private func card(backgroundColor: NSColor? = nil) -> NSView {
        let view = NSView()
        view.wantsLayer = true
        view.layer?.cornerRadius = 14
        view.layer?.borderWidth = 0.7
        view.layer?.borderColor = NSColor.white.withAlphaComponent(0.44).cgColor
        view.layer?.backgroundColor = (backgroundColor ?? NSColor.controlBackgroundColor.withAlphaComponent(0.58)).cgColor
        view.layer?.shadowColor = NSColor.black.withAlphaComponent(0.14).cgColor
        view.layer?.shadowOpacity = 1
        view.layer?.shadowRadius = 8
        view.layer?.shadowOffset = CGSize(width: 0, height: 2)
        view.translatesAutoresizingMaskIntoConstraints = false
        view.widthAnchor.constraint(equalToConstant: cardWidth).isActive = true
        return view
    }

    private func summaryCard(_ quota: MenuBarQuota?) -> NSView {
        let container = card()
        let weekly = quotaCell(
            symbol: "chart.bar.xaxis",
            tint: .systemPink,
            title: "Weekly",
            value: quota?.weeklyRemainingPercent,
            detail: accountCount(quota?.weeklyAccountCount ?? 0),
        )
        var quotaCells: [NSView] = []
        if quota?.fiveHourAccountCount ?? 0 > 0 {
            quotaCells.append(
                quotaCell(
                    symbol: "clock.fill",
                    tint: .systemBlue,
                    title: "5 hours",
                    value: quota?.fiveHourRemainingPercent,
                    detail: accountCount(quota?.fiveHourAccountCount ?? 0),
                ),
            )
        }
        quotaCells.append(weekly)
        let stack = NSStackView(views: quotaCells)
        stack.orientation = .horizontal
        stack.distribution = .fillEqually
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 10),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -10),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -10),
        ])
        return container
    }

    private func quotaCell(symbol: String, tint: NSColor, title: String, value: Double?, detail: String) -> NSView {
        let tile = metricTile()
        let icon = iconBubble(symbol: symbol, color: tint, size: 30)
        let titleLabel = label(title, size: 11, weight: .medium, color: .secondaryLabelColor)
        let valueLabel = label(percent(value), size: 22, weight: .semibold)
        valueLabel.font = .monospacedDigitSystemFont(ofSize: 22, weight: .semibold)
        let detailLabel = label(detail, size: 10, color: .secondaryLabelColor)
        let bar = QuotaBarView()
        bar.remainingPercent = value
        bar.translatesAutoresizingMaskIntoConstraints = false
        let labels = NSStackView(views: [titleLabel, valueLabel, detailLabel])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 2
        labels.translatesAutoresizingMaskIntoConstraints = false
        let content = NSStackView(views: [icon, labels])
        content.orientation = .horizontal
        content.alignment = .centerY
        content.spacing = 8
        content.translatesAutoresizingMaskIntoConstraints = false
        tile.addSubview(content)
        tile.addSubview(bar)
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 30),
            icon.heightAnchor.constraint(equalToConstant: 30),
            content.topAnchor.constraint(equalTo: tile.topAnchor, constant: 9),
            content.leadingAnchor.constraint(equalTo: tile.leadingAnchor, constant: 9),
            content.trailingAnchor.constraint(equalTo: tile.trailingAnchor, constant: -9),
            bar.topAnchor.constraint(equalTo: content.bottomAnchor, constant: 7),
            bar.leadingAnchor.constraint(equalTo: tile.leadingAnchor, constant: 9),
            bar.trailingAnchor.constraint(equalTo: tile.trailingAnchor, constant: -9),
            bar.bottomAnchor.constraint(equalTo: tile.bottomAnchor, constant: -9),
        ])
        return tile
    }

    private func accountCard(_ account: MenuBarAccount) -> NSView {
        let container = card()
        let avatar = avatarView(for: account.displayName, tint: avatarTint(for: account.displayName))
        let name = label(account.displayName, size: 12, weight: .semibold)
        name.lineBreakMode = .byTruncatingMiddle
        name.maximumNumberOfLines = 1
        let state = statusBadge(account.status)
        let identity = NSStackView(views: [avatar, name])
        identity.orientation = .horizontal
        identity.alignment = .centerY
        identity.spacing = 8
        let header = NSStackView(views: [identity, NSView(), state])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 6

        let unsupported = account.usageStatus == "unsupported"
        let quotaWindows: [(title: String, window: QuotaWindow?)] = [
            ("5H", account.fiveHour),
            ("WEEK", account.weekly),
            ("MONTH", account.monthly),
        ]
        let updatedText = usageDetail(account)
        let visibleQuotaWindows: [NSView] = unsupported
            ? []
            : quotaWindows.compactMap { item in
                guard let window = item.window, hasResetTime(window.resetAt) else { return nil }
                return compactQuota(title: item.title, window: window)
        }

        var contentViews: [NSView] = [header]
        var windowsView: NSStackView?
        if !visibleQuotaWindows.isEmpty {
            let windows = NSStackView(views: visibleQuotaWindows)
            windows.orientation = .horizontal
            windows.distribution = .fillEqually
            windows.spacing = 8
            windowsView = windows
            contentViews.append(windows)
        }
        if visibleQuotaWindows.isEmpty {
            contentViews.append(label(updatedText, size: 10, color: .tertiaryLabelColor))
        }

        let stack = NSStackView(views: contentViews)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 9
        stack.translatesAutoresizingMaskIntoConstraints = false
        avatar.widthAnchor.constraint(equalToConstant: 32).isActive = true
        avatar.heightAnchor.constraint(equalToConstant: 32).isActive = true
        header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        windowsView?.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 10),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 11),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -11),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -10),
        ])
        return container
    }

    private func compactQuota(title: String, window: QuotaWindow) -> NSView {
        let tile = metricTile()
        let titleLabel = label(title, size: 9, weight: .semibold, color: .secondaryLabelColor)
        let value = label(percent(window.remainingPercent), size: 15, weight: .semibold)
        value.font = .monospacedDigitSystemFont(ofSize: 15, weight: .semibold)
        let reset = label(resetText(window.resetAt), size: 9, color: .tertiaryLabelColor)
        reset.lineBreakMode = .byTruncatingTail
        let bar = QuotaBarView()
        bar.remainingPercent = window.remainingPercent
        bar.translatesAutoresizingMaskIntoConstraints = false
        let stack = NSStackView(views: [titleLabel, value, bar, reset])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        reset.maximumNumberOfLines = 1
        reset.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        bar.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        tile.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: tile.topAnchor, constant: 8),
            stack.leadingAnchor.constraint(equalTo: tile.leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: tile.trailingAnchor, constant: -8),
            stack.bottomAnchor.constraint(equalTo: tile.bottomAnchor, constant: -8),
        ])
        return tile
    }

    private func metricTile() -> NSView {
        let tile = NSView()
        tile.wantsLayer = true
        tile.layer?.cornerRadius = 11
        tile.layer?.borderWidth = 0.6
        tile.layer?.borderColor = NSColor.white.withAlphaComponent(0.38).cgColor
        tile.layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.32).cgColor
        tile.translatesAutoresizingMaskIntoConstraints = false
        return tile
    }

    private func iconBubble(symbol: String, color: NSColor, size: CGFloat) -> NSView {
        let bubble = NSView()
        bubble.wantsLayer = true
        bubble.layer?.cornerRadius = size / 2
        bubble.layer?.backgroundColor = color.withAlphaComponent(0.13).cgColor
        bubble.translatesAutoresizingMaskIntoConstraints = false

        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
            ?? NSImage(size: NSSize(width: size, height: size))
        let imageView = NSImageView(image: image)
        imageView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: size * 0.46, weight: .semibold)
        imageView.contentTintColor = color
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.translatesAutoresizingMaskIntoConstraints = false
        bubble.addSubview(imageView)
        NSLayoutConstraint.activate([
            imageView.centerXAnchor.constraint(equalTo: bubble.centerXAnchor),
            imageView.centerYAnchor.constraint(equalTo: bubble.centerYAnchor),
            imageView.widthAnchor.constraint(lessThanOrEqualTo: bubble.widthAnchor, multiplier: 0.62),
            imageView.heightAnchor.constraint(lessThanOrEqualTo: bubble.heightAnchor, multiplier: 0.62),
        ])
        return bubble
    }

    private func avatarView(for displayName: String, tint: NSColor) -> NSView {
        let avatar = NSView()
        avatar.wantsLayer = true
        avatar.layer?.cornerRadius = 16
        avatar.layer?.backgroundColor = tint.withAlphaComponent(0.16).cgColor
        avatar.translatesAutoresizingMaskIntoConstraints = false
        let initial = displayName.trimmingCharacters(in: .whitespacesAndNewlines).first.map(String.init)?.uppercased() ?? "?"
        let initialLabel = label(initial, size: 16, weight: .semibold, color: tint)
        initialLabel.alignment = .center
        initialLabel.translatesAutoresizingMaskIntoConstraints = false
        avatar.addSubview(initialLabel)
        NSLayoutConstraint.activate([
            initialLabel.centerXAnchor.constraint(equalTo: avatar.centerXAnchor),
            initialLabel.centerYAnchor.constraint(equalTo: avatar.centerYAnchor),
        ])
        return avatar
    }

    private func avatarTint(for displayName: String) -> NSColor {
        let palette: [NSColor] = [.systemBlue, .systemPurple, .systemTeal, .systemOrange, .systemPink]
        let value = displayName.unicodeScalars.reduce(0) { $0 + Int($1.value) }
        return palette[value % palette.count]
    }

    private func statusBadge(_ status: String) -> NSView {
        let copy: String
        let color: NSColor
        switch status {
        case "ready": (copy, color) = ("Ready", .systemGreen)
        case "paused": (copy, color) = ("Paused", .secondaryLabelColor)
        case "limited": (copy, color) = ("Limited", .systemOrange)
        default: (copy, color) = ("Attention", .systemRed)
        }
        let badge = NSView()
        badge.wantsLayer = true
        badge.layer?.cornerRadius = 10
        badge.layer?.backgroundColor = color.withAlphaComponent(0.12).cgColor
        badge.translatesAutoresizingMaskIntoConstraints = false
        let dot = NSView()
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 4
        dot.layer?.backgroundColor = color.cgColor
        dot.translatesAutoresizingMaskIntoConstraints = false
        let text = label(copy, size: 10, weight: .semibold, color: color)
        let row = NSStackView(views: [dot, text])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.translatesAutoresizingMaskIntoConstraints = false
        badge.addSubview(row)
        NSLayoutConstraint.activate([
            dot.widthAnchor.constraint(equalToConstant: 8),
            dot.heightAnchor.constraint(equalToConstant: 8),
            row.topAnchor.constraint(equalTo: badge.topAnchor, constant: 4),
            row.leadingAnchor.constraint(equalTo: badge.leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(equalTo: badge.trailingAnchor, constant: -8),
            row.bottomAnchor.constraint(equalTo: badge.bottomAnchor, constant: -4),
        ])
        return badge
    }

    private func emptyAccountsCard(operational: Bool) -> NSView {
        let container = card()
        let title = label(operational ? "No OpenAI account yet" : "Host data unavailable", size: 13, weight: .semibold)
        let detail = label(
            operational ? "Add an account from the dashboard to see its quota here." : "Start or refresh MultiVibe Host to load your accounts.",
            size: 11,
            color: .secondaryLabelColor
        )
        detail.maximumNumberOfLines = 2
        let stack = NSStackView(views: [title, detail])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 5
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 11),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -11),
        ])
        return container
    }

    private func earningsCard(_ earnings: MenuBarSummary.Earnings?) -> NSView {
        let container = card()
        let columns = NSStackView(views: [
            earningRow("Today", value: earningText(earnings?.today, earnings: earnings), symbol: "calendar", tint: .systemBlue),
            earningRow("This week", value: earningText(earnings?.week, earnings: earnings), symbol: "calendar.badge.clock", tint: .systemPurple),
            earningRow("This month", value: earningText(earnings?.month, earnings: earnings), symbol: "chart.bar.fill", tint: .systemGreen),
        ])
        columns.orientation = .horizontal
        columns.distribution = .fillEqually
        columns.alignment = .centerY
        columns.spacing = 8
        columns.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(columns)
        NSLayoutConstraint.activate([
            columns.topAnchor.constraint(equalTo: container.topAnchor, constant: 10),
            columns.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 10),
            columns.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -10),
            columns.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -10),
        ])
        return container
    }

    private func updateCard(_ update: HostUpdateStatus?, busy: Bool) -> NSView {
        let isCurrent = update?.availableVersion == nil && update?.status == "current"
        let container = card(backgroundColor: isCurrent
            ? NSColor.systemGreen.withAlphaComponent(0.10)
            : NSColor.controlBackgroundColor.withAlphaComponent(0.58))
        let title: String
        let detail: String
        if let version = update?.availableVersion {
            title = "Version \(version) available"
            detail = update?.downloaded == true ? "Verified download ready to install." : "Ready for verified background download."
        } else if update?.status == "current" {
            title = "MultiVibe Host is up to date"
            detail = "The signed stable release feed is checked periodically."
        } else {
            title = "Automatic verified updates"
            detail = "Check the signed release feed now or manage policy in the dashboard."
        }

        let tint: NSColor = isCurrent ? .systemGreen : .systemOrange
        let icon = iconBubble(symbol: isCurrent ? "checkmark" : "arrow.down.circle", color: tint, size: 32)
        let titleLabel = label(title, size: 12, weight: .semibold)
        let detailLabel = label(detail, size: 10, color: .secondaryLabelColor)
        detailLabel.maximumNumberOfLines = 2
        let checkButton = NSButton(title: busy ? "Checking…" : "Check Now", target: self, action: #selector(didCheckForUpdates))
        checkButton.bezelStyle = .rounded
        checkButton.isEnabled = !busy
        let actions = NSStackView(views: [checkButton])
        actions.orientation = .horizontal
        actions.spacing = 8
        if update?.availableVersion != nil {
            let installTitle = update?.installRequested == true ? "Installation Queued" : "Install Safely"
            let installButton = NSButton(title: installTitle, target: self, action: #selector(didInstallUpdate))
            installButton.bezelStyle = .rounded
            installButton.isEnabled = !busy && update?.installRequested != true
            actions.addArrangedSubview(installButton)
        }

        let copy = NSStackView(views: [titleLabel, detailLabel])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = 3
        copy.translatesAutoresizingMaskIntoConstraints = false
        let body = NSStackView(views: [icon, copy, NSView(), actions])
        body.orientation = .horizontal
        body.alignment = .centerY
        body.spacing = 8
        body.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(body)
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 32),
            icon.heightAnchor.constraint(equalToConstant: 32),
            body.topAnchor.constraint(equalTo: container.topAnchor, constant: 10),
            body.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 10),
            body.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -10),
            body.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -10),
        ])
        return container
    }

    private func earningRow(_ title: String, value: String, symbol: String, tint: NSColor) -> NSView {
        let icon = iconBubble(symbol: symbol, color: tint, size: 28)
        let titleLabel = label(title, size: 10, color: .secondaryLabelColor)
        let valueLabel = label(value, size: 11, weight: .semibold)
        valueLabel.lineBreakMode = .byTruncatingTail
        let copy = NSStackView(views: [titleLabel, valueLabel])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = 2
        let row = NSStackView(views: [icon, copy])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 7
        row.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 28).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 28).isActive = true
        return row
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = .labelColor) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .systemFont(ofSize: size, weight: weight)
        field.textColor = color
        return field
    }

    private func appIcon() -> NSImage? {
        let url = Bundle.main.resourceURL?.appendingPathComponent("MultiVibeMenuBarIcon.png")
        return url.flatMap(NSImage.init(contentsOf:)) ?? NSImage(systemSymbolName: "waveform.path", accessibilityDescription: "MultiVibe")
    }

    private func percent(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return "\(Int(value.rounded()))%"
    }

    private func accountCount(_ count: Int) -> String {
        count == 1 ? "1 account" : "\(count) accounts"
    }

    private func hasResetTime(_ timestamp: Double?) -> Bool {
        guard let timestamp else { return false }
        return timestamp.isFinite
    }

    private func resetText(_ timestamp: Double?) -> String {
        guard let timestamp, timestamp.isFinite else { return "No reset time" }
        let date = Date(timeIntervalSince1970: timestamp / 1_000)
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "en")
        formatter.unitsStyle = .short
        return "Resets \(formatter.localizedString(for: date, relativeTo: Date()))"
    }

    private func usageDetail(_ account: MenuBarAccount) -> String {
        if account.usageStatus == "unsupported" { return "OpenAI does not expose quota usage for this account." }
        guard let fetchedAt = account.fetchedAt, fetchedAt.isFinite else { return "Waiting for the first quota refresh." }
        let date = Date(timeIntervalSince1970: fetchedAt / 1_000)
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "en")
        formatter.unitsStyle = .short
        return "Updated \(formatter.localizedString(for: date, relativeTo: Date()))"
    }

    private func earningText(_ value: Decimal?, earnings: MenuBarSummary.Earnings?) -> String {
        guard let earnings, earnings.available, let value, let currency = earnings.currency else { return "Not available" }
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currency
        return formatter.string(from: value as NSDecimalNumber) ?? "\(value) \(currency)"
    }

    @objc private func didOpenDashboard() { openDashboard?() }
    @objc private func didRefresh() { refresh?() }
    @objc private func didCheckForUpdates() { checkForUpdates?() }
    @objc private func didInstallUpdate() { installUpdate?() }
    @objc private func didChangeStartAtLogin() { setStartAtLogin?(startAtLoginButton.state == .on) }
    @objc private func didQuit() { quit?() }
}

private final class GitHubStarPromptController: NSViewController {
    var openGitHub: (() -> Void)?

    private let messageLabel = NSTextField(wrappingLabelWithString: "Nice work — you’ve generated 5 million output tokens with MultiVibe. If it’s useful, please star the project on GitHub.")
    private let starButton = NSButton(title: "⭐ Star MultiVibe on GitHub", target: nil, action: nil)

    override func loadView() {
        let background = NSVisualEffectView()
        background.material = .popover
        background.blendingMode = .behindWindow
        background.state = .active

        messageLabel.font = .systemFont(ofSize: 13)
        messageLabel.textColor = .labelColor
        messageLabel.maximumNumberOfLines = 0
        messageLabel.lineBreakMode = .byWordWrapping

        starButton.bezelStyle = .rounded
        starButton.controlSize = .large
        starButton.target = self
        starButton.action = #selector(didOpenGitHub)

        let stack = NSStackView(views: [messageLabel, starButton])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        background.addSubview(stack)

        NSLayoutConstraint.activate([
            background.widthAnchor.constraint(equalToConstant: 340),
            stack.topAnchor.constraint(equalTo: background.topAnchor, constant: 18),
            stack.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -18),
            stack.bottomAnchor.constraint(equalTo: background.bottomAnchor, constant: -18),
            messageLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        view = background
    }

    func resetPrompt() {
        loadViewIfNeeded()
        messageLabel.stringValue = "Nice work — you’ve generated 5 million output tokens with MultiVibe. If it’s useful, please star the project on GitHub."
        starButton.title = "⭐ Star MultiVibe on GitHub"
        starButton.isEnabled = true
    }

    func showThankYou() {
        loadViewIfNeeded()
        messageLabel.stringValue = "Thank you for supporting MultiVibe! ❤️"
        starButton.title = "Thank you! ❤️"
        starButton.isEnabled = false
    }

    @objc private func didOpenGitHub() { openGitHub?() }
}

@main
final class MultiVibeMenuBarApp: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private static let githubRepositoryURL = URL(string: "https://github.com/thibautrey/multivibe")!
    private static let githubStarPromptAcknowledgedKey = "githubStarPromptAcknowledged"
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let popover = NSPopover()
    private let popoverController = HostPopoverController()
    private let githubStarPromptPopover = NSPopover()
    private let githubStarPromptController = GitHubStarPromptController()
    private var refreshTimer: Timer?
    private var signalSources: [DispatchSourceSignal] = []
    private var ownedService: Process?
    private var dashboardURL = URL(string: "http://127.0.0.1:\(configuredHostPort)")!
    private var usesFallbackPort = false
    private var pendingDashboardOpen = false
    private var operational = false
    private var statusText = "Starting…"
    private var summary: MenuBarSummary?
    private var refreshing = false
    private var updateStatus: HostUpdateStatus?
    private var updateBusy = false
    private var didFinishLaunching = false
    private var pendingEnrollmentToken: String?
    private var enrollmentInProgress = false
    private var githubStarPromptPresented = false
    private var githubStarPromptCloseWorkItem: DispatchWorkItem?
    private var githubStarPromptAcknowledged = UserDefaults.standard.bool(forKey: githubStarPromptAcknowledgedKey)
#if DEBUG
    private var previewWindow: NSWindow?
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
        configurePopover()
        configureTerminationSignals()
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

    func application(_ application: NSApplication, open urls: [URL]) {
        guard urls.count == 1, let token = enrollmentToken(from: urls[0]) else {
            if didFinishLaunching { showEnrollmentAlert(success: false, invalidLink: true) }
            return
        }
        guard pendingEnrollmentToken == nil, !enrollmentInProgress else { return }
        pendingEnrollmentToken = token
        if didFinishLaunching { presentPendingEnrollmentConfirmation() }
    }

    private func enrollmentToken(from url: URL) -> String? {
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

    private func presentPendingEnrollmentConfirmation() {
        guard pendingEnrollmentToken != nil, !enrollmentInProgress else { return }
        NSApplication.shared.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "Add this Mac to MultiVibe Cloud?"
        alert.informativeText = "MultiVibe Host will share its public device identity and selected local models. Your private key stays on this Mac."
        alert.addButton(withTitle: "Add this Mac")
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

    private func submitPendingEnrollment() {
        guard let token = pendingEnrollmentToken, !enrollmentInProgress,
              var request = authorizedRequest(path: "/admin/provider-agent/cloud-shadow/enroll-handoff", method: "POST")
        else { return }
        enrollmentInProgress = true
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["enrollment_token": token])
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let connected = (200...299).contains(status)
                && data.flatMap { try? JSONDecoder().decode(CloudEnrollmentResult.self, from: $0) }?.state == "submitted"
            DispatchQueue.main.async {
                self.pendingEnrollmentToken = nil
                self.enrollmentInProgress = false
                self.showEnrollmentAlert(success: connected, invalidLink: false)
                self.refreshNow()
            }
        }.resume()
    }

    private func showEnrollmentAlert(success: Bool, invalidLink: Bool) {
        NSApplication.shared.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = success ? .informational : .warning
        alert.messageText = success ? "This Mac is connected" : "This Mac could not be connected"
        alert.informativeText = success
            ? "Its public identity and selected local model were registered securely."
            : (invalidLink
                ? "The MultiVibe connection link is invalid or incomplete. Start again from MultiVibe Cloud."
                : "Make sure one local model is selected in MultiVibe Host, then try again from MultiVibe Cloud.")
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

#if DEBUG
    private func showPreviewWindow() {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: NSSize(width: 440, height: 620)),
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

    func applicationWillTerminate(_ notification: Notification) {
        refreshTimer?.invalidate()
        githubStarPromptCloseWorkItem?.cancel()
        if let process = ownedService, process.isRunning { process.terminate() }
    }

    private func configureStatusItem() {
        guard let button = statusItem.button else { return }
        let iconURL = Bundle.main.resourceURL?.appendingPathComponent("MultiVibeMenuBarIcon.png")
        if let iconURL, let image = NSImage(contentsOf: iconURL) {
            image.size = NSSize(width: 18, height: 18)
            image.isTemplate = false
            button.image = image
        } else {
            button.image = NSImage(systemSymbolName: "waveform.path", accessibilityDescription: "MultiVibe")
        }
        button.imagePosition = .imageLeading
        button.target = self
        button.action = #selector(togglePopover)
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        button.toolTip = "MultiVibe Host"
    }

    private func configurePopover() {
        popover.behavior = .transient
        popover.animates = true
        popover.contentSize = NSSize(width: 440, height: 620)
        popover.contentViewController = popoverController
        popover.delegate = self
        popoverController.openDashboard = { [weak self] in
            self?.popover.performClose(nil)
            self?.openDashboard()
        }
        popoverController.refresh = { [weak self] in self?.refreshNow() }
        popoverController.checkForUpdates = { [weak self] in self?.runUpdateAction(path: "/admin/host-update/check") }
        popoverController.installUpdate = { [weak self] in self?.runUpdateAction(path: "/admin/host-update/apply") }
        popoverController.setStartAtLogin = { [weak self] enabled in self?.setStartAtLogin(enabled) }
        popoverController.quit = { [weak self] in self?.quitApplication() }

        githubStarPromptPopover.behavior = .transient
        githubStarPromptPopover.animates = true
        githubStarPromptPopover.contentSize = NSSize(width: 340, height: 150)
        githubStarPromptPopover.contentViewController = githubStarPromptController
        githubStarPromptController.openGitHub = { [weak self] in self?.openGitHubStarPage() }
    }

    private func configureTerminationSignals() {
        for signalNumber in [SIGINT, SIGTERM] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { NSApplication.shared.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }
    }

    private func render() {
        guard let button = statusItem.button else { return }
        if let quota = summary?.quota, operational {
            var parts: [String] = []
            if let weekly = quota.weeklyRemainingPercent { parts.append("W:\(Int(weekly.rounded()))%") }
            if let fiveHour = quota.fiveHourRemainingPercent { parts.append("5h:\(Int(fiveHour.rounded()))%") }
            button.title = parts.isEmpty ? "" : "  " + parts.joined(separator: "  ")
            button.font = .monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
        } else {
            button.title = ""
        }
        button.toolTip = "MultiVibe Host — \(statusText)"
        popoverController.render(
            summary: summary,
            status: statusText,
            operational: operational,
            refreshing: refreshing,
            updateStatus: updateStatus,
            updateBusy: updateBusy,
            startAtLogin: UserDefaults.standard.object(forKey: "startAtLogin") as? Bool ?? true
        )
        presentGitHubStarPromptIfNeeded()
    }

    @objc private func togglePopover() {
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

    private func credentialsURL() -> URL? {
        if let configured = ProcessInfo.processInfo.environment["MULTIVIBE_HOST_DATA_DIR"], !configured.isEmpty {
            return URL(fileURLWithPath: configured, isDirectory: true).appendingPathComponent("host-credentials.json")
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/MultiVibe", isDirectory: true)
            .appendingPathComponent("host-credentials.json")
    }

    private func readCredentials() -> HostCredentials? {
        guard let url = credentialsURL(), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(HostCredentials.self, from: data)
    }

    private func authorizedRequest(path: String, method: String = "GET") -> URLRequest? {
        guard let credentials = readCredentials(), let url = URL(string: path, relativeTo: dashboardURL) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 3
        request.setValue(credentials.adminToken, forHTTPHeaderField: "x-admin-token")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        return request
    }

    private func refresh() {
        guard !refreshing else { return }
        refreshing = true
        render()
        guard let request = authorizedRequest(path: "/admin/host/menu-bar") else {
            refreshing = false
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
                    self?.updateState(operational: false, status: "Unavailable")
                    if self?.ownedService?.isRunning != true { self?.launchService(avoidingOccupiedPort: http != nil) }
                }
                return
            }
            DispatchQueue.main.async {
                self?.refreshing = false
                self?.summary = summary
                self?.updateState(operational: summary.operational, status: summary.operational ? "Operational" : "Unavailable")
                if summary.operational, self?.pendingDashboardOpen == true { self?.requestDashboardSession() }
                if summary.operational, self?.pendingEnrollmentToken != nil { self?.submitPendingEnrollment() }
                self?.refreshUpdateStatus()
            }
        }.resume()
    }

    private func refreshUpdateStatus() {
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

    private func runUpdateAction(path: String) {
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

    private func updateState(operational: Bool, status: String) {
        self.operational = operational
        self.statusText = status
        render()
    }

    private func presentGitHubStarPromptIfNeeded() {
        guard operational,
              summary?.githubStarPrompt?.eligible == true,
              !githubStarPromptAcknowledged,
              !githubStarPromptPresented,
              !popover.isShown,
              !githubStarPromptPopover.isShown,
              let button = statusItem.button else { return }
        githubStarPromptPresented = true
        githubStarPromptController.resetPrompt()
        githubStarPromptPopover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private func openGitHubStarPage() {
        githubStarPromptAcknowledged = true
        UserDefaults.standard.set(true, forKey: Self.githubStarPromptAcknowledgedKey)
        githubStarPromptController.showThankYou()
        NSWorkspace.shared.open(Self.githubRepositoryURL)

        githubStarPromptCloseWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.githubStarPromptPopover.performClose(nil)
        }
        githubStarPromptCloseWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: workItem)
    }

    func popoverDidClose(_ notification: Notification) {
        presentGitHubStarPromptIfNeeded()
    }

    private func setStartAtLogin(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: "startAtLogin")
        if !enabled, let service = ownedService, service.isRunning {
            service.terminate()
            ownedService = nil
            updateState(operational: false, status: "Stopped")
        } else if enabled {
            ensureServiceIsRunning()
        }
        render()
    }

    private func ensureServiceIsRunning() {
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

    private func launchService(avoidingOccupiedPort: Bool = false) {
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

    @objc private func refreshNow() {
        refreshing = false
        refresh()
    }

    @objc private func openDashboard() {
        pendingDashboardOpen = true
        if !operational {
            updateState(operational: false, status: "Starting…")
            ensureServiceIsRunning()
            return
        }
        requestDashboardSession()
    }

    private func requestDashboardSession() {
        guard var request = authorizedRequest(path: "/admin/desktop-session", method: "POST") else {
            ensureServiceIsRunning()
            return
        }
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            guard let data, (response as? HTTPURLResponse)?.statusCode == 200,
                  let session = try? JSONDecoder().decode(DesktopSession.self, from: data),
                  let url = URL(string: session.path, relativeTo: self.dashboardURL) else { return }
            DispatchQueue.main.async {
                self.pendingDashboardOpen = false
                NSWorkspace.shared.open(url)
            }
        }.resume()
    }

    @objc private func quitApplication() {
        NSApplication.shared.terminate(nil)
    }
}
