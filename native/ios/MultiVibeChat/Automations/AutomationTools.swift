import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

enum AutomationTools {
    static func requested(_ messages: [ChatMessage]) -> Bool {
        let text = messages.last(where: { $0.role == "user" })?.content.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current) ?? ""
        return text.range(of: #"automati|programm|planifi|chaque|tous les|toutes les|demain|rappel|recurr|schedule|every|trigger|quand j|lorsque j"#, options: .regularExpression) != nil
    }
    static let actions = ["capabilities", "list", "get", "create", "update", "pause", "resume", "delete", "run"]
    static var schema: [String: Any] {
        let strings = ["id", "title", "prompt", "kind", "at", "timeZone", "transition", "event", "executor", "model", "domains"]
        var properties = Dictionary(uniqueKeysWithValues: strings.map { ($0, ["type": "string"] as [String: Any]) })
        properties["action"] = ["type": "string", "enum": actions]
        properties["kind"] = ["type": "string", "enum": ["at", "interval", "daily", "geofence", "event"]]
        properties["executor"] = ["type": "string", "enum": ["local", "cloud"]]
        properties["at"] = ["type": "string", "description": "ISO 8601 date with timezone, e.g. 2026-10-01T09:00:00+02:00"]
        properties["domains"] = ["type": "string", "description": "Comma-separated public HTTPS hosts explicitly authorized for future local reads. Empty by default."]
        for field in ["seconds", "hour", "minute"] { properties[field] = ["type": "integer"] }
        for field in ["latitude", "longitude", "radius"] { properties[field] = ["type": "number"] }
        return ["type": "function", "function": ["name": "automation_manage", "description": "Manage requested automations. list before modifying an ID. create requires title, self-contained prompt and kind. at=date; interval=seconds(min900); daily=hour,minute,timeZone; geofence=latitude,longitude,radius,transition(enter/exit); event=event name for Shortcuts. Local timing is best effort; Cloud requires sign-in, a remote model and explicit user choice. Never promise exact local execution. Do not expose another app's notifications. Check returned readiness.", "parameters": ["type": "object", "properties": properties, "required": ["action"], "additionalProperties": false]]]
    }
    @MainActor static func execute(_ json: String, model: String, scope: String) async throws -> String {
        guard json.utf8.count <= 16_000, let data = json.data(using: .utf8), let a = try JSONSerialization.jsonObject(with: data) as? [String: Any], let action = a["action"] as? String, actions.contains(action) else { throw LocalAgentError.invalidInput }
        let c = AutomationCoordinator.shared
        guard c.scope == scope, let store = c.store else { throw AutomationFailure.unavailable("Ouvrez le compte associé à cette conversation.") }
        if action == "capabilities" {
            return #"{"triggers":["at","interval","daily","geofence","event"],"localTiming":"best_effort","minIntervalSeconds":900,"maxGeofences":20,"externalEvents":"App Intents/Shortcuts or authenticated Cloud API, not arbitrary app notifications","localTools":"date, arithmetic, explicitly allowed HTTPS domains","cloudRequires":"signed-in account, deployed Cloud service, explicit remote model","backgroundDownloadedModels":"deferred until foreground"}"#
        }
        if action == "list" {
            if scope != "guest" { try? await c.syncCloud() }
            return try AutomationCodec.string(store.state)
        }
        let id = (a["id"] as? String).flatMap(UUID.init(uuidString:))
        var job: AgentAutomation
        if action == "create" {
            guard let title = a["title"] as? String, let prompt = a["prompt"] as? String, let kind = a["kind"] as? String else { throw AutomationFailure.invalid("Titre, consigne et déclencheur requis.") }
            job = AgentAutomation(title: title, prompt: prompt, trigger: AutomationTrigger(kind: kind), model: model)
        } else {
            guard let id, let existing = store.jobs.first(where: { $0.id == id }) else { throw AutomationFailure.invalid("Automatisation introuvable. Utilisez list.") }; job = existing
        }
        if action == "get" { return try AutomationCodec.string(store.state.runs.filter { $0.automationID == job.id }) + "\n" + AutomationCodec.string(job) }
        if ["create", "update"].contains(action) {
            if let v = a["title"] as? String { job.title = v }; if let v = a["prompt"] as? String { job.prompt = v }
            if let v = a["executor"] as? String { guard action == "create" || job.executor == v else { throw AutomationFailure.invalid("Créez une nouvelle automatisation pour changer son lieu d’exécution.") }; job.executor = v }
            if let v = a["model"] as? String { job.model = v }
            if let kind = a["kind"] as? String { job.trigger = AutomationTrigger(kind: kind) }
            if let v = a["at"] as? String { job.trigger.at = ISO8601DateFormatter().date(from: v) }
            if let v = a["seconds"] as? Int { job.trigger.seconds = v }; if let v = a["hour"] as? Int { job.trigger.hour = v }; if let v = a["minute"] as? Int { job.trigger.minute = v }
            if let v = a["timeZone"] as? String { job.trigger.timeZone = v }
            if let v = a["latitude"] as? Double { job.trigger.latitude = v }; if let v = a["longitude"] as? Double { job.trigger.longitude = v }; if let v = a["radius"] as? Double { job.trigger.radius = v }
            if let v = a["transition"] as? String { job.trigger.transition = v }; if let v = a["event"] as? String { job.trigger.event = v }
            if let v = a["domains"] as? String { job.allowedDomains = v.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() } }
            try job.validate()
            if job.executor == "local" && !ModelExecution(job.model).isLocal { throw AutomationFailure.invalid("Choisissez un modèle local pour une exécution sur l’iPhone.") }
            if job.executor == "cloud" && ModelExecution(job.model).isLocal { throw AutomationFailure.invalid("Choisissez explicitement un modèle distant pour MultiVibe Cloud.") }
            if job.trigger.kind == "geofence", store.jobs.filter({ $0.id != job.id && $0.enabled && $0.trigger.kind == "geofence" }).count >= 20 { throw AutomationFailure.invalid("Limite iOS de 20 zones atteinte.") }
        }
        if job.executor == "cloud" {
            guard let cloud = c.cloud, scope != "guest" else { throw AutomationFailure.unavailable("Connexion à MultiVibe Cloud requise.") }
            var body: [String: Any] = ["action": action, "id": job.id.uuidString]
            if ["create", "update"].contains(action) { body["job"] = try JSONSerialization.jsonObject(with: AutomationCodec.encoder.encode(job)) }
            let result = try await cloud(JSONSerialization.data(withJSONObject: body))
            guard c.scope == scope else { throw CancellationError() }
            try await c.syncCloud(); return String(decoding: result, as: UTF8.self)
        }
        switch action {
        case "create", "update": job = try store.upsert(job)
        case "pause", "resume": job.enabled = action == "resume"; job = try store.upsert(job)
        case "delete": try store.remove(job.id)
        case "run": _ = try store.admit(job.id, eventID: "manual:" + UUID().uuidString, manual: true)
        default: throw LocalAgentError.invalidInput
        }
        c.reconcile(); c.wake()
        return try AutomationCodec.string(job) + "\n" + (action == "delete" ? "Supprimée." : c.readiness(job))
    }
}
#if canImport(FoundationModels)
@available(iOS 26, *)
struct AutomationAgentTool: Tool {
    let name = "automation_manage"
    let description = "Manage requested automations. Local schedules are best effort. list before modifying IDs. create requires title, prompt, kind. Check readiness in the result."
    let workspace: LocalAgentWorkspace
    @Generable struct Arguments {
        @Guide(description: "Operation", .anyOf(["capabilities", "list", "get", "create", "update", "pause", "resume", "delete", "run"])) var action: String
        var id: String?
        var title: String?
        var prompt: String?
        @Guide(description: "Trigger: at, interval, daily, geofence, event") var kind: String?
        @Guide(description: "ISO8601 date with timezone") var at: String?
        var seconds: Int?
        var hour: Int?
        var minute: Int?
        var timeZone: String?
        var latitude: Double?
        var longitude: Double?
        var radius: Double?
        var transition: String?
        var event: String?
        var executor: String?
        var model: String?
    }
    func call(arguments: Arguments) async throws -> String {
        let json = arguments.generatedContent.jsonString
        return try await workspace.automationTool(json)
    }
}
#endif
