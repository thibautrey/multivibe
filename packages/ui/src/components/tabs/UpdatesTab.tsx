import { useDashboardApi, useDashboardRuntime } from "../../adapter";
import { activeLocale, t, useT } from "../../i18n";
import { useEffect, useState } from "react";

import type { HostUpdateStatus } from "../../types";

function timestamp(value: string | null) {
  if (!value) return t("Not yet");
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? t("Unknown") : parsed.toLocaleString(activeLocale());
}

export function UpdatesTab() {
  const t = useT();
  const api = useDashboardApi();
  const { capabilities } = useDashboardRuntime();
  const [status, setStatus] = useState<HostUpdateStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => {
    const result = await api("host-update");
    setStatus(result as HostUpdateStatus);
  };

  useEffect(() => { void load().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }, []);

  const action = async (name: string, operation: () => Promise<unknown>, message?: string) => {
    setBusy(name);
    setError("");
    setNotice("");
    try {
      await operation();
      await load();
      if (message) setNotice(message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  if (!status && error) {
    return <section className="panel"><span className="eyebrow">MultiVibe Host</span><h2>{t("Host updates are unavailable")}</h2><p className="muted">{t("This dashboard is not running from a managed native MultiVibe Host installation. Docker updates are managed by the host orchestrator.")}</p></section>;
  }
  if (!status) return <section className="panel"><p className="muted">{t("Loading update status…")}</p></section>;

  const canDownload = status.status === "available" && status.rollout_eligible;
  const canInstall = Boolean(status.available_version && status.rollout_eligible);
  return <div className="stack">
    <section className="panel hero-panel">
      <div><span className="eyebrow">{t("Verified updates")}</span><h2>MultiVibe Host {status.current_version}</h2></div>
      <span className={`badge ${status.status === "current" ? "badge-live" : ""}`}>{t(status.status)}</span>
    </section>

    {error && <div className="panel error" role="alert">{error}</div>}
    {notice && <div className="panel" role="status">{notice}</div>}

    <section className="grid cards3">
      <article className="panel stat-card"><span>{t("Installed version")}</span><strong>{status.current_version}</strong><small>{t("Current native bundle")}</small></article>
      <article className="panel stat-card"><span>{t("Available")}</span><strong>{status.available_version ?? "—"}</strong><small>{status.available_critical ? t("Required security or compatibility update") : status.rollout_eligible ? t("Eligible for this installation") : t("No eligible rollout")}</small></article>
      <article className="panel stat-card"><span>{t("Next check")}</span><strong>{timestamp(status.next_check_at)}</strong><small>{t("Last check: {at}", { at: timestamp(status.last_checked_at) })}</small></article>
    </section>

    <section className="panel">
      <div className="section-heading"><div><span className="eyebrow">{t("Policy")}</span><h3>{t("Update behavior")}</h3></div></div>
      <div className="grid cols2">
        <label><span className="field-label">{t("Mode")}</span><select value={status.mode} disabled={Boolean(busy)} onChange={(event) => {
          const mode = event.target.value as HostUpdateStatus["mode"];
          void action("policy", () => api("host-update", { method: "PATCH", body: JSON.stringify({ mode, channel: status.channel }) }));
        }}><option value="automatic">{t("Install automatically overnight")}</option><option value="download">{t("Download automatically, install manually")}</option><option value="notify">{t("Notify only")}</option></select></label>
        <label><span className="field-label">{t("Channel")}</span><select value={status.channel} disabled={Boolean(busy)} onChange={(event) => {
          const channel = event.target.value as HostUpdateStatus["channel"];
          void action("policy", () => api("host-update", { method: "PATCH", body: JSON.stringify({ mode: status.mode, channel }) }));
        }}><option value="stable">{t("Stable")}</option><option value="beta">{t("Beta")}</option></select></label>
      </div>
      <p className="muted">{t("Automatic updates run between 02:00 and 06:00 in this machine’s local time, at a randomized time, after 30 minutes without requests. Busy or sleeping machines wait for a later night. No confirmation is needed.")}</p>
      <p className="muted">{t("Next automatic update window: {at}", { at: timestamp(status.next_automatic_at ?? null) })}</p>
      <div className="actions-row">
        <button className="btn secondary" disabled={Boolean(busy)} onClick={() => void action("check", () => api("host-update/check", { method: "POST", body: "{}" }))}>{busy === "check" ? t("Checking…") : t("Check now")}</button>
        <button className="btn secondary" disabled={Boolean(busy) || !canDownload || status.download_requested} onClick={() => void action("download", () => api("host-update/download", { method: "POST", body: "{}" }), t("Download queued for the background updater."))}>{busy === "download" ? t("Queuing…") : status.download_requested ? t("Download queued") : t("Download in background")}</button>
        <button className="btn" disabled={Boolean(busy) || !canInstall || status.install_requested} onClick={() => void action("install", () => api("host-update/apply", { method: "POST", body: "{}" }), t("Installation queued. The separate background updater will drain, verify and restart MultiVibe Host safely."))}>{busy === "install" ? t("Queuing…") : status.install_requested ? t("Installation queued") : t("Install on next updater run")}</button>
      </div>
      {status.last_error && <p className="error" role="alert"><strong>{status.last_error_code ?? "update_failed"}:</strong> {status.last_error}</p>}
    </section>
  </div>;
}
