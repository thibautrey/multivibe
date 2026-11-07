import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { ModuleManager } from "./module-manager.js";
import { audioPluginManifest, createAudioPlugin } from "./audio-plugin.js";
import { audioRoutes } from "./audio-routes.js";

async function withAudioServer(run: (baseUrl: string, moduleManager: ModuleManager) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "multivibe-audio-routes-"));
  const moduleManager = new ModuleManager(root);
  moduleManager.registerBuiltin(audioPluginManifest, createAudioPlugin());
  await moduleManager.initialize();
  const app = express();
  app.use(express.json());
  app.use("/admin/audio", audioRoutes({ moduleManager }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`, moduleManager);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("audio route exposes settings, catalog, and server environment without secrets", async () => {
  await withAudioServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/audio`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.module.id, "multivibe.audio");
    assert.equal(body.settings.ttsModel, "Kokoro-82M-bf16");
    assert.equal(body.catalog.stt.length, 4);
    assert.equal(body.catalog.tts[0].voices[0], "ff_siwis");
    assert.equal(body.env.OPENGPT_VOICE_ASR_MODEL, "whisper-large-v3-turbo-asr-4bit");
    assert.equal(JSON.stringify(body).includes("token"), false);
  });
});

test("audio route rejects malformed server URLs and saves valid settings", async () => {
  await withAudioServer(async (baseUrl) => {
    const invalid = await fetch(`${baseUrl}/admin/audio`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { serverUrl: "http://user:pass@127.0.0.1:8099" } }),
    });
    assert.equal(invalid.status, 400);

    const saved = await fetch(`${baseUrl}/admin/audio`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: {
        llmModel: "qwen3-32b",
        sttModel: "voxtral-mini-transcribe-3",
        ttsModel: "voxtral-mini-tts-3",
        ttsVoice: "marin",
        language: "fr",
        turnDetection: "vad",
        delegationMode: "responses",
        serverUrl: "http://127.0.0.1:8099/",
        maxSessionSeconds: 900,
      } }),
    });
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.equal(body.settings.serverUrl, "http://127.0.0.1:8099");
    assert.equal(body.settings.ttsVoice, "marin");
    assert.equal(body.env.OPENGPT_VOICE_ASR_LANGUAGE, "fr");
  });
});

test("audio route probes the configured server health endpoint", async () => {
  const health = http.createServer((request, response) => {
    response.writeHead(request.url === "/health" ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
  });
  health.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => health.once("listening", resolve));
  const address = health.address();
  assert.ok(address && typeof address !== "string");
  try {
    await withAudioServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/audio/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serverUrl: `http://127.0.0.1:${address.port}` }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.status, 200);
      assert.equal(body.url, `http://127.0.0.1:${address.port}`);
    });
  } finally {
    await new Promise<void>((resolve) => health.close(() => resolve()));
  }
});
