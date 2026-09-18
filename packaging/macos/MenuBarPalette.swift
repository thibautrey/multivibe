import AppKit

enum MenuBarPalette {
    private static func color(_ hex: UInt32) -> NSColor {
        NSColor(
            calibratedRed: CGFloat((hex >> 16) & 0xff) / 255,
            green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255,
            alpha: 1
        )
    }

    private static func adaptive(light: NSColor, dark: NSColor) -> NSColor {
        NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
        }
    }

    static let background = adaptive(light: color(0xf3f5f6), dark: color(0x171b1e))
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
