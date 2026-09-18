import AppKit

final class QuotaBarView: NSView {
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

final class AdaptiveLayerView: NSView {
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

final class AdaptiveLayerTextField: NSTextField {
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

final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}
