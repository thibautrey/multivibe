import Foundation

/// Finals are eligible only after successful generation AND complete playback.
/// Cancellation tombstones prevent late network events from reviving a turn.
struct VoiceTranscriptLedger {
    struct Turn: Equatable { let id: String; let role: String; let text: String }
    private var pending: [String: [Turn]] = [:]
    private var completed = Set<String>()
    private var played = Set<String>()
    private var cancelled = Set<String>()
    private var delivered = Set<String>()
    private(set) var activeResponse: String?

    mutating func interrupt() {
        if let activeResponse { cancelled.insert(activeResponse); pending[activeResponse] = nil }
        activeResponse = nil
    }
    mutating func consume(_ event: [String: Any]) -> [Turn] {
        switch event["type"] as? String {
        case "response.created":
            activeResponse = (event["response"] as? [String: Any])?["id"] as? String
        case "input_audio_buffer.speech_started": interrupt()
        case "conversation.item.input_audio_transcription.completed":
            guard let id = event["item_id"] as? String, let text = event["transcript"] as? String else { return [] }
            return deliver([Turn(id: id, role: "user", text: text)])
        case "response.output_audio_transcript.done":
            guard let response = event["response_id"] as? String, !cancelled.contains(response),
                  let id = event["item_id"] as? String, let text = event["transcript"] as? String else { return [] }
            if !(pending[response] ?? []).contains(where: { $0.id == id }) {
                pending[response, default: []].append(Turn(id: id, role: "assistant", text: text))
            }
            return flush(response)
        case "response.done":
            guard let response = event["response"] as? [String: Any], let id = response["id"] as? String else { return [] }
            guard response["status"] as? String == "completed" else {
                cancelled.insert(id); pending[id] = nil; return []
            }
            completed.insert(id)
            return flush(id)
        case "output_audio_buffer.stopped":
            guard let id = event["response_id"] as? String else { return [] }
            return playbackFinished(id)
        default: break
        }
        return []
    }
    mutating func playbackStarted(_ response: String) { played.remove(response) }
    mutating func playbackFinished(_ response: String) -> [Turn] {
        played.insert(response)
        return flush(response)
    }
    private mutating func flush(_ response: String) -> [Turn] {
        guard completed.contains(response), played.contains(response), !cancelled.contains(response) else { return [] }
        let turns = pending.removeValue(forKey: response) ?? []
        if activeResponse == response { activeResponse = nil }
        return deliver(turns)
    }
    private mutating func deliver(_ turns: [Turn]) -> [Turn] {
        turns.compactMap { turn in
            let text = turn.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, delivered.insert(turn.id).inserted else { return nil }
            return Turn(id: turn.id, role: turn.role, text: text)
        }
    }
}
