import React, { useMemo, useState } from "react";
import type { ExposedModel, ProviderId } from "../types";
import { ProviderMark, SETUP_PROVIDERS } from "./ProviderPicker";

const PAGE_SIZE = 20;
const providerName = (id: ProviderId) => SETUP_PROVIDERS.find((provider) => provider.id === id)?.name ?? "AI SDK";
const modelProviders = (model: ExposedModel): ProviderId[] =>
  model.metadata?.provider_candidates?.length
    ? model.metadata.provider_candidates
    : model.metadata?.provider ? [model.metadata.provider] : [];

export function AvailableModels({ models, openModelInDocs }: {
  models: ExposedModel[];
  openModelInDocs: (modelId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [page, setPage] = useState(0);
  const providers = useMemo(() => [...new Set(models.flatMap(modelProviders))]
    .sort((a, b) => providerName(a).localeCompare(providerName(b))), [models]);
  const filtered = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return models.filter((model) => {
      const candidates = modelProviders(model);
      const searchable = [model.id, model.owned_by, ...candidates, ...candidates.map(providerName)].join(" ").toLocaleLowerCase();
      return (provider === "all" || candidates.some((id) => id === provider)) && terms.every((term) => searchable.includes(term));
    }).sort((a, b) => a.id.localeCompare(b.id));
  }, [models, query, provider]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const offset = currentPage * PAGE_SIZE;

  return (
    <section className="panel overview-models-panel" aria-labelledby="available-models-title">
      <div className="section-split-header">
        <div>
          <h2 id="available-models-title">Available models</h2>
          <small>Choose a model to open a ready-to-run request.</small>
        </div>
        <span className="badge">{models.length} models</span>
      </div>
      <div className="overview-model-controls">
        <label className="compact-field overview-model-search">
          Search models
          <input type="search" value={query} placeholder="Model name or provider…"
            onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
        </label>
        <label className="compact-field overview-provider-filter">
          Provider
          <select value={provider} onChange={(event) => { setProvider(event.target.value); setPage(0); }}>
            <option value="all">All providers</option>
            {providers.map((id) => <option key={id} value={id}>{providerName(id)}</option>)}
          </select>
        </label>
      </div>
      <p className="muted overview-model-count" role="status">
        {filtered.length ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, filtered.length)} of ${filtered.length} models` : "0 models"}
      </p>
      <ul className="overview-model-list">
        {filtered.slice(offset, offset + PAGE_SIZE).map((model) => {
          const candidates = modelProviders(model);
          return <li key={model.id}>
            <button type="button" className="overview-model-row" onClick={() => openModelInDocs(model.id)} aria-label={`Test ${model.id} in API reference`}>
              <ProviderMark provider={candidates[0] ?? "openai-compatible"} />
              <span className="overview-model-info">
                <span className="mono overview-model-name">{model.id}</span>
                <span className="muted overview-model-provider">{candidates.map(providerName).join(" · ") || model.owned_by || "Custom model"}{model.metadata?.is_alias ? " · Alias" : ""}</span>
              </span>
              <span aria-hidden="true">→</span>
            </button>
          </li>;
        })}
      </ul>
      {!filtered.length && <div className="overview-model-empty">
        <p className="muted">{models.length ? "No models match your search or provider filter." : "No models available yet. Connect a provider to get started."}</p>
        {(query || provider !== "all") && <button type="button" className="btn" onClick={() => { setQuery(""); setProvider("all"); setPage(0); }}>Clear filters</button>}
      </div>}
      {pages > 1 && <nav className="overview-model-pagination" aria-label="Model pages">
        <button type="button" className="btn" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
        <span className="muted">Page {currentPage + 1} of {pages}</span>
        <button type="button" className="btn" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>Next</button>
      </nav>}
    </section>
  );
}
