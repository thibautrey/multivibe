import AppKit
import AVFoundation
import Combine
import CoreImage
import Foundation
import WebKit

enum NativeFaceRecognitionError: LocalizedError {
    case cancelled, permission, unavailable, timeout, busy, quality(String)
    var errorDescription: String? {
        switch self {
        case .cancelled: "Reconnaissance annulée."
        case .permission: "Autorisez la caméra dans les Réglages Système pour mémoriser votre visage."
        case .unavailable: "La reconnaissance est indisponible. Choisissez votre compte."
        case .timeout: "Visage non reconnu. Choisissez votre compte ou réessayez."
        case .busy: "Une reconnaissance est déjà en cours."
        case .quality(let message): message
        }
    }
}

/// face-api.js descriptors use Euclidean distance (not cosine similarity or a probability).
/// A match selects an account; the account controller still enforces its PIN.
enum NativeFaceDescriptorMatching {
    static let dimensions = 128
    static let maximumDistance: Float = 0.48
    static let minimumMargin: Float = 0.10
    static func valid(_ values: [Float]) -> Bool {
        values.count == dimensions && values.allSatisfy { $0.isFinite && abs($0) < 10 }
            && values.contains { abs($0) > 0.0001 }
    }
    static func distance(_ first: [Float], _ second: [Float]) -> Float {
        guard valid(first), valid(second) else { return .infinity }
        return sqrt(zip(first, second).reduce(Float(0)) { $0 + ($1.0 - $1.1) * ($1.0 - $1.1) })
    }
    static func account(for descriptor: [Float], enrollments: [String: [[Float]]]) -> String? {
        guard valid(descriptor), !enrollments.isEmpty else { return nil }
        var ranked: [(String, Float)] = []
        for (id, samples) in enrollments {
            guard !id.isEmpty, !samples.isEmpty, samples.count <= 20, samples.allSatisfy(valid) else { continue }
            let distances = samples.map { distance(descriptor, $0) }.sorted()
            let best = Array(distances.prefix(2))
            ranked.append((id, best.reduce(0, +) / Float(best.count)))
        }
        ranked.sort { $0.1 < $1.1 }
        guard let first = ranked.first, first.1 < maximumDistance else { return nil }
        guard ranked.count < 2 || ranked[1].1 - first.1 >= minimumMargin else { return nil }
        return first.0
    }
}

struct NativeFaceIdentityVotes {
    private var candidate: String?
    private var count = 0
    private var last = -Double.infinity
    mutating func observe(_ account: String?, at time: TimeInterval) -> String? {
        guard let account else { candidate = nil; count = 0; last = -.infinity; return nil }
        if account != candidate || time - last > 2 { candidate = account; count = 0; last = -.infinity }
        guard time - last >= 0.3 else { return nil }
        count += 1; last = time
        return count >= 3 ? account : nil
    }
}

struct NativeFaceObservation {
    var descriptor: [Float]?
    var issue: String?
    var faces: Int
}

