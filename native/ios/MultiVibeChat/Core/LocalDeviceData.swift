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
    static func read(action: String, query: String) async throws -> String {
        try Task.checkCancellation()
        do {
            let result: String
            switch action {
            case "read_calendar":
                guard try await authorizeCalendar() else { return denied("calendrier") }
                try Task.checkCancellation()
                result = await snapshot(calendar: true, reminders: false).calendar
            case "read_reminders":
                guard try await authorizeReminders() else { return denied("rappels") }
                try Task.checkCancellation()
                result = await snapshot(calendar: false, reminders: true).reminders
            case "read_contacts":
                let store = CNContactStore()
                guard try await store.requestAccess(for: .contacts) else { return denied("contacts") }
                try Task.checkCancellation()
                let request = CNContactFetchRequest(keysToFetch: [
                    CNContactGivenNameKey as CNKeyDescriptor, CNContactFamilyNameKey as CNKeyDescriptor,
                    CNContactEmailAddressesKey as CNKeyDescriptor, CNContactPhoneNumbersKey as CNKeyDescriptor
                ])
                var lines: [String] = []
                try store.enumerateContacts(with: request) { contact, stop in
                    let name = "\(contact.givenName) \(contact.familyName)"
                    guard query.isEmpty || name.localizedCaseInsensitiveContains(query) else { return }
                    lines.append("\(name): \(contact.emailAddresses.prefix(2).map { String($0.value) }.joined(separator: ", ")) \(contact.phoneNumbers.prefix(2).map { $0.value.stringValue }.joined(separator: ", "))")
                    if lines.count >= 30 { stop.pointee = true }
                }
                return "Contacts autorisés par iOS (30 maximum, accès éventuellement limité) :\n" + (lines.isEmpty ? "Aucun résultat." : String(lines.joined(separator: "\n").prefix(2400)))
            case "current_location":
                return try await LocalLocationRequest().read()
            case "read_mail":
                return "iOS ne propose aucune permission permettant de lire la boîte Apple Mail. Importez ou collez le message dans la conversation pour l’analyser localement. Aucun mail n’a été lu."
            default: return "Source de données non disponible."
            }
            let lines = result.components(separatedBy: .newlines)
            return String((query.isEmpty ? result : ([lines.first ?? ""] + lines.dropFirst().filter { $0.localizedCaseInsensitiveContains(query) }).joined(separator: "\n")).prefix(2400))
        } catch is CancellationError { throw CancellationError() }
        catch { return "Données indisponibles. Vérifiez les autorisations dans Réglages iOS. Aucun accès réussi : \(error.localizedDescription)" }
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


/// One-shot foreground location. No geocoder/network call or continuous tracking.
@MainActor private final class LocalLocationRequest: NSObject, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var pending: CheckedContinuation<String, Error>?
    private var timeout: Task<Void, Never>?
    func read() async throws -> String {
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
                self?.finish(.success("Position indisponible : délai de localisation dépassé."))
            }
            manager.requestLocation()
        case .denied, .restricted:
            finish(.success("Accès à la position refusé ou restreint. Modifiez l’autorisation dans Réglages iOS si souhaité."))
        case .notDetermined: break
        @unknown default: finish(.success("Autorisation de localisation indisponible."))
        }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last, location.horizontalAccuracy >= 0,
              abs(location.timestamp.timeIntervalSinceNow) < 120 else {
            finish(.success("Aucune position récente disponible.")); return
        }
        finish(.success("Position GPS : latitude \(location.coordinate.latitude), longitude \(location.coordinate.longitude). Précision : \(Int(location.horizontalAccuracy)) m. Mesure : \(location.timestamp.formatted()). Aucun nom de lieu déterminé ; ne pas en inventer."))
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish(.success("Position indisponible : \(error.localizedDescription)"))
    }
    private func finish(_ result: Result<String, Error>) {
        let continuation = pending; pending = nil
        timeout?.cancel(); timeout = nil
        manager.stopUpdatingLocation()
        continuation?.resume(with: result)
    }
}
