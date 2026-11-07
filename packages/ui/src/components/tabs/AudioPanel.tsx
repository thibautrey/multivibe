import { useEffect, useState } from "react";
import { useDashboardApi } from "../../adapter";
import type { ModuleView } from "../../types";
import { ModelSelect } from "../ModelSelect";

const AUDIO_PLUGIN = "multivibe.audio";

type AudioOption = { id: string; name: string; voices?: string[] };
type AudioSettings = {
  llmModel: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  language: string;
  turnDetection: string;
  delegationMode: string;
  serverUrl: string;
  maxSessionSeconds: number;
};
type AudioPayload = {
  module: ModuleView;
  settings: AudioSettings;
  catalog: {
    stt: AudioOption[];
    tts: AudioOption[];
    languages: AudioOption[];
    turnDetection: AudioOption[];
    delegationModes: AudioOption[];
  };
  env: Record<string, string>;
  server: { configured: boolean; url: string };
};
type TestResult = { ok: boolean; status: number | null; latencyMs: number; error?: string };

function ModelPicker({
  id,
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  options: AudioOption[];
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const known = options.some((option) => option.id === value);
  const [customMode, setCustomMode] = useState(Boolean(value) && !known);
  useEffect(() => { if (known) setCustomMode(false); }, [known]);
  const showCustom = customMode || (Boolean(value) && !known);
  return (
    <label className="control-field" htmlFor={id}>
      <span className="control-label">{label}</span>
      <select
        id={id}
        value={showCustom ? "__custom" : value}
        disabled={disabled}
        onChange={(event) => {
          if (event.target.value === "__custom") {
            setCustomMode(true);
            if (known) onChange("");
          } else {
            setCustomMode(false);
            onChange(event.target.value);
          }
        }}
      >
        <option value="">Not configured</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>{option.name}</option>
        ))}
        <option value="__custom">Custom model…</option>
      </select>
      {showCustom && (
        <input
          id={`${id}-custom`}
          value={value}
          disabled={disabled}
          placeholder="Model identifier"
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <span className="audio-hint">{hint}</span>
    </label>
  );
}

function statusLabel(module: ModuleView) {
  if (!module.enabled) return "Disabled";
  if (module.healthy) return "Active";
  return "Unavailable";
}

