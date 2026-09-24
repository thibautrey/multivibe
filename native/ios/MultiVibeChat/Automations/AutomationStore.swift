import Foundation
import Observation
import CryptoKit

enum AutomationFailure: LocalizedError {
    case invalid(String), unavailable(String)
    var errorDescription: String? { switch self { case .invalid(let s), .unavailable(let s): s } }
}
struct AutomationTrigger: Codable, Equatable, Sendable {
    var kind: String // at, interval, daily, geofence, event
    var at: Date?
    var seconds: Int?
    var hour: Int?
    var minute: Int?
    var timeZone: String?
    var latitude: Double?
    var longitude: Double?
    var radius: Double?
    var transition: String?
    var event: String?
    func validate() throws {
        switch kind {
        case "at": guard at != nil else { throw AutomationFailure.invalid("Date manquante.") }
        case "interval": guard let seconds, (900...31_536_000).contains(seconds) else { throw AutomationFailure.invalid("Intervalle : 15 minutes minimum, un an maximum.") }
        case "daily": guard let hour, (0...23).contains(hour), let minute, (0...59).contains(minute), let timeZone, TimeZone(identifier: timeZone) != nil else { throw AutomationFailure.invalid("Heure ou fuseau invalide.") }
        case "geofence": guard let latitude, latitude.isFinite, (-90...90).contains(latitude), let longitude, longitude.isFinite, (-180...180).contains(longitude), let radius, radius.isFinite, (100...100_000).contains(radius), ["enter", "exit"].contains(transition) else { throw AutomationFailure.invalid("Zone invalide (rayon minimum 100 m).") }
        case "event": guard let event, !event.isEmpty, event.count <= 120 else { throw AutomationFailure.invalid("Nom d’événement manquant.") }
        default: throw AutomationFailure.invalid("Déclencheur non pris en charge.")
        }
    }
    func next(after now: Date) -> Date? {
        switch kind {
        case "at": return at
        case "interval": return now.addingTimeInterval(Double(seconds ?? 900))
        case "daily":
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: timeZone ?? "UTC") ?? .gmt
            return calendar.nextDate(after: now, matching: DateComponents(hour: hour, minute: minute, second: 0), matchingPolicy: .nextTime, repeatedTimePolicy: .first)
        default: return nil
        }
    }
    var label: String {
        switch kind {
        case "at": return at?.formatted() ?? "Date manquante"
        case "interval": return "Toutes les \((seconds ?? 900) / 60) minutes"
        case "daily": return String(format: "Chaque jour à %02d:%02d", hour ?? 0, minute ?? 0) + " · " + (timeZone ?? "UTC")
        case "geofence": return transition == "exit" ? "Sortie de zone" : "Entrée dans une zone"
        default: return "Événement : " + (event ?? "")
        }
    }
}
struct AgentAutomation: Codable, Identifiable, Equatable, Sendable {
    var id = UUID()
    var title: String
    var prompt: String
    var trigger: AutomationTrigger
    var model: String
    var executor = "local"
    var enabled = true
    var notify = true
    var allowedDomains: [String] = []
    var nextRun: Date?
    var createdAt = Date()
    var revision = 1
    func validate() throws {
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, title.count <= 120,
              !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, prompt.count <= 4_000,
              !model.isEmpty, model.count <= 200, ["local", "cloud"].contains(executor), allowedDomains.count <= 10,
              allowedDomains.allSatisfy({ !$0.isEmpty && $0.count <= 253 && $0 == $0.lowercased() && $0.range(of: #"^[a-z0-9][a-z0-9.-]*[a-z0-9]$"#, options: .regularExpression) != nil }) else { throw AutomationFailure.invalid("Configuration d’automatisation invalide.") }
        try trigger.validate()
    }
}
struct AutomationRun: Codable, Identifiable, Equatable, Sendable {
    var id = UUID()
    var automationID: UUID
    var eventID: String
    var payload: String = ""
    var status = "queued"
    var createdAt = Date()
    var finishedAt: Date?
    var output = ""
    var revision: Int
}
enum AutomationCodec {
    static var encoder: JSONEncoder { let e = JSONEncoder(); e.dateEncodingStrategy = .millisecondsSince1970; e.outputFormatting = [.sortedKeys]; return e }
    static var decoder: JSONDecoder { let d = JSONDecoder(); d.dateDecodingStrategy = .millisecondsSince1970; return d }
    static func string<T: Encodable>(_ value: T) throws -> String { String(decoding: try encoder.encode(value), as: UTF8.self) }
}

/// One account, one serial owner, atomic durable admission before any execution.
@MainActor @Observable final class AutomationStore {
    struct Snapshot: Codable { var version = 1; var jobs: [AgentAutomation] = []; var runs: [AutomationRun] = [] }
    private(set) var state = Snapshot()
    var jobs: [AgentAutomation] { state.jobs }
    var runs: [AutomationRun] { state.runs }
    private let write: (Data) throws -> Void
    init(data: Data? = nil, write: @escaping (Data) throws -> Void) throws {
        self.write = write
        if let data { state = try AutomationCodec.decoder.decode(Snapshot.self, from: data); guard state.version == 1 else { throw AutomationFailure.invalid("Format d’automatisations incompatible.") } }
        // Never replay a possibly side-effecting interrupted run automatically.
        if state.runs.contains(where: { $0.status == "running" }) {
            try change { state in
                for i in state.runs.indices where state.runs[i].status == "running" {
                    state.runs[i].status = "interrupted"; state.runs[i].output = "Interrompu. Vérifiez les résultats avant de relancer."
                }
            }
        }
    }
    static func disk(scope: String) throws -> AutomationStore {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Automations", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let digest = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
        let url = root.appendingPathComponent(digest + ".json")
        let data = FileManager.default.fileExists(atPath: url.path) ? try Data(contentsOf: url) : nil
        return try AutomationStore(data: data) { bytes in
            try bytes.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            var value = URLResourceValues(); value.isExcludedFromBackup = true; var file = url; try file.setResourceValues(value)
        }
    }
    private func change(_ body: (inout Snapshot) throws -> Void) throws {
        var next = state; try body(&next)
        // Keep active admissions; trim terminal history, never pending work.
        let terminal = Set(next.runs.filter { !["queued", "waiting", "running"].contains($0.status) }.suffix(200).map(\.id))
        next.runs.removeAll { !["queued", "waiting", "running"].contains($0.status) && !terminal.contains($0.id) }
        try write(AutomationCodec.encoder.encode(next)); state = next
    }
    func upsert(_ proposed: AgentAutomation, now: Date = Date()) throws -> AgentAutomation {
        try proposed.validate()
        var job = proposed
        let old = jobs.first { $0.id == job.id }
        guard old != nil || jobs.count < 100 else { throw AutomationFailure.invalid("Limite de 100 automatisations.") }
        if let old { guard job.revision == old.revision else { throw AutomationFailure.invalid("Cette automatisation a changé. Rechargez-la.") }; job.revision += 1; job.createdAt = old.createdAt }
        job.nextRun = job.enabled ? job.trigger.next(after: now) : nil
        try change { state in
            state.jobs.removeAll { $0.id == job.id }; state.jobs.append(job)
            for i in state.runs.indices where state.runs[i].automationID == job.id && ["queued", "waiting"].contains(state.runs[i].status) { state.runs[i].status = "cancelled" }
        }
        return job
    }
    func remove(_ id: UUID) throws {
        try change { state in
            state.jobs.removeAll { $0.id == id }
            for i in state.runs.indices where state.runs[i].automationID == id && ["queued", "waiting"].contains(state.runs[i].status) { state.runs[i].status = "cancelled" }
        }
    }
    func mergeCloud(_ jobs: [AgentAutomation], runs: [AutomationRun]) throws {
        guard jobs.allSatisfy({ $0.executor == "cloud" }) else { throw AutomationFailure.invalid("Réponse Cloud invalide.") }
        try change { state in
            state.jobs.removeAll { $0.executor == "cloud" }; state.jobs += jobs
            let ids = Set(runs.map(\.id)); state.runs.removeAll { ids.contains($0.id) }; state.runs += runs
        }
    }
    func admit(_ id: UUID, eventID: String, payload: String = "", now: Date = Date(), manual: Bool = false) throws -> UUID? {
        guard eventID.count <= 200, payload.utf8.count <= 8_000,
              let job = jobs.first(where: { $0.id == id }), job.enabled || manual else { return nil }
        if let existing = runs.first(where: { $0.automationID == id && $0.eventID == eventID }) { return existing.id }
        // Coalesce busy/missed events. Never overlap a job with itself.
        if runs.contains(where: { $0.automationID == id && ["queued", "waiting", "running"].contains($0.status) }) { return nil }
        let run = AutomationRun(automationID: id, eventID: eventID, payload: payload, createdAt: now, revision: job.revision)
        try change { $0.runs.append(run) }; return run.id
    }
    func enqueueDue(now: Date = Date()) throws {
        // Admission and schedule advancement are one disk transaction.
        try change { state in
            for i in state.jobs.indices where state.jobs[i].enabled && state.jobs[i].executor == "local" {
                guard let due = state.jobs[i].nextRun, due <= now else { continue }
                let job = state.jobs[i]
                if !state.runs.contains(where: { $0.automationID == job.id && ["queued", "waiting", "running"].contains($0.status) }) {
                    state.runs.append(AutomationRun(automationID: job.id, eventID: "schedule:\(due.timeIntervalSince1970)", createdAt: now, revision: job.revision))
                }
                state.jobs[i].nextRun = job.trigger.kind == "at" ? nil : job.trigger.next(after: now)
            }
        }
    }
    func mark(_ id: UUID, status: String, output: String = "", now: Date = Date()) throws {
        try change { state in
            guard let i = state.runs.firstIndex(where: { $0.id == id }) else { return }
            state.runs[i].status = status; state.runs[i].output = String(output.prefix(12_000))
            if !["running", "queued", "waiting"].contains(status) { state.runs[i].finishedAt = now }
        }
    }
}
