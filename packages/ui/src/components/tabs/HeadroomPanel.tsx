import { useCallback, useEffect, useState } from "react";
import { useDashboardApi } from "../../adapter";
import type { ModuleView } from "../../types";

const HEADROOM_PLUGIN = "multivibe.headroom";

type HeadroomMode = "" | "lossless" | "lossy_inline" | "lossless_then_lossy";

type PublicSettings = {
  manageContainer: boolean;
  serverUrl: string;
  hasProxyToken: boolean;
  mode: HeadroomMode;
  timeoutMs: number;
  minBytes: number;
  image: string;
};

type Status = {
  module: string;
  installed: boolean;
  settings: PublicSettings;
  docker: { available: boolean; socket: string | null; version?: string; error?: string };
  container: { name: string; exists: boolean; running: boolean; id?: string; image?: string; status?: string; health?: string };
  service: { url: string | null; origin: "managed" | "manual" | null; healthy: boolean; status: number | null; latencyMs: number; error?: string };
  edge: { available: boolean; enabled: boolean; url: string | null; mode: string | null; error?: string };
  operation: { phase: string; message?: string; error?: string; startedAt?: string; finishedAt?: string };
};

const MODES: Array<{ value: HeadroomMode; label: string }> = [
  { value: "", label: "Headroom default" },
  { value: "lossless", label: "Lossless only" },
  { value: "lossy_inline", label: "Lossy, inline" },
  { value: "lossless_then_lossy", label: "Lossless first, then lossy" },
];

const BUSY_PHASES = new Set(["pulling", "creating", "starting", "stopping"]);

function phaseLabel(phase: string): string {
  switch (phase) {
    case "pulling": return "Pulling image…";
    case "creating": return "Creating container…";
    case "starting": return "Starting…";
    case "stopping": return "Stopping…";
    case "ready": return "Ready";
    case "error": return "Error";
    default: return "Idle";
  }
}

