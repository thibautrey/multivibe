import { useMemo, useState } from "react";
import type { ExposedModel } from "../types";
import { copyTextToClipboard } from "../lib/clipboard";
import "./AccountModelsSection.css";

/** Number of listed models above which a local filter is worth its rows. */
const SEARCH_THRESHOLD = 8;

/** Disclosure listing the models one connected account currently exposes.
 *
 * The catalog is the routing one: the edge already tags every exposed model
 * with the account it discovered it from, so this stays accurate for providers
 * without a per-account discovery endpoint. */
export function AccountModelsSection({ accountLabel, models, onRefresh }: {
  accountLabel: string;
  models: ExposedModel[];
  onRefresh?: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const entries = useMemo(() => {
    const byId = new Map<string, ExposedModel>();
    for (const model of models) if (!byId.has(model.id)) byId.set(model.id, model);
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, "en"));
  }, [models]);
  const needle = query.trim().toLowerCase();
  const list = needle
    ? entries.filter((model) => model.id.toLowerCase().includes(needle) || (model.name ?? "").toLowerCase().includes(needle))
    : entries;

  const refresh = async () => {
    if (!onRefresh) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const copy = async () => {
    try {
      await copyTextToClipboard(list.map((model) => model.id).join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A rejected clipboard write leaves the list selectable on screen.
    }
  };

  return (
    <details className="account-models">
      <summary>
        <span>Models exposed</span>
        <span className="badge">{entries.length}</span>
        {refreshing && <span className="muted" role="status">Refreshing…</span>}
      </summary>
      <div className="account-models-body">
        {entries.length > 0 ? (
          <>
            <div className="account-models-toolbar">
              {entries.length > SEARCH_THRESHOLD && (
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter models"
                  aria-label={`Filter ${accountLabel} models`}
                />
              )}
              <span className="account-models-toolbar-actions">
                <button type="button" className="btn secondary" onClick={() => void copy()} disabled={!list.length}>
                  {copied ? "Copied" : "Copy IDs"}
                </button>
                {onRefresh && (
                  <button type="button" className="btn secondary" onClick={() => void refresh()} disabled={refreshing}>
                    {refreshing ? "Refreshing…" : "Refresh"}
                  </button>
                )}
              </span>
            </div>
            {list.length ? (
              <ul className="account-models-list">
                {list.map((model) => (
                  <li key={model.id} className="account-models-item" title={model.name && model.name !== model.id ? `${model.id} · ${model.name}` : model.id}>
                    <span className="mono account-models-id">{model.id}</span>
                    {model.name && model.name !== model.id && <span className="muted account-models-name">{model.name}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No model matches “{query.trim()}”.</p>
            )}
          </>
        ) : (
          <div className="account-models-empty">
            <p className="muted">No model discovered for this provider yet. Refresh to ask the upstream for its list.</p>
            {onRefresh && (
              <button type="button" className="btn secondary" onClick={() => void refresh()} disabled={refreshing}>
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
