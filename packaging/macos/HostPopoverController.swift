import AppKit

final class HostPopoverController: NSViewController {
    var selectQuotaProvider: ((String?) -> Void)?
    var pinnedQuotaProvider: String?
    var openDashboard: (() -> Void)?
    var configureWorker: (() -> Void)?
    var checkForUpdates: (() -> Void)?
    var installUpdate: (() -> Void)?
    var setStartAtLogin: ((Bool) -> Void)?
    var quit: (() -> Void)?

    let headerTitle = NSTextField(labelWithString: "MultiVibe Host")
    let headerStatus = NSTextField(labelWithString: "Starting…")
    let headerVersion = NSTextField(labelWithString: "")
    let contentStack = NSStackView()
    let settingsStack = NSStackView()
    let settingsButton = NSButton(title: "Settings", target: nil, action: nil)
    var settingsExpanded = false
    var selectedProvider: String?
    var quotaProviders: [ProviderQuota] = []
    var hostOperational = false
    var providerPolicyPicker: NSPopUpButton?
    let accountSection = NSStackView()
    let primaryButton = NSButton(title: "Open Dashboard", target: nil, action: nil)
    let startAtLoginButton = NSButton(checkboxWithTitle: "Launch at login", target: nil, action: nil)

    override func loadView() {
        let background = AdaptiveLayerView(backgroundColor: MenuBarPalette.background)
        view = background

        let header = makeHeader()
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        let document = FlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = 12
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
            footer.heightAnchor.constraint(equalToConstant: 60),
            document.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor),
            contentStack.topAnchor.constraint(equalTo: document.topAnchor),
            contentStack.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            contentStack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            contentStack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
        ])
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
        hostOperational = operational
        providerPolicyPicker = nil
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

        if let providers = summary?.providers, !providers.isEmpty {
            let picker = NSPopUpButton()
            picker.addItem(withTitle: "Automatic · active provider")
            picker.controlSize = .small
            picker.font = .systemFont(ofSize: 11)
            picker.setAccessibilityLabel("Menu bar quota behavior")
            for provider in providers { picker.addItem(withTitle: "Pin \(provider.displayName)") }
            picker.selectItem(at: providers.firstIndex(where: { $0.id == pinnedQuotaProvider }).map { $0 + 1 } ?? 0)
            picker.target = self
            picker.action = #selector(didSelectQuotaProvider(_:))
            picker.itemArray.first?.representedObject = ""
            for (index, provider) in providers.enumerated() { picker.item(at: index + 1)?.representedObject = provider.id }
            providerPolicyPicker = picker
        }
        quotaProviders = summary?.providers ?? []
        if quotaProviders.isEmpty, let accounts = summary?.accounts, !accounts.isEmpty {
            quotaProviders = [ProviderQuota(id: "legacy", displayName: "Accounts", accounts: accounts, windows: [])]
        }
        accountSection.orientation = .vertical
        accountSection.alignment = .leading
        accountSection.spacing = 8
        renderAccounts(operational: operational)
        contentStack.addArrangedSubview(accountSection)
        if workerNeedsSetup {
            contentStack.addArrangedSubview(sectionLabel("Worker"))
            contentStack.addArrangedSubview(workerSetupCard())
        } else if let earnings = summary?.earnings, earnings.hasStartedEarning {
            contentStack.addArrangedSubview(sectionLabel("Earnings"))
            contentStack.addArrangedSubview(earningsCard(earnings))
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
        if let picker = providerPolicyPicker {
            settingsStack.addArrangedSubview(sectionLabel("Menu bar quota"))
            settingsStack.addArrangedSubview(picker)
        }
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

    func renderAccounts(operational: Bool) {
        for child in accountSection.arrangedSubviews {
            accountSection.removeArrangedSubview(child)
            child.removeFromSuperview()
        }
        let providers = quotaProviders.map { $0.id }
        if !providers.contains(selectedProvider ?? "") { selectedProvider = providers.first }
        if !providers.isEmpty {
            let picker = NSPopUpButton()
            picker.bezelStyle = .rounded
            picker.font = .systemFont(ofSize: 13, weight: .semibold)
            for provider in quotaProviders {
                picker.addItem(withTitle: provider.displayName)
                picker.lastItem?.representedObject = provider.id
            }
            picker.selectItem(at: providers.firstIndex(of: selectedProvider ?? "") ?? 0)
            picker.target = self
            picker.action = #selector(didSelectProvider(_:))
            picker.setAccessibilityLabel("View provider capacity")
            picker.translatesAutoresizingMaskIntoConstraints = false
            picker.widthAnchor.constraint(lessThanOrEqualToConstant: 270).isActive = true
            let heading = NSStackView(views: [sectionLabel("PROVIDER"), NSView(), picker])
            heading.orientation = .horizontal
            heading.alignment = .centerY
            heading.translatesAutoresizingMaskIntoConstraints = false
            heading.widthAnchor.constraint(lessThanOrEqualToConstant: 384).isActive = true
            accountSection.addArrangedSubview(heading)
        }
        let selected = quotaProviders.first { $0.id == selectedProvider }
        let accounts = selected?.accounts ?? []
        if accounts.isEmpty {
            accountSection.addArrangedSubview(emptyAccountsCard(operational: operational))
            return
        }
        accountSection.addArrangedSubview(sectionLabel("CAPACITY REMAINING"))
        let cells: [NSView] = (selected?.windows ?? []).map { window in
            quotaCell(title: window.label, value: window.remainingPercent, detail: accountCount(window.accountCount))
        }
        if !cells.isEmpty {
            let container = card()
            let stack = NSStackView(views: cells)
            stack.distribution = .fillEqually
            stack.spacing = 12
            stack.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 10),
                stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -10),
                stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
                stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
            ])
            accountSection.addArrangedSubview(container)
        }
        accountSection.addArrangedSubview(sectionLabel("CONNECTED ACCOUNTS · \(accounts.count)"))
        accountSection.addArrangedSubview(accountsCard(accounts))
    }

    @objc func didSelectProvider(_ sender: NSPopUpButton) {
        guard let id = sender.selectedItem?.representedObject as? String,
              quotaProviders.contains(where: { $0.id == id }) else { return }
        selectedProvider = id
        renderAccounts(operational: hostOperational)
    }

    @objc func didToggleSettings() {
        settingsExpanded.toggle()
        updateSettingsDisclosure()
    }

    func updateSettingsDisclosure() {
        settingsStack.isHidden = !settingsExpanded
        settingsButton.image = NSImage(
            systemSymbolName: settingsExpanded ? "chevron.down" : "chevron.right",
            accessibilityDescription: nil
        )
        settingsButton.setAccessibilityLabel(settingsExpanded ? "Collapse settings" : "Expand settings")
    }

    @objc func didSelectQuotaProvider(_ sender: NSPopUpButton) {
        let id = sender.selectedItem?.representedObject as? String
        selectQuotaProvider?(id?.isEmpty == false ? id : nil)
    }

    @objc func didOpenDashboard() { openDashboard?() }
    @objc func didConfigureWorker() { configureWorker?() }
    @objc func didCheckForUpdates() { checkForUpdates?() }
    @objc func didInstallUpdate() { installUpdate?() }
    @objc func didChangeStartAtLogin() { setStartAtLogin?(startAtLoginButton.state == .on) }
    @objc func didQuit() { quit?() }
}
