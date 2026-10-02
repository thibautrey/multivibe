import SwiftUI

/// Reusable entry point for applications that present MultiVibe sign-in.
/// Authentication still belongs to `MultiVibeAuthenticationPresenter`; this
/// view never receives credentials or conversation keys.
@MainActor public struct MultiVibeConnectButton: View {
    private let isBusy: Bool
    private let action: @MainActor () -> Void

    public init(isBusy: Bool = false, action: @escaping @MainActor () -> Void) {
        self.isBusy = isBusy
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isBusy { ProgressView().controlSize(.small) }
                Text(isBusy ? "Complete sign-in in the browser…" : "Connect MultiVibe")
                    .fontWeight(.semibold)
            }
        }
        .buttonStyle(.borderedProminent)
        .tint(Color(red: 0.24, green: 0.64, blue: 0.45))
        .disabled(isBusy)
        .accessibilityLabel(isBusy ? "MultiVibe sign-in in progress" : "Connect MultiVibe")
    }
}
