import AppKit
import Combine
import CryptoKit
import Foundation
import Security
import SwiftUI

struct NativeAppearanceSettings: Codable, Equatable {
    var cameraEnabled = false
    var faces: [String: [[Float]]] = [:]
}

@MainActor struct NativeAppearanceStorage {
    var load: () throws -> NativeAppearanceSettings
    var save: (NativeAppearanceSettings) throws -> Void

    static var keychain: Self {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "cloud.multivibe.desktop.appearance.v1", kSecAttrAccount as String: "multivibe-macos"]
        return Self(load: {
            var request = query; request[kSecReturnData as String] = true
            var result: CFTypeRef?
            let status = SecItemCopyMatching(request as CFDictionary, &result)
            if status == errSecItemNotFound { return .init() }
            guard status == errSecSuccess, let data = result as? Data else { throw NativeCloudSessionError.storage(status) }
            return try JSONDecoder().decode(NativeAppearanceSettings.self, from: data)
        }, save: { settings in
            let data = try JSONEncoder().encode(settings)
            let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            if status == errSecItemNotFound {
                var request = query; request[kSecValueData as String] = data
                request[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
                let added = SecItemAdd(request as CFDictionary, nil)
                guard added == errSecSuccess else { throw NativeCloudSessionError.storage(added) }
            } else if status != errSecSuccess { throw NativeCloudSessionError.storage(status) }
        })
    }
}

/// The continuous clock includes sleep. An input arriving after expiry cannot renew the old identity.
struct NativeIdentityActivity {
    static let timeout: TimeInterval = 600
    private(set) var lastInteraction: TimeInterval?
    mutating func unlocked(at time: TimeInterval) { lastInteraction = time }
    mutating func clear() { lastInteraction = nil }
    func expired(at time: TimeInterval) -> Bool {
        guard let lastInteraction else { return false }
        return time - lastInteraction >= Self.timeout
    }
    mutating func interact(at time: TimeInterval) -> Bool {
        guard lastInteraction != nil, !expired(at: time) else { return false }
        lastInteraction = time
        return true
    }
}

@MainActor final class NativeDesktopIdentity: ObservableObject {
    @Published var showsPicker = false
    @Published var pendingAccountID: String?
    @Published var error: String?
    @Published private(set) var working = false
    @Published private(set) var scanning = false
    @Published private(set) var appearance = NativeAppearanceSettings()
    @Published private(set) var configuringAppearance = false
    let agent: NativeChatAgentCoordinator
    let camera: NativeFaceRecognition
    private let storage: NativeAppearanceStorage
    private let now: () -> TimeInterval
    private var activity = NativeIdentityActivity()
    private var subscriptions: Set<AnyCancellable> = []
    private var recognition: Task<Void, Never>?
    private var epoch = UUID()
    private var operation = UUID()
    private var foreground = false
    private var storageAvailable = true
    private weak var window: NSWindow?
    private var lastAccountID: String?
    private(set) var isIsolated: Bool

