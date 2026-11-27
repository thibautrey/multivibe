import { useDashboardApi, useDashboardRuntime } from "../../adapter";
import { PluginSettings } from "../PluginSettings";
import { AudioPanel } from "./AudioPanel";
import { HeadroomPanel } from "./HeadroomPanel";
import { useMemo, useState } from "react";
import type { MarketplaceModule, ModuleView } from "../../types";
import { useT } from "../../i18n";

import "./PluginsTab.css";

const GUIDE_URL = "https://github.com/thibautrey/multivibe/wiki/plugins";
const AUDIO_PLUGIN = "multivibe.audio";
const HEADROOM_PLUGIN = "multivibe.headroom";
type View = "marketplace" | "installed" | "audio" | "headroom";

export function PluginsTab({ modules, marketplace, reload }: { modules: ModuleView[]; marketplace: MarketplaceModule[]; reload: () => Promise<void> }) {
  const t = useT();
  const api = useDashboardApi();
  const { capabilities } = useDashboardRuntime();
  const [settingsId, setSettingsId] = useState("");
  const settingsPlugin = modules.find((plugin) => plugin.id === settingsId);
  const audioModule = modules.find((plugin) => plugin.id === AUDIO_PLUGIN);
  const headroomModule = modules.find((plugin) => plugin.id === HEADROOM_PLUGIN);
  const [view, setView] = useState<View>("marketplace");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [submissionUrl, setSubmissionUrl] = useState("");
  const [showSubmission, setShowSubmission] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const installedById = useMemo(() => new Map(modules.map((module) => [module.id, module])), [modules]);
  const categories = useMemo(() => ["All", ...Array.from(new Set(marketplace.flatMap((plugin) => plugin.manifest.categories?.length ? plugin.manifest.categories : ["Other"]))).sort()], [marketplace]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return marketplace.filter((plugin) => {
      const groups = plugin.manifest.categories?.length ? plugin.manifest.categories : ["Other"];
      const text = [plugin.manifest.name, plugin.manifest.description, plugin.manifest.author, plugin.id, ...(plugin.manifest.tags ?? []), ...groups].filter(Boolean).join(" ").toLowerCase();
      return (category === "All" || groups.includes(category)) && (!needle || text.includes(needle));
    });
  }, [marketplace, query, category]);
  const categoryLabel = (item: string) => item === "All" ? t("All") : t(item);
  const submissionHelp = t("We validate the repository and read categories, tags and author from {file}.", { file: "multivibe.module.json" }).split("multivibe.module.json");

  const action = async (name: string, operation: () => Promise<unknown>, success?: string) => {
    setBusy(name); setError(""); setNotice("");
    try { await operation(); await reload(); if (success) setNotice(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(""); }
  };

  return <div className="plugins-workspace">
    <section className="panel plugins-hero"><div><span className="eyebrow">{t("Plugin ecosystem")}</span><h2>{t("Extend MultiVibe")}</h2><p className="muted">{t("Discover community lifecycle plugins, install a reviewed commit, or submit your own public GitHub repository.")}</p></div><div className="plugins-hero-actions"><a className="btn ghost" href={GUIDE_URL} target="_blank" rel="noreferrer">{t("Developer guide ↗")}</a><button className="btn" type="button" onClick={() => setShowSubmission((shown) => !shown)}>{showSubmission ? t("Close submission") : t("Submit a plugin")}</button></div></section>

    {showSubmission && <section className="panel plugins-submit"><div><h3>{t("Submit to this marketplace")}</h3><p className="muted">{submissionHelp[0]}<code>multivibe.module.json</code>{submissionHelp[1] ?? ""}</p></div><form onSubmit={(event) => { event.preventDefault(); void action("submit", async () => { await api("modules/submit", { method: "POST", body: JSON.stringify({ url: submissionUrl }) }); setSubmissionUrl(""); setShowSubmission(false); }, t("Plugin submitted to the marketplace.")); }}><label className="control-field"><span className="control-label">{t("Public GitHub HTTPS URL")}</span><input type="url" required pattern="https://github\.com/.+/.+" placeholder="https://github.com/owner/repository" value={submissionUrl} onChange={(event) => setSubmissionUrl(event.target.value)} /></label><button className="btn" disabled={Boolean(busy)}>{busy === "submit" ? t("Validating…") : t("Validate and submit")}</button></form></section>}
    {error && <div className="error plugins-feedback" role="alert">{error}</div>}{notice && <div className="plugins-notice" role="status">{notice}</div>}

    <div className="plugins-view-tabs" role="tablist" aria-label={t("Plugin views")}><button className={view === "marketplace" ? "active" : ""} role="tab" aria-selected={view === "marketplace"} onClick={() => setView("marketplace")}>{t("Marketplace")} <span>{marketplace.length}</span></button><button className={view === "installed" ? "active" : ""} role="tab" aria-selected={view === "installed"} onClick={() => setView("installed")}>{t("Installed plugins")} <span>{modules.length}</span></button><button className={view === "audio" ? "active" : ""} role="tab" aria-selected={view === "audio"} onClick={() => setView("audio")}>Audio</button><button className={view === "headroom" ? "active" : ""} role="tab" aria-selected={view === "headroom"} onClick={() => setView("headroom")}>Headroom</button></div>

    {settingsPlugin && <PluginSettings key={settingsPlugin.id} plugin={settingsPlugin} onSaved={reload} onClose={() => setSettingsId("")} />}
    {view === "audio" ? (audioModule ? <AudioPanel module={audioModule} onReload={reload} /> : <div className="panel plugins-empty"><h3>{t("Audio plugin unavailable")}</h3><p className="muted">{t("Restart MultiVibe to load the built-in audio plugin.")}</p></div>) : view === "headroom" ? (headroomModule ? <HeadroomPanel module={headroomModule} onReload={reload} /> : <div className="panel plugins-empty"><h3>{t("Headroom plugin unavailable")}</h3><p className="muted">{t("Restart MultiVibe to load the built-in Headroom extension.")}</p></div>) : view === "marketplace" ? <>
      <section className="plugins-toolbar" aria-label={t("Marketplace filters")}><label className="plugins-search"><span aria-hidden="true">⌕</span><input type="search" placeholder={t("Search plugins, authors, tags…")} value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="plugins-categories" aria-label={t("Categories")}>{categories.map((item) => <button key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>{categoryLabel(item)}</button>)}</div></section>
      <div className="plugins-results-heading"><div><h3>{category === "All" ? t("All plugins") : category === "Other" ? t("Other") : category}</h3><p className="muted">{visible.length === 1 ? t("1 result") : t("{count} results", { count: visible.length })}</p></div></div>
      <section className="marketplace-grid" aria-label={t("Plugin marketplace")}>{visible.map((plugin) => {
        const installed = installedById.get(plugin.id); const groups = plugin.manifest.categories?.length ? plugin.manifest.categories : ["Other"];
        return <article className="panel marketplace-card" key={plugin.id}><div className="marketplace-card-top"><div className="plugin-mark" aria-hidden="true">{plugin.manifest.name.slice(0, 1).toUpperCase()}</div><div className="marketplace-card-title"><h3>{plugin.manifest.name}</h3><p>{plugin.manifest.author ? t("by {author}", { author: plugin.manifest.author }) : plugin.id}</p></div>{installed && <span className="badge badge-live">{t("Installed")}</span>}</div><p className="marketplace-description">{plugin.manifest.description}</p><div className="plugin-taxonomy">{groups.map((item) => <span key={item}>{categoryLabel(item)}</span>)}{(plugin.manifest.tags ?? []).slice(0, 3).map((tag) => <span className="tag" key={tag}>#{tag}</span>)}</div><div className="marketplace-meta"><span>v{plugin.manifest.version}</span><span className="mono">{plugin.commit.slice(0, 8)}</span></div><footer>{plugin.manifest.homepage && <a className="btn ghost" href={plugin.manifest.homepage} target="_blank" rel="noreferrer">{t("Details")}</a>}<button className="btn" disabled={Boolean(busy) || Boolean(installed)} onClick={() => void action(`install-${plugin.id}`, () => api("modules/install", { method: "POST", body: JSON.stringify({ url: plugin.origin }) }), t("{name} installed. Restart MultiVibe, then enable it.", { name: plugin.manifest.name }))}>{busy === `install-${plugin.id}` ? t("Installing…") : installed ? t("Installed") : t("Install")}</button></footer></article>;
      })}{!visible.length && <div className="panel plugins-empty"><div className="plugin-empty-icon">⌕</div><h3>{t("No plugins found")}</h3><p className="muted">{t("Try another search or category, or submit the first matching plugin.")}</p></div>}</section>
    </> : <section className="installed-list" aria-label={t("Installed plugins")}>{modules.map((module) => <article className="panel installed-card" key={module.id}><div className="plugin-mark" aria-hidden="true">{(module.manifest?.name ?? module.id).slice(0, 1).toUpperCase()}</div><div className="installed-card-copy"><div><span className="eyebrow">{module.source === "bundled" ? t("Bundled") : "GitHub"}</span><h3>{module.manifest?.name ?? module.id}</h3></div><p>{module.manifest?.description ?? t("Manifest will be loaded after restart.")}</p><div className="marketplace-meta"><span>v{module.manifest?.version ?? "—"}</span><span className="mono">{module.commit.slice(0, 12)}</span><span>{(module.manifest?.hooks?.length ?? 0) === 1 ? t("1 hook") : t("{count} hooks", { count: module.manifest?.hooks?.length ?? 0 })}</span><span>{module.execution === "host-builtin" ? t("Built into MultiVibe") : t("Isolated runtime")}</span></div>{module.error && <div className="error">{module.error}</div>}</div><div className="installed-card-actions"><span className={`badge ${module.healthy ? "badge-live" : ""}`}>{module.restartRequired ? t("Restart required") : module.loaded ? t("Loaded") : module.enabled ? t("Unavailable") : t("Disabled")}</span><div>{module.manifest && <button className="btn ghost" onClick={() => module.id === AUDIO_PLUGIN ? setView("audio") : module.id === HEADROOM_PLUGIN ? setView("headroom") : setSettingsId(module.id)}>{t("Settings")}</button>}<button className={`btn ${module.enabled ? "secondary" : ""}`} disabled={Boolean(busy) || Boolean(module.restartRequired)} onClick={() => void action(`toggle-${module.id}`, () => api(`modules/${encodeURIComponent(module.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !module.enabled }) }))}>{module.enabled ? t("Disable") : t("Enable")}</button><button className="btn ghost" disabled={Boolean(busy) || module.commit === "builtin"} title={module.commit === "builtin" ? t("Updates with MultiVibe") : undefined} onClick={() => void action(`update-${module.id}`, () => api(`modules/${encodeURIComponent(module.id)}/update`, { method: "POST" }), t("Update pinned. Restart MultiVibe to load it."))}>{t("Update")}</button>{module.removable && <button className="btn danger" disabled={Boolean(busy) || module.enabled} title={module.enabled ? t("Disable before removing") : undefined} onClick={() => void action(`remove-${module.id}`, () => api(`modules/${encodeURIComponent(module.id)}`, { method: "DELETE" }))}>{t("Remove")}</button>}</div></div></article>)}{!modules.length && <div className="panel plugins-empty"><h3>{t("No installed plugins")}</h3><p className="muted">{t("Browse the marketplace to get started.")}</p></div>}</section>}
  </div>;
}
