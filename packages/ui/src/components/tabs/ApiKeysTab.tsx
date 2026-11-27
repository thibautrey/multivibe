import { useDashboardRuntime } from "../../adapter";
import ModalPortal from "../ModalPortal";
import React, { useState } from "react";
import { HostHarnessCards } from "../../host/HostHarnessCarousel";
import { copyTextToClipboard } from "../../lib/clipboard";
import { buildAgentSetupPrompt } from "../../lib/agentSetupPrompt";
import { activeLocale, useT } from "../../i18n";
import type {
  ApplicationPolicy,
  ApplicationWebhook,
  CreatedProxyApiKey,
  ProxyApiKey,
} from "../../types";

export type ApiKeyExtensions = {
  renderCreateFields?: (state: {value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void}) => React.ReactNode;
  renderKeyMetadata?: (key: ProxyApiKey) => React.ReactNode;
  renderCreatedKeyMetadata?: (key: CreatedProxyApiKey) => React.ReactNode;
  emptyDescription?: string;
};
export type CloudflareAccessConfig = {
  provisioningEnabled: boolean;
  configured: boolean;
  applications: string[];
  error?: string;
};
/**
 * Renders a translated sentence while keeping emphasis around an interpolated
 * value: the sentence comes from a single catalog key, so translators keep
 * control of the word order. Remaining placeholders must already be filled in.
 */
function withEmphasis(template: string, slot: string, node: React.ReactNode) {
  const [before, after = ""] = template.split(`{${slot}}`);
  return <>{before}{node}{after}</>;
}

type Props = {
  extensions?: ApiKeyExtensions;
  apiKeys: ProxyApiKey[];
  policies: ApplicationPolicy[];
  cloudflareAccess?: CloudflareAccessConfig;
  createApiKey: (application: string, extras?: Record<string, unknown>) => Promise<CreatedProxyApiKey>;
  deleteApiKey: (id: string) => Promise<void>;
  setApplicationWeight: (application: string, weight: number) => Promise<void>;
  createWebhook: (application: string, url: string) => Promise<ApplicationWebhook>;
  deleteWebhook: (application: string, id: string) => Promise<void>;
  onHarnessesChanged: () => Promise<void>;
};

