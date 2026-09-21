import EventKit
import Foundation
import Contacts
import CoreLocation

struct LocalDeviceSnapshot: Sendable {
    var calendar: String = "Lecture du calendrier non activée. Activez-la dans Documents et outils locaux."
    var reminders: String = "Lecture des rappels non activée. Activez-la dans Documents et outils locaux."
}

/// Permissions are requested on demand by a user-requested tool. Inference reads the device's
/// EventKit store; it never sends a calendar or reminders request to MultiVibe.
@MainActor enum LocalDeviceData {
    static func read(action: String, query: String) async throws -> LocalToolResult {
        try Task.checkCancellation()
        do {
            switch action {
            case "read_calendar":
                guard try await authorizeCalendar() else { return LocalToolResult(denied("calendrier")) }
                try Task.checkCancellation()
                return calendarResult(store: EKEventStore(), query: query)
            case "read_reminders":
                guard try await authorizeReminders() else { return LocalToolResult(denied("rappels")) }
                try Task.checkCancellation()
                return await remindersResult(store: EKEventStore(), query: query)
            case "read_contacts":
                let store = CNContactStore()
                guard try await store.requestAccess(for: .contacts) else { return LocalToolResult(denied("contacts")) }
                try Task.checkCancellation()
                return try contactsResult(store: store, query: query)
            case "current_location":
                return try await LocalLocationRequest().read()
            case "read_mail":
                return LocalToolResult("iOS ne propose aucune permission permettant de lire la boîte Apple Mail. Importez ou collez le message dans la conversation pour l’analyser localement. Aucun mail n’a été lu.")
            default:
                return LocalToolResult("Source de données non disponible.")
            }
        } catch is CancellationError { throw CancellationError() }
        catch {
            return LocalToolResult("Données indisponibles. Vérifiez les autorisations dans Réglages iOS. Aucun accès réussi : \(error.localizedDescription)")
        }
    }

    private static func filteredText(_ text: String, query: String) -> String {
        let lines = text.components(separatedBy: .newlines)
        return String((query.isEmpty ? text : ([lines.first ?? ""] + lines.dropFirst().filter {
            $0.localizedCaseInsensitiveContains(query)
        }).joined(separator: "\n")).prefix(2400))
    }

    private static func denied(_ source: String) -> String {
        "Accès aux données \(source) refusé ou restreint. Vous pouvez modifier l’autorisation dans Réglages iOS. Aucune donnée lue."
    }

    static func authorizeCalendar() async throws -> Bool {
        try await EKEventStore().requestFullAccessToEvents()
    }

    static func authorizeReminders() async throws -> Bool {
        try await EKEventStore().requestFullAccessToReminders()
    }

