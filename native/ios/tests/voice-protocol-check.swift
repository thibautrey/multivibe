import Foundation

@main enum VoiceProtocolCheck {
    static func main() {
        func created(_ id: String) -> [String: Any] { ["type": "response.created", "response": ["id": id]] }
        func transcript(_ id: String) -> [String: Any] { ["type": "response.output_audio_transcript.done", "response_id": id, "item_id": "item_" + id, "transcript": "Bonjour"] }
        func done(_ id: String, _ status: String = "completed") -> [String: Any] { ["type": "response.done", "response": ["id": id, "status": status]] }
        var ledger = VoiceTranscriptLedger()
        assert(ledger.consume(created("one")).isEmpty)
        assert(ledger.consume(transcript("one")).isEmpty)
        assert(ledger.consume(done("one")).isEmpty, "Generation completion must wait for audio playback")
        assert(ledger.playbackFinished("one").count == 1)
        assert(ledger.playbackFinished("one").isEmpty)
        assert(ledger.consume(transcript("one")).isEmpty, "Duplicate final must not persist twice")
        _ = ledger.consume(created("two")); _ = ledger.consume(transcript("two"))
        ledger.interrupt()
        assert(ledger.consume(done("two")).isEmpty)
        assert(ledger.playbackFinished("two").isEmpty)
        assert(ledger.consume(transcript("two")).isEmpty, "Late cancelled transcript must stay cancelled")
        _ = ledger.consume(created("three")); _ = ledger.consume(transcript("three"))
        _ = ledger.consume(done("three", "cancelled"))
        assert(ledger.playbackFinished("three").isEmpty)
        _ = ledger.consume(created("four")); _ = ledger.consume(transcript("four"))
        assert(ledger.playbackFinished("four").isEmpty)
        assert(ledger.consume(done("four")).count == 1, "Playback and final event can arrive out of order")
        _ = ledger.consume(created("five")); _ = ledger.consume(transcript("five"))
        _ = ledger.playbackFinished("five"); ledger.playbackStarted("five")
        assert(ledger.consume(done("five")).isEmpty, "A later audio chunk invalidates an earlier drain")
        assert(ledger.playbackFinished("five").count == 1)
        let user: [String: Any] = ["type": "conversation.item.input_audio_transcription.completed", "item_id": "user1", "transcript": "Salut"]
        assert(ledger.consume(user).count == 1)
        assert(ledger.consume(user).isEmpty)
        assert(ledger.consume(["type": "conversation.item.input_audio_transcription.delta", "delta": "provisoire"]).isEmpty)
        assert(ledger.consume(["type": "conversation.item.input_audio_transcription.completed", "transcript": "missing ID"]).isEmpty)
        assert(ledger.consume(["type": "conversation.item.input_audio_transcription.completed", "item_id": "blank", "transcript": "  "]).isEmpty)
        print("Voice transcript protocol checks passed (completion, playback, interruption, late events, deduplication, partials).")
    }
}
