import AppKit
import Foundation

private enum MenuBarPalette {
    private static func color(_ hex: UInt32) -> NSColor {
        NSColor(
            calibratedRed: CGFloat((hex >> 16) & 0xff) / 255,
            green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255,
            alpha: 1,
        )
    }

    private static func adaptive(light: NSColor, dark: NSColor) -> NSColor {
        NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
        }
    }

    static let background = NSColor.windowBackgroundColor
    static let panel = NSColor.controlBackgroundColor
    static let surfaceMuted = adaptive(light: color(0xf6f8f7), dark: color(0x182521))
    static let line = adaptive(light: color(0xe0e7e4), dark: color(0x273733))
    static let text = NSColor.labelColor
    static let muted = NSColor.secondaryLabelColor
    static let mutedStrong = adaptive(light: color(0x435650), dark: color(0xc2d1cc))
    static let primary = adaptive(light: color(0x147d72), dark: color(0x55c7b8))
    static let warning = adaptive(light: color(0xad681e), dark: color(0xf3b35f))
    static let warningSoft = adaptive(light: color(0xfff5e7), dark: color(0x392817))
    static let danger = adaptive(light: color(0xc74654), dark: color(0xfb7185))
    static let dangerSoft = adaptive(light: color(0xfff0f1), dark: color(0x3a1b22))
    static let success = adaptive(light: color(0x147d5f), dark: color(0x5fd2aa))
    static let successSoft = adaptive(light: color(0xe6f5ef), dark: color(0x17372d))
}

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

private struct MenuBarForecast: Decodable {
    let score: Double
}

private struct MenuBarNotification: Decodable {
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
    let forecast: MenuBarForecast?
    let notifications: [MenuBarNotification]?
    let earnings: Earnings
}

private struct LocalWorkerStatusResponse: Decodable {
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

private struct CloudEnrollmentError: Decodable {
    let error: String
}

private enum CloudEnrollmentFailure {
    case invalidLink
    case localAgentUnavailable
    case expiredGrant
    case conflict
    case cloudRejected
    case cloudUnavailable
}

private final class QuotaBarView: NSView {
    var remainingPercent: Double? {
        didSet { needsDisplay = true }
    }

    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: 4) }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let track = NSBezierPath(roundedRect: bounds, xRadius: 2, yRadius: 2)
        MenuBarPalette.line.setFill()
        track.fill()
        guard let remainingPercent else { return }
        let safeValue = max(0, min(100, remainingPercent))
        let fillRect = NSRect(x: 0, y: 0, width: bounds.width * safeValue / 100, height: bounds.height)
        guard fillRect.width > 0 else { return }
        let fill = NSBezierPath(roundedRect: fillRect, xRadius: 2, yRadius: 2)
        let color: NSColor = safeValue <= 10 ? MenuBarPalette.danger : safeValue <= 30 ? MenuBarPalette.warning : MenuBarPalette.primary
        color.setFill()
        fill.fill()
    }
}

private final class AdaptiveLayerView: NSView {
    private let adaptiveBackgroundColor: NSColor?
    private let adaptiveBorderColor: NSColor?

