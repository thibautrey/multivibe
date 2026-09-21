import AppKit
import UniformTypeIdentifiers

/// A share prepares a draft; the extension never calls a model or reads Host credentials.
final class ShareViewController: NSViewController {
    private let message = NSTextField(wrappingLabelWithString: "Préparation du texte…")
    private let send = NSButton(title: "Ouvrir dans MultiVibe", target: nil, action: nil)
    private var sharedText: String?
    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 180))
        let cancel = NSButton(title: "Annuler", target: self, action: #selector(cancelShare))
        send.target = self; send.action = #selector(openHost); send.isEnabled = false
        let buttons = NSStackView(views: [cancel, send])
        let stack = NSStackView(views: [message, buttons])
        stack.orientation = .vertical; stack.spacing = 20; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20), stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20), stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
    }
    override func viewDidAppear() {
        super.viewDidAppear()
        Task { @MainActor in
            var texts: [String] = []
            for item in extensionContext?.inputItems as? [NSExtensionItem] ?? [] {
                for provider in item.attachments ?? [] {
                    let type = provider.hasItemConformingToTypeIdentifier(UTType.utf8PlainText.identifier)
                        ? UTType.utf8PlainText.identifier : UTType.url.identifier
                    guard provider.hasItemConformingToTypeIdentifier(type) else { continue }
                    let value: NSSecureCoding? = await withCheckedContinuation { continuation in
                        provider.loadItem(forTypeIdentifier: type, options: nil) { value, _ in continuation.resume(returning: value) }
                    }
                    if let text = value as? String { texts.append(text) }
                    else if let data = value as? Data, let text = String(data: data, encoding: .utf8) { texts.append(text) }
                    else if let url = value as? URL, ["http", "https"].contains(url.scheme) { texts.append(url.absoluteString) }
                }
            }
            let text = texts.joined(separator: "\n\n")
            guard !text.isEmpty, text.count <= 32_000 else {
                message.stringValue = "Partagez du texte ou une adresse web (32 000 caractères maximum)."; return
            }
            sharedText = text
            message.stringValue = "Ouvrir ce texte dans MultiVibe pour choisir un modèle et préparer votre question."
            send.isEnabled = true
        }
    }
    @objc private func openHost() {
        guard let sharedText else { return }
        var components = URLComponents()
        components.scheme = "multivibe"; components.host = "compose"; components.fragment = sharedText
        guard let url = components.url, NSWorkspace.shared.open(url) else {
            message.stringValue = "Impossible d’ouvrir MultiVibe Host."; return
        }
        extensionContext?.completeRequest(returningItems: nil)
    }
    @objc private func cancelShare() { extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)) }
}
