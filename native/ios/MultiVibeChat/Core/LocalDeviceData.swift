import EventKit
import Foundation

struct LocalDeviceSnapshot: Sendable {
    var calendar: String = "Lecture du calendrier non activée. Activez-la dans Documents et outils locaux."
    var reminders: String = "Lecture des rappels non activée. Activez-la dans Documents et outils locaux."
}

/// Permissions are requested only from a user tap. Inference reads the device's
/// EventKit store; it never sends a calendar or reminders request to MultiVibe.
@MainActor enum LocalDeviceData {
    static func authorizeCalendar() async throws -> Bool {
        try await EKEventStore().requestFullAccessToEvents()
    }
    static func authorizeReminders() async throws -> Bool {
        try await EKEventStore().requestFullAccessToReminders()
    }
    static func snapshot(calendar: Bool, reminders: Bool) async -> LocalDeviceSnapshot {
        var snapshot = LocalDeviceSnapshot()
        guard calendar || reminders else { return snapshot }
        let store = EKEventStore()
        if calendar {
            if EKEventStore.authorizationStatus(for: .event) == .fullAccess {
                let start = Calendar.current.startOfDay(for: Date())
                let end = Calendar.current.date(byAdding: .day, value: 30, to: start)!
                let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))
                    .sorted { $0.startDate < $1.startDate }
                snapshot.calendar = "Calendrier local, aujourd’hui et les 30 prochains jours (50 événements maximum) :\n" + events.prefix(50).map {
                    "\($0.startDate.formatted(date: .abbreviated, time: .shortened)): \(($0.title ?? "Sans titre").prefix(160))"
                }.joined(separator: "\n")
            } else { snapshot.calendar = "Accès au calendrier refusé ou retiré dans les réglages iOS." }
        }
        if reminders {
            if EKEventStore.authorizationStatus(for: .reminder) == .fullAccess {
                let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
                snapshot.reminders = await withCheckedContinuation { continuation in
                    store.fetchReminders(matching: predicate) { reminders in
                        let lines = (reminders ?? []).prefix(50).map { reminder in
                            let due = reminder.dueDateComponents.flatMap { Calendar.current.date(from: $0) }
                            return "\((reminder.title ?? "Sans titre").prefix(160)) — \(due?.formatted(date: .abbreviated, time: .shortened) ?? "sans échéance")"
                        }
                        continuation.resume(returning: "Rappels locaux non terminés (50 maximum) :\n" + lines.joined(separator: "\n"))
                    }
                }
            } else { snapshot.reminders = "Accès aux rappels refusé ou retiré dans les réglages iOS." }
        }
        return snapshot
    }
}
