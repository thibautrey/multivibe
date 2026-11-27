import React, { useMemo, useState } from "react";
import type { ExposedModel, ProviderId } from "../types";
import { ProviderMark, SETUP_PROVIDERS } from "./ProviderPicker";
import { useT } from "../i18n";

const PAGE_SIZE = 5;
const providerName = (id: ProviderId) => SETUP_PROVIDERS.find((provider) => provider.id === id)?.name ?? "AI SDK";
const modelProviders = (model: ExposedModel): ProviderId[] =>
  model.metadata?.provider_candidates?.length
    ? model.metadata.provider_candidates
    : model.metadata?.provider ? [model.metadata.provider] : [];

export function AvailableModels({ models, openModelInDocs }: {
  models: ExposedModel[];
  openModelInDocs: (modelId: string) => void;
}) {
  const t = useT();
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
          <h2 id="available-models-title">{t("Available models")}</h2>
          <small>{t("Choose a model to open a ready-to-run request.")}</small>
        </div>
        <span className="badge">{models.length === 1 ? t("1 model") : t("{count} models", { count: models.length })}</span>
      </div>
      <div className="overview-model-controls">
        <label className="compact-field overview-model-search">
          {t("Search models")}
          <input type="search" value={query} placeholder={t("Model name or provider…")}
            onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
        </label>
        <label className="compact-field overview-provider-filter">
          {t("Provider")}
          <select value={provider} onChange={(event) => { setProvider(event.target.value); setPage(0); }}>
            <option value="all">{t("All providers")}</option>
            {providers.map((id) => <option key={id} value={id}>{providerName(id)}</option>)}
          </select>
        </label>
      </div>
      <p className="muted overview-model-count" role="status">
        {filtered.length ? t("{from}–{to} of {total} models", { from: offset + 1, to: Math.min(offset + PAGE_SIZE, filtered.length), total: filtered.length }) : t("0 models")}
      </p>
      <ul className="overview-model-list">
        {filtered.slice(offset, offset + PAGE_SIZE).map((model) => {
          const candidates = modelProviders(model);
          return <li key={model.id}>
            <button type="button" className="overview-model-row" onClick={() => openModelInDocs(model.id)} aria-label={t("Test {model} in API reference", { model: model.id })}>
              <ProviderMark provider={candidates[0] ?? "openai-compatible"} />
              <span className="overview-model-info">
                <span className="mono overview-model-name">{model.id}</span>
                <span className="muted overview-model-provider">{candidates.map(providerName).join(" · ") || model.owned_by || t("Custom model")}{model.metadata?.is_alias ? ` · ${t("Alias")}` : ""}</span>
              </span>
              <span aria-hidden="true">→</span>
            </button>
          </li>;
        })}
      </ul>
      {!filtered.length && <div className="overview-model-empty">
        <p className="muted">{models.length ? t("No models match your search or provider filter.") : t("No models available yet. Connect a provider to get started.")}</p>
        {(query || provider !== "all") && <button type="button" className="btn" onClick={() => { setQuery(""); setProvider("all"); setPage(0); }}>{t("Clear filters")}</button>}
      </div>}
      {pages > 1 && <nav className="overview-model-pagination" aria-label={t("Model pages")}>
        <button type="button" className="btn" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t("Previous")}</button>
        <span className="muted">{t("Page {page} of {pages}", { page: currentPage + 1, pages })}</span>
        <button type="button" className="btn" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>{t("Next")}</button>
      </nav>}
    </section>
  );
}
