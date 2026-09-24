import Foundation
import Observation
import CryptoKit
import Network
import UIKit

enum ModelInstallState: String, Codable, Sendable {
    case queued, downloading, paused, waiting, verifying, installed, failed
    var active: Bool { [.queued, .downloading, .waiting, .verifying].contains(self) }
}
struct ModelInstallation: Codable, Identifiable, Sendable {
    let model: DownloadableModel
    var state: ModelInstallState = .queued
    var completed: Int64 = 0
    var transfer: String = UUID().uuidString
    var retries = 0
    var failure: String?
    var id: String { model.id }
}
struct DownloadMeter: Sendable {
    var bytes: Int64 = 0
    var speed: Double = 0
    var lastTime = Date()
    mutating func update(_ bytes: Int64, now: Date = Date()) {
        let seconds = now.timeIntervalSince(lastTime)
        if seconds >= 0.5 {
            let measured = Double(max(0, bytes - self.bytes)) / seconds
            speed = speed == 0 ? measured : speed * 0.75 + measured * 0.25
            self.bytes = bytes; lastTime = now
        }
    }
    func label(total: Int64) -> String {
        let percent = min(100, max(0, Int(Double(bytes) / Double(max(1, total)) * 100)))
        guard speed > 0 else { return "\(percent) % · Estimation…" }
        let seconds = max(1, Int(Double(max(0, total - bytes)) / speed))
        return "\(percent) % · Environ " + (seconds < 60 ? "\(seconds) s restantes" : "\((seconds + 59) / 60) min restantes")
    }
}

