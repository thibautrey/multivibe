import { useDashboardRuntime } from "../../adapter";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { t, useT } from "../../i18n";
import { copyTextToClipboard } from "../../lib/clipboard";
import type { ExposedModel } from "../../types";
import {
  ENDPOINTS as CORE_ENDPOINTS,
  GROUPS,
  type ApiEndpoint,
  type EndpointGroup,
  type HttpMethod,
} from "./docsCatalog";
import "./DocsTab.css";

type RequestResult = {
  status: number | null;
  statusText: string;
  durationMs?: number;
  body: string;
  contentType?: string;
  error?: boolean;
};

type Props = {
  models: ExposedModel[];
  initialEndpointId?: string;
  initialModel?: string;
};

type IconName =
  | "search"
  | "copy"
  | "send"
  | "check"
  | "terminal"
  | "lock"
  | "chevron"
  | "stop";

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="11" height="11" rx="2" />
        <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
      </>
    ),
    send: (
      <>
        <path d="m22 2-7 20-4-9-9-4Z" />
        <path d="M22 2 11 13" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    terminal: (
      <>
        <path d="m4 17 6-6-6-6" />
        <path d="M12 19h8" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
    chevron: <path d="m9 18 6-6-6-6" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="1" />,
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function hydrateExample(value: string | undefined, model: string) {
  return (value ?? "")
    .split("{{model}}")
    .join(model || "gpt-5.3-codex");
}

function methodClass(method: HttpMethod) {
  return "docs-method docs-method-" + method.toLowerCase();
}

/** Group names double as data keys, so only their display label is translated. */
function groupLabel(group: EndpointGroup) {
  return t(group);
}

function tryFormatJson(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function shellQuote(value: string) {
  return "'" + value.split("'").join("'" + '"' + "'" + '"' + "'") + "'";
}

export function DocsTab({ models, initialEndpointId, initialModel }: Props) {
  const t = useT();
  const {adapter, capabilities, endpoints} = useDashboardRuntime();
  const ENDPOINTS = endpoints?.length ? endpoints : CORE_ENDPOINTS.filter(endpoint => capabilities.host || !endpoint.path.startsWith('/admin/'));
  const fetch = adapter.fetch;
  const linkedModel = initialModel?.trim();
  const defaultModel =
    linkedModel &&
    (!models.length || models.some((model) => model.id === linkedModel))
      ? linkedModel
      : models[0]?.id || "gpt-5.3-codex";
  const linkedEndpointId =
    ENDPOINTS.find((endpoint) => endpoint.id === initialEndpointId)?.id ??
    ENDPOINTS[0].id;
  const [selectedId, setSelectedId] = useState(linkedEndpointId);
  const [view, setView] = useState<"request" | "reference">("request");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const catalogToggleRef = useRef<HTMLButtonElement>(null);
  const referenceRef = useRef<HTMLElement>(null);
  const [search, setSearch] = useState("");
  const [activeGroup, setActiveGroup] = useState<EndpointGroup | "All">("All");
  const [pathValues, setPathValues] = useState<Record<string, string>>({});
  const [queryValues, setQueryValues] = useState<Record<string, string>>({});
  const [requestBody, setRequestBody] = useState("");
  const [result, setResult] = useState<RequestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const selected =
    ENDPOINTS.find((endpoint) => endpoint.id === selectedId) ?? ENDPOINTS[0];
  const origin = adapter.apiOrigin ?? window.location.origin;

  const filteredEndpoints = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return ENDPOINTS.filter((endpoint) => {
      if (activeGroup !== "All" && endpoint.group !== activeGroup) return false;
      if (!needle) return true;
      return [
        endpoint.method,
        endpoint.path,
        endpoint.title,
        endpoint.summary,
        endpoint.group,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [activeGroup, search]);

  useEffect(() => {
    setSelectedId(linkedEndpointId);
  }, [linkedEndpointId]);

  useEffect(() => {
    setPathValues(
      Object.fromEntries(
        (selected.pathParams ?? []).map((field) => [
          field.name,
          hydrateExample(field.example, defaultModel),
        ]),
      ),
    );
    setQueryValues(
      Object.fromEntries(
        (selected.queryParams ?? []).map((field) => [
          field.name,
          hydrateExample(field.example, defaultModel),
        ]),
      ),
    );
    setRequestBody(hydrateExample(selected.requestBody, defaultModel));
    setResult(null);
  }, [defaultModel, selected.id]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function resolvedPath() {
    const pathname = (selected.pathParams ?? []).reduce(
      (value, field) =>
        value.replace(
          ":" + field.name,
          encodeURIComponent(pathValues[field.name]?.trim() ?? ""),
        ),
      selected.path,
    );
    const params = new URLSearchParams();
    for (const field of selected.queryParams ?? []) {
      const value = queryValues[field.name]?.trim();
      if (value) params.set(field.name, value);
    }
    const query = params.toString();
    return query ? pathname + "?" + query : pathname;
  }

  function curlSnippet() {
    const body = requestBody.trim();
    const lines = [
      "curl --request " +
        selected.method +
        " " +
        shellQuote(origin + resolvedPath()),
    ];
    lines.push(
      selected.path.startsWith("/admin/")
        ? "  --header 'x-admin-token: $ADMIN_TOKEN'"
        : "  --header 'Authorization: Bearer $PROXY_API_KEY'",
    );
    if (body && selected.method !== "GET") {
      lines.push("  --header 'content-type: application/json'");
      lines.push("  --data " + shellQuote(body));
    }
    return lines.join(" " + String.fromCharCode(92) + "\n");
  }

  async function copy(value: string, key: string) {
    await copyTextToClipboard(value);
    setCopied(key);
    window.setTimeout(
      () => setCopied((current) => (current === key ? null : current)),
      1600,
    );
  }

  function selectEndpoint(endpoint: ApiEndpoint) {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setSelectedId(endpoint.id);
    setCatalogOpen(false);
    if (window.matchMedia("(max-width: 980px)").matches) {
      window.requestAnimationFrame(() => {
        referenceRef.current?.focus({ preventScroll: true });
        catalogToggleRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
      });
    }
  }

  async function runRequest() {
    const missingPathField = (selected.pathParams ?? []).find(
      (field) => field.required && !pathValues[field.name]?.trim(),
    );
    if (missingPathField) {
      setResult({
        status: null,
        statusText: t("Request not sent"),
        body: t("{name} is required.", { name: missingPathField.name }),
        error: true,
      });
      return;
    }

    let body: string | undefined;
    if (requestBody.trim() && selected.method !== "GET") {
      try {
        body = JSON.stringify(JSON.parse(requestBody));
      } catch (error: any) {
        setResult({
          status: null,
          statusText: t("Invalid JSON"),
          body: error?.message ?? String(error),
          error: true,
        });
        return;
      }
    }

    if (
      selected.destructive &&
      !window.confirm(
        t("Send {method} {path}? This request changes server state.", {
          method: selected.method,
          path: resolvedPath(),
        }),
      )
    ) {
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setResult(null);
    const startedAt = performance.now();

    try {
      const response = await fetch(resolvedPath(), {
        method: selected.method,
        credentials: "same-origin",
        headers: body
          ? { "content-type": "application/json", accept: "application/json" }
          : { accept: "application/json" },
        body,
        signal: controller.signal,
      });
      const raw = await response.text();
      if (abortRef.current !== controller) return;
      setResult({
        status: response.status,
        statusText:
          response.statusText ||
          (response.ok ? t("Success") : t("Request failed")),
        durationMs: Math.round(performance.now() - startedAt),
        body: raw ? tryFormatJson(raw) : t("No response body."),
        contentType: response.headers.get("content-type") ?? undefined,
        error: !response.ok,
      });
    } catch (error: any) {
      if (abortRef.current !== controller) return;
      const aborted = error?.name === "AbortError";
      setResult({
        status: null,
        statusText: aborted ? t("Cancelled") : t("Network error"),
        durationMs: Math.round(performance.now() - startedAt),
        body: aborted
          ? t("The request was cancelled.")
          : (error?.message ?? String(error)),
        error: !aborted,
      });
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setRunning(false);
      }
    }
  }

  const fields = [
    ...(selected.pathParams ?? []),
    ...(selected.queryParams ?? []),
  ];

  return (
    <div className="docs-page">
      <section className="docs-hero">
        <div className="docs-hero-copy">
          <h2>{t("API explorer")}</h2>
          <p>{t("Choose an endpoint and test a request.")}</p>
        </div>
        <div className="docs-base-url-card">
          <div className="docs-copy-row">
            <span className="control-label">{t("Base URL")}</span>
            <code title={origin}>{origin}</code>
            <button
              className="docs-icon-button"
              onClick={() => void copy(origin, "origin")}
              aria-label={t("Copy base URL")}
              title={t("Copy base URL")}
            >
              <Icon name={copied === "origin" ? "check" : "copy"} />
            </button>
          </div>
          <div className="docs-session-note">
            <span className="status-dot" />
            <span>{t("Uses your dashboard session")}</span>
          </div>
        </div>
      </section>

      <section className="docs-shell">
        <button
          ref={catalogToggleRef}
          className="docs-catalog-toggle"
          aria-expanded={catalogOpen}
          aria-controls="docs-catalog"
          onClick={() => setCatalogOpen((open) => !open)}
        >
          <span><small>{t("Choose an endpoint")}</small><strong>{t(selected.title)}</strong></span>
          <span>{catalogOpen ? t("Close") : t("Browse")} <Icon name="chevron" /></span>
        </button>
        <aside id="docs-catalog" className={"docs-catalog" + (catalogOpen ? " is-open" : "")} aria-label={t("API endpoint catalog")}>
          <div className="docs-search">
            <Icon name="search" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("Search endpoints")}
              aria-label={t("Search API endpoints")}
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                aria-label={t("Clear endpoint search")}
              >
                ×
              </button>
            )}
          </div>

          <label className="docs-group-filter">
            <span className="control-label">{t("Endpoint group")}</span>
            <select value={activeGroup} onChange={(event) => setActiveGroup(event.target.value as EndpointGroup | "All")}>
              {(["All", ...GROUPS] as const).map((group) => (
                <option key={group} value={group}>{group === "All" ? t("All endpoints") : groupLabel(group)} ({group === "All" ? ENDPOINTS.length : ENDPOINTS.filter((endpoint) => endpoint.group === group).length})</option>
              ))}
            </select>
          </label>

          <div className="docs-catalog-status">
            <span role="status">{filteredEndpoints.length === 1 ? t("1 endpoint") : t("{count} endpoints", { count: filteredEndpoints.length })}</span>
            {(search || activeGroup !== "All") && (
              <button onClick={() => { setSearch(""); setActiveGroup("All"); }}>{t("Clear filters")}</button>
            )}
          </div>
          <div className="docs-endpoint-list">
            {GROUPS.map((group) => {
              const endpoints = filteredEndpoints.filter(
                (endpoint) => endpoint.group === group,
              );
              if (!endpoints.length) return null;
              return (
                <section key={group}>
                  <h3>{groupLabel(group)}</h3>
                  {endpoints.map((endpoint) => (
                    <button
                      key={endpoint.id}
                      className={selected.id === endpoint.id ? "active" : ""}
                      aria-current={selected.id === endpoint.id ? "true" : undefined}
                      title={endpoint.method + " " + endpoint.path}
                      onClick={() => selectEndpoint(endpoint)}
                    >
                      <span className={methodClass(endpoint.method)}>
                        {endpoint.method}
                      </span>
                      <span>
                        <strong>{t(endpoint.title)}</strong>
                        <code>{endpoint.path}</code>
                      </span>
                      <Icon name="chevron" />
                    </button>
                  ))}
                </section>
              );
            })}
            {!filteredEndpoints.length && (
              <div className="docs-empty-search">
                <strong>{t("No endpoint found")}</strong>
                <small>{t("Try a path, method or broader keyword.")}</small>
                <button className="docs-copy-button" onClick={() => { setSearch(""); setActiveGroup("All"); }}>{t("Clear filters")}</button>
              </div>
            )}
          </div>
        </aside>

        <article ref={referenceRef} className="docs-reference" tabIndex={-1} aria-label={t(selected.title)}>
          <header className="docs-endpoint-header">
            <div className="docs-endpoint-route">
              <span className={methodClass(selected.method)}>
                {selected.method}
              </span>
              <code>{selected.path}</code>
            </div>
            <span className="docs-endpoint-group">{groupLabel(selected.group)}</span>
            <h2>{t(selected.title)}</h2>
            <p>{t(selected.description)}</p>
          </header>

          <div className="docs-view-switch" aria-label={t("Endpoint view")}>
            <button aria-pressed={view === "request"} onClick={() => setView("request")}><Icon name="terminal" /> {t("Try a request")}</button>
            <button aria-pressed={view === "reference"} onClick={() => setView("reference")}>{t("Documentation")}</button>
          </div>
          <div className="docs-reference-grid">
            <section className="docs-reference-content" hidden={view !== "reference"}>
              <div className="docs-section">
                <div className="docs-section-heading">
                  <div>
                    <span>{t("Overview")}</span>
                    <h3>{t(selected.summary)}</h3>
                  </div>
                </div>
                <div className="docs-auth-callout">
                  <Icon name="lock" />
                  <div>
                    <strong>
                      {selected.path.startsWith("/admin/")
                        ? t("Admin authentication")
                        : t("Application authentication")}
                    </strong>
                    <p>
                      {selected.path.startsWith("/admin/")
                        ? t("The interactive console uses your secure dashboard session. External clients should send x-admin-token or a Bearer admin token.")
                        : t("The interactive console uses your secure dashboard session. External clients should send a proxy API key as Bearer or x-api-key.")}
                    </p>
                  </div>
                </div>
              </div>

              {!!fields.length && (
                <div className="docs-section">
                  <div className="docs-section-heading">
                    <div>
                      <span>{t("Reference")}</span>
                      <h3>{t("Parameters")}</h3>
                    </div>
                  </div>
                  <div className="docs-parameter-table">
                    {fields.map((field) => (
                      <div key={field.name + "-" + field.description}>
                        <code>{field.name}</code>
                        <span>{field.type}</span>
                        <span
                          className={field.required ? "required" : "optional"}
                        >
                          {field.required ? t("Required") : t("Optional")}
                        </span>
                        <p>{t(field.description)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selected.note && (
                <div className="docs-note">
                  <strong>{t("Good to know")}</strong>
                  <p>{t(selected.note)}</p>
                </div>
              )}

              <div className="docs-section">
                <div className="docs-section-heading">
                  <div>
                    <span>{t("Example")}</span>
                    <h3>{t("Response")}</h3>
                  </div>
                  <button
                    className="docs-copy-button"
                    onClick={() =>
                      void copy(
                        hydrateExample(
                          selected.responseExample,
                          defaultModel,
                        ),
                        "response",
                      )
                    }
                  >
                    <Icon
                      name={copied === "response" ? "check" : "copy"}
                    />
                    {copied === "response" ? t("Copied") : t("Copy")}
                  </button>
                </div>
                <pre className="docs-code">
                  <code>
                    {hydrateExample(selected.responseExample, defaultModel)}
                  </code>
                </pre>
              </div>
            </section>

            <aside className="docs-console" hidden={view !== "request"}>
              <div className="docs-console-header">
                <div>
                  <Icon name="terminal" />
                  <span>
                    <strong>{t("Request builder")}</strong>
                    <small>{t("Edit the example and send when ready")}</small>
                  </span>
                </div>
                <span className="docs-live-pill">
                  <Icon name="lock" /> {t("Dashboard session")}
                </span>
              </div>

              <div className="docs-request-url">
                <span className={methodClass(selected.method)}>
                  {selected.method}
                </span>
                <code>{resolvedPath()}</code>
              </div>

              {!!selected.pathParams?.length && (
                <div className="docs-console-section">
                  <span className="control-label">{t("Path parameters")}</span>
                  <div className="docs-field-grid">
                    {selected.pathParams.map((field) => (
                      <label key={field.name}>
                        <span>
                          <code>{field.name}</code>
                          {field.required && <b>{t("Required")}</b>}
                        </span>
                        <input
                          title={t(field.description)}
                          required={field.required}
                          value={pathValues[field.name] ?? ""}
                          onChange={(event) =>
                            setPathValues((current) => ({
                              ...current,
                              [field.name]: event.target.value,
                            }))
                          }
                          placeholder={hydrateExample(
                            field.example,
                            defaultModel,
                          )}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {!!selected.queryParams?.length && (
                <div className="docs-console-section">
                  <span className="control-label">{t("Query parameters")}</span>
                  <div className="docs-field-grid">
                    {selected.queryParams.map((field) => (
                      <label key={field.name}>
                        <span>
                          <code>{field.name}</code>
                          {field.required && <b>{t("Required")}</b>}
                        </span>
                        <input
                          title={t(field.description)}
                          required={field.required}
                          value={queryValues[field.name] ?? ""}
                          onChange={(event) =>
                            setQueryValues((current) => ({
                              ...current,
                              [field.name]: event.target.value,
                            }))
                          }
                          placeholder={
                            hydrateExample(field.example, defaultModel) ||
                            t("Optional")
                          }
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {selected.requestBody !== undefined && (
                <div className="docs-console-section">
                  <div className="docs-console-label">
                    <span className="control-label">{t("JSON body")}</span>
                    <div className="docs-editor-tools">
                      <button className="docs-copy-button" onClick={() => setRequestBody(tryFormatJson(requestBody))}>{t("Format JSON")}</button>
                      <button className="docs-copy-button" onClick={() => setRequestBody(hydrateExample(selected.requestBody, defaultModel))}>{t("Reset example")}</button>
                    </div>
                  </div>
                  <textarea
                    className="docs-json-editor mono"
                    value={requestBody}
                    onChange={(event) => setRequestBody(event.target.value)}
                    rows={12}
                    spellCheck={false}
                    aria-label={t("JSON request body")}
                  />
                </div>
              )}

              <div className="docs-console-actions">
                {running ? (
                  <button
                    className="btn danger"
                    onClick={() => abortRef.current?.abort()}
                  >
                    <Icon name="stop" /> {t("Cancel request")}
                  </button>
                ) : (
                  <button
                    className={selected.destructive ? "btn danger" : "btn"}
                    onClick={() => void runRequest()}
                  >
                    <Icon name="send" /> {t("Send request")}
                  </button>
                )}
                <small>
                   {selected.destructive ? t("This endpoint changes server state. You’ll confirm before sending.") : t("Sent to this server using your dashboard session.")}
                </small>
              </div>


              <div
                className={
                  "docs-response " + (result?.error ? "is-error" : "")
                }
                aria-live="polite"
              >
                <div className="docs-response-header">
                  <div>
                    <span className="control-label">{t("Response")}</span>
                    {running && <span className="docs-running-dot" />}
                  </div>
                  {result && (
                    <div className="docs-response-meta">
                      <span
                        className={
                          result.error
                            ? "error"
                            : result.status && result.status < 400
                              ? "success"
                              : "neutral"
                        }
                      >
                        {result.status
                          ? result.status + " " + result.statusText
                          : result.statusText}
                      </span>
                      {result.durationMs !== undefined && (
                        <span>{result.durationMs} ms</span>
                      )}
                    </div>
                  )}
                </div>
                <pre>
                  <code>
                    {running
                      ? t("Sending request…")
                      : (result?.body ??
                        t("Run the request to inspect its response here."))}
                  </code>
                </pre>
                {result?.contentType && <small>{result.contentType}</small>}
              </div>
              <details className="docs-curl-block">
                <summary>{t("Use in your terminal · cURL")}</summary>
                <div className="docs-console-label">
                  <span className="control-label">cURL</span>
                  <button
                    onClick={() => void copy(curlSnippet(), "curl")}
                  >
                    <Icon name={copied === "curl" ? "check" : "copy"} />
                    {copied === "curl" ? t("Copied") : t("Copy")}
                  </button>
                </div>
                <pre>
                  <code>{curlSnippet()}</code>
                </pre>
              </details>

            </aside>
          </div>
        </article>
      </section>
    </div>
  );
}
