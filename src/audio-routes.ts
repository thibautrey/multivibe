import express from "express";
import type { ModuleManager } from "./module-manager.js";
import {
  AUDIO_DELEGATION_MODES,
  AUDIO_LANGUAGES,
  AUDIO_PLUGIN,
  AUDIO_STT_MODELS,
  AUDIO_TTS_MODELS,
  AUDIO_TURN_DETECTION,
  audioPluginManifest,
  audioServerEnv,
  normalizeAudioServerUrl,
} from "./audio-plugin.js";

export type AudioRoutesOptions = {
  moduleManager?: ModuleManager;
  env?: NodeJS.ProcessEnv;
  request?: typeof fetch;
};

const TOKEN_ENV_KEYS = ["AUDIO_GPT_LIVE_TOKEN", "OPENGPT_VOICE_BEARER_TOKEN"] as const;

function audioModule(moduleManager: ModuleManager | undefined) {
  const module = moduleManager?.list().find((entry) => entry.id === AUDIO_PLUGIN);
  if (!module) throw new Error("Audio plugin is unavailable");
  return module;
}

function settingsFor(moduleManager: ModuleManager | undefined) {
  const module = audioModule(moduleManager);
  return { ...audioPluginManifest.defaultSettings, ...module.settings };
}

function payload(moduleManager: ModuleManager | undefined) {
  const module = audioModule(moduleManager);
  const settings = settingsFor(moduleManager);
  return {
    module,
    settings,
    catalog: {
      stt: AUDIO_STT_MODELS,
      tts: AUDIO_TTS_MODELS,
      languages: AUDIO_LANGUAGES,
      turnDetection: AUDIO_TURN_DETECTION,
      delegationModes: AUDIO_DELEGATION_MODES,
    },
    env: audioServerEnv(settings),
    server: {
      configured: Boolean(settings.serverUrl),
      url: settings.serverUrl,
    },
  };
}

async function probe(
  url: string,
  env: NodeJS.ProcessEnv,
  request: typeof fetch,
): Promise<{ ok: boolean; status: number | null; latencyMs: number; error?: string }> {
  const token = TOKEN_ENV_KEYS.map((key) => env[key]).find((value) => value?.trim());
  const started = Date.now();
  try {
    const response = await request(`${url}/health`, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token.trim()}` } : {}),
      },
    });
    return { ok: response.ok, status: response.status, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function audioRoutes({ moduleManager, env = process.env, request = fetch }: AudioRoutesOptions) {
  const router = express.Router();

  router.get("/", (_req, res) => {
    if (!moduleManager) return res.status(503).json({ error: "Module manager is unavailable" });
    try {
      return res.json(payload(moduleManager));
    } catch (error) {
      return res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.patch("/", async (req, res) => {
    if (!moduleManager) return res.status(503).json({ error: "Module manager is unavailable" });
    try {
      const incoming = req.body?.settings;
      if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
        throw new Error("Settings must be an object");
      }
      const current = settingsFor(moduleManager);
      const settings = { ...current, ...incoming } as Record<string, unknown>;
      settings.serverUrl = normalizeAudioServerUrl(settings.serverUrl);
      await moduleManager.setSettings(AUDIO_PLUGIN, settings);
      return res.json(payload(moduleManager));
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/test", async (req, res) => {
    if (!moduleManager) return res.status(503).json({ error: "Module manager is unavailable" });
    try {
      const candidate = req.body?.serverUrl ?? settingsFor(moduleManager).serverUrl;
      const url = normalizeAudioServerUrl(candidate);
      if (!url) throw new Error("Configure the local GPT-Live server URL first");
      return res.json({ url, ...(await probe(url, env, request)) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