    init(agent: NativeChatAgentCoordinator, camera: NativeFaceRecognition? = nil,
         storage: NativeAppearanceStorage? = nil, now: (() -> TimeInterval)? = nil) {
        self.agent = agent
        self.camera = camera ?? NativeFaceRecognition()
        // Test/preview sessions never access a user's biometric Trousseau entry.
        isIsolated = agent.cloudSession?.usesIsolatedStorage ?? true
        self.storage = storage ?? (isIsolated ? .init(load: { .init() }, save: { _ in }) : .keychain)
        let origin = ContinuousClock.now
        self.now = now ?? {
            let elapsed = origin.duration(to: .now).components
            return Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
        }
        do {
            let value = try self.storage.load()
            guard value.faces.count <= 100, value.faces.values.allSatisfy({ samples in
                (5...10).contains(samples.count) && samples.allSatisfy { $0.count == 128 && $0.allSatisfy(\.isFinite) }
            }) else { throw NativeCloudSessionError.invalidResponse }
            appearance = value
        } catch {
            storageAvailable = false
            self.error = "Les réglages caméra ne peuvent pas être lus. Ils ont été préservés."
        }
        agent.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &subscriptions)
        if let session = agent.cloudSession {
            session.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &subscriptions)
            session.$accountID.receive(on: RunLoop.main).sink { [weak self] id in self?.accountChanged(id) }.store(in: &subscriptions)
        }
    }

    var session: NativeCloudSession? { agent.cloudSession }
    var profiles: [NativeCloudProfile] { session?.profiles ?? [] }
    var requiresSelection: Bool { session?.needsIdentity == true }
    var activeProfile: NativeCloudProfile? { profiles.first { $0.id == session?.accountID } }
    var asksEveryTime: Bool { session?.asksEveryTime == true }
    var cameraEnabled: Bool { appearance.cameraEnabled }
    var displayName: String { activeProfile?.displayName ?? (requiresSelection ? "Choisir un compte" : "Sur ce Mac") }
    var enrolled: Bool { activeProfile.map { appearance.faces[$0.id] != nil } ?? false }

    private func accountChanged(_ id: String?) {
        guard id != lastAccountID else { return }
        lastAccountID = id
        if id != nil { activity.unlocked(at: now()) }
        else { activity.clear() }
        if requiresSelection { showsPicker = true }
    }
    func attach(window: NSWindow) {
        self.window = window
        if session?.accountID != nil, activity.lastInteraction == nil { activity.unlocked(at: now()) }
        if requiresSelection { showsPicker = true }
        if NSApp.isActive && window.isVisible { becameActive() }
    }
    func becameActive() {
        guard !foreground, window?.isVisible == true else { return }
        foreground = true
        tick()
        guard !working, session?.isSigningIn != true else { return }
        if cameraEnabled && !configuringAppearance && !appearance.faces.isEmpty { recognizeForeground() }
        else if requiresSelection { showsPicker = true }
    }
    func becameInactive() {
        foreground = false
        cancelRecognition()
        camera.cancel()
    }
    func interaction() {
        guard !requiresSelection, session?.accountID != nil else { return }
        if asksEveryTime && activity.expired(at: now()) { lock(); return }
        if !activity.interact(at: now()) { activity.unlocked(at: now()) }
    }
    func tick() {
        if asksEveryTime && activity.expired(at: now()) { lock() }
    }
    func lock() {
        cancelRecognition()
        operation = UUID(); working = false
        camera.cancel()
        agent.lockAccount()
        activity.clear(); pendingAccountID = nil; showsPicker = true
    }
    func openPicker() { cancelRecognition(); error = nil; pendingAccountID = nil; showsPicker = true }
    func choose(_ profile: NativeCloudProfile) {
        cancelRecognition(); error = nil
        if profile.id == session?.accountID, !requiresSelection { showsPicker = false; return }
        if profile.hasPIN { agent.lockAccount(); activity.clear(); pendingAccountID = profile.id }
        else { Task { await unlock(profile.id) } }
    }
    func unlock(_ id: String, pin: String? = nil) async {
        guard !working else { return }
        cancelRecognition()
        operation = UUID(); let expected = operation
        working = true; error = nil
        defer { if operation == expected { working = false } }
        do {
            try await agent.selectAccount(id, pin: pin)
            guard expected == operation else { return }
            activity.unlocked(at: now()); pendingAccountID = nil; showsPicker = false
        } catch { if expected == operation { self.error = error.localizedDescription } }
    }
    func addAccount() async {
        guard !working, let window else { return }
        cancelRecognition()
        operation = UUID(); let expected = operation
        working = true; error = nil; pendingAccountID = nil
        await agent.connect(window: window)
        guard operation == expected else { return }
        working = false
        if let error = agent.error { self.error = error }
        else if requiresSelection { pendingAccountID = session?.selectedAccountID }
        else { activity.unlocked(at: now()); showsPicker = false }
    }
    func setAsksEveryTime(_ value: Bool) {
        do {
            try session?.setAsksEveryTime(value)
            if session?.accountID != nil { activity.unlocked(at: now()) }
        } catch { self.error = error.localizedDescription }
    }
    func rename(_ name: String) {
        guard let id = session?.accountID else { return }
        do { try session?.renameAccount(id, name: name) }
        catch { self.error = error.localizedDescription }
    }
    func savePIN(_ pin: String?, current: String?) async -> Bool {
        guard let id = session?.accountID, !working else { return false }
        working = true; error = nil
        defer { working = false }
        do { try await session?.setPIN(pin, for: id, currentPIN: current); return true }
        catch { self.error = error.localizedDescription; return false }
    }
    func forgetActiveAccount() async {
        guard let id = session?.accountID, !working else { return }
        cancelRecognition()
        do {
            // Remove biometric data before deleting the session; preserve both if the secure write fails.
            var next = appearance; next.faces.removeValue(forKey: id)
            if next.faces.isEmpty { next.cameraEnabled = false }
            try persist(next)
            try await agent.removeAccount(id)
            pendingAccountID = nil
        } catch { self.error = error.localizedDescription }
    }
    func setCameraEnabled(_ value: Bool) {
        do {
            var next = appearance; next.cameraEnabled = value && !next.faces.isEmpty
            try persist(next)
            if !value { cancelRecognition(); camera.cancel() }
        } catch { self.error = error.localizedDescription }
    }
    func beginAppearanceSetup() { cancelRecognition(); error = nil; configuringAppearance = true }
    func endAppearanceSetup() { configuringAppearance = false; camera.cancel() }
    func saveAppearance(_ samples: [[Float]], accountID: String) throws {
        guard session?.accountID == accountID, profiles.contains(where: { $0.id == accountID }),
              samples.count == 5, samples.allSatisfy({ $0.count == 128 && $0.allSatisfy(\.isFinite) }) else {
            throw NativeCloudSessionError.disconnected
        }
        var next = appearance; next.faces[accountID] = samples; next.cameraEnabled = true
        try persist(next)
    }
    func deleteAppearance() {
        guard let id = session?.accountID else { return }
        do {
            var next = appearance; next.faces.removeValue(forKey: id)
            if next.faces.isEmpty { next.cameraEnabled = false }
            try persist(next); cancelRecognition(); camera.cancel()
        } catch { self.error = error.localizedDescription }
    }
    private func persist(_ value: NativeAppearanceSettings) throws {
        guard storageAvailable else { throw NativeCloudSessionError.invalidResponse }
        try storage.save(value); appearance = value
    }
    private func cancelRecognition() {
        epoch = UUID(); recognition?.cancel(); recognition = nil; scanning = false
        camera.cancel()
    }
    private func recognizeForeground() {
        cancelRecognition()
        // Hide the outgoing account before a single frame can identify another person.
        agent.lockAccount(); activity.clear(); pendingAccountID = nil; showsPicker = true; scanning = true
        let expected = epoch
        let allowed = Set(profiles.map(\.id))
        let faces = appearance.faces.filter { allowed.contains($0.key) }
        recognition = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { if epoch == expected { scanning = false; recognition = nil } }
            do {
                let id = try await camera.identify(enrollments: faces)
                guard epoch == expected, foreground, !Task.isCancelled else { return }
                guard let id, let profile = profiles.first(where: { $0.id == id }) else {
                    error = "Je ne vous ai pas reconnu avec certitude. Choisissez votre compte."
                    return
                }
                scanning = false
                if profile.hasPIN { pendingAccountID = id }
                else { recognition = nil; await unlock(id) }
            } catch {
                if epoch == expected && !Task.isCancelled { self.error = error.localizedDescription }
            }
        }
    }
}