export function ApiKeysTab({
  apiKeys,
  policies,
  cloudflareAccess,
  createApiKey,
  deleteApiKey,
  setApplicationWeight,
  createWebhook,
  deleteWebhook,
  onHarnessesChanged,
  extensions,
}: Props) {
  const {capabilities, adapter} = useDashboardRuntime();
  const t = useT();
  const [error, setError] = useState("");
  const showError = (value: unknown) => setError(value instanceof Error ? value.message : t("The action could not be completed."));
  const [extraFields, setExtraFields] = useState<Record<string, unknown>>({});
  const [application, setApplication] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<CreatedProxyApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [cloudflareCopied, setCloudflareCopied] = useState(false);
  const [webhookApplication, setWebhookApplication] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [createdWebhook, setCreatedWebhook] = useState<ApplicationWebhook | null>(null);

  const policyFor = (application: string) =>
    policies.find((policy) => policy.application === application) ?? {
      application,
      fairnessWeight: 1,
      webhooks: [],
    };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = application.trim();
    if (!name) return;
    setIsCreating(true);
    setError("");
    try {
      const extras = { ...extraFields };
      if (
        extras.provisionCloudflareAccess === true &&
        !cloudflareAccess?.applications.includes(name)
      ) {
        delete extras.provisionCloudflareAccess;
      }
      const result = await createApiKey(name, extras);
      setCreatedKey(result);
      setApplication("");
      setExtraFields({});
      setCopied(false);
      setPromptCopied(false);
      setPromptExpanded(false);
      setCloudflareCopied(false);
    } catch (error) { showError(error); } finally {
      setIsCreating(false);
    }
  };

  const revoke = async (entry: ProxyApiKey) => {
    const message = entry.cloudflareAccess
      ? t("Revoke the API key for {application}? Clients using it will immediately lose access. This also deletes its Cloudflare Access service token ({clientId}).", {
          application: entry.application,
          clientId: entry.cloudflareAccess.clientId,
        })
      : t("Revoke the API key for {application}? Clients using it will immediately lose access.", {
          application: entry.application,
        });
    if (!confirm(message)) return;
    setDeletingId(entry.id);
    setError("");
    try {
      await deleteApiKey(entry.id);
    } catch (error) { showError(error); } finally {
      setDeletingId(null);
    }
  };

  const copyCreatedKey = async () => {
    if (!createdKey) return;
    await copyTextToClipboard(createdKey.key);
    setCopied(true);
  };

  // The prompt embeds the freshly created secret, so keep it derived from the
  // created key instead of storing another copy of the credential in state.
  const apiOrigin = (adapter.apiOrigin ?? (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/+$/, "");
  const agentPrompt = createdKey
    ? buildAgentSetupPrompt({ apiBaseUrl: `${apiOrigin}/v1`, apiKey: createdKey.key })
    : "";

  const copyAgentPrompt = async () => {
    if (!createdKey) return;
    await copyTextToClipboard(agentPrompt);
    setPromptCopied(true);
  };

  const copyCloudflareCredentials = async () => {
    const credential = createdKey?.cloudflareAccess;
    if (!credential) return;
    await copyTextToClipboard(
      `CF-Access-Client-Id: ${credential.clientId}\nCF-Access-Client-Secret: ${credential.clientSecret}`,
    );
    setCloudflareCopied(true);
  };

  const cloudflareMapped = Boolean(
    application.trim() &&
      cloudflareAccess?.applications.includes(application.trim()),
  );
  const showCloudflareField = Boolean(
    cloudflareAccess?.provisioningEnabled || cloudflareAccess?.error,
  );

  return (
    <>
      {error && <div className="panel error" role="alert">{error}</div>}
      {capabilities.hostHarnesses && <HostHarnessCards onApiKeysChanged={onHarnessesChanged} />}
      <section className="panel">
        <div className="section-split-header">
          <div>
            <h2>{t("Create an API key")}</h2>
            <p className="muted">{t("Use a short application name such as mobile, litellm, or staging-worker.")}</p>
          </div>
        </div>
        <form className="api-key-create" onSubmit={create}>
          <label className="control-field">
            <span className="control-label">{t("Application")}</span>
            <input
              value={application}
              onChange={(event) => setApplication(event.target.value)}
              placeholder="staging-worker"
              pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*"
              maxLength={80}
              autoComplete="off"
            />
          </label>
          {extensions?.renderCreateFields?.({value:extraFields,onChange:setExtraFields})}
          {showCloudflareField && (
            <label className="inline">
              <input
                type="checkbox"
                checked={cloudflareMapped && extraFields.provisionCloudflareAccess === true}
                disabled={!cloudflareAccess?.configured || !cloudflareMapped}
                onChange={(event) =>
                  setExtraFields((current) => ({
                    ...current,
                    provisionCloudflareAccess: event.target.checked,
                  }))
                }
              />
              <span>
                {t("Also create a Cloudflare Access service token")}
                <small className="muted">
                  {" — "}
                  {cloudflareAccess?.error
                    ? cloudflareAccess.error
                    : !cloudflareAccess?.configured
                      ? t("Cloudflare Access provisioning is not configured.")
                      : application.trim() && !cloudflareMapped
                        ? t("No Access application is mapped for “{application}”.", { application: application.trim() })
                        : t("One token per key, scoped to the mapped application.")}
                </small>
              </span>
            </label>
          )}
          <button className="btn" type="submit" disabled={isCreating || !application.trim()}>
            {isCreating ? t("Creating...") : t("Create secret key")}
          </button>
        </form>
      </section>

      <section className="panel api-key-list-panel">
        <div className="section-split-header">
          <div>
            <h2>{t("Active keys")}</h2>
          </div>
        </div>
        {!apiKeys.length ? (
          <div className="compact-empty-state">
            <strong>{t("No application keys yet")}</strong>
            <span>{extensions?.emptyDescription ?? (capabilities.host ? t("Proxy access is unrestricted until you create the first key.") : t("Create an application key to access the API."))}</span>
          </div>
        ) : <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("Application")}</th>
                <th>{t("Key")}</th>
                <th>{t("Created")}</th>
                <th>{t("Last used")}</th>
                <th>{t("Managed by")}</th>
                <th>{t("Fairness weight")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {apiKeys.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <strong>{entry.application}</strong>
                    {entry.cloudflareAccess && (
                      <div className="muted" style={{ fontSize: 11 }}>
                        <span
                          className="badge"
                          title={t("Cloudflare Access application {applicationId}", { applicationId: entry.cloudflareAccess.applicationId })}
                        >
                          Cloudflare Access
                        </span>{" "}
                        <span className="mono">{entry.cloudflareAccess.clientId}</span>
                      </div>
                    )}
                    {extensions?.renderKeyMetadata?.(entry)}
                  </td>
                  <td className="mono">{entry.keyPreview}</td>
                  <td>{entry.createdAt ? new Date(entry.createdAt).toLocaleDateString(activeLocale()) : "—"}</td>
                  <td>{entry.lastUsedAt ? new Date(entry.lastUsedAt).toLocaleString(activeLocale()) : "—"}</td>
                  <td>
                    <span className={entry.source === "dashboard" ? "badge badge-live" : "badge"}>
                      {entry.source === "dashboard" ? t("Dashboard") : t("Environment")}
                    </span>
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0.1"
                      max="100"
                      step="0.1"
                      defaultValue={policyFor(entry.application).fairnessWeight}
                      aria-label={t("Fairness weight for {application}", { application: entry.application })}
                      onBlur={(event) =>
                        void setApplicationWeight(
                          entry.application,
                          Number(event.target.value) || 1,
                        ).catch(showError)
                      }
                      style={{ width: 88 }}
                    />
                  </td>
                  <td>
                    {entry.source === "dashboard" && (
                      <button
                        className="btn danger"
                        disabled={deletingId === entry.id}
                        onClick={() => void revoke(entry)}
                      >
                        {deletingId === entry.id ? t("Revoking...") : t("Revoke")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
      </section>

      <details className="panel advanced-disclosure">
        <summary>
          <span><strong>{t("Advanced: signed result webhooks")}</strong><small>{t("Register destinations for deferred results.")}</small></span>
          <span className="advanced-disclosure-toggle">{t("Show")}</span>
        </summary>
        <div className="advanced-disclosure-content">
        <form
          className="api-key-create"
          onSubmit={(event) => {
            event.preventDefault();
            if (!webhookApplication || !webhookUrl) return;
            void createWebhook(webhookApplication, webhookUrl).then((webhook) => {
              setCreatedWebhook(webhook);
              setWebhookUrl("");
            }).catch(showError);
          }}
        >
          <label className="control-field"><span className="control-label">{t("Application")}</span>
            <select value={webhookApplication} onChange={(event) => setWebhookApplication(event.target.value)}>
              <option value="">{t("Select application")}</option>
              {Array.from(new Set(apiKeys.map((entry) => entry.application))).map((name) => <option key={name}>{name}</option>)}
            </select>
          </label>
          <label className="control-field"><span className="control-label">{t("HTTPS endpoint")}</span><input type="url" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://worker.example.com/multivibe" /></label>
          <button className="btn" type="submit" disabled={!webhookApplication || !webhookUrl}>{t("Register webhook")}</button>
        </form>
        {policies.some((policy) => policy.webhooks.length) && <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>{t("Application")}</th><th>ID</th><th>URL</th><th>{t("Status")}</th><th /></tr></thead>
            <tbody>
              {policies.flatMap((policy) => policy.webhooks.map((webhook) => (
                <tr key={webhook.id}><td>{policy.application}</td><td className="mono">{webhook.id}</td><td className="mono">{webhook.url}</td><td><span className="badge badge-live">{webhook.enabled ? t("Enabled") : t("Disabled")}</span></td><td><button className="btn danger" onClick={() => void deleteWebhook(policy.application, webhook.id).catch(showError)}>{t("Delete")}</button></td></tr>
              )))}
            </tbody>
          </table>
        </div>}
        </div>
      </details>

      {createdKey && (
        <ModalPortal><div className="modal-backdrop" role="presentation">
          <div className="modal panel api-key-modal" role="dialog" aria-modal="true" aria-labelledby="created-key-title">
            <div>
              <span className="badge badge-live">{t("Key created")}</span>
              <h2 id="created-key-title">{t("Copy your secret key")}</h2>
              <p className="muted">
                {withEmphasis(
                  t("This is the only time the full key for {application} will be displayed."),
                  "application",
                  <strong>{createdKey.application}</strong>,
                )}
              </p>
              {createdKey.warning && <p role="alert">{createdKey.warning}</p>}
              {extensions?.renderCreatedKeyMetadata?.(createdKey)}
            </div>
            <div className="api-key-secret">
              <code>{createdKey.key}</code>
              <button className="btn secondary" onClick={() => void copyCreatedKey()}>
                {copied ? t("Copied") : t("Copy")}
              </button>
            </div>
            <section className={`api-key-agent-prompt${promptExpanded ? " expanded" : " collapsed"}`}>
              <div className="api-key-agent-prompt-header">
                <div>
                  <h3>{t("Set up your AI agents")}</h3>
                  <p className="muted">
                    {t("Copy this prompt and paste it into your AI agent. It will configure the main harnesses installed on this machine and test each connection with a minimal request.")}
                  </p>
                </div>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => void copyAgentPrompt()}
                >
                  {promptCopied ? t("Prompt copied") : t("Copy prompt")}
                </button>
              </div>
              <pre className="api-key-agent-prompt-text">{agentPrompt}</pre>
              <button
                className="btn ghost api-key-agent-prompt-toggle"
                type="button"
                aria-expanded={promptExpanded}
                onClick={() => setPromptExpanded((current) => !current)}
              >
                {promptExpanded ? t("Show less") : t("Show more")}
              </button>
            </section>
            {createdKey.cloudflareAccess && (
              <div>
                <span className="badge">Cloudflare Access</span>
                <p className="muted">
                  {withEmphasis(
                    createdKey.cloudflareAccess.expiresAt
                      ? t("Service token for application {applicationId}. The client secret is shown only once. Expires {date}.", {
                          date: new Date(createdKey.cloudflareAccess.expiresAt).toLocaleDateString(activeLocale()),
                        })
                      : t("Service token for application {applicationId}. The client secret is shown only once."),
                    "applicationId",
                    <strong className="mono">{createdKey.cloudflareAccess.applicationId}</strong>,
                  )}
                </p>
                <div className="api-key-secret">
                  <code>CF-Access-Client-Id: {createdKey.cloudflareAccess.clientId}</code>
                </div>
                <div className="api-key-secret">
                  <code>CF-Access-Client-Secret: {createdKey.cloudflareAccess.clientSecret}</code>
                </div>
                <button
                  className="btn secondary"
                  onClick={() => void copyCloudflareCredentials()}
                >
                  {cloudflareCopied ? t("Copied") : t("Copy both headers")}
                </button>
              </div>
            )}
            <div className="inline wrap">
              <button className="btn" onClick={() => setCreatedKey(null)}>{t("I have saved this key")}</button>
            </div>
          </div>
        </div></ModalPortal>
      )}

      {createdWebhook?.secret && (
        <ModalPortal><div className="modal-backdrop" role="presentation">
          <div className="modal panel api-key-modal" role="dialog" aria-modal="true">
            <span className="badge badge-live">{t("Webhook registered")}</span>
            <h2>{t("Copy the HMAC secret")}</h2>
            <p className="muted">{t("This secret is shown once. Verify x-multivibe-signature before accepting an event.")}</p>
            <div className="api-key-secret"><code>{createdWebhook.secret}</code><button className="btn secondary" onClick={() => void copyTextToClipboard(createdWebhook.secret!)}>{t("Copy")}</button></div>
            <button className="btn" onClick={() => setCreatedWebhook(null)}>{t("I have saved this secret")}</button>
          </div>
        </div></ModalPortal>
      )}
    </>
  );
}