/// A single transient camera owner. Frames are produced only for a pending consumer.
/// AVFoundation configuration and start/stop run on a dedicated serial queue.
private final class NativeFaceCamera: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let queue = DispatchQueue(label: "cloud.multivibe.face-camera", qos: .userInitiated)
    private let lock = NSLock()
    private var cancelled = false
    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var consumer: CheckedContinuation<Data, Error>?
    private func isCancelled() -> Bool { lock.lock(); defer { lock.unlock() }; return cancelled }

    func start() async throws {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    guard !self.isCancelled(), let device = AVCaptureDevice.default(for: .video) else { throw NativeFaceRecognitionError.cancelled }
                    let input = try AVCaptureDeviceInput(device: device)
                    self.session.beginConfiguration()
                    self.session.sessionPreset = .vga640x480
                    guard self.session.canAddInput(input), self.session.canAddOutput(self.output) else {
                        self.session.commitConfiguration(); throw NativeFaceRecognitionError.unavailable
                    }
                    self.session.addInput(input)
                    self.output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
                    self.output.alwaysDiscardsLateVideoFrames = true
                    self.output.setSampleBufferDelegate(self, queue: self.queue)
                    self.session.addOutput(self.output); self.session.commitConfiguration()
                    guard !self.isCancelled() else { throw NativeFaceRecognitionError.cancelled }
                    self.session.startRunning()
                    guard !self.isCancelled(), self.session.isRunning else {
                        self.release(); throw NativeFaceRecognitionError.cancelled
                    }
                    continuation.resume()
                } catch { self.release(); continuation.resume(throwing: error) }
            }
        }
    }
    func nextFrame() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                guard !self.isCancelled(), self.session.isRunning else { continuation.resume(throwing: NativeFaceRecognitionError.cancelled); return }
                guard self.consumer == nil else { continuation.resume(throwing: NativeFaceRecognitionError.busy); return }
                self.consumer = continuation
            }
        }
    }
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard !isCancelled(), let pending = consumer, let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        consumer = nil
        let image = CIImage(cvPixelBuffer: buffer)
        guard let cgImage = context.createCGImage(image, from: image.extent),
              let data = NSBitmapImageRep(cgImage: cgImage).representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else {
            pending.resume(throwing: NativeFaceRecognitionError.unavailable); return
        }
        guard !isCancelled() else { pending.resume(throwing: NativeFaceRecognitionError.cancelled); return }
        pending.resume(returning: data)
    }
    func stop() {
        lock.lock(); cancelled = true; lock.unlock()
        queue.async { self.release() }
    }
    func stopAndWait() async {
        stop()
        await withCheckedContinuation { continuation in queue.async { continuation.resume() } }
    }
    private func release() {
        output.setSampleBufferDelegate(nil, queue: nil)
        if session.isRunning { session.stopRunning() }
        session.beginConfiguration()
        for input in session.inputs { session.removeInput(input) }
        for output in session.outputs { session.removeOutput(output) }
        session.commitConfiguration()
        consumer?.resume(throwing: NativeFaceRecognitionError.cancelled); consumer = nil
        context.clearCaches()
    }
}

/// Serves a closed allowlist from the signed app bundle, without file:// read access or a local HTTP server.
private final class NativeFaceAssetHandler: NSObject, WKURLSchemeHandler {
    static let names: Set<String> = ["index.html", "engine.js", "face-api.min.js",
        "models/tiny_face_detector_model-weights_manifest.json", "models/tiny_face_detector_model-shard1",
        "models/face_landmark_68_tiny_model-weights_manifest.json", "models/face_landmark_68_tiny_model-shard1",
        "models/face_recognition_model-weights_manifest.json", "models/face_recognition_model-shard1", "models/face_recognition_model-shard2"]
    let directory: URL
    init(directory: URL) { self.directory = directory.resolvingSymlinksInPath(); super.init() }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, url.scheme == "multivibe-face", url.host == "bundle",
              url.query == nil, url.fragment == nil else {
            urlSchemeTask.didFailWithError(NativeFaceRecognitionError.unavailable); return
        }
        let name = String(url.path.dropFirst())
        let file = directory.appendingPathComponent(name).resolvingSymlinksInPath()
        guard Self.names.contains(name), file.path.hasPrefix(directory.path + "/"),
              let data = try? Data(contentsOf: file), data.count <= 8_000_000 else {
            urlSchemeTask.didFailWithError(NativeFaceRecognitionError.unavailable); return
        }
        let mime = name.hasSuffix(".html") ? "text/html" : name.hasSuffix(".js") ? "application/javascript" : name.hasSuffix(".json") ? "application/json" : "application/octet-stream"
        urlSchemeTask.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: mime == "application/octet-stream" ? nil : "utf-8"))
        urlSchemeTask.didReceive(data); urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

@MainActor private final class NativeFaceScriptBridge: NSObject, WKScriptMessageHandler {
    weak var owner: NativeFaceWebEngine?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) { owner?.receive(message) }
}

