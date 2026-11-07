import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModuleManager } from "./module-manager.js";
import {
  AUDIO_PLUGIN,
  audioPluginManifest,
  audioServerEnv,
  createAudioPlugin,
  normalizeAudioServerUrl,
} from "./audio-plugin.js";

test("audio plugin is a discoverable built-in with a model schema", () => {
  assert.equal(audioPluginManifest.id, AUDIO_PLUGIN);
  assert.equal(audioPluginManifest.defaultEnabled, true);
  assert.deepEqual(audioPluginManifest.hooks, []);
  assert.equal(audioPluginManifest.categories?.[0], "Audio");
  const properties = (audioPluginManifest.settingsSchema as any).properties;
  assert.equal(properties.llmModel.format, "multivibe-model");
  assert.equal(properties.sttModel.type, "string");
  assert.equal(properties.ttsModel.type, "string");
  assert.equal(properties.ttsVoice.type, "string");
  assert.deepEqual(createAudioPlugin(), {});
});

test("audio settings map to the local GPT-Live environment", () => {
  assert.deepEqual(audioServerEnv({
    sttModel: "whisper-1",
    ttsModel: "Kokoro-82M-bf16",
    ttsVoice: "ff_siwis",
    language: "fr",
    turnDetection: "vad",
    delegationMode: "responses",
    llmModel: "qwen3-32b",
    maxSessionSeconds: 3600,
  }), {
    OPENGPT_VOICE_ASR_MODEL: "whisper-1",
    OPENGPT_VOICE_TTS_MODEL: "Kokoro-82M-bf16",
    OPENGPT_VOICE_TTS_VOICE: "ff_siwis",
    OPENGPT_VOICE_DELEGATION_MODE: "responses",
    OPENGPT_VOICE_RESPONSES_MODEL: "qwen3-32b",
    OPENGPT_VOICE_TURN_PROVIDER: "vad",
    OPENGPT_VOICE_MAX_SESSION_DURATION_S: "3600",
    OPENGPT_VOICE_ASR_LANGUAGE: "fr",
  });
  assert.equal(audioServerEnv({ language: "auto" }).OPENGPT_VOICE_ASR_LANGUAGE, undefined);
});

test("audio server URLs are bounded to credential-free HTTP(S)", () => {
  assert.equal(normalizeAudioServerUrl("http://127.0.0.1:8099/"), "http://127.0.0.1:8099");
  assert.equal(normalizeAudioServerUrl(" https://voice.example.test/base/ "), "https://voice.example.test/base");
  assert.equal(normalizeAudioServerUrl(""), "");
  for (const value of [
    "ftp://127.0.0.1:8099",
    "http://user:pass@127.0.0.1:8099",
    "http://127.0.0.1:8099/?token=secret",
    "http://127.0.0.1:8099/#fragment",
    "not a url",
  ]) {
    assert.throws(() => normalizeAudioServerUrl(value));
  }
});

test("audio plugin is enabled on first discovery and persists model choices", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-audio-"));
  try {
    const manager = new ModuleManager(root);
    manager.registerBuiltin(audioPluginManifest, createAudioPlugin());
    await manager.initialize();
    const [module] = manager.list();
    assert.equal(module.id, AUDIO_PLUGIN);
    assert.equal(module.enabled, true);
    assert.equal(module.loaded, true);
    assert.equal(module.settings.ttsModel, "Kokoro-82M-bf16");

    await manager.setSettings(AUDIO_PLUGIN, {
      ...module.settings,
      llmModel: "qwen3-32b",
      sttModel: "voxtral-mini-transcribe-3",
      ttsVoice: "marin",
      maxSessionSeconds: 900,
    });
    const restarted = new ModuleManager(root);
    restarted.registerBuiltin(audioPluginManifest, createAudioPlugin());
    await restarted.initialize();
    assert.equal(restarted.list()[0].settings.llmModel, "qwen3-32b");
    assert.equal(restarted.list()[0].settings.ttsVoice, "marin");
    await assert.rejects(
      restarted.setSettings(AUDIO_PLUGIN, { ...restarted.list()[0].settings, maxSessionSeconds: 30 }),
      /out of range/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
