# Audio and live voice

MultiVibe's **Extensions → Audio** workspace configures the speech pipeline used
by a local GPT-Live-compatible voice server. It gives one place to choose the
reasoning, transcription, synthesis, and output-voice models instead of editing
environment variables by hand.

The workspace is a built-in plugin (`multivibe.audio`). It stores model choices,
shows the generated server environment, and can probe the local server's
`/health` endpoint. It does not start model runtimes or bundle Python.

## How it fits together

```text
GPT-Live client
  │  POST /v1/live/sessions        WebRTC SDP offer
  │  WS  /v1/live/sessions/{id}/attach
  ▼
Local GPT-Live server (OpenGPT-Voice compatibility layer)
  │
  ├─ VAD / turn detection
  ├─ Speech-to-text  ──► transcription model
  ├─ Reasoning       ──► MultiVibe routed model
  └─ Text-to-speech  ──► synthesis model + voice
```

The local server exposes the GPT-Live session contract:

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/live/sessions` | WebRTC offer/answer |
| `WS /v1/live/sessions` | WebSocket event channel |
| `WS /v1/live/sessions/{id}/attach` | Sideband event channel |
| `POST /internal/delegations/{id}/result` | Client-delegated result |
| `GET /health` | Liveness probe |

The `oai-events` data channel is optional. A client that only uses the sideband
socket can omit it. Input audio is 48 kHz Opus over WebRTC and is converted to
24 kHz PCM16 for the cascade; output PCM is upsampled back to 48 kHz.

MultiVibe's existing Realtime WebSocket gateway (`/v1/realtime`) is separate.
Use the Audio workspace when you want the GPT-Live session shape and a local
cascade; use `/v1/realtime` for OpenAI Realtime clients.

## Configure models

Open **Extensions → Audio**. The workspace exposes:

| Control | Server variable | Meaning |
| --- | --- | --- |
| Reasoning model | `OPENGPT_VOICE_RESPONSES_MODEL` | Local model used for low-latency voice turns |
| Escalation model | — | Stronger model used when a turn crosses the threshold |
| Escalation threshold | — | `0..1` heuristic threshold; higher keeps more turns local |
| Escalate complex requests | — | Publish `multivibe/voice` with local-first routing |
| Transcription | `OPENGPT_VOICE_ASR_MODEL` | Speech-to-text model |
| Synthesis | `OPENGPT_VOICE_TTS_MODEL` | Text-to-speech model |
| Output voice | `OPENGPT_VOICE_TTS_VOICE` | Default voice |
| Language | `OPENGPT_VOICE_ASR_LANGUAGE` | Optional transcription hint |
| Turn detection | `OPENGPT_VOICE_TURN_PROVIDER` | `vad` or `http` |
| Task delegation | `OPENGPT_VOICE_DELEGATION_MODE` | `responses` or `client` |
| Session limit | `OPENGPT_VOICE_MAX_SESSION_DURATION_S` | Maximum call length in seconds |
| Local server | — | Base URL used by the health check |

Model identifiers are suggestions; choose **Custom model…** to enter any
identifier your OpenAI-compatible server accepts. The reasoning model is
resolved by MultiVibe, so it must also exist in the MultiVibe model catalog.

When **Escalate complex requests** is enabled, the server environment uses
`multivibe/voice` instead of the local model name. The Rust edge resolves that
virtual model before provider selection:

- short greetings and simple commands stay on the configured local model;
- longer turns, multi-step questions, tool-enabled requests, or explicit
  reasoning requests are sent to the escalation model.

The decision is a local heuristic (length, French/English complexity keywords,
tool presence, reasoning flags, conversation depth, and multiple questions). It
adds no classifier call, so it does not consume the latency budget. The
threshold is stored in Host settings as `voiceEscalationThreshold`; the local and
advanced models are stored as `voiceLocalModel` and `voiceAdvancedModel`.

**Server environment** shows the exact variables to start the local server with.
The plugin never stores bearer tokens; set them in the host environment.

## Run the local server

The runtime is the OpenGPT-Voice compatibility layer. From a checkout:

```bash
python -m venv .venv
.venv/bin/pip install -e '.[webrtc]'
export OPENGPT_VOICE_BEARER_TOKEN='replace-with-a-long-random-token'
export OPENGPT_VOICE_ASR_PROVIDER=openai
export OPENGPT_VOICE_ASR_BASE_URL=http://127.0.0.1:8000/v1
export OPENGPT_VOICE_TTS_PROVIDER=openai
export OPENGPT_VOICE_TTS_BASE_URL=http://127.0.0.1:8880/v1
export OPENGPT_VOICE_RESPONSES_BASE_URL=http://127.0.0.1:1455/v1
.venv/bin/uvicorn open_gpt_voice.server:app --host 127.0.0.1 --port 8099
```

The ASR, TTS, and Responses URLs must point at OpenAI-compatible services. For
example, vLLM can serve Voxtral transcription and speech models; a local
OpenAI-compatible server can serve the reasoning model. MultiVibe routes the
reasoning call through its normal model catalog when
`OPENGPT_VOICE_RESPONSES_BASE_URL` points at the MultiVibe edge.

Then set **Local server** to `http://127.0.0.1:8099` and press **Test server**.
The token used for the probe is read from `AUDIO_GPT_LIVE_TOKEN` or
`OPENGPT_VOICE_BEARER_TOKEN`; it must match the server's bearer token.

## Delegation

- **Responses API** — the local server calls an OpenAI-compatible
  `POST /v1/responses` endpoint, relays streamed events as `response.event`,
  speaks `response.output_text.delta`, and keeps the turn in history.
- **Client callback** — the server emits `session.delegation.created` and waits
  for the client to post the result to `/internal/delegations/{id}/result`.

`session.update` can change only `delegation.responses` after start. Model,
instructions, audio, input, store, and delegation type are immutable.

## Security and limits

- Bind the local server to loopback unless you have added authentication and
  network controls. The default configuration is intended for one machine.
- Keep `OPENGPT_VOICE_BEARER_TOKEN` out of the dashboard and source control.
- The cascade is not a duplex speech model: barge-in stops playback when speech
  is detected, but the model does not listen while speaking.
- Turn-taking depends on the configured detector. The HTTP detector is only as
  good as its endpoint.
- WebRTC uses software codecs; echo cancellation and jitter buffering are the
  client's responsibility.
- One server process serves all sessions; there is no horizontal scaling or GPU
  scheduling.
- The local-first router is heuristic. It does not guarantee that every complex
  turn reaches the advanced model, and it never escalates a turn that is already
  served by a provider-held continuation without a fresh request.
- Compatibility is verified against the project's tests, not OpenAI production.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Test server returns 401 | Token in `AUDIO_GPT_LIVE_TOKEN` matches the server token |
| Test server returns 404 | Base URL points at the server root, not `/health` |
| No audio output | TTS URL/model/voice and the server's PCM format |
| Transcription is empty | ASR URL/model and the 24 kHz mono input contract |
| Delegation never completes | `OPENGPT_VOICE_RESPONSES_BASE_URL` and model availability |

## Related documentation

- [Realtime voice gateway](./realtime-voice-gateway.md) — MultiVibe's OpenAI
  Realtime WebSocket cascade.
- [Plugin API](./plugins-api.md) — built-in and installed plugin lifecycle.
- [OpenGPT-Voice GPT-Live compatibility](https://github.com/thibautrey/open-gpt-voice/blob/main/docs/gpt-live-compat.md)
  — endpoint and event reference for the local server.
