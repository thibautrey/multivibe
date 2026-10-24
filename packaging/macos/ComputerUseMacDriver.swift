import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit
import CoreImage

/// App-scoped AX operations and PID-directed input. No shell, AppleScript or clipboard writes.
@MainActor final class ComputerUseMacDriver: ComputerUseDriving {
    static let eventMarker: Int64 = 0x4D564355
    private var nodes: [Int: AXUIElement] = [:]
    private var observationID: String?
    private var observedTarget: String?
    private var observedWindow: AXUIElement?
    private var windowID: CGWindowID?
    private var observedPID: pid_t?
    private var frame = CGRect.zero
    private var imageSize = CGSize.zero
    private var observedAt = Date.distantPast
    func reset() { nodes = [:]; observationID = nil; observedTarget = nil; observedPID = nil; observedWindow = nil; windowID = nil }
    func apps() -> [ComputerUseApp] {
        NSWorkspace.shared.runningApplications.compactMap { app in
            guard app.activationPolicy == .regular, let id = app.bundleIdentifier,
                  ComputerUsePolicy.allowedApp(id), app.isFinishedLaunching, !app.isTerminated else { return nil }
            return ComputerUseApp(id: id, name: app.localizedName ?? id, pid: app.processIdentifier)
        }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    private func application(_ target: String) throws -> NSRunningApplication {
        guard ComputerUsePolicy.allowedApp(target),
              let app = NSRunningApplication.runningApplications(withBundleIdentifier: target).first,
              app.activationPolicy == .regular, !app.isTerminated else { throw ComputerUseFailure("Application indisponible ou protégée. Ouvrez l’application cible manuellement.") }
        guard AXIsProcessTrusted() else { throw ComputerUseFailure("Autorisez MultiVibe dans Réglages système → Confidentialité et sécurité → Accessibilité.") }
        return app
    }
    private func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
        return value
    }
    private func string(_ element: AXUIElement, _ key: String) -> String { attribute(element, key) as? String ?? "" }
    private func secure(_ element: AXUIElement) -> Bool {
        string(element, kAXSubroleAttribute) == kAXSecureTextFieldSubrole || string(element, kAXRoleAttribute) == "AXSecureTextField"
    }
    func observe(target: String) async throws -> ComputerUseObservation {
        reset()
        try Task.checkCancellation()
        let app = try application(target)
        guard CGPreflightScreenCaptureAccess() else { throw ComputerUseFailure("Autorisez l’enregistrement de l’écran pour MultiVibe dans les réglages macOS. Seule la fenêtre cible sera capturée.") }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.15)
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              let window = windows.first(where: { ($0[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier) && ($0[kCGWindowLayer as String] as? Int) == 0 && ($0[kCGWindowBounds as String] as? [String: Any]) != nil }),
              let bounds = window[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width > 1, rect.height > 1,
              let number = window[kCGWindowNumber as String] as? UInt32 else {
            throw ComputerUseFailure("Aucune fenêtre visible capturable. Affichez la fenêtre cible sur un bureau déverrouillé.")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        try Task.checkCancellation()
        guard let captureWindow = content.windows.first(where: { $0.windowID == number && $0.owningApplication?.processID == app.processIdentifier }) else { throw ComputerUseFailure("La fenêtre cible a disparu.") }
        let filter = SCContentFilter(desktopIndependentWindow: captureWindow)
        let configuration = SCStreamConfiguration()
        let ratio = min(2, 1440 / max(rect.width, rect.height))
        configuration.width = max(1, Int(rect.width * ratio)); configuration.height = max(1, Int(rect.height * ratio))
        configuration.showsCursor = false; configuration.capturesAudio = false
        let capture: CGImage
        if #available(macOS 14.0, *) { capture = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) }
        else { capture = try await ComputerUseSingleFrame().capture(filter: filter, configuration: configuration) }
        try Task.checkCancellation()
        guard let (preview, url) = computerUseImage(NSImage(cgImage: capture, size: rect.size)) else { throw ComputerUseFailure("Capture de la fenêtre impossible.") }
        frame = rect; imageSize = preview.size; observedAt = Date(); observedPID = app.processIdentifier
        let id = UUID().uuidString; observationID = id; observedTarget = target
        var lines: [String] = []
        // Read the visible window and menus, never unrelated application windows.
        let candidates = (attribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? [])
        let selected = candidates.first { element in
            guard let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID() else { return false }
            var point = CGPoint.zero
            AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point)
            return abs(point.x - rect.minX) < 3 && abs(point.y - rect.minY) < 3
        }
        observedWindow = selected; windowID = number
        let deadline = Date().addingTimeInterval(1.2)
        func visit(_ element: AXUIElement, depth: Int) {
            guard depth < 14, nodes.count < 220, Date() < deadline else { return }
            let role = string(element, kAXRoleAttribute)
            if secure(element) { lines.append("[champ sécurisé masqué]"); return }
            let index = nodes.count + 1; nodes[index] = element
            let parts = [string(element, kAXTitleAttribute), string(element, kAXDescriptionAttribute), string(element, kAXValueAttribute)]
                .filter { !$0.isEmpty }.map { String($0.prefix(300)) }
            var actions: CFArray?
            AXUIElementCopyActionNames(element, &actions)
            let available = (actions as? [String] ?? []).joined(separator: ",")
            lines.append("[\(index)] \(role) \(parts.joined(separator: " | ")) actions=\(available)")
            for child in attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] { visit(child, depth: depth + 1) }
        }
        if let selected { visit(selected, depth: 0) }
        if let menu = attribute(root, kAXMenuBarAttribute), CFGetTypeID(menu) == AXUIElementGetTypeID() { visit(unsafeBitCast(menu, to: AXUIElement.self), depth: 0) }
        return .init(id: id, target: target, text: "Application: \(app.localizedName ?? target)\nObservation: \(id)\nImage: \(Int(imageSize.width)) × \(Int(imageSize.height)); coordonnées relatives à cette image.\n\(lines.joined(separator: "\n"))", image: preview, imageURL: url)
    }
    private func point(_ x: Double?, _ y: Double?) throws -> CGPoint {
        guard let x, let y, imageSize.width > 0, imageSize.height > 0,
              x < imageSize.width, y < imageSize.height else { throw ComputerUseFailure("Point hors de la fenêtre observée.") }
        return CGPoint(x: frame.minX + x * frame.width / imageSize.width, y: frame.minY + y * frame.height / imageSize.height)
    }
    private func post(_ event: CGEvent?, pid: pid_t) throws {
        try Task.checkCancellation()
        guard let event else { throw ComputerUseFailure("Impossible de créer l’événement d’entrée.") }
        event.setIntegerValueField(.eventSourceUserData, value: Self.eventMarker)
        event.postToPid(pid)
    }
    func perform(_ command: ComputerUseCommand, target: String) async throws {
        try command.validate()
        let app = try application(target), pid = app.processIdentifier
        guard observedTarget == target, observationID == command.observation, command.observation != nil,
              observedPID == pid, Date().timeIntervalSince(observedAt) < 120 else { throw ComputerUseFailure("Observation périmée. Observez de nouveau la fenêtre avant d’agir.") }
        guard let windowID,
              let windows = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]],
              let current = windows.first, let bounds = current[kCGWindowBounds as String] as? [String: Any],
              let currentFrame = CGRect(dictionaryRepresentation: bounds as CFDictionary), currentFrame == frame else { throw ComputerUseFailure("La fenêtre a bougé ou changé de taille. Observez de nouveau.") }
        // Invalidate before dispatch: a failed or interrupted action must not be replayed against stale nodes.
        observationID = nil
        let source = CGEventSource(stateID: .privateState)
        if command.action == "click", let index = command.element {
            guard let element = nodes[index], !secure(element) else { throw ComputerUseFailure("Élément inaccessible ou sécurisé.") }
            guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else { throw ComputerUseFailure("Cet élément ne permet pas AXPress. Observez et utilisez un clic visuel si nécessaire.") }
        } else if ["click", "double_click", "drag"].contains(command.action) {
            let start = try point(command.x, command.y)
            var hit: AXUIElement?
            guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(start.x), Float(start.y), &hit) == .success, let hit else { throw ComputerUseFailure("La fenêtre cible doit être visible au point demandé.") }
            var owner: pid_t = 0; AXUIElementGetPid(hit, &owner)
            guard owner == pid, !secure(hit) else { throw ComputerUseFailure("Le point est masqué par une autre application ou un champ sécurisé.") }
            let end = command.action == "drag" ? try point(command.toX, command.toY) : start
            let count = command.action == "double_click" ? 2 : 1
            for click in 1...count {
                try post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left).map { $0.setIntegerValueField(.mouseEventClickState, value: Int64(click)); return $0 }, pid: pid)
                // Always release, including cancellation mid-drag.
                defer {
                    let release = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left)
                    release?.setIntegerValueField(.eventSourceUserData, value: Self.eventMarker); release?.setIntegerValueField(.mouseEventClickState, value: Int64(click)); release?.postToPid(pid)
                }
                if command.action == "drag" {
                    for step in 1...12 {
                        let fraction = Double(step) / 12
                        try post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: CGPoint(x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction), mouseButton: .left), pid: pid)
                        try await Task.sleep(nanoseconds: 15_000_000)
                    }
                }
            }
        } else if ["type", "key"].contains(command.action) {
            let root = AXUIElementCreateApplication(pid)
            if let index = command.element {
                guard let element = nodes[index], !secure(element), AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else { throw ComputerUseFailure("Impossible de donner le focus à cet élément.") }
            }
            if let observedWindow, let focusedWindow = attribute(root, kAXFocusedWindowAttribute) {
                guard CFEqual(observedWindow, focusedWindow) else { throw ComputerUseFailure("La fenêtre active de l’application a changé. Observez de nouveau.") }
            }
            guard let focused = attribute(root, kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID(),
                  !secure(unsafeBitCast(focused, to: AXUIElement.self)) else { throw ComputerUseFailure("Aucun champ actif accessible ; les champs sécurisés nécessitent votre intervention.") }
            if command.action == "type" {
                let units = Array((command.text ?? "").utf16)
                var offset = 0
                while offset < units.count {
                    var end = min(offset + 20, units.count)
                    if end < units.count, (0xD800...0xDBFF).contains(units[end - 1]) { end -= 1 }
                    let part = Array(units[offset..<end]); offset = end
                    let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
                    let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
                    part.withUnsafeBufferPointer {
                        down?.keyboardSetUnicodeString(stringLength: part.count, unicodeString: $0.baseAddress)
                        up?.keyboardSetUnicodeString(stringLength: part.count, unicodeString: $0.baseAddress)
                    }
                    try post(down, pid: pid)
                    up?.setIntegerValueField(.eventSourceUserData, value: Self.eventMarker); up?.postToPid(pid)
                    try await Task.sleep(nanoseconds: 5_000_000)
                }
            } else {
                let codes: [String: CGKeyCode] = ["return":36,"tab":48,"escape":53,"backspace":51,"delete":117,"up":126,"down":125,"left":123,"right":124,"home":115,"end":119,"pageup":116,"pagedown":121,"select_all":0,"copy":8,"paste":9,"undo":6,"redo":6]
                guard let key = command.key, let code = codes[key] else { throw ComputerUseFailure("Touche invalide.") }
                let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
                let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
                if ["select_all", "copy", "paste", "undo", "redo"].contains(key) {
                    let flags: CGEventFlags = key == "redo" ? [.maskCommand, .maskShift] : .maskCommand
                    down?.flags = flags; up?.flags = flags
                }
                try post(down, pid: pid)
                up?.setIntegerValueField(.eventSourceUserData, value: Self.eventMarker); up?.postToPid(pid)
            }
        } else if command.action == "scroll" {
            let direction = command.direction ?? "down", amount = Int32(command.amount ?? 500)
            let vertical: Int32 = direction == "up" ? amount : direction == "down" ? -amount : 0
            let horizontal: Int32 = direction == "left" ? amount : direction == "right" ? -amount : 0
            let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: vertical, wheel2: horizontal, wheel3: 0)
            event?.location = CGPoint(x: frame.midX, y: frame.midY)
            try post(event, pid: pid)
        } else { throw ComputerUseFailure("Action réservée au navigateur intégré.") }
        try await Task.sleep(nanoseconds: 250_000_000)
    }
}

