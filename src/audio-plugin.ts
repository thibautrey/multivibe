import type { ModuleManifest, MultivibeModule } from "./module-sdk.js";

export const AUDIO_PLUGIN = "multivibe.audio";

export type AudioModelOption = {
  id: string;
  name: string;
  voices?: readonly string[];
};

export const AUDIO_STT_MODELS: readonly AudioModelOption[] = [
  { id: "whisper-large-v3-turbo-asr-4bit", name: "Whisper large v3 turbo" },
  { id: "whisper-1", name: "Whisper (OpenAI-compatible)" },
  { id: "voxtral-mini-transcribe-3", name: "Voxtral Mini Transcribe" },
  { id: "parakeet-tdt-0.6b-v2", name: "Parakeet TDT 0.6B" },
];

export const AUDIO_TTS_MODELS: readonly AudioModelOption[] = [
  {
    id: "Kokoro-82M-bf16",
    name: "Kokoro 82M",
    voices: ["ff_siwis", "af_heart", "am_michael", "bf_emma"],
  },
  {
    id: "Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16",
    name: "Qwen3 TTS 0.6B",
    voices: ["serena", "vivian", "aiden"],
  },
  {
    id: "voxtral-mini-tts-3",
    name: "Voxtral Mini TTS",
    voices: ["marin", "emma"],
  },
  { id: "supertonic", name: "Supertonic" },
];

export const AUDIO_LANGUAGES = [
  { id: "auto", name: "Detect automatically" },
  { id: "fr", name: "French" },
  { id: "en", name: "English" },
  { id: "de", name: "German" },
  { id: "es", name: "Spanish" },
  { id: "it", name: "Italian" },
  { id: "pt", name: "Portuguese" },
  { id: "nl", name: "Dutch" },
] as const;

export const AUDIO_TURN_DETECTION = [
  { id: "vad", name: "Voice activity (VAD)" },
  { id: "http", name: "HTTP turn detector" },
] as const;

export const AUDIO_DELEGATION_MODES = [
  { id: "responses", name: "Responses API" },
  { id: "client", name: "Client callback" },
] as const;

export const AUDIO_DEFAULT_SETTINGS = {
  llmModel: "",
  sttModel: "whisper-large-v3-turbo-asr-4bit",
  ttsModel: "Kokoro-82M-bf16",
  ttsVoice: "ff_siwis",
  language: "auto",
  turnDetection: "vad",
  delegationMode: "responses",
  serverUrl: "",
  maxSessionSeconds: 3600,
} as const;

const modelSetting = (title: string, description: string) => ({
  type: "string",
  title,
  description,
  format: "multivibe-model",
});

const choiceSetting = (
  title: string,
  description: string,
  values: readonly { id: string; name: string }[],
) => ({
  type: "string",
  title,
  description,
  enum: values.map((value) => value.id),
});

export const audioPluginManifest: ModuleManifest = {
  id: AUDIO_PLUGIN,
  name: "Audio & live voice",
  version: "1.0.0",
  apiVersion: 1,
  description:
    "Configure the speech-to-text, reasoning, and text-to-speech models behind a local GPT-Live voice server.",
  repository: "https://github.com/thibautrey/multivibe",
  entrypoint: "audio-plugin.js",
  hooks: [],
  categories: ["Audio"],
  tags: ["voice", "stt", "tts", "gpt-live", "local"],
  defaultEnabled: true,
  defaultSettings: { ...AUDIO_DEFAULT_SETTINGS },
  settingsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      llmModel: modelSetting(
        "Reasoning model",
        "Answers after transcription, routed through MultiVibe.",
      ),
      sttModel: {
        type: "string",
        title: "Transcription model",
        description: "Speech-to-text model used by the local server.",
      },
      ttsModel: {
        type: "string",
        title: "Synthesis model",
        description: "Text-to-speech model used by the local server.",
      },
      ttsVoice: {
        type: "string",
        title: "Output voice",
        description: "Default voice passed to the synthesis model.",
      },
      language: choiceSetting(
        "Transcription language",
        "Optional language hint for speech-to-text.",
        AUDIO_LANGUAGES,
      ),
      turnDetection: choiceSetting(
        "Turn detection",
        "How the server decides that the user finished speaking.",
        AUDIO_TURN_DETECTION,
      ),
      delegationMode: choiceSetting(
        "Task delegation",
        "Where delegated reasoning runs.",
        AUDIO_DELEGATION_MODES,
      ),
      serverUrl: {
        type: "string",
        title: "Local GPT-Live server",
        description: "Base HTTP URL used for the health check, for example http://127.0.0.1:8099.",
      },
      maxSessionSeconds: {
        type: "integer",
        title: "Session limit (seconds)",
        minimum: 60,
        maximum: 3600,
      },
    },
  },
};

export function createAudioPlugin(): MultivibeModule {
  // The dashboard and the local GPT-Live server own the runtime. This built-in
  // module is the durable configuration surface; it deliberately runs no
  // inference hooks in the host process.
  return {};
}

export function audioServerEnv(
  settings: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const text = (key: string) =>
    typeof settings[key] === "string" ? String(settings[key]).trim() : "";
  const language = text("language");
  const env: Record<string, string> = {
    OPENGPT_VOICE_ASR_MODEL: text("sttModel"),
    OPENGPT_VOICE_TTS_MODEL: text("ttsModel"),
    OPENGPT_VOICE_TTS_VOICE: text("ttsVoice"),
    OPENGPT_VOICE_DELEGATION_MODE: text("delegationMode"),
    OPENGPT_VOICE_RESPONSES_MODEL: text("llmModel"),
    OPENGPT_VOICE_TURN_PROVIDER: text("turnDetection"),
  };
  if (language && language !== "auto") env.OPENGPT_VOICE_ASR_LANGUAGE = language;
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value));
}

export function normalizeAudioServerUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Audio server URL must be a valid HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Audio server URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Audio server URL cannot contain credentials, query, or fragment");
  }
  return url.toString().replace(/\/+$/u, "");
}
