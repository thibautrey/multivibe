import Foundation

/// Renders an absolute provider balance for the menu bar.
///
/// Currency units use their symbol so the amount is immediately readable; any
/// other unit (points, credits, DIEM…) keeps the provider's own label because
/// inventing a currency for it would misstate the remaining value.
func creditBalanceText(remaining: Double, unit: String) -> String {
    guard remaining.isFinite else { return "—" }
    let normalized = unit.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    let amount = decimalText(remaining, minimumFractionDigits: 2, maximumFractionDigits: 2)
    switch normalized {
    case "USD": return "$" + amount
    case "EUR": return "€" + amount
    case "GBP": return "£" + amount
    case "JPY", "CNY", "RMB": return "¥" + amount
    default: break
    }
    let trimmedUnit = unit.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedUnit.isEmpty else { return amount }
    return amount + " " + trimmedUnit
}

func decimalText(_ value: Double, minimumFractionDigits: Int, maximumFractionDigits: Int) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    formatter.locale = Locale(identifier: "en")
    formatter.minimumFractionDigits = minimumFractionDigits
    formatter.maximumFractionDigits = maximumFractionDigits
    return formatter.string(from: NSNumber(value: value)) ?? String(value)
}
