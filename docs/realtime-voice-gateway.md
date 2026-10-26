# Realtime voice gateway

MultiVibe can expose an OpenAI Realtime-compatible WebSocket while composing
independent speech-to-text, routed language-model, and text-to-speech services.
The client connects to the normal Rust edge and does not receive provider
credentials or adapter URLs.

The implementation follows the public Realtime conversation contract rather
than attempting to reproduce private ChatGPT Voice or GPT-Live behavior:

- [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [Realtime WebSocket transport](https://developers.openai.com/api/docs/guides/voice-websockets?api=realtime)
- [Realtime client and server events](https://developers.openai.com/api/reference/resources/realtime)

## Architecture

```text
OpenAI Realtime client
        |
        |  GET /v1/realtime?model=multivibe/voice
        v
MultiVibe Rust edge
  auth, session limits, conversation state, cancellation
        |
        +--> STT adapter (OpenAI-compatible audio transcription)
        |
        +--> existing MultiVibe /v1/responses router
        |      aliases, provider selection, admission, failover, tracing
        |
        +--> TTS adapter (OpenAI-compatible speech synthesis)
```

The LLM request never bypasses MultiVibe routing. STT and TTS endpoints are
startup configuration and cannot be supplied by a Realtime client. Adapter API
keys remain server-side and are redacted from configuration debug output.

## Configuration

The gateway is disabled unless both adapter URLs are present, or
`REALTIME_CASCADE_ENABLED=true` is set. Enabling it without both URLs makes
the Realtime routes return a configuration error.

| Variable | Default | Purpose |
| --- | --- | --- |
| `REALTIME_CASCADE_ENABLED` | auto | Enable the cascaded voice gateway |
| `REALTIME_CASCADE_MODEL` | `multivibe/voice` | Public virtual model ID |
| `REALTIME_CASCADE_LLM_MODEL` | first proxy model | MultiVibe model or alias used by the LLM stage |
| `REALTIME_STT_URL` | — | Full OpenAI-compatible transcription endpoint |
| `REALTIME_STT_API_KEY` | — | Optional STT bearer token |
| `REALTIME_STT_MODEL` | `whisper-1` | STT model sent in multipart requests |
| `REALTIME_TTS_URL` | — | Full OpenAI-compatible speech endpoint |
| `REALTIME_TTS_API_KEY` | — | Optional TTS bearer token |
| `REALTIME_TTS_MODEL` | `kokoro` | TTS model |
| `REALTIME_TTS_VOICE` | `af_heart` | Default TTS voice |
| `REALTIME_TTS_RESPONSE_FORMAT` | `pcm` | `pcm` for streaming raw PCM or `wav` for buffered WAV |
| `REALTIME_MAX_AUDIO_BYTES` | 12 MiB | Per-turn input and per-response output limit |
| `REALTIME_MAX_CONVERSATION_ITEMS` | 128 | Per-session context bound |
| `REALTIME_MAX_SESSION_SECONDS` | 3600 | Session lifetime, capped at one hour |
| `REALTIME_ADAPTER_TIMEOUT_MS` | 120000 | STT/TTS request deadline |
| `REALTIME_CLIENT_SECRET_TTL_SECONDS` | 600 | Default and maximum ephemeral client-secret lifetime |

Both adapters must accept or return PCM16 mono at 24 kHz. The STT adapter is
called as an OpenAI multipart transcription request with a WAV file. The TTS
adapter receives an OpenAI speech JSON request. A `pcm` response is streamed
as raw PCM; a `wav` response is validated and its data chunk is extracted.

Example:

```dotenv
REALTIME_CASCADE_ENABLED=true
REALTIME_CASCADE_MODEL=multivibe/voice
REALTIME_CASCADE_LLM_MODEL=qwen3.8-27b
REALTIME_STT_URL=http://stt.internal:8000/v1/audio/transcriptions
REALTIME_STT_MODEL=nvidia/parakeet-tdt-0.6b-v2
REALTIME_TTS_URL=http://tts.internal:8880/v1/audio/speech
REALTIME_TTS_MODEL=kokoro
REALTIME_TTS_VOICE=af_heart
```

## Connecting

Server-side clients authenticate exactly like other MultiVibe endpoints:

```javascript
const socket = new WebSocket(
  "wss://gateway.example/v1/realtime?model=multivibe%2Fvoice",
  {
    headers: {
      Authorization: "Bearer MULTIVIBE_API_KEY",
      "OpenAI-Beta": "realtime=v1",
    },
  },
);
```

An authenticated backend can mint a one-time, model-bound secret for a client:

```http
POST /v1/realtime/client_secrets
Authorization: Bearer MULTIVIBE_API_KEY
Content-Type: application/json

{"session":{"type":"realtime","model":"multivibe/voice"}}
```

The returned `ek_...` value is stored only as a SHA-256 digest. It is
model-bound, carries the validated session defaults, and can create multiple
sessions until it expires, matching the OpenAI client-secret lifecycle. A
request may shorten its lifetime with
`expires_after: {"anchor":"created_at","seconds":...}`. MultiVibe also
accepts it in the `client_secret` query parameter for clients that cannot add
an authorization header. Avoid logging full WebSocket URLs when using that
transport.

## Supported session behavior

The WebSocket sends `session.created` immediately and accepts:

- `session.update`
- `conversation.item.create`, `conversation.item.delete`, and
  `conversation.item.truncate`
- `input_audio_buffer.append`, `input_audio_buffer.commit`, and
  `input_audio_buffer.clear`
- `response.create` and `response.cancel`

It emits the matching session, conversation, transcription, response item,
audio, transcript, function-call, completion, and error events. Current
`conversation.item.added` / `conversation.item.done` events are emitted;
`conversation.item.created` is also emitted for pre-GA clients.

`server_vad` is available through a bounded PCM energy detector with
configurable threshold, prefix padding, and silence duration. Starting a new
speech turn aborts the LLM and TTS tasks, advances the response generation, and
discards late events from the cancelled generation. `semantic_vad` is rejected
explicitly until a semantic detector is configured. Clients can set turn
detection to `null` for push-to-talk.

LLM text deltas are exposed as audio transcript deltas and are divided at
sentence boundaries before TTS, so speech can begin before the LLM finishes.
Function calls continue through the Responses protocol and are returned with
their stable call IDs. Clients provide results with a
`function_call_output` conversation item before creating the next response.

## Transport boundary

The cascaded pipeline currently terminates the OpenAI Realtime WebSocket at
`GET /v1/realtime`. Existing `POST /v1/realtime/calls` behavior remains the
native-provider WebRTC SDP proxy. Cascaded WebRTC media termination would
require an ICE/DTLS/SRTP media service and is not silently emulated by the
WebSocket implementation.

The gateway reports generated and transmitted PCM bytes. A WebSocket server
cannot know how much audio a client actually played, so clients remain
responsible for stopping playback and sending
`conversation.item.truncate` with the observed playback position.