    init(backgroundColor: NSColor? = nil, borderColor: NSColor? = nil) {
        adaptiveBackgroundColor = backgroundColor
        adaptiveBorderColor = borderColor
        super.init(frame: .zero)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = adaptiveBackgroundColor?.cgColor
            layer?.borderColor = adaptiveBorderColor?.cgColor
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

private final class AdaptiveLayerTextField: NSTextField {
    private let adaptiveBackgroundColor: NSColor
    private let adaptiveBorderColor: NSColor

    init(labelWithString string: String, backgroundColor: NSColor, borderColor: NSColor) {
        adaptiveBackgroundColor = backgroundColor
        adaptiveBorderColor = borderColor
        super.init(frame: .zero)
        stringValue = string
        isEditable = false
        isSelectable = false
        isBezeled = false
        drawsBackground = false
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = adaptiveBackgroundColor.cgColor
            layer?.borderColor = adaptiveBorderColor.cgColor
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

private final class HostPopoverController: NSViewController {
    var openDashboard: (() -> Void)?
    var configureWorker: (() -> Void)?
    var checkForUpdates: (() -> Void)?
    var installUpdate: (() -> Void)?
    var setStartAtLogin: ((Bool) -> Void)?
    var quit: (() -> Void)?

    private let headerTitle = NSTextField(labelWithString: "MultiVibe Host")
    private let headerStatus = NSTextField(labelWithString: "Starting…")
    private let headerVersion = NSTextField(labelWithString: "")
    private let contentStack = NSStackView()
    private let settingsStack = NSStackView()
    private let settingsButton = NSButton(title: "Settings", target: nil, action: nil)
    private var settingsExpanded = false
    private let primaryButton = NSButton(title: "Open Dashboard", target: nil, action: nil)
    private let startAtLoginButton = NSButton(checkboxWithTitle: "Launch at login", target: nil, action: nil)

    override func loadView() {
        let background = AdaptiveLayerView(backgroundColor: MenuBarPalette.background)
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
        contentStack.edgeInsets = NSEdgeInsets(top: 14, left: 18, bottom: 16, right: 18)
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(contentStack)
        scrollView.documentView = document

        let footer = makeFooter()
        startAtLoginButton.font = .systemFont(ofSize: 11, weight: .regular)
        startAtLoginButton.contentTintColor = MenuBarPalette.mutedStrong
        background.addSubview(header)
        background.addSubview(scrollView)
        background.addSubview(footer)

        NSLayoutConstraint.activate([
            background.widthAnchor.constraint(equalToConstant: 420),
            background.heightAnchor.constraint(equalToConstant: 570),
            header.topAnchor.constraint(equalTo: background.topAnchor),
            header.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            header.heightAnchor.constraint(equalToConstant: 72),
            scrollView.topAnchor.constraint(equalTo: header.bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: footer.topAnchor),
            footer.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            footer.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            footer.bottomAnchor.constraint(equalTo: background.bottomAnchor),
            footer.heightAnchor.constraint(equalToConstant: 68),
            document.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor),
            contentStack.topAnchor.constraint(equalTo: document.topAnchor),
            contentStack.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            contentStack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            contentStack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
        ])
    }

    private func makeHeader() -> NSView {
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

    private func makeFooter() -> NSView {
        let container = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false
        let divider = makeDivider()
        divider.translatesAutoresizingMaskIntoConstraints = false

        styleButton(primaryButton, kind: .primary)
        primaryButton.target = self
        primaryButton.action = #selector(didOpenDashboard)
        let quitButton = NSButton(title: "Quit", target: self, action: #selector(didQuit))
        styleButton(quitButton, kind: .quiet)

        let actions = NSStackView(views: [primaryButton, quitButton])
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

    private func makeDivider() -> NSView {
        AdaptiveLayerView(backgroundColor: MenuBarPalette.line)
    }

    private enum ButtonKind {
        case primary
        case secondary
        case quiet
    }

    private func styleButton(_ button: NSButton, kind: ButtonKind) {
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

    func render(
        summary: MenuBarSummary?,
        workerNeedsSetup: Bool,
        status: String,
        operational: Bool,
        updateStatus: HostUpdateStatus?,
        updateBusy: Bool,
        startAtLogin: Bool
    ) {
        _ = view
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        headerTitle.stringValue = "MultiVibe"
        headerStatus.stringValue = status
        headerStatus.textColor = operational ? MenuBarPalette.success : MenuBarPalette.mutedStrong
        headerVersion.stringValue = "v\(version)"
        primaryButton.title = operational ? "Open Dashboard" : "Start Host"

        for child in contentStack.arrangedSubviews {
            contentStack.removeArrangedSubview(child)
            child.removeFromSuperview()
        }

        contentStack.addArrangedSubview(sectionLabel("OpenAI · remaining capacity"))
        contentStack.addArrangedSubview(summaryCard(summary?.quota))
        contentStack.addArrangedSubview(sectionLabel("Accounts"))
        if let accounts = summary?.accounts, !accounts.isEmpty {
            contentStack.addArrangedSubview(accountsCard(accounts))
        } else {
            contentStack.addArrangedSubview(emptyAccountsCard(operational: operational))
        }
        if workerNeedsSetup {
            contentStack.addArrangedSubview(sectionLabel("Worker"))
            contentStack.addArrangedSubview(workerSetupCard())
        } else {
            contentStack.addArrangedSubview(sectionLabel("Earnings"))
            contentStack.addArrangedSubview(earningsCard(summary?.earnings))
        }
        // An available update stays visible even while settings are collapsed.
        if updateStatus?.availableVersion != nil {
            contentStack.addArrangedSubview(updateCard(updateStatus, busy: updateBusy))
        }
        for child in settingsStack.arrangedSubviews {
            settingsStack.removeArrangedSubview(child)
            child.removeFromSuperview()
        }
        settingsStack.orientation = .vertical
        settingsStack.alignment = .leading
        settingsStack.spacing = 12
        if updateStatus?.availableVersion == nil {
            settingsStack.addArrangedSubview(updateCard(updateStatus, busy: updateBusy))
        }
        styleButton(settingsButton, kind: .quiet)
        settingsButton.target = self
        settingsButton.action = #selector(didToggleSettings)
        settingsButton.imagePosition = .imageLeading
        updateSettingsDisclosure()
        contentStack.addArrangedSubview(settingsButton)
        contentStack.addArrangedSubview(settingsStack)
        startAtLoginButton.state = startAtLogin ? .on : .off
        startAtLoginButton.target = self
        startAtLoginButton.action = #selector(didChangeStartAtLogin)
        settingsStack.addArrangedSubview(startAtLoginButton)
    }

    @objc private func didToggleSettings() {
        settingsExpanded.toggle()
        updateSettingsDisclosure()
    }

    private func updateSettingsDisclosure() {
        settingsStack.isHidden = !settingsExpanded
        settingsButton.image = NSImage(
            systemSymbolName: settingsExpanded ? "chevron.down" : "chevron.right",
            accessibilityDescription: nil
        )
        settingsButton.setAccessibilityLabel(settingsExpanded ? "Collapse settings" : "Expand settings")
    }

    private func sectionLabel(_ text: String) -> NSTextField {
        label(text, size: 11, weight: .medium, color: MenuBarPalette.muted)
    }

    private func card() -> NSView {
        let view = AdaptiveLayerView(backgroundColor: MenuBarPalette.panel, borderColor: MenuBarPalette.line)
        view.layer?.cornerRadius = 10
        view.layer?.borderWidth = 0
        view.layer?.masksToBounds = true
        view.translatesAutoresizingMaskIntoConstraints = false
        view.widthAnchor.constraint(equalToConstant: 384).isActive = true
        return view
    }

    private func summaryCard(_ quota: MenuBarQuota?) -> NSView {
        let container = card()
        let weekly = quotaCell(title: "Weekly", value: quota?.weeklyRemainingPercent, detail: accountCount(quota?.weeklyAccountCount ?? 0))
        var quotaCells: [NSView] = []
        if quota?.fiveHourAccountCount ?? 0 > 0 {
            quotaCells.append(
                quotaCell(
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

    private func quotaCell(title: String, value: Double?, detail: String) -> NSView {
        let titleLabel = label(title, size: 11, weight: .semibold, color: MenuBarPalette.muted)
        let valueLabel = label(percent(value), size: 24, weight: .semibold, color: MenuBarPalette.text)
        valueLabel.font = .monospacedDigitSystemFont(ofSize: 22, weight: .semibold)
        let detailLabel = label(detail, size: 10, color: MenuBarPalette.muted)
        let bar = QuotaBarView()
        bar.remainingPercent = value
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.setAccessibilityLabel(title)
        bar.setAccessibilityValue(percent(value))
        let stack = NSStackView(views: [titleLabel, valueLabel, bar, detailLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 5
        bar.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        return stack
    }

    private func accountsCard(_ accounts: [MenuBarAccount]) -> NSView {
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

    private func accountCard(_ account: MenuBarAccount) -> NSView {
        let container = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false
        let name = label(account.displayName, size: 13, weight: .semibold, color: MenuBarPalette.text)
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
                guard let window = item.window, hasResetTime(window.resetAt) else { return nil }
                return compactQuota(title: item.title, window: window)
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
        contentViews.append(updated)

        let stack = NSStackView(views: contentViews)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        windowsView?.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 13),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 15),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -15),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -13),
        ])
        return container
    }

    private func compactQuota(title: String, window: QuotaWindow) -> NSView {
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

    private func statusBadge(_ status: String) -> NSTextField {
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

    private func emptyAccountsCard(operational: Bool) -> NSView {
        let container = card()
        let title = label(operational ? "No OpenAI account yet" : "Host data unavailable", size: 13, weight: .semibold, color: MenuBarPalette.text)
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

    private func earningsCard(_ earnings: MenuBarSummary.Earnings?) -> NSView {
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

    private func workerSetupCard() -> NSView {
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

    private func updateCard(_ update: HostUpdateStatus?, busy: Bool) -> NSView {
        let container = card()
        let title: String
        let detail: String
        if let version = update?.availableVersion {
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

    private func earningRow(_ title: String, value: String) -> NSView {
        let titleLabel = label(title, size: 11, color: MenuBarPalette.muted)
        let valueLabel = label(value, size: 12, weight: .semibold, color: MenuBarPalette.text)
        let row = NSStackView(views: [titleLabel, NSView(), valueLabel])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.widthAnchor.constraint(equalToConstant: 354).isActive = true
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
    @objc private func didConfigureWorker() { configureWorker?() }
    @objc private func didCheckForUpdates() { checkForUpdates?() }
    @objc private func didInstallUpdate() { installUpdate?() }
    @objc private func didChangeStartAtLogin() { setStartAtLogin?(startAtLoginButton.state == .on) }
    @objc private func didQuit() { quit?() }
}

private final class NotificationPopup: NSViewController {
    struct Configuration {
        let message: String
        let actionTitle: String
        let confirmationMessage: String?
        let confirmationTitle: String?
        let action: () -> Void
    }

    private var configuration: Configuration?
    private let messageLabel = NSTextField(wrappingLabelWithString: "")
    private let actionButton = NSButton(title: "", target: nil, action: nil)

    override func loadView() {
        let background = AdaptiveLayerView(backgroundColor: MenuBarPalette.background)

        messageLabel.font = .systemFont(ofSize: 13)
        messageLabel.textColor = MenuBarPalette.text
        messageLabel.maximumNumberOfLines = 0
        messageLabel.lineBreakMode = .byWordWrapping

        actionButton.bezelStyle = .rounded
        actionButton.controlSize = .regular
        actionButton.font = .systemFont(ofSize: 12, weight: .semibold)
        actionButton.bezelColor = MenuBarPalette.primary
        actionButton.contentTintColor = .white
        actionButton.target = self
        actionButton.action = #selector(didSelectAction)

        let stack = NSStackView(views: [messageLabel, actionButton])
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

    func configure(_ configuration: Configuration) {
        self.configuration = configuration
        reset()
    }

    func reset() {
        _ = view
        guard let configuration else { return }
        messageLabel.stringValue = configuration.message
        actionButton.title = configuration.actionTitle
        actionButton.isEnabled = true
    }

    func showConfirmation() {
        _ = view
        guard let configuration,
              let confirmationMessage = configuration.confirmationMessage,
              let confirmationTitle = configuration.confirmationTitle else { return }
        messageLabel.stringValue = confirmationMessage
        actionButton.title = confirmationTitle
        actionButton.isEnabled = false
    }

    func showStatus(message: String, actionTitle: String, actionEnabled: Bool) {
        _ = view
        messageLabel.stringValue = message
        actionButton.title = actionTitle
        actionButton.isEnabled = actionEnabled
    }

    @objc private func didSelectAction() { configuration?.action() }
}

@main
final class MultiVibeMenuBarApp: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private static let githubRepositoryURL = URL(string: "https://github.com/thibautrey/multivibe")!
    private static let githubStarPromptAcknowledgedKey = "githubStarPromptAcknowledged"
    private static let notificationAcknowledgedIDsKey = "notificationAcknowledgedIDs"
    private static let notificationLastForecastScoreKey = "notificationLastForecastScore"
    private static let notificationLastUrgentPresentedAtKey = "notificationLastUrgentPresentedAt"
    private static let notificationLastGamificationPresentedAtKey = "notificationLastGamificationPresentedAt"
    private static let notificationConditionLastShownPrefix = "notificationConditionLastShown."
    private static let notificationUrgentSpacing: TimeInterval = 60 * 60
    private static let notificationGamificationSpacing: TimeInterval = 7 * 24 * 60 * 60
    private static let notificationConditionReminder: TimeInterval = 7 * 24 * 60 * 60
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let popover = NSPopover()
    private let popoverController = HostPopoverController()
    private let notificationPopover = NSPopover()
    private let notificationPopup = NotificationPopup()
    private var refreshTimer: Timer?
    private var signalSources: [DispatchSourceSignal] = []
    private var ownedService: Process?
    private var dashboardURL = URL(string: "http://127.0.0.1:\(configuredHostPort)")!
    private var usesFallbackPort = false
    private var pendingDashboardOpen = false
    private var operational = false
    private var statusText = "Starting…"
    private var summary: MenuBarSummary?
    private var workerConfigurationState: String?
    private var workerSetupURL: URL?
    private var refreshing = false
    private var updateStatus: HostUpdateStatus?
    private var updateBusy = false
    private var didFinishLaunching = false
    private var pendingEnrollmentToken: String?
    private var enrollmentInProgress = false
    private var githubStarPromptPresented = false
    private var notificationCloseWorkItem: DispatchWorkItem?
    private var githubStarPromptAcknowledged = UserDefaults.standard.bool(forKey: githubStarPromptAcknowledgedKey)
    private var acknowledgedNotificationIDs = Set(
        UserDefaults.standard.stringArray(forKey: notificationAcknowledgedIDsKey) ?? []
    )
    private var activeConditionNotificationIDs = Set<String>()
    private var pendingNotifications: [MenuBarNotification] = []
    private var currentNotification: MenuBarNotification?
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
            if didFinishLaunching { showEnrollmentAlert(success: false, failure: .invalidLink) }
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

    private func submitPendingEnrollment() {
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

    private func showEnrollmentAlert(success: Bool, failure: CloudEnrollmentFailure? = nil) {
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
    private func showPreviewWindow() {
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

    func applicationWillTerminate(_ notification: Notification) {
        refreshTimer?.invalidate()
        notificationCloseWorkItem?.cancel()
        if let process = ownedService, process.isRunning { process.terminate() }
    }

    private func configureStatusItem() {
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

    private func configurePopover() {
        popover.behavior = .transient
        popover.animates = true
        popover.contentSize = NSSize(width: 420, height: 570)
        popover.contentViewController = popoverController
        popover.delegate = self
        popoverController.openDashboard = { [weak self] in
            self?.popover.performClose(nil)
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
            workerNeedsSetup: workerConfigurationState == "unconfigured" && workerSetupURL != nil,
            status: statusText,
            operational: operational,
            updateStatus: updateStatus,
            updateBusy: updateBusy,
            startAtLogin: UserDefaults.standard.object(forKey: "startAtLogin") as? Bool ?? true
        )
        presentNextNotificationIfNeeded()
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
        var summaryPath = "/admin/host/menu-bar"
        if UserDefaults.standard.object(forKey: Self.notificationLastForecastScoreKey) != nil {
            let previousScore = UserDefaults.standard.double(forKey: Self.notificationLastForecastScoreKey)
            if previousScore.isFinite && previousScore >= 0 && previousScore <= 100 {
                summaryPath += "?previous_forecast_score=\(previousScore)"
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

    private func refreshLocalWorkerStatus() {
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

    private func ingestNotifications(_ summary: MenuBarSummary) {
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

    private func isValid(_ notification: MenuBarNotification) -> Bool {
        guard !notification.id.isEmpty, notification.id.count <= 160,
              !notification.message.isEmpty, notification.message.count <= 500,
              (0...100).contains(notification.priority),
              ["once", "condition", "edge"].contains(notification.repeatMode) else { return false }
        if let url = notification.actionURL, url.scheme != "https" { return false }
        if let path = notification.actionPath, path != "/admin/host/weekly-auto-reset" { return false }
        return true
    }

    private func enqueue(_ notification: MenuBarNotification) {
        guard currentNotification?.id != notification.id,
              !pendingNotifications.contains(where: { $0.id == notification.id }) else { return }
        pendingNotifications.append(notification)
        pendingNotifications.sort { left, right in
            left.priority == right.priority ? left.id < right.id : left.priority > right.priority
        }
    }

    private func acknowledge(_ id: String) {
        acknowledgedNotificationIDs.insert(id)
        UserDefaults.standard.set(
            acknowledgedNotificationIDs.sorted(),
            forKey: Self.notificationAcknowledgedIDsKey
        )
    }

    private func presentNextNotificationIfNeeded() {
        guard operational, currentNotification == nil, !popover.isShown,
              !notificationPopover.isShown, let button = statusItem.button,
              let next = pendingNotifications.first else { return }
        let urgent = next.priority >= 80
        let spacing = next.kind == "github-star"
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
        if next.kind == "github-star" { githubStarPromptPresented = true }
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: spacingKey)

        notificationPopup.configure(.init(
            message: next.message,
            actionTitle: next.actionTitle ?? "Got it",
            confirmationMessage: next.confirmationMessage,
            confirmationTitle: next.confirmationTitle,
            action: { [weak self] in self?.performNotificationAction(next) }
        ))
        notificationPopover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private func performNotificationAction(_ notification: MenuBarNotification) {
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

    private func performNotificationRequest(path: String) {
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

    private func closeNotification(after seconds: TimeInterval) {
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
