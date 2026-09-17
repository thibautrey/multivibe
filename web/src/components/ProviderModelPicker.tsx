import { memo, useMemo, useState } from "react";
import "./ProviderModelPicker.css";

export type ProviderModelOption = { id: string; name?: string; context?: number | null };

export type ProviderModelsLive = {
  discovered: boolean;
  source?: string | null;
  fetchedAt?: string | null;
  stale?: boolean;
  error?: string | null;
  catalog?: { source?: string; fetchedAt?: string; stale?: boolean; lastError?: string } | null;
} | null;

function parseSelection(value: string): string[] {
  return [...new Set(value.split(/[\n,]+/).map((id) => id.trim()).filter(Boolean))];
}

function formatSelection(ids: string[]): string {
  return ids.join(", ");
}

function fetchedLabel(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

/** Provider model picker shared by account creation and editing.
 *
 * An empty selection means "every model the provider lists". Explicit ids form
 * an allow-list, including ids that are not (yet) listed by discovery. */
export const ProviderModelPicker = memo(function ProviderModelPicker({
  providerName,
  value,
  onChange,
  options,
  live,
  loading,
  error,
  onRefresh,
  requiresSelection,
  inputId,
}: {
  providerName?: string;
  value: string;
  onChange: (next: string) => void;
  options: ProviderModelOption[];
  live?: ProviderModelsLive;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
  requiresSelection?: boolean;
  inputId?: string;
}) {
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState("");
  const selected = useMemo(() => parseSelection(value), [value]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allModels = !requiresSelection && selected.length === 0;
  const list = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? options.filter((option) => option.id.toLowerCase().includes(needle) || (option.name ?? "").toLowerCase().includes(needle))
      : options;
    return filtered.slice(0, 500);
  }, [options, query]);
  const unlisted = selected.filter((id) => !options.some((option) => option.id === id));

  const toggle = (id: string) => {
    if (selectedSet.has(id)) onChange(formatSelection(selected.filter((entry) => entry !== id)));
    else onChange(formatSelection([...selected, id]));
  };
  const addManual = () => {
    const id = manual.trim().replace(/[\n,]+/g, "");
    if (!id) return;
    if (!selectedSet.has(id)) onChange(formatSelection([...selected, id]));
    setManual("");
  };
  const status = live?.discovered
    ? `Liste live du provider${live.stale ? " (mise à jour en arrière-plan)" : ""}${fetchedLabel(live.fetchedAt) ? ` — ${fetchedLabel(live.fetchedAt)}` : ""}`
    : live?.catalog?.fetchedAt
      ? `Catalogue revu${fetchedLabel(live.catalog.fetchedAt) ? ` — ${fetchedLabel(live.catalog.fetchedAt)}` : ""}`
      : "Catalogue revu";

  return (
    <div className="provider-model-picker">
      <div className="provider-model-picker-head">
        <span>
          {loading ? "Chargement des modèles du provider…" : `${options.length} modèle${options.length === 1 ? "" : "s"} disponible${options.length === 1 ? "" : "s"} · ${status}`}
        </span>
        {onRefresh && (
          <button type="button" className="btn secondary" disabled={loading} onClick={onRefresh}>
            {loading ? "Rafraîchissement…" : "Rafraîchir"}
          </button>
        )}
      </div>
      {error && <p className="provider-model-picker-error">{error}</p>}
      {live?.error && !loading && <p className="provider-model-picker-error">Découverte en échec ({live.error}). Liste de secours affichée.</p>}
      {!requiresSelection && (
        <label className="provider-model-picker-all">
          <input
            type="checkbox"
            checked={allModels}
            onChange={(event) => onChange(event.target.checked ? "" : formatSelection(selected))}
          />
          Tous les modèles du provider{providerName ? ` (${providerName})` : ""}
        </label>
      )}
      {!allModels && (
        <div className="provider-model-picker-selected">
          {selected.map((id) => (
            <button type="button" key={id} className="provider-model-picker-chip" onClick={() => toggle(id)} title="Retirer">
              {id} <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}
      {options.length > 0 && (
        <>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filtrer les modèles"
            aria-label="Filtrer les modèles"
          />
          <ul className="provider-model-picker-list" role="listbox" aria-multiselectable="true">
            {list.map((option) => (
              <li key={option.id}>
                <label>
                  <input type="checkbox" checked={selectedSet.has(option.id)} onChange={() => toggle(option.id)} />
                  <span className="provider-model-picker-id">{option.id}</span>
                  {option.name && option.name !== option.id && <span className="provider-model-picker-name">{option.name}</span>}
                </label>
              </li>
            ))}
            {!list.length && <li className="provider-model-picker-empty">Aucun modèle ne correspond au filtre.</li>}
          </ul>
        </>
      )}
      <div className="provider-model-picker-manual">
        <input
          id={inputId}
          type="text"
          value={manual}
          onChange={(event) => setManual(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addManual(); } }}
          placeholder="Ajouter un ID de modèle manuellement"
          aria-label="Ajouter un ID de modèle manuellement"
        />
        <button type="button" className="btn secondary" onClick={addManual} disabled={!manual.trim()}>Ajouter</button>
      </div>
      {unlisted.length > 0 && <p className="muted">IDs personnalisés : {unlisted.join(", ")}</p>}
    </div>
  );
});