export function AudioPanel({ module, onReload }: { module: ModuleView; onReload: () => Promise<void> }) {
  const api = useDashboardApi();
  const [payload, setPayload] = useState<AudioPayload | null>(null);
  const [settings, setSettings] = useState<AudioSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [test, setTest] = useState<TestResult | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setError("");
    const value = await api("audio") as AudioPayload;
    setPayload(value);
    setSettings(value.settings);
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    api("audio")
      .then((value: AudioPayload) => {
        if (!active) return;
        setPayload(value);
        setSettings(value.settings);
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  if (loading) return <section className="panel audio-panel"><p className="muted">Loading audio settings…</p></section>;
  if (!payload || !settings) {
    return <section className="panel audio-panel">
      <h2>Audio & live voice</h2>
      <p className="error" role="alert">{error || "The audio plugin is unavailable."}</p>
    </section>;
  }

  const currentModule = payload.module;
  const tts = payload.catalog.tts.find((option) => option.id === settings.ttsModel);
  const voices: AudioOption[] = (tts?.voices ?? []).map((voice) => ({ id: voice, name: voice }));
  const update = (key: keyof AudioSettings, value: string | number) =>
    setSettings((previous) => previous ? { ...previous, [key]: value } : previous);

  const save = async () => {
    setBusy("save"); setError(""); setNotice(""); setTest(null);
    try {
      const value = await api("audio", { method: "PATCH", body: JSON.stringify({ settings }) }) as AudioPayload;
      setPayload(value); setSettings(value.settings); await onReload(); setNotice("Audio settings saved.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(""); }
  };

  const toggle = async () => {
    setBusy("toggle"); setError(""); setNotice("");
    try {
      await api(`modules/${encodeURIComponent(AUDIO_PLUGIN)}`, { method: "PATCH", body: JSON.stringify({ enabled: !currentModule.enabled }) });
      await load(); await onReload();
      setNotice(currentModule.enabled ? "Audio plugin disabled." : "Audio plugin enabled.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(""); }
  };

  const testServer = async () => {
    setBusy("test"); setError(""); setNotice(""); setTest(null);
    try {
      const value = await api("audio/test", { method: "POST", body: JSON.stringify({ serverUrl: settings.serverUrl }) }) as TestResult;
      setTest(value);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(""); }
  };

  const copyEnv = async () => {
    await navigator.clipboard.writeText(Object.entries(payload.env).map(([key, value]) => `${key}=${value}`).join("\n"));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return <section className="panel audio-panel" aria-label="Audio and live voice settings">
    <header className="audio-panel-header">
      <div>
        <span className="eyebrow">Audio</span>
        <h2>Live voice</h2>
        <p className="muted">Configure the speech pipeline behind the local GPT-Live server.</p>
      </div>
      <div className="audio-panel-status">
        <span className={`badge ${currentModule.enabled && currentModule.healthy ? "badge-live" : ""}`}>{statusLabel(currentModule)}</span>
        <button className={`btn ${currentModule.enabled ? "secondary" : ""}`} type="button" disabled={Boolean(busy)} onClick={() => void toggle()}>
          {busy === "toggle" ? "Working…" : currentModule.enabled ? "Disable" : "Enable"}
        </button>
      </div>
    </header>

    <div className="audio-grid">
      <label className="control-field" htmlFor="audio-llm-model">
        <span className="control-label">Reasoning model</span>
        <ModelSelect id="audio-llm-model" value={settings.llmModel} onChange={(value) => update("llmModel", value)} disabled={Boolean(busy)} />
        <span className="audio-hint">Answers after transcription, routed through MultiVibe.</span>
      </label>
      <label className="control-field" htmlFor="audio-language">
        <span className="control-label">Transcription language</span>
        <select id="audio-language" value={settings.language} disabled={Boolean(busy)} onChange={(event) => update("language", event.target.value)}>
          {payload.catalog.languages.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
        <span className="audio-hint">Optional hint; automatic detection is the default.</span>
      </label>
      <ModelPicker id="audio-stt-model" label="Transcription" hint="Speech-to-text model." value={settings.sttModel} options={payload.catalog.stt} disabled={Boolean(busy)} onChange={(value) => update("sttModel", value)} />
      <ModelPicker id="audio-tts-model" label="Synthesis" hint="Text-to-speech model." value={settings.ttsModel} options={payload.catalog.tts} disabled={Boolean(busy)} onChange={(value) => update("ttsModel", value)} />
      <ModelPicker id="audio-tts-voice" label="Output voice" hint="Default voice for spoken replies." value={settings.ttsVoice} options={voices} disabled={Boolean(busy)} onChange={(value) => update("ttsVoice", value)} />
      <label className="control-field" htmlFor="audio-turn-detection">
        <span className="control-label">Turn detection</span>
        <select id="audio-turn-detection" value={settings.turnDetection} disabled={Boolean(busy)} onChange={(event) => update("turnDetection", event.target.value)}>
          {payload.catalog.turnDetection.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
        <span className="audio-hint">How the server decides the user finished speaking.</span>
      </label>
    </div>

    <details className="audio-advanced">
      <summary>Advanced</summary>
      <div className="audio-advanced-grid">
        <label className="control-field" htmlFor="audio-server-url">
          <span className="control-label">Local GPT-Live server</span>
          <input id="audio-server-url" value={settings.serverUrl} disabled={Boolean(busy)} placeholder="http://127.0.0.1:8099" onChange={(event) => update("serverUrl", event.target.value)} />
          <span className="audio-hint">Base URL used for the health check. The token stays in the host environment.</span>
        </label>
        <label className="control-field" htmlFor="audio-delegation">
          <span className="control-label">Task delegation</span>
          <select id="audio-delegation" value={settings.delegationMode} disabled={Boolean(busy)} onChange={(event) => update("delegationMode", event.target.value)}>
            {payload.catalog.delegationModes.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
          <span className="audio-hint">Responses API or a client callback.</span>
        </label>
        <label className="control-field" htmlFor="audio-session-limit">
          <span className="control-label">Session limit (seconds)</span>
          <input id="audio-session-limit" type="number" min={60} max={3600} step={60} value={settings.maxSessionSeconds} disabled={Boolean(busy)} onChange={(event) => update("maxSessionSeconds", Number(event.target.value))} />
        </label>
      </div>
    </details>

    <div className="audio-actions">
      <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save settings"}</button>
      <button className="btn ghost" type="button" disabled={Boolean(busy) || !settings.serverUrl} onClick={() => void testServer()}>{busy === "test" ? "Testing…" : "Test server"}</button>
      {test && <span className={`audio-test ${test.ok ? "ok" : "error"}`} role="status">{test.ok ? `Reachable · ${test.status} · ${test.latencyMs} ms` : test.error ? `Unreachable · ${test.error}` : `Unreachable · HTTP ${test.status}`}</span>}
      {error && <span className="error" role="alert">{error}</span>}
      {notice && <span className="audio-notice" role="status">{notice}</span>}
    </div>

    <details className="audio-env">
      <summary>Server environment</summary>
      <div className="audio-env-copy">
        <pre>{Object.entries(payload.env).map(([key, value]) => `${key}=${value}`).join("\n")}</pre>
        <button className="btn ghost" type="button" onClick={() => void copyEnv()}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <p className="audio-hint">Start the local server with these values, or use them to verify its configuration.</p>
    </details>
  </section>;
}
