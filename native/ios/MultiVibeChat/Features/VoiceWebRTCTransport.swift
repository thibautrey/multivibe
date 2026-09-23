import Foundation
@preconcurrency import WebRTC

/// Media stays on WebRTC tracks; only protocol events use the data channel.
@MainActor final class VoiceWebRTCTransport: NSObject {
    private let factory = RTCPeerConnectionFactory()
    private var peer: RTCPeerConnection?
    private var events: RTCDataChannel?
    private var microphone: RTCAudioTrack?
    var onEvent: ((Data) -> Void)?
    var onDisconnect: (() -> Void)?

    func connect(_ credential: VoiceCredential) async throws {
        guard credential.transport == "webrtc", credential.endpoint.scheme == "https",
              credential.endpoint.host == "api.openai.com", credential.expiresAt > Date() else {
            throw URLError(.unsupportedURL)
        }
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let connection = factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            throw URLError(.cannotConnectToHost)
        }
        peer = connection
        let track = factory.audioTrack(with: factory.audioSource(with: constraints), trackId: "microphone")
        track.isEnabled = false
        microphone = track
        connection.add(track, streamIds: ["multivibe-voice"])
        let channelConfig = RTCDataChannelConfiguration()
        channelConfig.isOrdered = true
        guard let channel = connection.dataChannel(forLabel: "oai-events", configuration: channelConfig) else {
            throw URLError(.cannotConnectToHost)
        }
        events = channel
        channel.delegate = self
        let offer: RTCSessionDescription = try await withCheckedThrowingContinuation { continuation in
            connection.offer(for: constraints) { offer, error in
                if let offer { continuation.resume(returning: offer) }
                else { continuation.resume(throwing: error ?? URLError(.cannotConnectToHost)) }
            }
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.setLocalDescription(offer) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        let deadline = Date().addingTimeInterval(10)
        while connection.iceGatheringState != .complete {
            try Task.checkCancellation()
            guard peer === connection, Date() < deadline else { throw URLError(.timedOut) }
            try await Task.sleep(for: .milliseconds(50))
        }
        var request = URLRequest(url: credential.endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data((connection.localDescription?.sdp ?? offer.sdp).utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 201,
              let sdp = String(data: data, encoding: .utf8), sdp.hasPrefix("v=0"), peer === connection else {
            throw URLError(.badServerResponse)
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        let channelDeadline = Date().addingTimeInterval(15)
        while channel.readyState != .open {
            try Task.checkCancellation()
            guard peer === connection, Date() < channelDeadline else { throw URLError(.timedOut) }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    func send(_ data: Data) throws {
        guard let events, events.readyState == .open, events.bufferedAmount < 262_144,
              events.sendData(RTCDataBuffer(data: data, isBinary: false)) else { throw URLError(.networkConnectionLost) }
    }
    func setMuted(_ muted: Bool) { microphone?.isEnabled = !muted }
    func close() {
        microphone?.isEnabled = false
        microphone = nil
        events?.delegate = nil
        events?.close()
        events = nil
        peer?.delegate = nil
        peer?.close()
        peer = nil
    }
}

extension VoiceWebRTCTransport: RTCDataChannelDelegate {
    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}
    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        let data = buffer.data
        Task { @MainActor [weak self] in self?.onEvent?(data) }
    }
}

extension VoiceWebRTCTransport: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        if newState == .failed || newState == .closed {
            Task { @MainActor [weak self] in self?.onDisconnect?() }
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
