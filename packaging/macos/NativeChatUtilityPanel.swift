import SwiftUI

enum NativeChatUtilityPanel: Hashable {
    case conversation
    case browser
}

@MainActor struct NativeChatUtilityPanelView: View {
    @ObservedObject var store: NativeChatStore
    @ObservedObject var browser: ChromiumBrowser
    let showsConversation: Bool
    let inspectorSubject: String
    @Binding var selection: NativeChatUtilityPanel
    let closeConversation: () -> Void
    let closeBrowser: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if showsConversation {
                    tab(
                        title: "Conversation",
                        icon: "gearshape",
                        panel: .conversation,
                        close: closeConversation
                    )
                }
                if browser.isVisible {
                    tab(
                        title: browser.title.isEmpty ? "Navigateur" : browser.title,
                        icon: "globe",
                        panel: .browser,
                        close: closeBrowser
                    )
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(height: 70)
            .background(ChatPalette.elevated)
            Divider()
            Group {
                if selection == .browser && browser.isVisible {
                    ChromiumBrowserPanel(browser: browser, showsCloseButton: false)
                } else if showsConversation {
                    NativeHarnessInspector(
                        store: store,
                        onClose: closeConversation,
                        isEmbedded: true,
                        initialSubject: inspectorSubject
                    ).id(inspectorSubject)
                } else if browser.isVisible {
                    ChromiumBrowserPanel(browser: browser, showsCloseButton: false)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(ChatPalette.elevated)
        .frame(minWidth: 390, idealWidth: 560)
    }

    private func tab(
        title: String,
        icon: String,
        panel: NativeChatUtilityPanel,
        close: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 0) {
            Button { selection = panel } label: {
                Label(title, systemImage: icon)
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(1)
                    .padding(.leading, 12)
                    .padding(.trailing, 8)
                    .frame(height: 38)
            }
            .buttonStyle(.plain)
            Button(action: close) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 30, height: 38)
            }
            .buttonStyle(.plain)
            .help("Fermer \(title.lowercased())")
            .accessibilityLabel("Fermer \(title.lowercased())")
        }
        .foregroundStyle(selection == panel ? .primary : .secondary)
        .background(
            selection == panel ? ChatPalette.surface : Color.clear,
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(selection == panel ? ChatPalette.hairline : Color.clear, lineWidth: 0.5)
        }
        .frame(maxWidth: 230)
    }
}
