import AppKit

enum MenuBarSpacing {
    static let xSmall: CGFloat = 4
    static let small: CGFloat = 8
    static let medium: CGFloat = 12
    static let large: CGFloat = 16
    static let xLarge: CGFloat = 20
    static let xxLarge: CGFloat = 24
}

enum MenuBarLayoutMetrics {
    static let width: CGFloat = 420
    static let height: CGFloat = 620
    static let headerHeight: CGFloat = 76
    static let footerHeight: CGFloat = 64
    static let contentInset = MenuBarSpacing.large
    static let contentWidth = width - contentInset * 2
    static let cardCornerRadius: CGFloat = 14
}
