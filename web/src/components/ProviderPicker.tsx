import { memo, useState } from "react";
import type { ProviderId } from "../types";
import "./ProviderSetup.css";

export type SetupProvider = ProviderId | "nvidia-pair";
export const SETUP_PROVIDERS: { id: SetupProvider; name: string; description: string; method: string; icon?: string }[] = [
  { id: "openai", name: "OpenAI", description: "Connect your ChatGPT account with OAuth.", method: "Account sign-in", icon: "openai" },
  { id: "xai", name: "Grok Build", description: "Use your SuperGrok or X Premium+ subscription.", method: "Device sign-in", icon: "xai" },
  { id: "opencode", name: "OpenCode Zen / Go", description: "Connect with an API key or your Console account.", method: "API key or sign-in", icon: "opencode" },
  { id: "mistral", name: "Mistral", description: "Access Mistral models with your API key.", method: "API key", icon: "mistral" },
  { id: "zai", name: "z.ai", description: "Bring your z.ai API key to access GLM models.", method: "API key", icon: "zai" },
  { id: "nvidia-pair", name: "NVIDIA PAIR", description: "Connect your Personal AI Router endpoint.", method: "Local endpoint", icon: "nvidia" },
  { id: "openai-compatible", name: "OpenAI-compatible", description: "Connect a local server or another hosted API.", method: "Custom endpoint" },
];

export type CloudProvider = { id: string; name: string; models: Array<{ id: string; name: string }> };

export function ProviderMark({ provider, sdkProvider }: { provider: SetupProvider; sdkProvider?: string }) {
  const icon = provider === "ai-sdk" ? sdkProvider : SETUP_PROVIDERS.find((item) => item.id === provider)?.icon;
  return <span className="provider-setup-mark" aria-hidden="true">
    {icon ? <img src={`/assets/providers/${icon}.svg`} alt="" /> :
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6h.01M7 17h.01M12 6h5M12 17h5" /></svg>}
  </span>;
}

// Search stays local: typing must not render the account tables and charts.
export const ProviderPicker = memo(function ProviderPicker({ value, sdkProvider, cloudProviders, error, onChange }: {
  value: SetupProvider;
  sdkProvider: string;
  cloudProviders: CloudProvider[];
  error: string;
  onChange: (provider: SetupProvider, sdkProvider?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const providers = [
    ...SETUP_PROVIDERS,
    ...cloudProviders.map((item) => ({ id: "ai-sdk" as const, sdkProvider: item.id, name: item.name,
      description: `Connect ${item.name} with your API key.`, method: "API key" })),
  ];
  const normalized = query.trim().toLocaleLowerCase();
  const matches = providers.filter((item) => `${item.name} ${item.description} ${item.method}`.toLocaleLowerCase().includes(normalized));
  return <div className="provider-setup-picker">
    <label className="provider-setup-search">Search providers
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name or connection type…" />
    </label>
    <p className="muted provider-setup-results" role="status">{matches.length} providers{normalized ? " found" : " available"}</p>
    {error && <p className="provider-setup-error" role="alert">{error}</p>}
    {!cloudProviders.length && !error && <p className="muted" role="status">Loading cloud providers…</p>}
    <div className="provider-setup-cards" role="group" aria-label="Choose a provider">
      {matches.map((item) => {
        const cloudId = "sdkProvider" in item ? item.sdkProvider : undefined;
        const selected = value === item.id && (item.id !== "ai-sdk" || sdkProvider === cloudId);
        return <button key={cloudId ?? item.id} type="button" className={`provider-setup-card${selected ? " selected" : ""}`} aria-pressed={selected} onClick={() => onChange(item.id, cloudId)}>
          <ProviderMark provider={item.id} sdkProvider={cloudId} />
          <span className="provider-setup-card-copy"><strong>{item.name}</strong><span>{item.description}</span><small>{item.method}</small></span>
          <span className="provider-setup-check" aria-hidden="true">{selected ? "✓" : ""}</span>
        </button>;
      })}
    </div>
    {!matches.length && <p className="provider-setup-empty">No providers match “{query}”. Try another name or connection type.</p>}
  </div>;
});
