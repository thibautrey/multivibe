import { memo, useState } from "react";
import type { ProviderId } from "../types";
import "./ProviderSetup.css";
import { PROVIDER_ACCESS, matchesAccessFilter, type AccessFilter } from "../lib/providerAccess";

export type SetupProvider = ProviderId | "nvidia-pair";
export const SETUP_PROVIDERS: { id: SetupProvider; name: string; description: string; method: string; icon?: string }[] = [
  { id: "openai", name: "OpenAI", description: "Connect your ChatGPT account with a one-time device code.", method: "Device sign-in", icon: "openai" },
  { id: "github-copilot", name: "GitHub Copilot", description: "Connect your GitHub account to use Copilot models.", method: "Device sign-in" },
  { id: "xai", name: "Grok Build", description: "Use your SuperGrok or X Premium+ subscription.", method: "Device sign-in", icon: "xai" },
  { id: "opencode", name: "OpenCode Zen / Go", description: "Connect with an API key or your Console account.", method: "API key or sign-in", icon: "opencode" },
  { id: "mistral", name: "Mistral", description: "Access Mistral models with your API key.", method: "API key", icon: "mistral" },
  { id: "zai", name: "Z.AI GLM Coding Plan", description: "Use your GLM Coding Plan key with subscription quota tracking.", method: "API key", icon: "zai" },
  { id: "nvidia-pair", name: "NVIDIA PAIR", description: "Connect your Personal AI Router endpoint.", method: "Local endpoint", icon: "nvidia" },
  { id: "openai-compatible", name: "OpenAI-compatible", description: "Connect a local server or another hosted API.", method: "Custom endpoint" },
];

export type CloudProvider = { id: string; name: string; models: Array<{ id: string; name: string }>;
  endpointPlaceholder?: string; endpointRequired?: boolean; credentialLabel?: string; requiresModelSelection?: boolean };

const PROVIDER_ICON_ALIASES: Record<string, string> = {"github-copilot": "githubcopilot", "azure-foundry": "azureai", "vertex-express": "vertexai", "siliconflow": "siliconcloud", "nvidia-nim": "nvidia", "codestral": "mistral", "kilo": "kilocode", "byteplus-coding": "bytedance", "xiaomi-token-plan": "xiaomimimo", "xiaomi-token-plan-ams": "xiaomimimo", "xiaomi-token-plan-sgp": "xiaomimimo", "ollama-cloud": "ollama", "minimax-coding": "minimax", "kimi-coding": "kimi", "qwen-coding": "qwen"};
const PROVIDER_ICONS = new Set(["ai21", "anthropic", "azureai", "baseten", "bedrock", "bytedance", "cerebras", "cloudflare", "cohere", "deepinfra", "deepseek", "fal", "fireworks", "githubcopilot", "google", "groq", "huggingface", "kilocode", "kimi", "mammouth", "manus", "minimax", "mistral", "nebius", "novita", "nvidia", "ollama", "openai", "opencode", "openrouter", "perplexity", "poe", "qwen", "replicate", "sambanova", "siliconcloud", "togetherai", "venice", "vertexai", "xai", "xiaomimimo", "zai"]);

export function ProviderMark({ provider, sdkProvider, name }: { provider: SetupProvider; sdkProvider?: string; name?: string }) {
  const id = provider === "ai-sdk" ? sdkProvider ?? provider : provider;
  const candidate = PROVIDER_ICON_ALIASES[id] ?? SETUP_PROVIDERS.find(item => item.id === id)?.icon ?? id;
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  const initials = (name ?? id).split(/[\s-]+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase();
  return <span className="provider-setup-mark" aria-hidden="true">
    {PROVIDER_ICONS.has(candidate) && failedIcon !== candidate ? <img src={`/assets/providers/${candidate}.svg`} alt="" onError={() => setFailedIcon(candidate)} /> :
      provider === "openai-compatible" ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/></svg> : <span className="provider-initials">{initials}</span>}
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
  const [accessFilter, setAccessFilter] = useState<AccessFilter | null>(null);
  const providers = [
    ...SETUP_PROVIDERS,
    ...cloudProviders.map((item) => ({ id: "ai-sdk" as const, sdkProvider: item.id, name: item.name,
      description: `Connect ${item.name} with your ${item.credentialLabel ?? "API key"}.`, method: item.credentialLabel ?? "API key" })),
  ];
  const normalized = query.trim().toLocaleLowerCase();
  const matches = providers.filter((item) =>
    matchesAccessFilter("sdkProvider" in item ? item.sdkProvider : item.id, accessFilter) &&
    `${item.name} ${item.description} ${item.method}`.toLocaleLowerCase().includes(normalized));
  return <div className="provider-setup-picker">
    <label className="provider-setup-search">Search providers
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a provider…" />
    </label>
    <div className="provider-picker-toolbar"><label className="provider-pricing-select">Pricing<select value={accessFilter ?? "all"} onChange={event => setAccessFilter(event.target.value === "all" ? null : event.target.value as AccessFilter)}><option value="all">All pricing</option><option value="Paid">Paid</option><option value="Free">Free tier available</option><option value="Freemium">Free & paid</option></select></label><span className="muted">Free tiers may have limits.</span></div>
    <p className="muted provider-setup-results" role="status">{matches.length} provider{matches.length === 1 ? "" : "s"}{normalized || accessFilter ? " found" : " available"}</p>
    {error && <p className="provider-setup-error" role="alert">{error}</p>}
    {!cloudProviders.length && !error && <p className="muted" role="status">Loading cloud providers…</p>}
    <div className="provider-setup-cards" role="group" aria-label="Choose a provider">
      {matches.map((item) => {
        const cloudId = "sdkProvider" in item ? item.sdkProvider : undefined;
        const access = PROVIDER_ACCESS[cloudId ?? item.id];
        const selected = value === item.id && (item.id !== "ai-sdk" || sdkProvider === cloudId);
        return <button key={cloudId ?? item.id} type="button" className={`provider-setup-card${selected ? " selected" : ""}`} aria-pressed={selected} onClick={() => onChange(item.id, cloudId)}>
          <ProviderMark provider={item.id} sdkProvider={cloudId} name={item.name} />
          <span className="provider-setup-card-copy"><strong>{item.name}</strong><small>{item.method}</small><span className="provider-access-label" title={access?.note}>{access ? access.free ? access.paid ? "Free & paid" : "Free tier" : "Paid" : "Depends on endpoint"}</span></span>
          <span className="provider-setup-check" aria-hidden="true">{selected ? "✓" : ""}</span>
        </button>;
      })}
    </div>
    {(() => {
      const selected = providers.find(item => item.id === value && (item.id !== "ai-sdk" || ("sdkProvider" in item && item.sdkProvider === sdkProvider)));
      return selected ? <div className="provider-selection-summary"><strong>{selected.name}</strong><span>{selected.description}</span></div> : null;
    })()}
    {!matches.length && <p className="provider-setup-empty">No providers match{query.trim() ? ` “${query}”` : ""}{accessFilter ? ` with the ${accessFilter} filter` : ""}. Try another search or clear the filter.</p>}
  </div>;
});