@MainActor @Observable final class LocalModelLibrary: NSObject {
    static let shared = LocalModelLibrary()
    static let sessionIdentifier = "cloud.multivibe.chat.model-downloads.v1"
    private(set) var installations: [ModelInstallation] = []
    private(set) var meters: [String: DownloadMeter] = [:]
    private(set) var cachedModels: [DownloadableModel] = []
    private(set) var connected = true
    private(set) var cellular = false
    var storageError: String?
    var cellularRequest: DownloadableModel?
    @ObservationIgnored private var storageReady = true
    @ObservationIgnored private let root: URL
    @ObservationIgnored private let monitor = NWPathMonitor()
    @ObservationIgnored private var tasks: [String: URLSessionDownloadTask] = [:]
    @ObservationIgnored private var retryTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var completion: (() -> Void)?
    @ObservationIgnored private var reconciliationComplete = false
    @ObservationIgnored private var verificationTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        config.waitsForConnectivity = true
        config.httpMaximumConnectionsPerHost = 2
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()
    var installed: [DownloadableModel] { installations.filter { $0.state == .installed }.map(\.model) }
    var available: [DownloadableModel] {
        var seen = Set<String>()
        return (HuggingFaceCatalog.bundled + cachedModels + installations.map(\.model)).filter { seen.insert($0.id).inserted }
    }
    override convenience init() {
        self.init(root: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("LocalModels", isDirectory: true))
    }
    init(root: URL) {
        self.root = root
        super.init()
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            var folder = root; var values = URLResourceValues(); values.isExcludedFromBackup = true
            try folder.setResourceValues(values)
            if FileManager.default.fileExists(atPath: registry.path) {
                installations = try JSONDecoder().decode([ModelInstallation].self, from: Data(contentsOf: registry))
            }
            cachedModels = (try? JSONDecoder().decode([DownloadableModel].self, from: Data(contentsOf: root.appendingPathComponent("catalog.json")))) ?? []
            for i in installations.indices {
                if installations[i].state == .installed && !FileManager.default.fileExists(atPath: file(installations[i].model).path) {
                    installations[i].state = .failed; installations[i].failure = "Le fichier du modèle est absent. Téléchargez-le à nouveau."
                }
                if installations[i].state != .installed {
                    installations[i].completed = size(part(installations[i].model))
                }
            }
        } catch { storageReady = false; storageError = "Impossible de lire les modèles enregistrés : \(error.localizedDescription)" }
    }
    private var registry: URL { root.appendingPathComponent("installations.json") }
    func file(_ model: DownloadableModel) -> URL { root.appendingPathComponent(model.key + ".gguf") }
    private func part(_ model: DownloadableModel) -> URL { root.appendingPathComponent(model.key + ".partial") }
    private func resumeFile(_ model: DownloadableModel) -> URL { root.appendingPathComponent(model.key + ".resume") }
    private func size(_ url: URL) -> Int64 { ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0 }
    func installation(_ id: String) -> ModelInstallation? { installations.first { $0.id == id } }
    func model(_ id: String) -> DownloadableModel? { available.first { $0.id == id } }
    @discardableResult private func persist() -> Bool {
        guard storageReady else { storageError = "Le registre des modèles est illisible. Relancez l’app ; les fichiers sont conservés."; return false }
        do { try JSONEncoder().encode(installations).write(to: registry, options: .atomic); return true }
        catch { storageError = "Impossible d’enregistrer le téléchargement : \(error.localizedDescription)"; return false }
    }
    func cache(_ models: [DownloadableModel]) {
        var seen = Set<String>()
        cachedModels = (models + cachedModels).filter { seen.insert($0.id).inserted }.prefix(200).map { $0 }
        do { try JSONEncoder().encode(cachedModels).write(to: root.appendingPathComponent("catalog.json"), options: .atomic) }
        catch { storageError = "Impossible de conserver le catalogue hors ligne." }
    }
    func start() {
        guard !reconciliationComplete else { return }
        reconciliationComplete = true
        monitor.pathUpdateHandler = { [weak self] path in
            let connected = path.status == .satisfied, cellular = path.isExpensive
            Task { @MainActor in
                guard let self else { return }
                self.connected = connected; self.cellular = cellular
                if connected { self.pump() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "model.network"))
        session.getAllTasks { [weak self] existing in
            Task { @MainActor in
                guard let self else { return }
                for task in existing {
                    guard let download = task as? URLSessionDownloadTask, let transfer = task.taskDescription,
                          let entry = self.installations.first(where: { $0.transfer == transfer && $0.state.active }) else { task.cancel(); continue }
                    self.tasks[entry.id] = download
                }
                for entry in self.installations where entry.state.active && self.tasks[entry.id] == nil {
                    if entry.completed == entry.model.bytes { self.verify(entry.id) }
                    else { self.setState(entry.id, .queued) }
                }
                self.pump()
            }
        }
    }
    func attachBackgroundCompletion(_ handler: @escaping () -> Void) { completion = handler; start() }
    func requestDownload(_ model: DownloadableModel) {
        if cellular && model.bytes > 200_000_000 && UserDefaults.standard.string(forKey: "localModelCellular") == nil {
            cellularRequest = model; return
        }
        download(model)
    }
    func cellularChoice(allow: Bool) {
        UserDefaults.standard.set(allow ? "allow" : "wifi", forKey: "localModelCellular")
        if let model = cellularRequest { cellularRequest = nil; download(model) }
    }
    func resetCellularChoice() { UserDefaults.standard.removeObject(forKey: "localModelCellular") }
    private func download(_ model: DownloadableModel) {
        guard storageReady else { _ = persist(); return }
        if let entry = installation(model.id), entry.state == .installed || entry.state.active { return }
        if let problem = LocalDeviceBudget.current.problem(model, downloading: true) { storageError = problem; return }
        if let i = installations.firstIndex(where: { $0.id == model.id }) {
            installations[i].state = .queued; installations[i].failure = nil; installations[i].retries = 0
        } else { installations.append(ModelInstallation(model: model)) }
        guard persist() else { return }; start(); pump()
    }
    func pause(_ id: String) {
        guard let i = installations.firstIndex(where: { $0.id == id }), installations[i].state != .verifying else { return }
        retryTasks[id]?.cancel(); retryTasks[id] = nil
        installations[i].state = .paused
        let entry = installations[i]; _ = persist()
        if let task = tasks.removeValue(forKey: id) {
            task.cancel { [weak self] data in
                Task { @MainActor in
                    guard let self, self.installation(id)?.transfer == entry.transfer, let data else { return }
                    do { try data.write(to: self.resumeFile(entry.model), options: .atomic) }
                    catch { self.storageError = "La reprise utilisera le dernier segment enregistré." }
                }
            }
        }
        pump()
    }
    func resume(_ id: String) { guard let model = installation(id)?.model else { return }; requestDownload(model) }
    func delete(_ id: String) async throws {
        guard let entry = installation(id) else { return }
        // Invalidate callbacks before cancellation; an old transfer cannot resurrect this installation.
        installations.removeAll { $0.id == id }; guard persist() else { installations.append(entry); return }
        retryTasks.removeValue(forKey: id)?.cancel(); verificationTasks.removeValue(forKey: id)?.cancel()
        tasks.removeValue(forKey: id)?.cancel()
        await DownloadedModelRuntime.shared.unload(modelID: id)
        do {
            for url in [file(entry.model), part(entry.model), resumeFile(entry.model)] where FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            meters[id] = nil
        } catch {
            var failed = entry; failed.state = .failed; failed.failure = "Suppression impossible. Réessayez."
            installations.append(failed); _ = persist(); throw error
        }
        pump()
    }
    private func setState(_ id: String, _ state: ModelInstallState, error: String? = nil) {
        guard let i = installations.firstIndex(where: { $0.id == id }) else { return }
        installations[i].state = state; installations[i].failure = error; _ = persist()
    }
    private func pump() {
        guard reconciliationComplete, tasks.isEmpty, storageError == nil else { return }
        guard connected else { return }
        for entry in installations where [.queued, .waiting, .downloading].contains(entry.state) && retryTasks[entry.id] == nil {
            if cellular && UserDefaults.standard.string(forKey: "localModelCellular") != "allow" && entry.model.bytes > 200_000_000 {
                setState(entry.id, .waiting); continue
            }
            begin(entry); return
        }
    }
    private func begin(_ entry: ModelInstallation) {
        guard let i = installations.firstIndex(where: { $0.id == entry.id }) else { return }
        if entry.completed >= entry.model.bytes { verify(entry.id); return }
        let transfer = UUID().uuidString
        installations[i].transfer = transfer; installations[i].state = .downloading
        guard persist() else { return }
        let task: URLSessionDownloadTask
        if let resume = try? Data(contentsOf: resumeFile(entry.model)) {
            task = session.downloadTask(withResumeData: resume)
            try? FileManager.default.removeItem(at: resumeFile(entry.model))
        } else {
            var request = URLRequest(url: entry.model.url)
            let end = min(entry.model.bytes - 1, entry.completed + 32 * 1024 * 1024 - 1)
            request.setValue("bytes=\(entry.completed)-\(end)", forHTTPHeaderField: "Range")
            request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
            request.allowsCellularAccess = UserDefaults.standard.string(forKey: "localModelCellular") == "allow" || entry.model.bytes <= 200_000_000
            task = session.downloadTask(with: request)
        }
        task.taskDescription = transfer; tasks[entry.id] = task
        meters[entry.id] = DownloadMeter(bytes: entry.completed)
        task.resume()
    }
    private func received(transfer: String, location: URL, response: HTTPURLResponse?) {
        defer { try? FileManager.default.removeItem(at: location) }
        guard let i = installations.firstIndex(where: { $0.transfer == transfer }), installations[i].state == .downloading else { return }
        let entry = installations[i]; tasks[entry.id] = nil
        do {
            let received = size(location)
            guard let response else { throw URLError(.badServerResponse) }
            let full = try DownloadSegment.validate(status: response.statusCode,
                range: response.value(forHTTPHeaderField: "Content-Range"), offset: entry.completed,
                received: received, total: entry.model.bytes)
            if full || entry.completed == 0 {
                if FileManager.default.fileExists(atPath: part(entry.model).path) { try FileManager.default.removeItem(at: part(entry.model)) }
                try FileManager.default.moveItem(at: location, to: part(entry.model))
            } else {
                let output = try FileHandle(forWritingTo: part(entry.model)); defer { try? output.close() }
                // Discard an uncommitted tail left by a crash during a previous append.
                try output.truncate(atOffset: UInt64(entry.completed)); try output.seekToEnd()
                let input = try FileHandle(forReadingFrom: location); defer { try? input.close() }
                while let data = try input.read(upToCount: 1_048_576), !data.isEmpty { try output.write(contentsOf: data) }
                try output.synchronize()
            }
            installations[i].completed = full ? entry.model.bytes : entry.completed + received
            installations[i].retries = 0
            guard persist() else { return }
            if installations[i].completed == entry.model.bytes { verify(entry.id) }
            else { setState(entry.id, .queued); pump() }
        } catch { failed(transfer: transfer, error: error as NSError) }
    }
    private func failed(transfer: String, error: NSError) {
        guard let i = installations.firstIndex(where: { $0.transfer == transfer }), installations[i].state == .downloading else { return }
        let entry = installations[i]; tasks[entry.id] = nil
        if let resume = error.userInfo[NSURLSessionDownloadTaskResumeData] as? Data { try? resume.write(to: resumeFile(entry.model), options: .atomic) }
        installations[i].retries += 1
        if installations[i].retries <= 3 {
            setState(entry.id, .waiting)
            let delay = 2 << installations[i].retries
            retryTasks[entry.id] = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                guard let self, self.installation(entry.id)?.transfer == transfer else { return }
                self.retryTasks[entry.id] = nil; self.pump()
            }
        } else { setState(entry.id, .failed, error: "Téléchargement interrompu. Reprenez à partir de la progression enregistrée.") }
        pump()
    }
    private func verify(_ id: String) {
        guard verificationTasks[id] == nil, let entry = installation(id) else { return }
        setState(id, .verifying)
        let destination = file(entry.model)
        let source = FileManager.default.fileExists(atPath: part(entry.model).path) ? part(entry.model) : destination
        verificationTasks[id] = Task { [weak self] in
            do {
                let valid = try await Task.detached(priority: .utility) {
                    let handle = try FileHandle(forReadingFrom: source); defer { try? handle.close() }
                    var hash = SHA256(); var bytes: Int64 = 0
                    while let data = try handle.read(upToCount: 1_048_576), !data.isEmpty {
                        try Task.checkCancellation(); hash.update(data: data); bytes += Int64(data.count)
                    }
                    return bytes == entry.model.bytes && hash.finalize().map { String(format: "%02x", $0) }.joined() == entry.model.sha256.lowercased()
                }.value
                try Task.checkCancellation()
                guard let self, self.installation(id)?.transfer == entry.transfer else { return }
                guard valid else { throw URLError(.cannotDecodeContentData) }
                if source != destination {
                    if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
                    try FileManager.default.moveItem(at: source, to: destination)
                }
                self.setState(id, .installed)
            } catch {
                guard let self, self.installation(id)?.transfer == entry.transfer else { return }
                if error is CancellationError { return }
                try? FileManager.default.removeItem(at: source)
                if let i = self.installations.firstIndex(where: { $0.id == id }) { self.installations[i].completed = 0 }
                self.setState(id, .failed, error: "Le fichier n’a pas pu être vérifié. Téléchargez-le à nouveau.")
            }
            self?.verificationTasks[id] = nil; self?.pump()
        }
    }
}

