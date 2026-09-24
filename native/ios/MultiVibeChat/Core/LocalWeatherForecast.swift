import Foundation

/// A domain tool supplies a real API contract instead of asking a small model to
/// invent forecast-page URLs. All network I/O still goes through app permission.
enum LocalWeatherForecast {
    struct Places: Decodable { var results: [Place]? }
    struct Place: Decodable {
        var name: String
        var latitude: Double
        var longitude: Double
        var country: String?
        var admin1: String?
    }
    struct Forecast: Decodable {
        var timezone: String
        var daily: Daily
        struct Daily: Decodable {
            var time: [String]
            var temperature_2m_max: [Double?]
            var temperature_2m_min: [Double?]
            var precipitation_probability_max: [Double?]
        }
    }
    static func read(city: String, fetch: @Sendable (URL) async throws -> LocalWebResponse) async throws -> String {
        var geocoding = URLComponents(string: "https://geocoding-api.open-meteo.com/v1/search")!
        geocoding.queryItems = [.init(name: "name", value: city), .init(name: "count", value: "1"),
            .init(name: "language", value: "fr"), .init(name: "format", value: "json")]
        let locationPage = try await fetch(geocoding.url!)
        let places = try JSONDecoder().decode(Places.self, from: Data(locationPage.text.utf8))
        guard let place = places.results?.first else {
            throw LocalAgentError.unavailable("Ville introuvable. Demandez à l’utilisateur de préciser la ville et le pays.")
        }
        var forecastURL = URLComponents(string: "https://api.open-meteo.com/v1/forecast")!
        forecastURL.queryItems = [.init(name: "latitude", value: String(place.latitude)), .init(name: "longitude", value: String(place.longitude)),
            .init(name: "daily", value: "temperature_2m_max,temperature_2m_min,precipitation_probability_max"),
            .init(name: "timezone", value: "auto"), .init(name: "forecast_days", value: "3")]
        let page = try await fetch(forecastURL.url!)
        let forecast = try JSONDecoder().decode(Forecast.self, from: Data(page.text.utf8))
        let daily = forecast.daily
        guard daily.time.count >= 2, daily.temperature_2m_max.count == daily.time.count,
              daily.temperature_2m_min.count == daily.time.count, daily.precipitation_probability_max.count == daily.time.count else {
            throw LocalAgentError.unavailable("La source météo a renvoyé des données incomplètes.")
        }
        func value(_ number: Double?, unit: String) -> String { number.map { "\($0) \(unit)" } ?? "indisponible" }
        let rows = daily.time.indices.map { index in
            "\(index == 0 ? "Aujourd’hui" : index == 1 ? "Demain" : "Après-demain") (\(daily.time[index])) : minimum \(value(daily.temperature_2m_min[index], unit: "°C")), maximum \(value(daily.temperature_2m_max[index], unit: "°C")), probabilité de pluie \(value(daily.precipitation_probability_max[index], unit: "%"))."
        }
        return "Prévisions pour \([place.name, place.admin1, place.country].compactMap { $0 }.joined(separator: ", ")) — fuseau \(forecast.timezone).\n" + rows.joined(separator: "\n") + "\nSource : Open-Meteo, " + page.url.absoluteString
    }
}
