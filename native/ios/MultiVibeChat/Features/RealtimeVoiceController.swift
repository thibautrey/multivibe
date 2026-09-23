import AVFoundation
import Foundation
import MediaPlayer
import Observation
import UIKit

@MainActor @Observable final class RealtimeVoiceController {
    enum Phase: String { case idle, connecting, listening, thinking, speaking, reconnecting, awaitingConfirmation, ended }
    var phase: Phase = .idle
    var partialUser = ""
    var partialAssistant = ""
    var muted = false
    var error: String?
    var route = ""
    private var socket: URLSessionWebSocketTask?
    private var webRTC: VoiceWebRTCTransport?
    private var capture = AVAudioEngine()
    private var playback = AVAudioEngine()
    private var player = AVAudioPlayerNode()
    private var session: VoiceSession?
    private var accountToken = ""
    private var receiveTask: Task<Void, Never>?
    private var expiryTask: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    private var remoteCommands: [(MPRemoteCommand, Any)] = []
    private var ledger = VoiceTranscriptLedger()
    private var captureTapInstalled = false
    private var pendingAudio: [String: Int] = [:]
    private var audioGeneration = 0
    private var onTurn: (@MainActor (String, String, String) async -> Bool)?
    private var sessionClosed = false
    private var closing = false
    private var cueEngine: AVAudioEngine?
    private var cuePlayer: AVAudioPlayerNode?

