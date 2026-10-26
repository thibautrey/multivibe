import { SDK_PROVIDER_NAMES } from "./expandedProviderMetadata";
import type { Account } from "../types";

export type RuntimeIdentity = {
  id: string;
  label: string;
  iconUrl: string;
  homepageUrl?: string;
};

const GENERIC_RUNTIME_ICON = "/assets/brand/favicon.svg";

const RUNTIME_CATALOG: Record<string, RuntimeIdentity> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    iconUrl: "https://openai.com/favicon.ico",
    homepageUrl: "https://openai.com",
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    iconUrl: "https://mistral.ai/favicon.ico",
    homepageUrl: "https://mistral.ai",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    iconUrl: "https://opencode.ai/favicon-v3.svg",
    homepageUrl: "https://opencode.ai",
  },
  zai: {
    id: "zai",
    label: "z.ai",
    iconUrl: "https://z.ai/favicon.png",
    homepageUrl: "https://z.ai",
  },
  "github-copilot": {
    id: "github-copilot", label: "GitHub Copilot",
    iconUrl: "https://github.com/favicon.ico", homepageUrl: "https://github.com/features/copilot",
  },
  xai: {
    id: "xai",
    label: "Grok Build",
    iconUrl: "https://grok.com/favicon.ico",
    homepageUrl: "https://grok.com",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    iconUrl: "/assets/providers/deepseek.svg",
    homepageUrl: "https://www.deepseek.com",
  },
  "manual-openai-compatible": {
    id: "manual-openai-compatible",
    label: "OpenAI-compatible",
    iconUrl: GENERIC_RUNTIME_ICON,
  },
};

function fallbackIdentity(id: string, label?: string): RuntimeIdentity {
  return {
    id,
    label: label ?? id,
    iconUrl: GENERIC_RUNTIME_ICON,
  };
}

export function runtimeIdentityForAdapter(
  adapter?: string,
  displayName?: string,
): RuntimeIdentity {
  const id = adapter?.trim() || "unknown-runtime";
  const identity = RUNTIME_CATALOG[id];
  if (!identity) return fallbackIdentity(id, displayName);
  return displayName && identity.iconUrl === GENERIC_RUNTIME_ICON
    ? { ...identity, label: displayName }
    : identity;
}

export function runtimeIdentityForProvider(provider?: string): RuntimeIdentity {
  if (!provider) return runtimeIdentityForAdapter("openai");
  return runtimeIdentityForAdapter(provider);
}

export function runtimeIdentityForAccount(
  account: Pick<Account, "provider" | "localRuntime" | "sdkProvider">,
): RuntimeIdentity {
  if (account.provider === "ai-sdk") {
    return runtimeIdentityForAdapter(
      account.sdkProvider ?? "ai-sdk",
      SDK_PROVIDER_NAMES[account.sdkProvider ?? ""] ?? "Cloud provider",
    );
  }
  return runtimeIdentityForProvider(account.provider);
}