/// macOS 13 uses a one-frame ScreenCaptureKit stream; newer systems use SCScreenshotManager.
private final class ComputerUseSingleFrame: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<CGImage, Error>?
    private var stream: SCStream?
    private var finished = false
    func capture(filter: SCContentFilter, configuration: SCStreamConfiguration) async throws -> CGImage {
        try Task.checkCancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.lock()
                if finished { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
                self.continuation = continuation; lock.unlock()
                do {
                    let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
                    self.stream = stream
                    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "MultiVibe.ComputerUse.Frame"))
                    stream.startCapture { [weak self] error in if let error { self?.finish(.failure(error)) } }
                    DispatchQueue.global().asyncAfter(deadline: .now() + 8) { [weak self] in self?.finish(.failure(ComputerUseFailure("Délai de capture dépassé."))) }
                } catch { finish(.failure(error)) }
            }
        } onCancel: { self.finish(.failure(CancellationError())) }
    }
    private func finish(_ result: Result<CGImage, Error>) {
        lock.lock(); guard !finished else { lock.unlock(); return }; finished = true
        let pending = continuation; continuation = nil; lock.unlock()
        stream?.stopCapture { _ in }; pending?.resume(with: result)
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { finish(.failure(error)) }
    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferIsValid(buffer), let pixel = CMSampleBufferGetImageBuffer(buffer),
              let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue else { return }
        let image = CIImage(cvPixelBuffer: pixel)
        guard let cg = CIContext().createCGImage(image, from: image.extent) else { return }
        finish(.success(cg))
    }
}
