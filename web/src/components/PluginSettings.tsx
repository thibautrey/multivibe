import { useState } from "react";
import type { ModuleView } from "../types";
import { api } from "../lib/api";
import { ModelSelect } from "./ModelSelect";

export function PluginSettings({ plugin, onSaved, onClose }: { plugin: ModuleView; onSaved: () => Promise<void>; onClose: () => void }) {
  const [settings, setSettings] = useState(plugin.settings);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const properties = (plugin.manifest?.settingsSchema?.properties ?? {}) as Record<string, {
    type?: string; title?: string; description?: string; format?: string; enum?: string[]; minimum?: number; maximum?: number;
  }>;
  return <section className="panel plugin-settings" aria-label={`${plugin.manifest?.name ?? plugin.id} settings`}>
    <h3>{plugin.manifest?.name ?? plugin.id} settings</h3>
    {plugin.id === "multivibe.automatic-router" && <p className="muted">Requires JavaScript inference. Choose a classifier and three difficulty tiers before enabling. Multi-turn routing requires a stable session ID; continuations retain their first selection to help reuse cached input. Classifier calls add cost and latency.</p>}
    <form onSubmit={async (event) => {
      event.preventDefault(); setSaving(true); setError("");
      try { await api(`/admin/modules/${encodeURIComponent(plugin.id)}`, { method: "PATCH", body: JSON.stringify({ settings }) }); await onSaved(); onClose(); }
      catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { setSaving(false); }
    }}>
      {Object.entries(properties).map(([name, field]) => {
        const id = `plugin-${plugin.id}-${name}`;
        const change = (value: unknown) => setSettings((previous) => ({ ...previous, [name]: value }));
        return <label className="control-field" key={name} htmlFor={id}><span className="control-label">{field.title ?? name}</span>
          {field.format === "multivibe-model" ? <ModelSelect id={id} value={String(settings[name] ?? "")} onChange={change} disabled={saving} />
            : field.type === "boolean" ? <input id={id} type="checkbox" checked={Boolean(settings[name])} onChange={(event) => change(event.target.checked)} />
            : field.enum ? <select id={id} value={String(settings[name] ?? "")} onChange={(event) => change(event.target.value)}>{field.enum.map((item) => <option key={item}>{item}</option>)}</select>
            : field.type === "object" || field.type === "array" ? <textarea id={id} defaultValue={JSON.stringify(settings[name], null, 2)} onChange={(event) => { try { change(JSON.parse(event.target.value)); event.target.setCustomValidity(""); } catch { event.target.setCustomValidity("Enter valid JSON"); } }} />
            : <input id={id} type={field.type === "integer" || field.type === "number" ? "number" : "text"} step={field.type === "integer" ? 1 : "any"} min={field.minimum} max={field.maximum} value={String(settings[name] ?? "")} onChange={(event) => change(field.type === "integer" || field.type === "number" ? Number(event.target.value) : event.target.value)} />}
          {field.description && <span className="muted">{field.description}</span>}
        </label>;
      })}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn" disabled={saving}>{saving ? "Saving…" : "Save settings"}</button> <button className="btn ghost" type="button" disabled={saving} onClick={onClose}>Cancel</button>
    </form>
  </section>;
}