/// No camera API is exposed to this WebView. Only transient, native-captured JPEGs enter it.
@MainActor final class NativeFaceWebEngine: NSObject, WKNavigationDelegate {
    private let webView: WKWebView
    private var ready = false
    private var load: CheckedContinuation<Void, Error>?
    private var pending: (String, CheckedContinuation<NativeFaceObservation, Error>)?
    private var timer: Task<Void, Never>?
    private var pageLoaded = false
    init(resources: URL) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.setURLSchemeHandler(NativeFaceAssetHandler(directory: resources), forURLScheme: "multivibe-face")
        let bridge = NativeFaceScriptBridge()
        configuration.userContentController.add(bridge, name: "multivibeFace")
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 640, height: 480), configuration: configuration)
        super.init()
        bridge.owner = self; webView.navigationDelegate = self
    }
    func prepare() async throws {
        if ready { return }
        guard load == nil else { throw NativeFaceRecognitionError.busy }
        try await withCheckedThrowingContinuation { continuation in
            load = continuation
            armTimeout(seconds: 25)
            webView.load(URLRequest(url: URL(string: "multivibe-face://bundle/index.html")!))
        }
    }
    func analyze(_ image: Data) async throws -> NativeFaceObservation {
        guard ready, pending == nil, image.count <= 1_400_000 else { throw NativeFaceRecognitionError.unavailable }
        return try await withCheckedThrowingContinuation { continuation in
            let id = UUID().uuidString
            pending = (id, continuation); armTimeout(seconds: 5)
            // UUID and base64 have no JavaScript string delimiters.
            let script = "void window.multivibeFace.analyze('\(id)', 'data:image/jpeg;base64,\(image.base64EncodedString())')"
            webView.evaluateJavaScript(script) { [weak self] _, error in
                guard error != nil else { return }
                Task { @MainActor in self?.cancel(NativeFaceRecognitionError.unavailable) }
            }
        }
    }
    func clearImage() { webView.evaluateJavaScript("window.multivibeFace?.clear()", completionHandler: nil) }
    func cancel(_ error: Error = NativeFaceRecognitionError.cancelled) {
        timer?.cancel(); timer = nil
        let loading = load; load = nil
        let sampling = pending; pending = nil
        ready = false; webView.stopLoading(); clearImage()
        loading?.resume(throwing: error); sampling?.1.resume(throwing: error)
    }
    fileprivate func receive(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.scheme == "multivibe-face",
              message.frameInfo.request.url?.host == "bundle", let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if type == "ready" {
            timer?.cancel(); timer = nil; ready = true
            let continuation = load; load = nil; continuation?.resume()
        } else if type == "failed" { cancel(NativeFaceRecognitionError.unavailable) }
        else if type == "sample", let id = body["id"] as? String, pending?.0 == id, let current = pending {
            pending = nil; timer?.cancel(); timer = nil
            if body["failed"] as? Bool == true { current.1.resume(throwing: NativeFaceRecognitionError.unavailable); return }
            let values = (body["descriptor"] as? [NSNumber])?.map(\.floatValue)
            let descriptor = values.flatMap { NativeFaceDescriptorMatching.valid($0) ? $0 : nil }
            current.1.resume(returning: .init(descriptor: descriptor, issue: body["issue"] as? String, faces: body["faces"] as? Int ?? 0))
        }
    }
    private func armTimeout(seconds: Double) {
        timer?.cancel()
        timer = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
            catch { return }
            self?.cancel(NativeFaceRecognitionError.timeout)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let allowed = !pageLoaded && url?.absoluteString == "multivibe-face://bundle/index.html" && navigationAction.targetFrame?.isMainFrame == true
        if allowed { pageLoaded = true }
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { cancel(NativeFaceRecognitionError.unavailable) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { cancel(NativeFaceRecognitionError.unavailable) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { cancel(NativeFaceRecognitionError.unavailable) }
}

@MainActor final class NativeFaceRecognition: ObservableObject {
    @Published private(set) var preview: NSImage?
    @Published private(set) var message = "La caméra reste éteinte jusqu’à votre choix."
    @Published private(set) var isRunning = false
    private let resources: URL?
    private var generation = UUID()
    private var camera: NativeFaceCamera?
    private var engine: NativeFaceWebEngine?
    private var observers: [NSObjectProtocol] = []
    private var timedOut = false

    init(resources: URL? = nil) {
        self.resources = resources ?? Bundle.main.resourceURL?.appendingPathComponent("FaceRecognition", isDirectory: true)
        for name in [NSApplication.didResignActiveNotification, NSWindow.willCloseNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.cancel() }
            })
        }
    }
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

    func captureSample() async throws -> [Float] {
        let result = try await perform(enrollments: nil, requestPermission: true)
        guard let descriptor = result.descriptor else { throw NativeFaceRecognitionError.timeout }
        return descriptor
    }
    func identify(enrollments: [String: [[Float]]]) async throws -> String? {
        // Foreground identification never opens a permission dialog.
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized, !enrollments.isEmpty else { return nil }
        do { return try await perform(enrollments: enrollments, requestPermission: false).account }
        catch NativeFaceRecognitionError.timeout { return nil }
    }
    func cancel() {
        generation = UUID(); camera?.stop(); camera = nil
        engine?.cancel(); engine = nil
        preview = nil; isRunning = false; message = "Reconnaissance annulée."
    }
    private func perform(enrollments: [String: [[Float]]]?, requestPermission: Bool) async throws -> (descriptor: [Float]?, account: String?) {
        guard !isRunning else { throw NativeFaceRecognitionError.busy }
        generation = UUID(); let current = generation
        isRunning = true; timedOut = false; preview = nil
        var source: NativeFaceCamera?
        var watchdog: Task<Void, Never>?
        defer {
            watchdog?.cancel(); source?.stop()
            if generation == current { camera = nil; preview = nil; isRunning = false; engine?.clearImage() }
        }
        do {
            if requestPermission && AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
                message = "Autorisez la caméra pour mémoriser votre visage."
                let granted = await AVCaptureDevice.requestAccess(for: .video)
                try check(current)
                guard granted else { throw NativeFaceRecognitionError.permission }
            }
            try check(current)
            guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { throw NativeFaceRecognitionError.permission }
            guard let resources else { throw NativeFaceRecognitionError.unavailable }
            message = "Préparation de la reconnaissance sur cet ordinateur…"
            if engine == nil { engine = NativeFaceWebEngine(resources: resources) }
            guard let activeEngine = engine else { throw NativeFaceRecognitionError.unavailable }
            try await activeEngine.prepare(); try check(current)
            // Loading weights is finished before requesting any camera hardware.
            let activeCamera = NativeFaceCamera(); source = activeCamera; camera = activeCamera
            watchdog = Task { [weak self, weak activeEngine] in
                do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
                guard let self, self.generation == current else { return }
                self.timedOut = true; activeCamera.stop(); activeEngine?.cancel(NativeFaceRecognitionError.timeout)
            }
            message = "Regardez la caméra, visage bien éclairé."
            try await activeCamera.start(); try check(current)
            var votes = NativeFaceIdentityVotes()
            let deadline = ProcessInfo.processInfo.systemUptime + 5
            var lastIssue: String?
            while ProcessInfo.processInfo.systemUptime < deadline {
                try check(current)
                let jpeg = try await activeCamera.nextFrame(); try check(current)
                preview = NSImage(data: jpeg)
                let observation = try await activeEngine.analyze(jpeg); try check(current)
                lastIssue = observation.issue
                message = observation.issue ?? "Vérification du visage…"
                if let descriptor = observation.descriptor {
                    if let enrollments {
                        let candidate = NativeFaceDescriptorMatching.account(for: descriptor, enrollments: enrollments)
                        if let account = votes.observe(candidate, at: ProcessInfo.processInfo.systemUptime) {
                            await activeCamera.stopAndWait(); try check(current)
                            message = "Compte reconnu."
                            return (nil, account)
                        }
                    } else {
                        await activeCamera.stopAndWait(); try check(current)
                        message = "Vue du visage mémorisée."
                        return (descriptor, nil)
                    }
                } else { _ = votes.observe(nil, at: ProcessInfo.processInfo.systemUptime) }
                try await Task.sleep(nanoseconds: 300_000_000)
            }
            await activeCamera.stopAndWait()
            if enrollments == nil, let lastIssue { throw NativeFaceRecognitionError.quality(lastIssue) }
            throw NativeFaceRecognitionError.timeout
        } catch {
            if let source { await source.stopAndWait() }
            if generation == current {
                engine?.cancel(); engine = nil
                let actual: Error = timedOut ? NativeFaceRecognitionError.timeout : error
                message = actual.localizedDescription
                throw actual
            }
            throw NativeFaceRecognitionError.cancelled
        }
    }
    private func check(_ expected: UUID) throws {
        guard generation == expected, !Task.isCancelled else { throw NativeFaceRecognitionError.cancelled }
        if timedOut { throw NativeFaceRecognitionError.timeout }
    }
}