extension LocalModelLibrary: URLSessionDownloadDelegate {
    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                                didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let transfer = downloadTask.taskDescription else { return }
        Task { @MainActor in
            guard let entry = self.installations.first(where: { $0.transfer == transfer }) else { return }
            var meter = self.meters[entry.id] ?? DownloadMeter(bytes: entry.completed)
            meter.update(min(entry.model.bytes, entry.completed + totalBytesWritten)); self.meters[entry.id] = meter
        }
    }
    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let transfer = downloadTask.taskDescription else { return }
        let retained = FileManager.default.temporaryDirectory.appendingPathComponent("model-transfer-" + UUID().uuidString)
        do {
            try FileManager.default.moveItem(at: location, to: retained)
            let response = downloadTask.response as? HTTPURLResponse
            Task { @MainActor in self.received(transfer: transfer, location: retained, response: response) }
        } catch { let failure = error as NSError; Task { @MainActor in self.failed(transfer: transfer, error: failure) } }
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error = error as NSError?, let transfer = task.taskDescription else { return }
        Task { @MainActor in self.failed(transfer: transfer, error: error) }
    }
    nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        Task { @MainActor in self.completion?(); self.completion = nil }
    }
}

final class ModelDownloadAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard identifier == LocalModelLibrary.sessionIdentifier else { completionHandler(); return }
        LocalModelLibrary.shared.attachBackgroundCompletion(completionHandler)
    }
}

/// A resumed response must match the immutable artifact and exact append offset.
enum DownloadSegment {
    static func validate(status: Int, range: String?, offset: Int64, received: Int64, total: Int64) throws -> Bool {
        guard offset >= 0, received > 0, total > 0, offset <= total, received <= total else { throw URLError(.badServerResponse) }
        if status == 200 && received == total { return true }
        guard status == 206, received <= total - offset,
              range == "bytes \(offset)-\(offset + received - 1)/\(total)" else { throw URLError(.badServerResponse) }
        return false
    }
}