    private static func calendarResult(store: EKEventStore, query: String) -> LocalToolResult {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
            return LocalToolResult("Accès au calendrier refusé ou retiré dans les réglages iOS.")
        }
        let start = Calendar.current.startOfDay(for: Date())
        let end = Calendar.current.date(byAdding: .day, value: 30, to: start)!
        let events = Array(store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))
            .sorted { $0.startDate < $1.startDate }
            .prefix(50))
        let header = "Calendrier local, aujourd’hui et les 30 prochains jours (50 événements maximum) :"
        let text = header + "\n" + events.map {
            "\($0.startDate.formatted(date: .abbreviated, time: .shortened)): \(($0.title ?? "Sans titre").prefix(160))"
        }.joined(separator: "\n")
        let selected = query.isEmpty ? events : events.filter { event in
            let line = "\(event.startDate.formatted(date: .abbreviated, time: .shortened)): \((event.title ?? "Sans titre").prefix(160))"
            return line.localizedCaseInsensitiveContains(query)
        }
        let items = selected.map { event in
            NativeContentBlock.CalendarEvent(
                id: event.eventIdentifier ?? event.calendarItemIdentifier,
                title: String((event.title ?? "Sans titre").prefix(160)),
                start: event.startDate,
                end: event.endDate,
                calendar: event.calendar.title,
                location: event.location,
                isAllDay: event.isAllDay
            )
        }
        return LocalToolResult(filteredText(text, query: query), blocks: [
            .agenda(title: "Agenda des 30 prochains jours", events: items)
        ])
    }

    private static func remindersResult(store: EKEventStore, query: String) async -> LocalToolResult {
        guard EKEventStore.authorizationStatus(for: .reminder) == .fullAccess else {
            return LocalToolResult("Accès aux rappels refusé ou retiré dans les réglages iOS.")
        }
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        return await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { reminders in
                let reminders = Array((reminders ?? []).prefix(50))
                let rows = reminders.map { reminder -> (EKReminder, Date?, String) in
                    let due = reminder.dueDateComponents.flatMap { Calendar.current.date(from: $0) }
                    let line = "\((reminder.title ?? "Sans titre").prefix(160)) — \(due?.formatted(date: .abbreviated, time: .shortened) ?? "sans échéance")"
                    return (reminder, due, line)
                }
                let text = "Rappels locaux non terminés (50 maximum) :\n" + rows.map { $0.2 }.joined(separator: "\n")
                let selected = query.isEmpty ? rows : rows.filter { $0.2.localizedCaseInsensitiveContains(query) }
                let items = selected.map { reminder, due, _ in
                    NativeContentBlock.Reminder(
                        id: reminder.calendarItemIdentifier,
                        title: String((reminder.title ?? "Sans titre").prefix(160)),
                        due: due,
                        isCompleted: reminder.isCompleted,
                        list: reminder.calendar.title
                    )
                }
                continuation.resume(returning: LocalToolResult(filteredText(text, query: query), blocks: [
                    .reminders(title: "Rappels à venir", items: items)
                ]))
            }
        }
    }

    private static func contactsResult(store: CNContactStore, query: String) throws -> LocalToolResult {
        let request = CNContactFetchRequest(keysToFetch: [
            CNContactGivenNameKey as CNKeyDescriptor, CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor, CNContactPhoneNumbersKey as CNKeyDescriptor
        ])
        var lines: [String] = []
        var items: [NativeContentBlock.Contact] = []
        try store.enumerateContacts(with: request) { contact, stop in
            let name = "\(contact.givenName) \(contact.familyName)"
            guard query.isEmpty || name.localizedCaseInsensitiveContains(query) else { return }
            let emails = contact.emailAddresses.prefix(2).map { String($0.value) }
            let phones = contact.phoneNumbers.prefix(2).map { $0.value.stringValue }
            lines.append("\(name): \(emails.joined(separator: ", ")) \(phones.joined(separator: ", "))")
            items.append(.init(id: contact.identifier, name: name, phones: phones, emails: emails))
            if lines.count >= 30 { stop.pointee = true }
        }
        let text = "Contacts autorisés par iOS (30 maximum, accès éventuellement limité) :\n" +
            (lines.isEmpty ? "Aucun résultat." : String(lines.joined(separator: "\n").prefix(2400)))
        return LocalToolResult(text, blocks: [.contacts(title: "Contacts", items: items)])
    }

    static func snapshot(calendar: Bool, reminders: Bool) async -> LocalDeviceSnapshot {
        var snapshot = LocalDeviceSnapshot()
        guard calendar || reminders else { return snapshot }
        let store = EKEventStore()
        if calendar {
            snapshot.calendar = calendarResult(store: store, query: "").modelText
        }
        if reminders {
            snapshot.reminders = await remindersResult(store: store, query: "").modelText
        }
        return snapshot
    }
}

/// One-shot foreground location. No geocoder/network call or continuous tracking.
@MainActor private final class LocalLocationRequest: NSObject, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var pending: CheckedContinuation<LocalToolResult, Error>?
    private var timeout: Task<Void, Never>?

    func read() async throws -> LocalToolResult {
        try Task.checkCancellation()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pending = continuation
                if Task.isCancelled { finish(.failure(CancellationError())); return }
                switch manager.authorizationStatus {
                case .notDetermined: manager.requestWhenInUseAuthorization()
                default: requestIfAuthorized()
                }
            }
        } onCancel: {
            Task { @MainActor in self.finish(.failure(CancellationError())) }
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard pending != nil else { return }
        requestIfAuthorized()
    }

    private func requestIfAuthorized() {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            guard timeout == nil else { return }
            timeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(20)) } catch { return }
                self?.finish(.success(LocalToolResult("Position indisponible : délai de localisation dépassé.")))
            }
            manager.requestLocation()
        case .denied, .restricted:
            finish(.success(LocalToolResult("Accès à la position refusé ou restreint. Modifiez l’autorisation dans Réglages iOS si souhaité.")))
        case .notDetermined: break
        @unknown default:
            finish(.success(LocalToolResult("Autorisation de localisation indisponible.")))
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last, location.horizontalAccuracy >= 0,
              abs(location.timestamp.timeIntervalSinceNow) < 120 else {
            finish(.success(LocalToolResult("Aucune position récente disponible.")))
            return
        }
        let text = "Position GPS : latitude \(location.coordinate.latitude), longitude \(location.coordinate.longitude). Précision : \(Int(location.horizontalAccuracy)) m. Mesure : \(location.timestamp.formatted()). Aucun nom de lieu déterminé ; ne pas en inventer."
        let block = NativeContentBlock.location(.init(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            accuracy: location.horizontalAccuracy,
            measuredAt: location.timestamp
        ))
        finish(.success(LocalToolResult(text, blocks: [block])))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish(.success(LocalToolResult("Position indisponible : \(error.localizedDescription)")))
    }

    private func finish(_ result: Result<LocalToolResult, Error>) {
        let continuation = pending
        pending = nil
        timeout?.cancel()
        timeout = nil
        manager.stopUpdatingLocation()
        continuation?.resume(with: result)
    }
}
