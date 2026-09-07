import type { ProviderId } from "../types";
import "./ProviderSetup.css";

export type SetupProvider = ProviderId | "nvidia-pair";
export const SETUP_PROVIDERS: { id: SetupProvider; name: string; description: string; method: string; icon?: string }[] = [
  { id: "openai", name: "OpenAI", description: "Connect your ChatGPT account with OAuth.", method: "Account sign-in", icon: "openai" },
  { id: "xai", name: "Grok Build", description: "Use your SuperGrok or X Premium+ subscription.", method: "Device sign-in", icon: "xai" },
  { id: "opencode", name: "OpenCode Zen / Go", description: "Connect with an API key or your Console account.", method: "API key or sign-in", icon: "opencode" },
  { id: "mistral", name: "Mistral", description: "Access Mistral models with your API key.", method: "API key", icon: "mistral" },
  { id: "zai", name: "z.ai", description: "Bring your z.ai API key to access GLM models.", method: "API key", icon: "zai" },
  { id: "ai-sdk", name: "More cloud providers", description: "Anthropic, Google Gemini, OpenRouter, DeepSeek and more.", method: "API key" },
  { id: "nvidia-pair", name: "NVIDIA PAIR", description: "Connect your Personal AI Router endpoint.", method: "Local endpoint", icon: "nvidia" },
  { id: "openai-compatible", name: "OpenAI-compatible", description: "Connect a local server or another hosted API.", method: "Custom endpoint" },
];

export function ProviderMark({ provider }: { provider: SetupProvider }) {
  const info = SETUP_PROVIDERS.find((item) => item.id === provider)!;
  return <span className="provider-setup-mark" aria-hidden="true">
    {info.icon ? <img src={`/assets/providers/${info.icon}.svg`} alt="" /> :
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6h.01M7 17h.01M12 6h5M12 17h5" /></svg>}
  </span>;
}

export function ProviderPicker({ value, onChange }: { value: SetupProvider; onChange: (provider: SetupProvider) => void }) {
  return <div className="provider-setup-cards" role="group" aria-label="Choose a provider">
    {SETUP_PROVIDERS.map((item) => <button key={item.id} type="button" className={`provider-setup-card${value === item.id ? " selected" : ""}`} aria-pressed={value === item.id} onClick={() => onChange(item.id)}>
      <ProviderMark provider={item.id} />
      <span className="provider-setup-card-copy"><strong>{item.name}</strong><span>{item.description}</span><small>{item.method}</small></span>
      <span className="provider-setup-check" aria-hidden="true">{value === item.id ? "✓" : ""}</span>
    </button>)}
  </div>;
}
