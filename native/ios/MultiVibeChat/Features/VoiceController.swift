import AVFoundation
import Speech
import Observation

/// Dictation is explicit and foreground-only. The transcript stays editable;
/// only the Send action transmits it to MultiVibe.
@MainActor @Observable final class VoiceController: NSObject, AVSpeechSynthesizerDelegate {
    var transcript = ""
    var recording = false
    var speaking = false
    var error: String?
    private let engine = AVAudioEngine()
    private let synthesizer = AVSpeechSynthesizer()
    private var recognition: SFSpeechRecognitionTask?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var tapInstalled = false
    private var activation = UUID()
    private var starting = false
    private var currentUtterance: AVSpeechUtterance?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let identity = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in self?.finishSpeaking(identity) }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let identity = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in self?.finishSpeaking(identity) }
    }
    private func finishSpeaking(_ identity: ObjectIdentifier) {
        guard let currentUtterance, ObjectIdentifier(currentUtterance) == identity else { return }
        self.currentUtterance = nil; speaking = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }


    func start() async {
        guard !recording, !starting else { return }
        let activation = UUID()
        self.activation = activation; starting = true
        defer { if self.activation == activation { starting = false } }
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
        guard self.activation == activation, !Task.isCancelled else { return }
        let microphone = await AVAudioApplication.requestRecordPermission()
        guard self.activation == activation, !Task.isCancelled else { return }
        guard speech && microphone else { error = "Autorisez le micro et la reconnaissance vocale dans Réglages."; return }
        guard let recognizer = SFSpeechRecognizer(locale: .current), recognizer.isAvailable else {
            error = "La dictée est indisponible pour le moment."; return
        }
        do {
            currentUtterance = nil; speaking = false
            synthesizer.stopSpeaking(at: .immediate)
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audio.setActive(true)
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            // Prefer on-device recognition. Refuse a silent fallback to Apple's servers.
            guard recognizer.supportsOnDeviceRecognition else {
                try? audio.setActive(false); error = "La dictée sur l’appareil n’est pas disponible dans cette langue."; return
            }
            request.requiresOnDeviceRecognition = true
            self.request = request
            transcript = ""; error = nil
            let input = engine.inputNode
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in request.append(buffer) }
            tapInstalled = true
            recognition = recognizer.recognitionTask(with: request) { [weak self] result, failure in
                let text = result?.bestTranscription.formattedString
                let finished = result?.isFinal == true || failure != nil
                Task { @MainActor [weak self] in
                    guard let self, self.activation == activation else { return }
                    if let text { self.transcript = text }
                    if finished { self.stop() }
                }
            }
            engine.prepare(); try engine.start(); recording = true
        } catch { stop(); self.error = error.localizedDescription }
    }
    func stop() {
        activation = UUID(); starting = false
        engine.stop()
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        request?.endAudio(); recognition?.cancel(); recognition = nil; request = nil
        recording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    func speak(_ text: String) {
        silence()
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: .duckOthers)
            try AVAudioSession.sharedInstance().setActive(true)
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier)
            currentUtterance = utterance; speaking = true
            synthesizer.speak(utterance)
        } catch { self.error = error.localizedDescription }
    }
    func silence() { currentUtterance = nil; speaking = false; synthesizer.stopSpeaking(at: .immediate); stop() }
}
