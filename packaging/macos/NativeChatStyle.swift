import AppKit
import SwiftUI

enum ChatPalette {
    static let accent = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0.45, green: 0.89, blue: 0.69, alpha: 1)
            : NSColor(srgbRed: 0.06, green: 0.42, blue: 0.29, alpha: 1)
    })
    static let surface = Color(nsColor: .controlBackgroundColor)
    static let canvas = Color(nsColor: .textBackgroundColor)
    static let elevated = Color(nsColor: .windowBackgroundColor)
    static let hairline = Color(nsColor: .separatorColor).opacity(0.5)
    static let subtle = Color.primary.opacity(0.035)
    static func motion(_ reduce: Bool) -> Animation? { reduce ? nil : .easeInOut(duration: 0.18) }
}

/// Hover and press feedback share the same rhythm across the chat and inspector.
struct ChatActionStyle: ButtonStyle {
    var selected = false
    var prominent = false
    func makeBody(configuration: Configuration) -> some View {
        Surface(configuration: configuration, selected: selected, prominent: prominent)
    }
    private struct Surface: View {
        let configuration: ButtonStyle.Configuration
        let selected: Bool
        let prominent: Bool
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @Environment(\.isEnabled) private var enabled
        @State private var hovered = false
        var body: some View {
            Group {
                if prominent { configuration.label.foregroundStyle(Color(nsColor: .textBackgroundColor)) }
                else { configuration.label }
            }
                .background {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(prominent ? ChatPalette.accent : selected ? ChatPalette.accent.opacity(0.12) : Color.primary.opacity(hovered ? 0.055 : 0))
                }
                .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
                .scaleEffect(reduceMotion || !configuration.isPressed ? 1 : 0.98)
                .contentShape(RoundedRectangle(cornerRadius: 9))
                .onHover { hovered = $0 }
                .animation(ChatPalette.motion(reduceMotion), value: hovered)
                .animation(ChatPalette.motion(reduceMotion), value: configuration.isPressed)
        }
    }
}

struct ChatIconButton: View {
    let title: String
    let icon: String
    var action: () -> Void
    var body: some View {
        Button(action: action) { Image(systemName: icon).font(.system(size: 13, weight: .medium)).frame(width: 30, height: 30) }
            .buttonStyle(ChatActionStyle()).foregroundStyle(.secondary)
            .help(title).accessibilityLabel(title)
    }
}

struct ChatSection<Content: View>: View {
    let title: String
    let icon: String
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(title, systemImage: icon).font(.system(size: 13, weight: .semibold))
            content
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
        .background(ChatPalette.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(ChatPalette.hairline, lineWidth: 0.5))
    }
}

struct HarnessLogo: View {
    @Environment(\.colorScheme) private var colorScheme
    let id: String
    let name: String
    var size: CGFloat
    private var resource: (String, String)? {
        switch id {
        case "native": return ("multivibe", "png")
        case "claude-code": return ("claude-code", "svg")
        case "openai-codex": return ("openai-codex", "svg")
        case "opencode": return ("opencode", "svg")
        case "openclaw": return ("openclaw", "png")
        case "hermes-agent": return (colorScheme == .dark ? "hermes-dark" : "hermes-light", "png")
        case "pi": return ("pi", "svg")
        case "goose": return ("goose", "svg")
        case "openhands": return ("openhands", "svg")
        default: return nil
        }
    }
    private var usesTemplateRendering: Bool {
        ["claude-code", "openai-codex", "opencode"].contains(id)
    }
    var body: some View {
        Group {
            if let resource, let url = Bundle.main.url(forResource: resource.0, withExtension: resource.1, subdirectory: "harnesses"), let image = NSImage(contentsOf: url) {
                Image(nsImage: image).renderingMode(usesTemplateRendering ? .template : .original)
                    .resizable().aspectRatio(contentMode: .fit).foregroundStyle(.primary)
            } else if id == "native" {
                Image(systemName: "waveform.path").resizable().scaledToFit().padding(size * 0.17).foregroundStyle(ChatPalette.accent)
            } else {
                Text(name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased())
                    .font(.system(size: size * 0.32, weight: .semibold, design: .rounded)).foregroundStyle(.secondary)
            }
        }.frame(width: size, height: size).accessibilityHidden(true)
    }
}

/// Observe user scrolling without treating a growing streaming response as a scroll away.
struct ChatScrollPositionReader: NSViewRepresentable {
    let changed: (Bool) -> Void
    func makeNSView(context: Context) -> Reader { Reader(changed: changed) }
    func updateNSView(_ view: Reader, context: Context) { view.changed = changed }
    final class Reader: NSView {
        var changed: (Bool) -> Void
        private weak var scroll: NSScrollView?
        private var observer: NSObjectProtocol?
        private var height: CGFloat = 0
        init(changed: @escaping (Bool) -> Void) { self.changed = changed; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let observer { NotificationCenter.default.removeObserver(observer); self.observer = nil }
            guard window != nil else { return }
            DispatchQueue.main.async { [weak self] in self?.attach() }
        }
        private func attach() {
            guard let scroll = enclosingScrollView else { return }
            self.scroll = scroll
            height = scroll.documentView?.frame.height ?? 0
            scroll.contentView.postsBoundsChangedNotifications = true
            observer = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { [weak self] _ in
                guard let self, let scroll = self.scroll else { return }
                let nextHeight = scroll.documentView?.frame.height ?? 0
                let contentGrew = abs(nextHeight - self.height) > 1
                self.height = nextHeight
                guard !contentGrew else { return }
                let atBottom = nextHeight - scroll.contentView.bounds.maxY < 60
                DispatchQueue.main.async { [weak self] in self?.changed(atBottom) }
            }
        }
        deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
    }
}