/// Only interactions in this window (or its account sheet) renew the ten-minute timer.
struct NativeIdentityWindowActivity: NSViewRepresentable {
    let identity: NativeDesktopIdentity
    func makeNSView(context: Context) -> ActivityView { let view = ActivityView(); view.identity = identity; return view }
    func updateNSView(_ view: ActivityView, context: Context) { view.identity = identity }
    @MainActor final class ActivityView: NSView {
        weak var identity: NativeDesktopIdentity?
        private var monitor: Any?
        private var observers: [NSObjectProtocol] = []
        private var timer: Timer?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow(); cleanup()
            guard let window else { identity?.becameInactive(); return }
            identity?.attach(window: window)
            let center = NotificationCenter.default
            for name in [NSApplication.didBecomeActiveNotification, NSWindow.didBecomeMainNotification, NSWindow.didDeminiaturizeNotification] {
                observers.append(center.addObserver(forName: name, object: name == NSApplication.didBecomeActiveNotification ? nil : window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.identity?.becameActive() }
                })
            }
            for name in [NSApplication.didResignActiveNotification, NSWindow.willCloseNotification, NSWindow.didMiniaturizeNotification] {
                observers.append(center.addObserver(forName: name, object: name == NSApplication.didResignActiveNotification ? nil : window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.identity?.becameInactive() }
                })
            }
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel, .mouseMoved, .leftMouseDragged, .rightMouseDragged]) { [weak self, weak window] event in
                guard let window else { return event }
                var owner = event.window
                while let candidate = owner, candidate !== window { owner = candidate.sheetParent }
                guard owner === window else { return event }
                self?.identity?.interaction(); return event
            }
            let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.identity?.tick() } }
            self.timer = timer; RunLoop.main.add(timer, forMode: .common)
        }
        private func cleanup() {
            if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers = []; timer?.invalidate(); timer = nil
        }
        deinit {
            if let monitor { NSEvent.removeMonitor(monitor) }
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            timer?.invalidate()
        }
    }
}
