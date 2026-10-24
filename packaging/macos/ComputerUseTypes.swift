import AppKit
import Foundation

struct ComputerUseFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct ComputerUseCommand: Codable {
    let action: String
    var target: String?
    var observation: String?
    var element: Int?
    var text: String?
    var key: String?
    var url: String?
    var x: Double?
    var y: Double?
    var toX: Double?
    var toY: Double?
    var amount: Int?
    var direction: String?

    static let actions: Set<String> = ["list_apps", "observe", "navigate", "click", "double_click", "type", "key", "scroll", "drag", "back"]
    var changesState: Bool { !["list_apps", "observe"].contains(action) }
    func validate() throws {
        guard Self.actions.contains(action), (text?.utf8.count ?? 0) <= 16_000,
              (target?.count ?? 0) <= 256, (observation?.count ?? 0) <= 64 else { throw ComputerUseFailure("Commande d’interface invalide.") }
        if action == "navigate" { _ = try ComputerUsePolicy.origin(url ?? "") }
        if action == "type", text == nil { throw ComputerUseFailure("Le texte à saisir est manquant.") }
        if action == "key", !ComputerUsePolicy.keys.contains(key ?? "") { throw ComputerUseFailure("Touche non autorisée. Utilisez return, tab, escape, backspace, delete, arrows, home, end, pageup, pagedown, select_all, copy, paste, undo ou redo.") }
        if action == "scroll" {
            guard ["up", "down", "left", "right"].contains(direction ?? ""), (1...2000).contains(amount ?? 500) else { throw ComputerUseFailure("Défilement invalide.") }
        }
        for value in [x, y, toX, toY].compactMap({ $0 }) {
            guard value.isFinite, value >= 0, value <= 20_000 else { throw ComputerUseFailure("Coordonnées invalides.") }
        }
        if ["click", "double_click"].contains(action), element == nil && (x == nil || y == nil) { throw ComputerUseFailure("Indiquez un élément observé ou des coordonnées.") }
        if action == "drag", x == nil || y == nil || toX == nil || toY == nil { throw ComputerUseFailure("Le glisser-déposer nécessite deux points.") }
    }
    var summary: String {
        switch action {
        case "type": return "Saisir : \(String((text ?? "").prefix(240)))"
        case "navigate": return "Ouvrir \(url ?? "")"
        case "key": return "Touche : \(key ?? "")"
        case "click", "double_click": return "\(action == "click" ? "Cliquer" : "Double-cliquer") sur \(element.map { "l’élément \($0)" } ?? "(\(x ?? 0), \(y ?? 0))")"
        case "scroll": return "Défiler \(direction ?? "") · \(amount ?? 500) px"
        case "drag": return "Glisser de (\(x ?? 0), \(y ?? 0)) vers (\(toX ?? 0), \(toY ?? 0))"
        case "back": return "Page précédente"
        default: return "Observer"
        }
    }
}

enum ComputerUsePolicy {
    static let keys: Set<String> = ["return", "tab", "escape", "backspace", "delete", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "select_all", "copy", "paste", "undo", "redo"]
    static func origin(_ string: String) throws -> String {
        guard string.utf8.count <= 8192, let url = URL(string: string),
              let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = url.host?.lowercased(), !host.isEmpty, url.user == nil, url.password == nil else {
            throw ComputerUseFailure("Seules les URL HTTP(S) sans identifiants sont autorisées.")
        }
        return "\(scheme)://\(host)\(url.port.map { ":\($0)" } ?? "")"
    }
    static func allowedApp(_ bundle: String, ownBundle: String? = Bundle.main.bundleIdentifier) -> Bool {
        let id = bundle.lowercased()
        let denied = ["terminal", "iterm", "warp", "alacritty", "kitty", "ghostty", "wezterm", "password", "keychain", "securityagent", "systempreferences", "systemsettings", "loginwindow", "codex", "chatgpt", "multivibe"]
        return !id.isEmpty && bundle != ownBundle && !denied.contains { id.contains($0) }
    }
}

struct ComputerUseApp: Identifiable {
    let id: String
    let name: String
    let pid: pid_t
}
struct ComputerUseObservation {
    let id: String
    let target: String
    let text: String
    let image: NSImage?
    let imageURL: String?
}
struct ComputerUseEvent: Codable, Identifiable {
    var id = UUID()
    var date = Date()
    let action: String
    let target: String
    let detail: String
    let succeeded: Bool
}
struct ComputerUseApproval: Identifiable {
    let id = UUID()
    let title: String
    let detail: String
    let canRemember: Bool
}

@MainActor protocol ComputerUseDriving: AnyObject {
    func apps() -> [ComputerUseApp]
    func observe(target: String) async throws -> ComputerUseObservation
    func perform(_ command: ComputerUseCommand, target: String) async throws
    func reset()
}

func computerUseImage(_ image: NSImage) -> (NSImage, String)? {
    guard image.size.width > 0, image.size.height > 0 else { return nil }
    let ratio = min(1, 1440 / max(image.size.width, image.size.height))
    let size = NSSize(width: image.size.width * ratio, height: image.size.height * ratio)
    let resized = NSImage(size: size)
    resized.lockFocus(); image.draw(in: NSRect(origin: .zero, size: size)); resized.unlockFocus()
    guard let tiff = resized.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
          let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.65]), data.count <= 3_000_000 else { return nil }
    return (resized, "data:image/jpeg;base64," + data.base64EncodedString())
}