export function HeadroomPanel({ module, onReload }: { module: ModuleView; onReload: () => Promise<void> }) {
  const api = useDashboardApi();
  const [status, setStatus] = useState<Status | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [probe, setProbe] = useState<{ ok: boolean; status: number | null; latencyMs: number; error?: string } | null>(null);

  const load = useCallback(async () => {
    const next = (await api("headroom")) as Status;
    setStatus(next);
    setSettings((current) => current ?? next.settings);
  }, [api]);

  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }, [load]);

  useEffect(() => {
    if (!status || !BUSY_PHASES.has(status.operation.phase)) return;
    const timer = setInterval(() => { void load().catch(() => undefined); }, 1500);
    return () => clearInterval(timer);
  }, [status, load]);

  const run = async (name: string, operation: () => Promise<unknown>, success?: string) => {
    setBusy(name); setError(""); setNotice(""); setProbe(null);
    try {
      await operation();
      await load();
      await onReload();
      if (success) setNotice(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    const payload: Record<string, unknown> = {
      manageContainer: settings.manageContainer,
      serverUrl: settings.serverUrl,
      mode: settings.mode,
      timeoutMs: settings.timeoutMs,
      minBytes: settings.minBytes,
      image: settings.image,
    };
    await run("save", async () => {
      await api(`modules/${encodeURIComponent(HEADROOM_PLUGIN)}`, { method: "PATCH", body: JSON.stringify({ settings: payload }) });
      // The manual token is stored beside the generated one, outside the
      // module settings, and only ever pushed to the edge.
      if (token.trim()) {
        await api("headroom/apply", { method: "POST", body: JSON.stringify({ proxyToken: token.trim() }) });
        setToken("");
      }
    }, "Settings saved.");
  };

  /** Enabling the module also installs and starts Headroom through the module route. */
  const toggle = async () => {
    await run("toggle", () => api(`modules/${encodeURIComponent(HEADROOM_PLUGIN)}`, { method: "PATCH", body: JSON.stringify({ enabled: !module.enabled }) }), module.enabled ? "Extension disabled." : "Extension enabled.");
  };

  if (!status || !settings) {
    return <div className="panel plugins-empty"><h3>Headroom</h3><p className="muted">{error || "Loading extension status…"}</p></div>;
  }

  const busyPhase = BUSY_PHASES.has(status.operation.phase);
  const disabled = Boolean(busy) || busyPhase;
  const canManage = status.docker.available;

  return <div className="plugins-workspace">
    <section className="panel plugins-hero">
      <div>
        <span className="eyebrow">Performance extension</span>
        <h2>Headroom compression</h2>
        <p className="muted">MultiVibe sends the provider-ready body through a managed Headroom sidecar before the upstream call. Routing, authentication and quota stay in MultiVibe, and a Headroom failure never fails a request.</p>
      </div>
      <div className="plugins-hero-actions">
        <span className={`badge ${status.edge.enabled ? "badge-live" : ""}`}>{status.edge.enabled ? "Compression active" : module.enabled ? "Enabled, inactive" : "Disabled"}</span>
        <button className={`btn ${module.enabled ? "secondary" : ""}`} disabled={disabled} onClick={() => void toggle()}>{module.enabled ? "Disable extension" : "Enable extension"}</button>
      </div>
    </section>

    {error && <div className="error plugins-feedback" role="alert">{error}</div>}
    {notice && <div className="plugins-notice" role="status">{notice}</div>}

    <section className="panel headroom-runtime">
      <div className="installed-card-copy">
        <div><span className="eyebrow">Runtime</span><h3>Container</h3></div>
        <div className="marketplace-meta">
          <span className={`badge ${status.container.running && status.service.healthy ? "badge-live" : ""}`}>
            {status.container.running ? (status.service.healthy ? "Running and ready" : "Running, not ready") : status.container.exists ? "Stopped" : "Not installed"}
          </span>
          <span className="mono">{status.container.name}</span>
          {status.container.image && <span className="mono">{status.container.image}</span>}
          {status.container.health && <span>health: {status.container.health}</span>}
        </div>
        <div className="marketplace-meta">
          <span className={status.docker.available ? "" : "error"}>
            Docker {status.docker.available ? `available${status.docker.version ? ` (${status.docker.version})` : ""}` : "unavailable"}
          </span>
          {status.docker.socket && <span className="mono">{status.docker.socket}</span>}
          {status.docker.error && <span className="error">{status.docker.error}</span>}
        </div>
        <div className="marketplace-meta">
          <span className={status.edge.enabled ? "badge badge-live" : "badge"}>{status.edge.enabled ? "Compression active" : "Compression off"}</span>
          {status.edge.url && <span className="mono">{status.edge.url}</span>}
          {status.edge.error && <span className="error">{status.edge.error}</span>}
          {status.service.url && <span>readyz {status.service.healthy ? `${status.service.status} in ${status.service.latencyMs}ms` : status.service.error ?? `status ${status.service.status ?? "—"}`}</span>}
        </div>
        {status.operation.phase !== "idle" && <p className="muted">{phaseLabel(status.operation.phase)}{status.operation.message ? ` — ${status.operation.message}` : ""}{status.operation.error ? ` — ${status.operation.error}` : ""}</p>}
        {!canManage && <p className="muted">Mount <code>/var/run/docker.sock</code> into the MultiVibe container to let the extension manage this container. Until then, configure a manual URL below.</p>}
      </div>
      <div className="headroom-runtime-actions">
        <div>
          {!status.container.exists
            ? <button className="btn" disabled={disabled || !canManage} onClick={() => void run("install", () => api("headroom/install", { method: "POST" }), "Install started.")}>{busy === "install" || busyPhase ? "Installing…" : "Install Headroom"}</button>
            : status.container.running
              ? <button className="btn secondary" disabled={disabled} onClick={() => void run("stop", () => api("headroom/stop", { method: "POST" }), "Headroom stopped.")}>Stop</button>
              : <button className="btn" disabled={disabled || !canManage} onClick={() => void run("start", () => api("headroom/start", { method: "POST" }), "Headroom started.")}>Start</button>}
          <button className="btn ghost" disabled={disabled} onClick={() => void run("test", async () => { const result = (await api("headroom/test", { method: "POST" })) as { probe: typeof probe }; setProbe(result.probe); await load(); })}>Test connection</button>
          <button className="btn danger" disabled={disabled || (!status.container.exists && !status.edge.enabled && !status.settings.hasProxyToken)} onClick={() => void run("uninstall", () => api("headroom/uninstall", { method: "POST" }), "Headroom removed.")}>Uninstall</button>
        </div>
        {probe && <span className={probe.ok ? "badge badge-live" : "badge"}>{probe.ok ? `Reachable (${probe.latencyMs}ms)` : probe.error ?? `HTTP ${probe.status ?? "—"}`}</span>}
      </div>
    </section>

    <section className="panel">
      <h3>Compression settings</h3>
      <form className="headroom-form" onSubmit={(event) => void save(event)}>
        <label className="control-field">
          <span className="control-label">Manage the Docker container</span>
          <input type="checkbox" checked={settings.manageContainer} disabled={disabled} onChange={(event) => setSettings({ ...settings, manageContainer: event.target.checked })} />
          <span className="muted">Pull, start, stop and remove the Headroom container from this page.</span>
        </label>
        <label className="control-field">
          <span className="control-label">Image</span>
          <input type="text" value={settings.image} disabled={disabled} onChange={(event) => setSettings({ ...settings, image: event.target.value })} />
          <span className="muted">Advanced. <code>latest</code> follows upstream releases; a pinned tag keeps a known contract.</span>
        </label>
        {!settings.manageContainer && <>
          <label className="control-field">
            <span className="control-label">Manual Headroom URL</span>
            <input type="url" placeholder="http://127.0.0.1:8787" value={settings.serverUrl} disabled={disabled} onChange={(event) => setSettings({ ...settings, serverUrl: event.target.value })} />
          </label>
          <label className="control-field">
            <span className="control-label">Proxy token {settings.hasProxyToken ? "(configured)" : "(optional)"}</span>
            <input type="password" placeholder={settings.hasProxyToken ? "Leave empty to keep it" : "x-headroom-proxy-token"} value={token} disabled={disabled} onChange={(event) => setToken(event.target.value)} />
          </label>
        </>}
        <label className="control-field">
          <span className="control-label">Compression mode</span>
          <select value={settings.mode} disabled={disabled} onChange={(event) => setSettings({ ...settings, mode: event.target.value as HeadroomMode })}>
            {MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
          </select>
        </label>
        <label className="control-field">
          <span className="control-label">Timeout (ms)</span>
          <input type="number" min={50} max={30000} step={50} value={settings.timeoutMs} disabled={disabled} onChange={(event) => setSettings({ ...settings, timeoutMs: Number(event.target.value) })} />
        </label>
        <label className="control-field">
          <span className="control-label">Minimum payload (bytes)</span>
          <input type="number" min={0} max={1048576} step={512} value={settings.minBytes} disabled={disabled} onChange={(event) => setSettings({ ...settings, minBytes: Number(event.target.value) })} />
          <span className="muted">Streaming requests use request-half compression only; MultiVibe never re-drives a provider call.</span>
        </label>
        <button className="btn" disabled={disabled}>{busy === "save" ? "Saving…" : "Save settings"}</button>
      </form>
    </section>
  </div>;
}
