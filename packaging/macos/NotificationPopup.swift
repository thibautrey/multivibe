import AppKit

final class NotificationPopup: NSViewController {
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
        actionButton.isHidden = configuration.actionTitle.isEmpty
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