    func start(session: VoiceSession, history: [ChatMessage], accountToken: String, backgroundAudio: Bool,
               onTurn: @escaping @MainActor (String, String, String) async -> Bool) async {
        endAudio()
        self.session = session; self.accountToken = accountToken; self.onTurn = onTurn
        sessionClosed = false; ledger = VoiceTranscriptLedger()
        route = session.route; error = nil; phase = .connecting
        do {
            guard session.expiresAt > Date() else { throw URLError(.userAuthenticationRequired) }
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try audio.setPreferredIOBufferDuration(0.02)
            try audio.setActive(true)
            installLifecycle(backgroundAudio: backgroundAudio)
            expiryTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(max(0, session.expiresAt.timeIntervalSinceNow)))
                guard !Task.isCancelled else { return }
                self?.fail("La session vocale a expiré. Vous pouvez en ouvrir une nouvelle.")
            }
            if session.credential.transport == "webrtc" {
                let transport = VoiceWebRTCTransport()
                webRTC = transport
                transport.onEvent = { [weak self] data in Task { @MainActor in await self?.receive(data) } }
                transport.onDisconnect = { [weak self] in self?.fail("La connexion audio est interrompue. Ouvrez une nouvelle session.") }
                try await transport.connect(session.credential)
            } else {
                guard session.credential.transport == "websocket", session.credential.endpoint.scheme == "wss" else { throw URLError(.unsupportedURL) }
                var request = URLRequest(url: session.credential.endpoint)
                request.setValue("Bearer \(session.credential.token)", forHTTPHeaderField: "Authorization")
                let task = URLSession(configuration: .ephemeral).webSocketTask(with: request)
                socket = task; task.resume()
                playback.attach(player)
                playback.connect(player, to: playback.mainMixerNode, format: outputFormat)
                try playback.start(); player.play()
            }
            try Task.checkCancellation()
            guard phase != .ended else { return }
            var input: [String: Any] = ["turn_detection": ["type": "server_vad", "interrupt_response": true],
                                         "transcription": ["model": "gpt-4o-mini-transcribe"]]
            var output: [String: Any] = [:]
            if webRTC == nil {
                input["format"] = ["type": "audio/pcm", "rate": 24000]
                output["format"] = ["type": "audio/pcm", "rate": 24000]
            }
            try await send(["type": "session.update", "session": ["type": "realtime", "tools": [],
                "audio": ["input": input, "output": output]]])
            for message in history.suffix(20) where ["user", "assistant"].contains(message.role) && !message.content.isEmpty && (message.completion == nil || message.completion == .completed) {
                try await send(["type": "conversation.item.create", "item": ["type": "message", "role": message.role,
                    "content": [["type": message.role == "assistant" ? "output_text" : "input_text", "text": message.content]]]])
            }
            await playCue(.started)
            guard phase != .ended else { return }
            if let webRTC { webRTC.setMuted(muted) }
            else {
                try startCapture()
                receiveTask = Task { [weak self] in await self?.receiveLoop() }
            }
            phase = .listening
        } catch { if phase != .ended { fail("La connexion vocale a échoué. Réessayez depuis le chat.") } }
    }

    private var outputFormat: AVAudioFormat { AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)! }
    private func startCapture() throws {
        let input = capture.inputNode
        try input.setVoiceProcessingEnabled(true)
        let format = input.outputFormat(forBus: 0)
        guard let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: format, to: target) else { throw URLError(.cannotDecodeContentData) }
        input.installTap(onBus: 0, bufferSize: 960, format: format) { [weak self] buffer, _ in
            guard let data = Self.pcm24k(buffer, converter: converter, targetFormat: target) else { return }
            Task { @MainActor [weak self] in
                guard let self, !self.muted, [.listening, .thinking, .speaking].contains(self.phase) else { return }
                do { try await self.send(["type": "input_audio_buffer.append", "audio": data.base64EncodedString()]) }
                catch { self.fail("La connexion audio est interrompue.") }
            }
        }
        captureTapInstalled = true
        capture.prepare(); try capture.start()
    }
    nonisolated private static func pcm24k(_ source: AVAudioPCMBuffer, converter: AVAudioConverter, targetFormat: AVAudioFormat) -> Data? {
        let capacity = AVAudioFrameCount(Double(source.frameLength) * 24_000 / source.format.sampleRate + 32)
        guard let target = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return nil }
        var supplied = false
        let status = converter.convert(to: target, error: nil) { _, flag in
            if supplied { flag.pointee = .noDataNow; return nil }
            supplied = true; flag.pointee = .haveData; return source
        }
        guard status != .error, let samples = target.int16ChannelData?[0] else { return nil }
        return Data(bytes: samples, count: Int(target.frameLength) * 2)
    }
    private func send(_ object: [String: Any]) async throws {
        guard phase != .ended else { throw CancellationError() }
        let data = try JSONSerialization.data(withJSONObject: object)
        if let webRTC { try webRTC.send(data) }
        else if let socket { try await socket.send(.string(String(decoding: data, as: UTF8.self))) }
        else { throw URLError(.networkConnectionLost) }
    }
    private func receiveLoop() async {
        do {
            while !Task.isCancelled, let socket {
                switch try await socket.receive() {
                case .data(let data): await receive(data)
                case .string(let text): await receive(Data(text.utf8))
                @unknown default: break
                }
            }
        } catch {
            // A new provider connection is a new conversation; never replay a possibly billed turn.
            if phase != .ended { fail("Connexion perdue. Ouvrez une nouvelle session pour continuer sans rejouer votre demande.") }
        }
    }
    private func receive(_ data: Data) async {
        guard phase != .ended, data.count <= 2_097_152,
              let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = event["type"] as? String else { return }
        let turns = ledger.consume(event)
        switch type {
        case "input_audio_buffer.speech_started":
            stopOutput(); partialAssistant = ""; phase = .listening
            // server_vad.interrupt_response performs cancellation atomically at the provider.
        case "input_audio_buffer.speech_stopped": phase = .thinking
        case "conversation.item.input_audio_transcription.delta": partialUser = String((partialUser + (event["delta"] as? String ?? "")).suffix(20_000))
        case "conversation.item.input_audio_transcription.completed": partialUser = ""
        case "response.output_audio_transcript.delta": partialAssistant = String((partialAssistant + (event["delta"] as? String ?? "")).suffix(20_000))
        case "response.output_audio.delta":
            guard let response = event["response_id"] as? String, response == ledger.activeResponse else { break }
            if let encoded = event["delta"] as? String, let audio = Data(base64Encoded: encoded) { play(audio, response: response) }
        case "output_audio_buffer.started": phase = .speaking
        case "output_audio_buffer.stopped": partialAssistant = ""; phase = .listening
        case "response.done":
            if webRTC == nil, let response = event["response"] as? [String: Any], let id = response["id"] as? String, pendingAudio[id, default: 0] == 0 {
                await persist(ledger.playbackFinished(id)); partialAssistant = ""; phase = .listening
            }
        case "response.function_call_arguments.done":
            // Tool dispatch is unavailable until connected to the existing ownership/approval boundary.
            fail("Les outils ne sont pas encore disponibles dans ce mode vocal. Continuez dans le chat.")
        case "error": fail("Le service vocal a rencontré une erreur. La session a été arrêtée.")
        default: break
        }
        await persist(turns)
    }
    private func play(_ data: Data, response: String) {
        guard !data.isEmpty, data.count.isMultiple(of: 2), data.count <= 1_048_576,
              let buffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: AVAudioFrameCount(data.count / 2)),
              let channel = buffer.floatChannelData?[0] else { fail("Format audio invalide."); return }
        buffer.frameLength = buffer.frameCapacity
        data.withUnsafeBytes { raw in
            for index in 0..<Int(buffer.frameLength) {
                channel[index] = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))) / 32768
            }
        }
        phase = .speaking
        ledger.playbackStarted(response)
        pendingAudio[response, default: 0] += 1
        let generation = audioGeneration
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.audioGeneration == generation, self.phase != .ended else { return }
                self.pendingAudio[response, default: 1] -= 1
                if self.pendingAudio[response] == 0 {
                    await self.persist(self.ledger.playbackFinished(response))
                }
            }
        }
    }
    private func persist(_ turns: [VoiceTranscriptLedger.Turn]) async {
        guard let session else { return }
        for turn in turns {
            // Device persistence owns the text. Cloud acknowledges IDs only; a lost response is retryable.
            guard await onTurn?(turn.role, turn.text, session.id + ":" + turn.id) == true else {
                fail("La transcription n’a pas pu être enregistrée. La session a été arrêtée."); return
            }
            do { _ = try await ChatAPI.shared.reconcileVoiceTurn(session: session, turnID: turn.id, token: accountToken) }
            catch { self.error = "Transcription enregistrée sur l’appareil ; réconciliation vocale indisponible." }
        }
    }
    func setMuted(_ value: Bool) {
        guard phase != .ended else { return }
        muted = value; webRTC?.setMuted(value)
        Task { try? await send(["type": "input_audio_buffer.clear"]) }
        MPNowPlayingInfoCenter.default().playbackState = value ? .paused : .playing
    }
    func sendText(_ text: String) async {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, clean.count <= 20_000, [.listening, .thinking, .speaking].contains(phase) else { return }
        do {
            let id = "text_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
            if phase == .speaking || phase == .thinking { ledger.interrupt(); stopOutput(); try await send(["type": "response.cancel"]) }
            try await send(["type": "conversation.item.create", "item": ["id": id, "type": "message", "role": "user", "content": [["type": "input_text", "text": clean]]]])
            await persist([.init(id: id, role: "user", text: clean)])
            try await send(["type": "response.create"])
            phase = .thinking
        } catch { fail("Le texte n’a pas pu être transmis.") }
    }
    private func installLifecycle(backgroundAudio: Bool) {
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
            let began = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
            Task { @MainActor in
                guard began else { return }
                self?.fail("L’audio a été interrompu. Reprenez depuis le chat après l’appel.")
            }
        })
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] notification in
            let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            Task { @MainActor in
                if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
                    self?.setMuted(true)
                    self?.error = "La sortie audio a changé. Réactivez le micro pour continuer."
                }
            }
        })
        if !backgroundAudio {
            observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.end() }
            })
        } else {
            let center = MPRemoteCommandCenter.shared()
            for (command, action) in [(center.pauseCommand, 0), (center.playCommand, 1), (center.stopCommand, 2)] {
                command.isEnabled = true
                let target = command.addTarget { [weak self] _ in
                    Task { @MainActor in if action == 2 { self?.end() } else { self?.setMuted(action == 0) } }
                    return .success
                }
                remoteCommands.append((command, target))
            }
            MPNowPlayingInfoCenter.default().nowPlayingInfo = [MPMediaItemPropertyTitle: "Conversation MultiVibe", MPNowPlayingInfoPropertyIsLiveStream: true]
            MPNowPlayingInfoCenter.default().playbackState = .playing
        }
    }
    private func stopOutput() {
        audioGeneration += 1; pendingAudio.removeAll()
        player.stop(); player.reset()
        if playback.isRunning { player.play() }
    }
    func endWithCue() async {
        guard !closing, phase != .ended else { return }
        closing = true
        muted = true
        webRTC?.setMuted(true)
        if capture.isRunning { capture.pause() }
        ledger.interrupt()
        stopOutput()
        try? await send(["type": "response.cancel"])
        await playCue(.ended)
        end()
    }
    func end() {
        guard phase != .ended else { return }
        phase = .ended; ledger.interrupt(); endAudio()
        guard !sessionClosed, let session else { return }
        sessionClosed = true
        let token = accountToken
        Task { await ChatAPI.shared.closeVoiceSession(session, token: token) }
    }

    private enum SessionCue { case started, ended }
    private func playCue(_ cue: SessionCue) async {
        guard phase != .ended else { return }
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let duration = cue == .started ? 0.34 : 0.30
        let frames = AVAudioFrameCount(48_000 * duration)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames),
              let samples = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = frames
        let frequencies: (Double, Double) = cue == .started ? (523.25, 783.99) : (659.25, 392.00)
        for index in 0..<Int(frames) {
            let progress = Double(index) / Double(frames)
            let attack = min(1, progress / 0.08)
            let release = min(1, (1 - progress) / 0.38)
            let envelope = sin(.pi * min(1, attack)) * sin(.pi / 2 * min(1, release))
            let frequency = frequencies.0 + (frequencies.1 - frequencies.0) * progress
            let fundamental = sin(2 * .pi * frequency * Double(index) / 48_000)
            let overtone = sin(2 * .pi * frequency * 2 * Double(index) / 48_000) * 0.16
            samples[index] = Float((fundamental + overtone) * envelope * 0.12)
        }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        cueEngine = engine; cuePlayer = player
        do { try engine.start() } catch { cueEngine = nil; cuePlayer = nil; return }
        await withCheckedContinuation { continuation in
            player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in continuation.resume() }
            player.play()
        }
        player.stop(); engine.stop()
        if cueEngine === engine { cueEngine = nil; cuePlayer = nil }
    }
    private func fail(_ message: String) { error = message; end() }
    private func endAudio() {
        expiryTask?.cancel(); expiryTask = nil
        receiveTask?.cancel(); receiveTask = nil
        webRTC?.close(); webRTC = nil
        socket?.cancel(with: .normalClosure, reason: nil); socket = nil
        if capture.isRunning { capture.stop() }
        if captureTapInstalled { capture.inputNode.removeTap(onBus: 0); captureTapInstalled = false }
        stopOutput()
        cuePlayer?.stop(); cueEngine?.stop(); cuePlayer = nil; cueEngine = nil
        if playback.isRunning { playback.stop() }
        for observer in observers { NotificationCenter.default.removeObserver(observer) }; observers.removeAll()
        for (command, target) in remoteCommands { command.removeTarget(target); command.isEnabled = false }
        if !remoteCommands.isEmpty { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil }
        remoteCommands.removeAll()
        partialUser = ""; partialAssistant = ""
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
