# Voice through an account-owned instance

iOS uses the selected remote chat's machine for voice. The account token goes to
the fixed MultiVibe HTTPS/WSS origin, and the existing device credential remains
in device-only Keychain. Cloud verifies account ownership and the registered
machine; the companion rereads the Host's pairing file, including renewal grace,
expiry and revocation. Neither a QR nor a client can provide an adapter URL.

The independent `dist/host/instance-voice-main.js` companion opens one outbound
WebSocket. It never polls completion jobs or restarts the Host or speech runtime.
It starts a separate Rust voice edge bound to loopback, with separate private
state. Whisper transcribes audio; installed Kokoro and Qwen3 TTS voices are
discovered from the local oMLX runtime. The explicitly configured language model
uses the existing edge router. Credentials and audio adapter URLs stay on the Mac.

The owner configures `instance-voice.json` in the Host data directory with an
explicit `llm` object (`model`, `baseUrl`, `apiKeyEnvironmentFile`, `apiKeyName`).
The file contains references to an existing private credential source. Optional
`speechOrigin` must be a loopback HTTP origin; `edgePort` defaults to 1457.
Run the companion with the Host's bundled Node runtime after starting oMLX.

The Cloud duplex relay runs separately under `/relay/voice/v1`. It reserves the
next Personal Relay message before accepting audio, commits on each spoken or
typed turn, and releases an unused reservation when the session closes. Exhaustion
stops new input. Sessions are bounded to fifteen minutes, one per account and
four per relay process. Loss of either connection closes the media session;
user requests are never replayed. The initial deployment uses one replica because
its live connections are held in memory.

Audio and draft transcripts are transient. The existing iOS ledger persists final
user text and completed, played assistant text into the originating remote chat,
with stable IDs. Cancelled speech is excluded. Cloud does not store the text in a
voice-history service. The relay can observe transient audio, as with existing
Personal Relay payloads; this is not an end-to-end encrypted audio transport.

Background audio and tool execution remain disabled for this instance transport.
Voice selection is scoped to account and machine and applies to the next session.
